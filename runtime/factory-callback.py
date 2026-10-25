#!/usr/bin/env python3
"""Opt-in factory-desktop:// handler registration with exact rollback.

The packaged desktop entry advertises the URL scheme without replacing an
existing user default. App startup never changes the default handler.
Use this helper to override the default explicitly and restore it later:

    factory-callback register   # make this port the factory-desktop:// handler
    factory-callback rollback   # restore exactly the pre-registration state
    factory-callback status     # show the current handler

Design notes:

- Registration is user-local. The handler lives in
  ~/.local/share/applications/factory-droid-desktop-callback.desktop and the
  association in the user's mimeapps.list files.
- Only the entry in `[Default Applications]` is read and mutated. Same-key
  entries under `[Added Associations]` and `[Removed Associations]` are
  never treated as a default and are never touched.
- The journaled original full text is restored byte-for-byte (including
  comments, spacing, line endings, and a missing final newline) whenever the
  file still matches what this helper wrote. If unrelated later edits
  exist, only the owned `[Default Applications]` entry is merged back,
  preserving those edits.
- A file that another action removed after the registration is left removed:
  the rollback restores the files that survived and never recreates it, so
  a later cleanup by another tool is not silently undone.
- Desktop-specific files (for example hyprland-mimeapps.list under
  XDG_CURRENT_DESKTOP=Hyprland) take precedence over the generic
  mimeapps.list during resolution. When such a file exists and already
  carries a `[Default Applications]` entry for the scheme, registering
  updates that file too; otherwise the generic file alone is sufficient.
- Effective entries are re-read immediately before mutation; an intervening
  third-party change is journaled as the new previous state instead of being
  overwritten. Any failure after a mutation restores the journaled state.
  This protects the known interleavings; it is not a cross-application lock.
- Symbolic links anywhere in the managed paths (state directory, lock,
  state JSON, desktop entry, and the MIME files) are refused rather than
  followed, and the lock is opened with no-follow semantics and without
  truncation. A callback desktop file that was modified after this helper
  created it is never overwritten or deleted: the recovery state is kept
  and the refusal is reported.
"""

import fcntl
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

SCHEME = "x-scheme-handler/factory-desktop"
DESKTOP_ID = "factory-droid-desktop-callback.desktop"
STATE_DIRNAME = "factory-droid-desktop"
STATE_FILENAME = "callback.json"
LOCK_FILENAME = "callback.lock"
MAX_JOURNAL_BYTES = 1 << 20  # refuse to journal absurdly large files
# Section names are matched case-sensitively, as glib's key-file parser
# (which desktop resolvers use) treats group names. A mixed-case or
# differently spelled heading is therefore "another section": left
# untouched, and never mistaken for the default section.
DEFAULT_SECTION = "Default Applications"
SAFE_DESKTOP_NAME = re.compile(r"^[a-z0-9][a-z0-9._-]*$")

ENTRY_BODY = f"""[Desktop Entry]
Type=Application
Name=Factory Droid Desktop (unofficial port)
Comment=Handles factory-desktop:// callback links
Exec=factory-droid-desktop %u
Icon=factory-droid-desktop
Terminal=false
Categories=Development;
MimeType={SCHEME};
NoDisplay=true
"""


class CallbackError(Exception):
    pass


def config_dir():
    return Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config")


def data_dir():
    return Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share")


def state_dir():
    return Path(os.environ.get("XDG_STATE_HOME") or Path.home() / ".local" / "state") / STATE_DIRNAME


def state_file():
    return state_dir() / STATE_FILENAME


def lock_file():
    return state_dir() / LOCK_FILENAME


def entry_path():
    return data_dir() / "applications" / DESKTOP_ID


def desktop_name():
    """Validated desktop component for <desktop>-mimeapps.list paths. An
    invalid or missing name disables the desktop-specific file rather than
    ever constructing a traversal path from user-controlled input."""
    name = (os.environ.get("XDG_CURRENT_DESKTOP") or "").split(":")[0].strip().lower()
    return name if name and SAFE_DESKTOP_NAME.match(name) else None


def user_files():
    """The mimeapps.list files that participate in handler resolution,
    keyed by role."""
    files = {
        "generic": config_dir() / "mimeapps.list",
        "legacy": data_dir() / "applications" / "mimeapps.list",
    }
    desktop = desktop_name()
    if desktop:
        files["desktop"] = config_dir() / f"{desktop}-mimeapps.list"
    return files


