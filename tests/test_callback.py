"""Fixture-based tests for the opt-in factory-desktop:// callback helper.

Every test runs against an isolated XDG environment and a fake xdg-mime that
mimics xdg-utils resolution (desktop-specific file first, then the generic
mimeapps.list, then the legacy file; writes go to the generic file, which is
what real xdg-mime does for non-KDE/GNOME desktops). No real user settings,
desktop environment, or registration is touched.
"""

import importlib.util
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCHEME = "x-scheme-handler/factory-desktop"
OUR_ID = "factory-droid-desktop-callback.desktop"

FAKE_XDG_MIME = r"""#!/bin/sh
CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}"
DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
TYPE="$3"
DESKTOP=$(printf '%s' "${XDG_CURRENT_DESKTOP-}" | cut -d: -f1 | tr 'A-Z' 'a-z')
if [ "$1" = query ]; then
  for f in "$CONFIG/$DESKTOP-mimeapps.list" "$CONFIG/mimeapps.list" "$DATA/applications/mimeapps.list"; do
    if [ -f "$f" ]; then
      # Real xdg-mime resolves the default from [Default Applications]
      # only, and tolerates CRLF line endings.
      RESULT=$(awk -v t="$TYPE" '
        { sub(/\r$/, "") }
        /^[[]/ { in_default = ($0 == "[Default Applications]") }
        in_default && index($0, t "=") == 1 {
          sub("^[^=]*=", "", $0); split($0, a, ";"); print a[1]; exit
        }' "$f")
      [ -n "$RESULT" ] && { echo "$RESULT"; exit 0; }
    fi
  done
  exit 0
fi
APP="$2"
FILE="$CONFIG/mimeapps.list"
mkdir -p "$(dirname "$FILE")"; touch "$FILE"
if grep -q "^$TYPE=" "$FILE"; then
  sed -i "s|^$TYPE=.*|$TYPE=$APP;|" "$FILE"
else
  printf '%s=%s;\n' "$TYPE" "$APP" >> "$FILE"
fi
"""