def read_text_if_exists(path):
    """Read the file as raw bytes decoded to text, with NO newline
    translation, so journaled originals keep their exact CRLF/LF/CR bytes."""
    try:
        if path.is_symlink() or not path.is_file():
            return None
        return path.read_bytes().decode("utf-8")
    except (OSError, UnicodeDecodeError):
        return None


# Split ONLY on CR LF, CR, or LF (unlike str.splitlines, which also splits
# on other Unicode line boundaries), keeping the original terminators. The
# $ alternative keeps a final line that has no terminator.
_LINE_RE = re.compile(r"[^\r\n]*(?:\r\n|\r|\n|$)")


def split_keepends(text):
    if not text:
        return []
    lines = [m.group(0) for m in _LINE_RE.finditer(text)]
    # finditer yields one trailing empty match at the end of the text; the
    # real final line (with or without a terminator) is already captured.
    if lines and lines[-1] == "":
        lines.pop()
    return lines


def section_of_each_line(lines):
    """Map line index -> section name it belongs to (case-sensitive, as
    glib's key-file parser treats group names)."""
    spans = {}
    current = None
    for i, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith("[") and stripped.endswith("]"):
            current = stripped[1:-1].strip()
        spans[i] = current
    return spans


def default_section_header_index(lines):
    for i, line in enumerate(lines):
        if line.strip() == f"[{DEFAULT_SECTION}]":
            return i
    return None


def default_scheme_line(text, scheme=SCHEME):
    """The raw (keepends) scheme entry inside [Default Applications], with
    its line index. Entries under Added/Removed Associations are ignored."""
    lines = split_keepends(text)
    spans = section_of_each_line(lines)
    for i, line in enumerate(lines):
        if spans[i] == DEFAULT_SECTION and line.strip().startswith(f"{scheme}="):
            return i, line
    return None, None


def default_for(path):
    """The first desktop id in the scheme's [Default Applications] line."""
    text = read_text_if_exists(path)
    _, line = default_scheme_line(text)
    if not line:
        return ""
    return line.split("=", 1)[1].split(";")[0].strip()


def atomic_write(path, content, mode):
    """Write exact bytes (no newline translation) atomically."""
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = tempfile.NamedTemporaryFile("wb", dir=path.parent, delete=False)
    try:
        handle.write(content.encode("utf-8"))
        handle.flush()
        os.fsync(handle.fileno())
    finally:
        handle.close()
    os.chmod(handle.name, mode)
    os.replace(handle.name, path)


def write_if_changed(path, content, mode):
    current = read_text_if_exists(path)
    if current == content:
        return
    atomic_write(path, content, mode)


def check_no_symlink(path, what):
    if path.is_symlink() or any(p.is_symlink() for p in path.parents):
        raise CallbackError(
            f"{what} is or passes through a symbolic link; refusing to touch it: {path}")


def validate_state_paths():
    """Refuse symlinked state directory, parents, lock, or state JSON before
    anything is created or written."""
    state = state_dir()
    check_no_symlink(state, "The registration state directory")
    lock = lock_file()
    if lock.is_symlink():
        raise CallbackError(f"The registration lock is a symbolic link: {lock}")
    sf = state_file()
    if sf.is_symlink():
        raise CallbackError(f"The registration state file is a symbolic link: {sf}")


def effective_handler():
    if shutil.which("xdg-mime") is None:
        raise CallbackError("xdg-mime not found; install xdg-utils.")
    try:
        result = subprocess.run(
            ["xdg-mime", "query", "default", SCHEME],
            capture_output=True, text=True, timeout=30,
        )
    except subprocess.TimeoutExpired:
        raise CallbackError("xdg-mime query timed out.")
    if result.returncode != 0:
        return ""
    # Real xdg-mime resolves to a single desktop id; normalize defensively.
    return result.stdout.strip().split(";")[0].strip()


def effective_default_from_files():
    """Mirror the resolution order: a desktop-specific file with a
    [Default Applications] entry wins, then the generic file, then the
    legacy file. Added/Removed Associations never decide the default."""
    files = user_files()
    for key in ("desktop", "generic", "legacy"):
        path = files.get(key)
        if path is None:
            continue
        default = default_for(path)
        if default:
            return default
    return ""


def snapshot_files():
    journal = {"files": {}}
    for key, path in user_files().items():
        check_no_symlink(path, f"The {key} associations file")
        existed = path.is_file()
        content = read_text_if_exists(path)
        if existed and content is None:
            raise CallbackError(f"Could not read {path}; refusing to proceed.")
        if existed and len(content.encode()) > MAX_JOURNAL_BYTES:
            raise CallbackError(f"{path} is too large to journal safely.")
        _, raw_line = default_scheme_line(content)
        journal["files"][key] = {
            "path": str(path),
            "existed": existed,
            "content": content,
            # Raw [Default Applications] scheme line, with its line ending.
            "lines": [raw_line] if raw_line else [],
            "hadDefaultHeader": default_section_header_index(split_keepends(content)) is not None,
        }
    entry = entry_path()
    if entry.is_symlink():
        raise CallbackError(f"The callback desktop entry is a symbolic link: {entry}")
    check_no_symlink(entry.parent, "The desktop entry directory")
    journal["scheme"] = SCHEME
    journal["desktop"] = desktop_name()
    journal["entryExisted"] = entry.exists()
    return journal


def write_association(path, old_line, mode):
    """Set the scheme's default to DESKTOP_ID in the [Default Applications]
    section only, preserving the current fallback list, all other sections,
    comments, formatting, and line endings. Returns the written content."""
    text = read_text_if_exists(path) or ""
    lines = split_keepends(text)
    idx, current_line = default_scheme_line(text)
    fallback = current_line.split("=", 1)[1] if current_line else None
    core = f"{SCHEME}={DESKTOP_ID};" + (fallback.rstrip("\n") if fallback else "")
    replacement = core + "\n"

    if idx is not None:
        # Replace in place, keeping the file's own line-ending style.
        ending = "\n" if lines[idx].endswith("\n") else ""
        lines[idx] = core + ending
        content = "".join(lines)
    else:
        header_idx = default_section_header_index(lines)
        if header_idx is not None:
            if not lines[header_idx].endswith("\n"):
                # A trailing header without a newline: normalize it so the
                # entry can be inserted below; the exact-restore path keeps
                # original bytes when nothing else edited the file.
                lines[header_idx] += "\n"
            lines.insert(header_idx + 1, replacement)
            content = "".join(lines)
        else:
            # Append a new section; separate from a non-newline-terminated
            # tail by one newline.
            prefix = text
            if prefix and not prefix.endswith("\n"):
                prefix += "\n"
            content = prefix + "[Default Applications]\n" + replacement

    atomic_write(path, content, mode)
    return content


def restore_default_entry(path, record, written_content, mode):
    """Restore one file's [Default Applications] entry. When the file still
    equals what we wrote, restore the journaled original bytes exactly.
    Otherwise merge back only the owned default entry, preserving later
    third-party edits everywhere else."""
    current = read_text_if_exists(path)
    if current is None:
        return
    original_content = record["content"]
    original_line = record["lines"][-1] if record["lines"] else None
    if written_content is not None and current == written_content:
        if original_content is not None:
            atomic_write(path, original_content, mode)
        else:
            path.unlink()  # we created this file and nothing else touched it
        return

    lines = split_keepends(current)
    spans = section_of_each_line(lines)
    ours_idx = None
    for i, line in enumerate(lines):
        if spans[i] == DEFAULT_SECTION and line.strip().startswith(f"{SCHEME}=") \
                and line.split("=", 1)[1].split(";")[0].strip() == DESKTOP_ID:
            ours_idx = i
            break
    if ours_idx is None:
        return  # nothing of ours left to restore

    if original_line:
        # Put the original default entry back exactly where ours was,
        # keeping the file's own line-ending style.
        ending = "\n" if lines[ours_idx].endswith("\n") else ""
        lines[ours_idx] = original_line.rstrip("\n") + ending
        write_if_changed(path, "".join(lines), mode)
        return

    # No original default entry: drop our line. If we also added the header
    # (the original file had no [Default Applications] section) and nothing
    # else now lives in that section, remove the added header too — but
    # only when it is the last line, so later unrelated sections and any
    # third-party additions are preserved byte-for-byte.
    del lines[ours_idx]
    content = "".join(lines)
    if not record.get("hadDefaultHeader") and original_content is not None:
        remaining = split_keepends(content)
        header_idx = default_section_header_index(remaining)
        if header_idx is not None and header_idx == len(remaining) - 1 \
                and remaining[header_idx].strip() == "[Default Applications]":
            spans_after = section_of_each_line(remaining)
            section_entries = [line for i, line in enumerate(remaining)
                               if i != header_idx
                               and spans_after[i] == DEFAULT_SECTION]
            if not section_entries:
                del remaining[header_idx]
                content = "".join(remaining)
                # Undo the separator newline we added when the original did
                # not end with one.
                if not original_content.endswith("\n") and content.endswith("\n") \
                        and content.startswith(original_content):
                    content = content[:-1]
    write_if_changed(path, content, mode)