def load_helper():
    spec = importlib.util.spec_from_file_location(
        "factory_callback", ROOT / "runtime" / "factory-callback.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class CallbackTestBase(unittest.TestCase):
    def setUp(self):
        self.helper = load_helper()
        self.tmp = Path(tempfile.mkdtemp(prefix="factory-cb-"))
        self.fake_bin = self.tmp / "fakebin"
        self.fake_bin.mkdir()
        xdg = self.fake_bin / "xdg-mime"
        xdg.write_text(FAKE_XDG_MIME)
        xdg.chmod(0o755)
        self.old_env = {k: os.environ.get(k) for k in
                        ("XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME",
                         "XDG_CURRENT_DESKTOP", "PATH", "HOME")}
        self.config = self.tmp / "config"
        self.data = self.tmp / "data"
        self.state = self.tmp / "state"
        os.environ.update({
            "HOME": str(self.tmp),
            "XDG_CONFIG_HOME": str(self.config),
            "XDG_DATA_HOME": str(self.data),
            "XDG_STATE_HOME": str(self.state),
            "XDG_CURRENT_DESKTOP": "",
            "PATH": f"{self.fake_bin}:{os.environ.get('PATH', '')}",
        })
        self.generic = self.config / "mimeapps.list"

    def tearDown(self):
        for key, value in self.old_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        shutil.rmtree(self.tmp, ignore_errors=True)

    # -- helpers ---------------------------------------------------------

    def write_generic(self, text):
        self.generic.parent.mkdir(parents=True, exist_ok=True)
        self.generic.write_text(text)

    def read_generic(self):
        return self.generic.read_text() if self.generic.exists() else None

    def set_handler_third_party(self, desktop_id):
        """Simulate another app claiming the scheme via xdg-mime."""
        subprocess.run(["xdg-mime", "default", desktop_id, SCHEME], check=True)

    def register(self, **kwargs):
        self.helper.register(**kwargs)

    def rollback(self):
        self.helper.rollback()


class RegisterRollbackTest(CallbackTestBase):
    def test_fallback_list_survives_register_and_rollback_exactly(self):
        original = ("[Default Applications]\n"
                    f"{SCHEME}=orig-a.desktop;orig-b.desktop;\n"
                    "x-scheme-handler/https=firefox.desktop;\n")
        self.write_generic(original)
        self.register()
        content = self.read_generic()
        self.assertIn(f"{SCHEME}={OUR_ID};orig-a.desktop;orig-b.desktop;", content)
        self.assertIn("x-scheme-handler/https=firefox.desktop;", content)
        self.rollback()
        # Byte-for-byte restoration, including the fallback list.
        self.assertEqual(self.read_generic(), original)

    def test_no_override_invented_when_previous_was_inherited(self):
        original = "[Default Applications]\ntext/plain=nano.desktop;\n"
        self.write_generic(original)
        self.register()
        self.assertIn(f"{SCHEME}={OUR_ID};", self.read_generic())
        self.rollback()
        # No scheme line may remain, and no override file invented.
        self.assertEqual(self.read_generic(), original)
        self.assertFalse((self.data / "applications" / OUR_ID).exists())
        self.assertFalse(self.helper.state_file().exists())

    def test_unrelated_files_untouched(self):
        unrelated = self.data / "applications" / "user-notes.txt"
        unrelated.parent.mkdir(parents=True, exist_ok=True)
        unrelated.write_text("keep me\n")
        self.write_generic("[Default Applications]\ntext/plain=nano.desktop;\n")
        self.register()
        self.rollback()
        self.assertTrue(unrelated.exists())
        self.assertEqual(unrelated.read_text(), "keep me\n")


class RegisterRefusalsTest(CallbackTestBase):
    def test_refuses_unexpected_existing_entry(self):
        entry = self.data / "applications" / OUR_ID
        entry.parent.mkdir(parents=True, exist_ok=True)
        entry.write_text("[Desktop Entry]\nName=Someone else\n")
        self.write_generic("[Default Applications]\n")
        with self.assertRaises(self.helper.CallbackError):
            self.register()
        # Nothing was mutated.
        self.assertEqual(entry.read_text(), "[Desktop Entry]\nName=Someone else\n")
        self.assertNotIn(SCHEME, self.read_generic())
        self.assertFalse(self.helper.state_file().exists())

    def test_refuses_symlinked_associations_file(self):
        target = self.tmp / "real-mimeapps.list"
        target.write_text("[Default Applications]\n")
        self.generic.parent.mkdir(parents=True, exist_ok=True)
        self.generic.symlink_to(target)
        with self.assertRaises(self.helper.CallbackError):
            self.register()
        self.assertEqual(target.read_text(), "[Default Applications]\n")
        self.assertFalse((self.data / "applications" / OUR_ID).exists())


class InterleavingTest(CallbackTestBase):
    def test_newer_third_party_change_is_journaled_not_clobbered(self):
        self.write_generic(f"[Default Applications]\n{SCHEME}=orig-a.desktop;\n")
        def concurrent_change():
            # Another app claims the scheme while we prepare the entry.
            self.set_handler_third_party("other.desktop")
        self.register(before_mutate=concurrent_change)
        content = self.read_generic()
        # Ours wins the default, the newer change is preserved as fallback.
        self.assertIn(f"{SCHEME}={OUR_ID};other.desktop;", content)
        state = json.loads(self.helper.state_file().read_text())
        self.assertEqual(state["previousHandler"], "other.desktop")
        self.rollback()
        # Rollback restores the newer third-party choice, not the original.
        self.assertIn(f"{SCHEME}=other.desktop;", self.read_generic())

    def test_repeatedly_changing_handler_refuses_without_mutation(self):
        self.write_generic(f"[Default Applications]\n{SCHEME}=orig-a.desktop;\n")
        calls = {"n": 0}
        real_default = self.helper.effective_default_from_files
        def churning_default():
            # A resolver that answers a different value every read.
            calls["n"] += 1
            return f"churn-{calls['n']}.desktop"
        self.helper.effective_default_from_files = churning_default
        try:
            with self.assertRaises(self.helper.CallbackError):
                self.register()
        finally:
            self.helper.effective_default_from_files = real_default
        # No association was mutated and no debris was left behind.
        content = self.read_generic()
        self.assertEqual(content, f"[Default Applications]\n{SCHEME}=orig-a.desktop;\n")
        self.assertFalse((self.data / "applications" / OUR_ID).exists())
        self.assertFalse(self.helper.state_file().exists())


class DesktopSpecificTest(CallbackTestBase):
    def test_desktop_specific_override_is_updated_and_restored(self):
        os.environ["XDG_CURRENT_DESKTOP"] = "Hyprland"
        hypr = self.config / "hyprland-mimeapps.list"
        original = (f"[Default Applications]\n{SCHEME}=old.desktop;\n"
                    "x-scheme-handler/https=firefox.desktop;\n")
        hypr.parent.mkdir(parents=True, exist_ok=True)
        hypr.write_text(original)
        # No scheme line in the generic file: without the desktop-specific
        # entry, registering only the generic file would be shadowed.
        self.write_generic("[Default Applications]\ntext/plain=nano.desktop;\n")
        self.register()
        # Both files carry ours; effective handler resolves to us.
        self.assertIn(f"{SCHEME}={OUR_ID};old.desktop;", hypr.read_text())
        self.assertIn(f"{SCHEME}={OUR_ID};", self.read_generic())
        self.assertEqual(self.helper.effective_handler(), OUR_ID)
        self.rollback()
        # Byte-for-byte restoration of both files.
        self.assertEqual(hypr.read_text(), original)
        self.assertEqual(self.read_generic(), "[Default Applications]\ntext/plain=nano.desktop;\n")

    def test_desktop_file_without_scheme_entry_is_not_shadowing(self):
        os.environ["XDG_CURRENT_DESKTOP"] = "Hyprland"
        hypr = self.config / "hyprland-mimeapps.list"
        hypr.parent.mkdir(parents=True, exist_ok=True)
        hypr.write_text("[Default Applications]\ntext/plain=nano.desktop;\n")
        self.register()
        # Only the generic file is written; the desktop file is untouched.
        self.assertNotIn(SCHEME, hypr.read_text())
        self.assertIn(f"{SCHEME}={OUR_ID};", self.read_generic())
        self.assertEqual(self.helper.effective_handler(), OUR_ID)


class CreatedFileTest(CallbackTestBase):
    def test_created_file_removed_on_rollback_when_unmodified(self):
        self.assertFalse(self.generic.exists())
        self.register()
        self.assertTrue(self.generic.exists())
        self.rollback()
        self.assertFalse(self.generic.exists())

    def test_created_file_kept_when_third_party_added_content(self):
        self.register()
        with self.generic.open("a") as handle:
            handle.write("[Added Associations]\nx-scheme-handler/https=firefox.desktop;\n")
        self.rollback()
        self.assertTrue(self.generic.exists())
        content = self.generic.read_text()
        self.assertNotIn(OUR_ID, content)
        self.assertIn("x-scheme-handler/https=firefox.desktop;", content)


class VerificationFailureTest(CallbackTestBase):
    def test_failed_verification_restores_everything(self):
        # A stubborn resolver (simulating any desktop whose resolution we
        # cannot influence): queries always answer with the pre-existing
        # handler no matter what is written.
        stubborn = self.fake_bin / "xdg-mime"
        stubborn.write_text('#!/bin/sh\n'
                            'if [ "$1" = query ]; then echo old-handler.desktop; exit 0; fi\n'
                            'exit 0\n')
        stubborn.chmod(0o755)
        self.write_generic(f"[Default Applications]\n{SCHEME}=old-handler.desktop;\n")
        with self.assertRaises(self.helper.CallbackError) as ctx:
            self.register()
        self.assertIn("restored", str(ctx.exception))
        # Exact restoration: original line back, entry and state removed.
        self.assertEqual(self.read_generic(),
                         f"[Default Applications]\n{SCHEME}=old-handler.desktop;\n")
        self.assertFalse((self.data / "applications" / OUR_ID).exists())
        self.assertFalse(self.helper.state_file().exists())


class RollbackGuardsTest(CallbackTestBase):
    def test_rollback_refuses_concurrent_change(self):
        self.register()
        self.set_handler_third_party("someone-else.desktop")
        with self.assertRaises(SystemExit):
            self.rollback()
        # The third-party choice and our state file survive untouched.
        self.assertIn("someone-else.desktop", self.read_generic())
        self.assertTrue(self.helper.state_file().exists())

    def test_rollback_without_state_is_a_noop(self):
        self.rollback()  # must not raise
        self.assertFalse((self.data / "applications" / OUR_ID).exists())


class CliWiringTest(CallbackTestBase):
    def test_status_and_full_cycle_through_the_shell_wrapper(self):
        script = ROOT / "runtime" / "factory-callback.sh"
        env = dict(os.environ)
        result = subprocess.run(["/bin/sh", str(script), "status"],
                                capture_output=True, text=True, env=env, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("none", result.stdout)
        result = subprocess.run(["/bin/sh", str(script), "register"],
                                capture_output=True, text=True, env=env, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Registered", result.stdout)
        result = subprocess.run(["/bin/sh", str(script), "rollback"],
                                capture_output=True, text=True, env=env, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("restored", result.stdout)


class SectionAwareTest(CallbackTestBase):
    """Regression tests: only [Default Applications] is read and mutated;
    Added/Removed Associations and exact bytes survive register+rollback."""

    def test_all_three_sections_byte_preserved(self):
        original = ("# my associations\n"
                    "[Default Applications]\n"
                    f"{SCHEME}=A.desktop;\n"
                    "\n"
                    "[Added Associations]\n"
                    f"{SCHEME}=B.desktop;\n"
                    "\n"
                    "[Removed Associations]\n"
                    f" {SCHEME}=C.desktop;\n"
                    "text/plain=nano.desktop;")
        self.write_generic(original)
        self.register()
        written = self.read_generic()
        # Only the Default Applications entry changed.
        self.assertIn(f"{SCHEME}={OUR_ID};A.desktop;", written)
        self.assertIn(f"{SCHEME}=B.desktop;", written.split("[Added Associations]")[1])
        self.assertIn(f" {SCHEME}=C.desktop;", written.split("[Removed Associations]")[1])
        self.assertIn("text/plain=nano.desktop;", written)
        self.rollback()
        # Byte-for-byte, including comments, spaces and no terminal newline.
        self.assertEqual(self.read_generic(), original)

    def test_added_section_never_treated_as_default(self):
        original = ("[Added Associations]\n"
                    f"{SCHEME}=B.desktop;\n")
        self.write_generic(original)
        self.register()
        state = json.loads(self.helper.state_file().read_text())
        # The Added entry must not be journaled as the previous default.
        self.assertEqual(state["previousHandler"], "")
        content = self.read_generic()
        self.assertIn("[Default Applications]", content)
        self.assertIn(f"{SCHEME}={OUR_ID};", content)
        self.assertIn(f"{SCHEME}=B.desktop;", content.split("[Added Associations]")[1])
        self.rollback()
        self.assertEqual(self.read_generic(), original)

    def test_parent_reproduction_fixed(self):
        # The reviewer's exact scenario: register+rollback used to rewrite
        # the Added entry and lose the original Default value.
        before = ("[Default Applications]\n"
                  f"{SCHEME}=A.desktop;\n"
                  "[Added Associations]\n"
                  f"{SCHEME}=B.desktop;\n")
        self.write_generic(before)
        state = self.helper.snapshot_files()
        path = Path(state["files"]["generic"]["path"])
        state["written"] = {
            "generic": self.helper.write_association(
                path, state["files"]["generic"]["lines"][-1], 0o644),
        }
        self.helper.restore_from_journal(state)
        self.assertEqual(path.read_text(), before)

    def test_unrelated_later_edit_kept_with_owned_entry_merged(self):
        before = ("[Default Applications]\n"
                  f"{SCHEME}=A.desktop;\n"
                  "[Added Associations]\n"
                  f"{SCHEME}=B.desktop;\n")
        self.write_generic(before)
        self.register()
        written = self.read_generic()
        # A third-party edit lands after our registration.
        with self.generic.open("a") as handle:
            handle.write("# third-party comment\n")
        self.rollback()
        content = self.read_generic()
        # Owned default entry restored exactly; later edits survive.
        self.assertIn(f"{SCHEME}=A.desktop;", content.split("[Default Applications]")[1]
                      .split("[Added Associations]")[0])
        self.assertIn(f"{SCHEME}=B.desktop;", content.split("[Added Associations]")[1])
        self.assertIn("# third-party comment\n", content)


class PathGuardTest(CallbackTestBase):
    def test_symlinked_lock_refused_and_target_intact(self):
        target = self.tmp / "valuable-fixture-data"
        target.write_text("valuable-fixture-data")
        state_dir_path = self.helper.state_dir()
        state_dir_path.mkdir(parents=True)
        (state_dir_path / "callback.lock").symlink_to(target)
        with self.assertRaises(self.helper.CallbackError):
            with self.helper.RegistrationLock():
                pass
        self.assertEqual(target.read_text(), "valuable-fixture-data")

    def test_symlinked_state_dir_refused(self):
        real_dir = self.tmp / "real-state"
        real_dir.mkdir()
        secret = real_dir / "payload.txt"
        secret.write_text("precious")
        # Point XDG_STATE_HOME at a directory whose factory-droid-desktop
        # child is a symlink to a directory holding data.
        (self.tmp / "linked-state").mkdir()
        os.environ["XDG_STATE_HOME"] = str(self.tmp / "linked-state")
        (self.tmp / "linked-state" / "factory-droid-desktop").symlink_to(real_dir)
        self.write_generic("[Default Applications]\n")
        with self.assertRaises(self.helper.CallbackError):
            self.register()
        self.assertEqual(secret.read_text(), "precious")
        self.assertFalse((real_dir / "callback.lock").exists())

    def test_symlinked_state_json_refused(self):
        target = self.tmp / "state-json-target.json"
        target.write_text('{"injected": true}\n')
        state_dir_path = self.helper.state_dir()
        state_dir_path.mkdir(parents=True)
        (state_dir_path / "callback.json").symlink_to(target)
        self.write_generic("[Default Applications]\n")
        with self.assertRaises(self.helper.CallbackError):
            self.register()
        self.assertEqual(target.read_text(), '{"injected": true}\n')

    def test_symlinked_managed_parent_refused(self):
        # The applications directory that would hold the callback entry is a
        # symlink to a fixture directory.
        target = self.tmp / "real-applications"
        target.mkdir()
        keeper = target / "keep.txt"
        keeper.write_text("keep")
        applications = self.data / "applications"
        applications.parent.mkdir(parents=True, exist_ok=True)
        applications.symlink_to(target)
        self.write_generic("[Default Applications]\n")
        with self.assertRaises(self.helper.CallbackError):
            self.register()
        self.assertEqual(keeper.read_text(), "keep")
        self.assertFalse((target / OUR_ID).exists())

    def test_invalid_desktop_name_cannot_traverse(self):
        os.environ["XDG_CURRENT_DESKTOP"] = "../evil"
        self.register()
        # No file was written outside the config root.
        self.assertFalse((self.tmp / "evil-mimeapps.list").exists())
        self.assertFalse((self.tmp / "config" / "evil-mimeapps.list").exists())
        self.assertIn(f"{SCHEME}={OUR_ID};", self.read_generic())
        self.rollback()

    def test_unreadable_state_json_refused(self):
        state_dir_path = self.helper.state_dir()
        state_dir_path.mkdir(parents=True)
        (state_dir_path / "callback.json").write_text("not json{")
        self.write_generic("[Default Applications]\n")
        with self.assertRaises(self.helper.CallbackError):
            self.register()
        self.assertEqual((state_dir_path / "callback.json").read_text(), "not json{")


class EntryOwnershipTest(CallbackTestBase):
    def test_rollback_keeps_modified_entry_and_state(self):
        # A pre-existing generic file so the restored associations file stays
        # observable after rollback.
        self.write_generic("[Default Applications]\ntext/plain=nano.desktop;\n")
        self.register()
        entry = self.data / "applications" / OUR_ID
        entry.write_text("[Desktop Entry]\nName=Changed by someone else\n")
        with self.assertRaises(SystemExit):
            self.rollback()
        # The modified entry and the recovery state survive.
        self.assertEqual(entry.read_text(), "[Desktop Entry]\nName=Changed by someone else\n")
        self.assertTrue(self.helper.state_file().exists())
        # The owned association restore still happened.
        self.assertNotIn(f"{SCHEME}={OUR_ID};", self.read_generic())

    def test_rollback_after_later_clean_cycle_still_works(self):
        self.register()
        self.rollback()
        self.assertFalse((self.data / "applications" / OUR_ID).exists())
        self.assertFalse(self.helper.state_file().exists())


class BytePreservationTest(CallbackTestBase):
    """Original bytes — CRLF/CR/LF terminators, comments, spacing, and a
    missing final newline — must survive register+rollback exactly."""

    def test_crlf_bytes_preserved(self):
        raw = (b"[Default Applications]\r\n"
               b"x-scheme-handler/factory-desktop=A.desktop;\r\n")
        p = self.generic
        self.generic.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(raw)
        s = self.helper.snapshot_files()
        s["written"] = {
            "generic": self.helper.write_association(
                p, s["files"]["generic"]["lines"][-1], 0o644),
        }
        self.helper.restore_from_journal(s)
        self.assertEqual(p.read_bytes(), raw)

    def test_crlf_comment_spacing_no_final_newline(self):
        raw = (b"# my handlers\r\n"
               b"[Default Applications]\r\n"
               b"text/plain=nano.desktop;\r\n"
               b"x-scheme-handler/factory-desktop=A.desktop;B.desktop;\r\n"
               b"# trailing comment without newline")
        p = self.generic
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(raw)
        self.register()
        written = p.read_bytes()
        # Only the default entry changed; CRLF endings and the unterminated
        # comment survive.
        self.assertIn(b"factory-droid-desktop-callback.desktop;A.desktop;B.desktop;\r\n", written)
        self.assertTrue(written.endswith(b"without newline"))
        self.rollback()
        self.assertEqual(p.read_bytes(), raw)

    def test_lone_cr_terminator_preserved(self):
        raw = (b"[Default Applications]\r"
               b"x-scheme-handler/factory-desktop=A.desktop;\r")
        p = self.generic
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(raw)
        s = self.helper.snapshot_files()
        s["written"] = {
            "generic": self.helper.write_association(
                p, s["files"]["generic"]["lines"][-1], 0o644),
        }
        self.helper.restore_from_journal(s)
        self.assertEqual(p.read_bytes(), raw)

    def test_mixed_case_default_header_is_another_section(self):
        # Section names are case-sensitive (glib key-file semantics): a
        # mixed-case heading is not the default section, so its entry is
        # left untouched and a canonical section is appended instead.
        original = "[DEFAULT APPLICATIONS]\n" f"{SCHEME}=A.desktop;\n"
        self.write_generic(original)
        self.register()
        content = self.read_generic()
        self.assertIn("[DEFAULT APPLICATIONS]\n" f"{SCHEME}=A.desktop;\n", content)
        self.assertIn("[Default Applications]\n" f"{SCHEME}={OUR_ID};\n", content)
        self.assertEqual(self.helper.effective_handler(), OUR_ID)
        self.rollback()
        self.assertEqual(self.read_generic(), original)


class AddedBlockRemovalTest(CallbackTestBase):
    def test_removing_owned_empty_section_keeps_later_sections(self):
        # The reviewer's reproduction: our appended [Default Applications]
        # header sits BEFORE a section a third party added later; removal
        # of the owned block must not truncate what follows.
        p = self.generic
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text("[Added Associations]\ntext/plain=A.desktop;\n")
        s = self.helper.snapshot_files()
        s["written"] = {"generic": self.helper.write_association(p, None, 0o644)}
        with p.open("a") as f:
            f.write("[Removed Associations]\nimage/png=B.desktop;\n")
        self.helper.restore_from_journal(s)
        content = p.read_text()
        self.assertIn("[Removed Associations]", content)
        self.assertIn("image/png=B.desktop;", content)
        self.assertIn("text/plain=A.desktop;", content)
        self.assertNotIn(OUR_ID, content)

    def test_owned_block_removed_exactly_when_header_was_last(self):
        original = "[Added Associations]\ntext/plain=A.desktop;\n"
        p = self.generic
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(original)
        s = self.helper.snapshot_files()
        s["written"] = {"generic": self.helper.write_association(p, None, 0o644)}
        self.helper.restore_from_journal(s)
        self.assertEqual(p.read_bytes(), original.encode())


class ReconcileRefreshTest(CallbackTestBase):
    def test_reconcile_refreshes_content_when_handler_unchanged(self):
        # The reviewer's reproduction: a newer comment lands between
        # snapshot and reconcile; rollback must keep it.
        p = self.generic
        p.parent.mkdir(parents=True, exist_ok=True)
        base = "[Default Applications]\n" f"{SCHEME}=A.desktop;\n"
        p.write_text(base)
        s = self.helper.snapshot_files()
        s["previousHandler"] = self.helper.effective_default_from_files()
        p.write_text(p.read_text() + "# newer user comment\n")
        self.helper.reconcile(s)
        s["written"] = {
            "generic": self.helper.write_association(
                p, s["files"]["generic"]["lines"][-1], 0o644),
        }
        self.helper.restore_from_journal(s)
        content = p.read_text()
        self.assertIn("# newer user comment", content)
        self.assertIn(f"{SCHEME}=A.desktop;", content)
        self.assertNotIn(OUR_ID, content)

    def test_reconcile_journals_default_removal(self):
        p = self.generic
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(f"[Default Applications]\n{SCHEME}=A.desktop;\n")
        s = self.helper.snapshot_files()
        s["previousHandler"] = self.helper.effective_default_from_files()
        # A third party removes the default entirely.
        p.write_text("[Default Applications]\ntext/plain=nano.desktop;\n")
        self.helper.reconcile(s)
        record = s["files"]["generic"]
        self.assertEqual(record["lines"], [])
        self.assertEqual(s["previousHandler"], "")
        s["written"] = {"generic": self.helper.write_association(p, None, 0o644)}
        self.helper.restore_from_journal(s)
        # Exact restore of the newer content; no override invented.
        self.assertEqual(p.read_text(), "[Default Applications]\ntext/plain=nano.desktop;\n")

    def test_concurrent_file_creation_is_never_deleted(self):
        # The generic MIME file does not exist at snapshot time; another
        # action creates it (with unrelated content) during entry creation.
        s = self.helper.snapshot_files()
        self.assertFalse(s["files"]["generic"]["existed"])
        third_party = ("[Default Applications]\n"
                       "text/plain=nano.desktop;\n"
                       "# created by another tool\n")
        self.write_generic(third_party)
        self.helper.reconcile(s)
        self.assertTrue(s["files"]["generic"]["existed"])
        s["written"] = {
            # No [Default Applications] entry exists in the third-party
            # file: there is no old default line to preserve.
            "generic": self.helper.write_association(
                self.generic, (s["files"]["generic"]["lines"] or [None])[-1], 0o644),
        }
        self.helper.restore_from_journal(s)
        # The third-party file survives byte-for-byte, without our line.
        content = self.generic.read_text()
        self.assertEqual(content, third_party)
        self.assertNotIn(OUR_ID, content)


class RemovedAssociationsFileTest(CallbackTestBase):
    """A file that existed at registration time may be removed by another
    tool afterwards. The rollback must respect that removal (never
    recreate the file) and still restore the changes this helper still
    owns in the files that survived."""

    def register_with_desktop_file(self):
        os.environ["XDG_CURRENT_DESKTOP"] = "Hyprland"
        hypr = self.config / "hyprland-mimeapps.list"
        original = f"[Default Applications]\n{SCHEME}=old.desktop;\n"
        hypr.parent.mkdir(parents=True, exist_ok=True)
        hypr.write_text(original)
        self.write_generic(original)
        self.register()
        self.assertEqual(self.helper.effective_handler(), OUR_ID)
        return hypr, original

    def test_rollback_survives_a_removed_associations_file(self):
        hypr, original = self.register_with_desktop_file()
        # Another tool removes the generic file after our registration.
        self.generic.unlink()
        # The rollback must complete instead of aborting on the missing file.
        self.rollback()
        # The later removal is respected: the file is NOT recreated.
        self.assertFalse(self.generic.exists())
        # The surviving file is restored byte-for-byte.
        self.assertEqual(hypr.read_text(), original)
        self.assertNotIn(OUR_ID, hypr.read_text())
        # Cleanup completes: our desktop entry and the journal are gone.
        self.assertFalse((self.data / "applications" / OUR_ID).exists())
        self.assertFalse(self.helper.state_file().exists())

    def test_rollback_keeps_third_party_edits_in_the_surviving_file(self):
        hypr, original = self.register_with_desktop_file()
        self.generic.unlink()
        # A third party edits the surviving file after our registration.
        with hypr.open("a") as handle:
            handle.write("# third-party comment\n")
        self.rollback()
        content = hypr.read_text()
        # Our owned entry is gone, the third-party edit survives, and the
        # original default is back.
        self.assertNotIn(OUR_ID, content)
        self.assertIn("# third-party comment\n", content)
        self.assertIn(f"{SCHEME}=old.desktop;", content)

    def test_rollback_of_a_file_we_created_still_removes_it(self):
        # The complementary case: the generic file did not exist before the
        # registration, so the rollback removes the file we created.
        self.assertFalse(self.generic.exists())
        self.register()
        self.assertTrue(self.generic.exists())
        self.rollback()
        self.assertFalse(self.generic.exists())
        self.assertFalse(self.helper.state_file().exists())


if __name__ == "__main__":
    unittest.main()