def restore_from_journal(state):
    """Undo exactly the changes this helper owns, preserving newer
    third-party edits made after registration."""
    written = state.get("written", {})
    for key, record in state["files"].items():
        path = Path(record["path"])
        if not record["existed"]:
            current = read_text_if_exists(path)
            if current is None:
                continue
            if written.get(key) is not None and current == written[key]:
                path.unlink()  # we created this file and nothing else touched it
            else:
                restore_default_entry(path, record, written.get(key), 0o644)
            continue
        try:
            mode = path.stat().st_mode & 0o777
        except OSError:
            # The file existed at registration time and is gone now: a later
            # action removed it. That removal is NOT ours to undo —
            # recreating the file would overwrite a third party's decision.
            # The files that survived keep being restored, and the rollback
            # continues instead of aborting on the missing path.
            continue
        restore_default_entry(path, record, written.get(key), mode)


def load_state():
    try:
        return json.loads(state_file().read_text())
    except (OSError, ValueError):
        return None


def save_state(state):
    atomic_write(state_file(), json.dumps(state, indent=2) + "\n", 0o600)


class RegistrationLock:
    """Serializes invocations of this helper. The lock is opened without
    truncation and with no-follow semantics; symlinked locks are refused.
    It cannot lock other applications; interleavings from them are detected
    by re-reading."""

    def __enter__(self):
        validate_state_paths()
        state_dir().mkdir(parents=True, exist_ok=True)
        flags = os.O_RDWR | os.O_CREAT
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        try:
            self.fd = os.open(str(lock_file()), flags, 0o600)
        except OSError as error:
            raise CallbackError(f"Cannot acquire the registration lock safely: {error}")
        fcntl.flock(self.fd, fcntl.LOCK_EX)
        return self

    def __exit__(self, *exc):
        fcntl.flock(self.fd, fcntl.LOCK_UN)
        os.close(self.fd)
        return False


def refresh_journal(state):
    """Refresh the complete journaled state for every participating file
    from disk: full content, existence, [Default Applications] entry, and
    header presence — even when the effective handler id is unchanged, so a
    rollback never restores stale bytes over newer comments or sections. A
    file created by a third party after the snapshot (previously absent) is
    recorded as existing now, so a rollback never deletes it."""
    for key, record in state["files"].items():
        path = Path(record["path"])
        check_no_symlink(path, f"The {key} associations file")
        fresh_text = read_text_if_exists(path)
        existed = path.is_file() and fresh_text is not None
        _, fresh_line = default_scheme_line(fresh_text)
        record["content"] = fresh_text
        record["existed"] = existed
        # A missing or emptied default must clear the journaled entry, not
        # retain the stale default line.
        record["lines"] = [fresh_line] if fresh_line else []
        record["hadDefaultHeader"] = \
            default_section_header_index(split_keepends(fresh_text)) is not None


def reconcile(state):
    """Refresh the full journaled state and settle the previous handler
    right before a mutation. If a third-party change slipped in, journal it
    as the previous state. Raises CallbackError if the state refuses to
    settle."""
    seen = state.get("previousHandler", "")
    for _ in range(3):
        refresh_journal(state)
        current = effective_default_from_files()
        if current == seen:
            save_state(state)
            return current
        seen = current
        state["previousHandler"] = current
        save_state(state)
    raise CallbackError(
        "The handler kept changing during registration; no association was mutated.")


def entry_owned():
    """True when the callback desktop file still has exactly the content
    this helper writes."""
    return read_text_if_exists(entry_path()) == ENTRY_BODY


def cleanup_failed_registration(state):
    """Restore every owned change after a failed registration attempt. A
    callback entry modified by someone else is left in place together with
    the recovery state."""
    try:
        if state.get("files"):
            restore_from_journal(state)
        entry = entry_path()
        if state.get("entryExisted"):
            return
        if entry.is_file() and not entry.is_symlink():
            if entry_owned():
                entry.unlink()
            else:
                return  # keep entry and state for recovery; caller reports it
        state_file().unlink()
    except OSError:
        pass


def register(before_mutate=None):
    with RegistrationLock():
        _register(before_mutate)


def _register(before_mutate=None):
    entry = entry_path()
    check_no_symlink(entry, "The callback desktop entry")
    if entry.is_symlink():
        raise CallbackError(f"The callback desktop entry is a symbolic link: {entry}")
    state = load_state()
    if state:
        if effective_handler() == DESKTOP_ID:
            print(f"Already registered as the {SCHEME} handler.")
            return
        raise CallbackError(
            f"Stale registration state found at {state_file()} but the handler has changed.\n"
            "Inspect it, then remove the state file and re-run register.")
    if state_file().exists():
        raise CallbackError(
            f"An unreadable registration state exists at {state_file()}; refusing to "
            "overwrite it. Inspect and remove the file, then re-run register.")
    if entry.exists():
        raise CallbackError(
            f"An unexpected callback desktop file already exists: {entry}\n"
            "Refusing to overwrite a file this helper did not create.")

    # Journal BEFORE any mutation, including entry creation.
    state = snapshot_files()
    if state["entryExisted"]:
        raise CallbackError(
            f"An unexpected callback desktop file already exists: {entry}\n"
            "Refusing to overwrite a file this helper did not create.")
    state["previousHandler"] = effective_default_from_files()
    save_state(state)

    try:
        atomic_write(entry, ENTRY_BODY, 0o644)

        # Detect intervening changes (including any injected by the test
        # hook) immediately before mutating, and journal newer values.
        reconcile(state)
        if before_mutate is not None:
            before_mutate()
        reconcile(state)

        # Mutate the generic file; also update the desktop-specific file only
        # when it already carries a [Default Applications] entry for the
        # scheme (it would otherwise shadow ours).
        written = {}
        for key in ("generic", "desktop"):
            if key not in state["files"]:
                continue
            record = state["files"][key]
            path = Path(record["path"])
            if key == "desktop" and not default_scheme_line(read_text_if_exists(path))[1]:
                continue
            old_line = record["lines"][-1] if record["lines"] else None
            mode = path.stat().st_mode & 0o777 if record["existed"] else 0o644
            written[key] = write_association(path, old_line, mode)

        # Persist what we wrote so a crash before verification is still
        # recoverable via rollback.
        state = load_state() or state
        state["written"] = written
        save_state(state)

        # Verify through the same resolution the desktop uses.
        handler = effective_handler()
        if handler != DESKTOP_ID:
            entry_was_owned = entry_owned()
            cleanup_failed_registration(state)
            if entry_was_owned:
                raise CallbackError(
                    f"Registration did not take effect (effective handler: {handler or 'none'}). "
                    "All changes made were restored.")
            raise CallbackError(
                f"Registration did not take effect (effective handler: {handler or 'none'}). "
                "Associations were restored; the callback desktop file was modified by "
                "another action and was left in place with the recovery state at "
                f"{state_file()}.")

        subprocess.run(["update-desktop-database", str(data_dir() / "applications")],
                       capture_output=True, timeout=30)
        print(f"Registered {DESKTOP_ID} for {SCHEME}.")
        if state.get("previousHandler"):
            print(f"Previous handler saved for rollback: {state['previousHandler']}")
    except BaseException:
        cleanup_failed_registration(load_state() or state)
        raise


def rollback():
    with RegistrationLock():
        state = load_state()
        if not state:
            print("No registration state found; nothing to roll back.")
            return
        handler = effective_handler()
        if handler != DESKTOP_ID:
            print(f"The handler changed since registration (now: {handler or 'none'}).", file=sys.stderr)
            print("Refusing to overwrite it. Remove the state file to discard it:", file=sys.stderr)
            print(f"  rm {state_file()}", file=sys.stderr)
            raise SystemExit(1)

        for key, record in state["files"].items():
            check_no_symlink(Path(record["path"]), f"The {key} associations file")
        restore_from_journal(state)

        entry = entry_path()
        if entry.is_file() and not entry.is_symlink():
            if entry_owned():
                entry.unlink()
            else:
                # Another action changed the entry after we created it:
                # never delete it; keep the recovery state and report.
                print(f"The callback desktop file {entry} was modified after registration "
                      "and was left untouched.", file=sys.stderr)
                print(f"Recovery state kept at {state_file()}.", file=sys.stderr)
                raise SystemExit(1)
        subprocess.run(["update-desktop-database", str(data_dir() / "applications")],
                       capture_output=True, timeout=30)
        state_file().unlink()
        print(f"Rolled back {SCHEME}; original associations restored.")


def status():
    handler = effective_handler()
    if handler == DESKTOP_ID:
        print(f"This port is the {SCHEME} handler.")
    else:
        print(f"Current {SCHEME} handler: {handler or 'none'}")
    if state_file().exists():
        print(f"Rollback state: {state_file()}")


def main(argv):
    if len(argv) != 2 or argv[1] not in ("register", "rollback", "status"):
        print("usage: factory-callback <register|rollback|status>", file=sys.stderr)
        return 2
    try:
        if argv[1] == "register":
            register()
        elif argv[1] == "rollback":
            rollback()
        else:
            status()
    except CallbackError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
