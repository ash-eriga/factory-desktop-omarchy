# History

A short, factual log of what changed in this repository. Internal
validation reports, machine-specific proofs and personal notes stay out
of the public tree; the methodology behind each change is described in
[validation](validation.md).

## Port update notifications

- Added a separate File-menu release check and an optional daily check
  against the port's public stable releases, including package revisions.
  The native notice links to release notes and a profile-backup/update
  guide; no update is downloaded or installed automatically.
- Private repositories, missing releases and network failures are reported
  as unavailable on manual checks, never as an up-to-date installation.

## Scope cleanup

- Removed the optional Omarchy service plugin and its duplicated runtime,
  packaging and tests. The standalone usage collector and Desktop theme
  integration remain.

## Upgrading from factory-desktop-arch

The new package replaces the old package but does not migrate its profile.

### The handover, in order

The new callback helper cannot undo a registration made by the old helper:

1. Before removing or replacing the old package, run `factory-callback rollback`.
2. Install the new package: `sudo pacman -U <package-file>`.
3. Browser callbacks are available automatically on a clean install. Use
   `factory-callback register` only to override an existing default.

If you explicitly registered a callback with either package, run
`factory-callback rollback` with that package still installed before
uninstalling it.

## First-install browser sign-in

- The packaged desktop entry now advertises `factory-desktop://` support.
  A clean install can return from browser sign-in without a registration
  command. Existing protocol defaults are not overwritten, and the browser
  still controls its external-app permission prompt.
- Regression tests use real `xdg-mime`, `xdg-open` and the desktop database
  in temporary XDG directories. They cover discovery, delivery of a synthetic
  callback URI, existing defaults and removal, without touching real accounts.

## Deleted-computer recovery

- A re-registration that replaces the local computer id now reaches the
  relay while Remote Control is on. The main process broadcasts the id
  transition after any registration attempt (startup, sign-in, the
  explicit registration request), including a transition from a cleared
  or absent id: the backend's deletion clears the stored id and the
  repair attempt can fail after that, so the next successful attempt
  must still announce what the relay may be serving. The renderer's
  recovery compares the id the relay reports it serves with the current
  local id: a mismatch stops and starts the relay once, so the daemon
  re-reads the new id, while a relay that serves no id, or the current
  one, is left untouched. A disabled or disallowed state never starts
  the relay. An id change that arrives while a recovery run is already
  in flight is retained and re-checked once after that run settles, so
  it is not lost to the ids the run had already captured. The relay
  never restarts in a notification loop: the relay-status notifications
  the daemon broadcasts for the recovery's own stop and start (and for
  a failed start's cleanup, and for every later disconnect) are
  distinguished from external id-change requests and never cancel or
  bypass a failure backoff. A disconnect notification that arrives
  while a run is still comparing ids — including one that lands after
  an in-flight status read already captured connected:true — is
  retained as one pending recheck instead of dropped, so a relay that
  drops right after such a read still recovers; the retention is
  bounded, because a successful restart costs the recheck at most one
  extra status read and a failed run leaves the recheck to the armed
  backoff timer. What the status reports right after the
  restart decides the outcome: a relay that is still down, or one that
  is still serving another id, is a failure that retries on the bounded
  1s-to-60s schedule, so a restart whose id never becomes current
  cannot repeat immediately. A retained id change that outlives a
  failed run is served by the armed backoff timer, not by cancelling
  it.
- Explicit Remote Control enable now waits for upstream registration
  verification/repair, including a locally stored ID deleted in the
  backend. Failure before registration completes leaves the preference
  unchanged and never starts the relay.
- Droid Computers offers a registration action when the local computer
  is absent from the loaded account list. Opening the page does not
  force repair of a stale registration. The explicit action refreshes
  the local ID and computer list without enabling remote access.
- The preload forwards the explicit registration option; ordinary
  local-ID reads keep their existing fast path and the shared driver
  still serializes registration attempts.
- The bundled daemon (the same `droid` the Windows build ships in
  `resources/bin`) answers its first relay start from a host identity
  captured when it started. The Desktop starts the daemon before it
  registers the computer, so after a first sign-in or a re-registration
  that first start reported "No computer registered" even though the
  registration was already on disk, and the toast appeared while the
  automatic recovery connected the relay a moment later. Manual enable
  and recovery now retry that exact reply once; any other error, or a
  second identical reply, still surfaces unchanged.

## Packaging

- The recipe no longer builds from a checkout. It declares one source,
  the port's own source archive, with its pinned SHA-256, and the build,
  check and package steps run inside the extracted sources. The same
  recipe and the same archive serve the GitHub clone and the AUR, so
  both workflows ship the same bytes; the release asset does not exist
  yet, and the repository is still private.
- The archive is deterministic: sorted paths, zeroed timestamps, numeric
  root ownership, fixed modes and a gzip stream without a timestamp. The
  same tree produces the same bytes on every machine, so the pinned
  digest is a checksum of the sources and not of one directory.
- The archive is built from a checked-in source inventory
  (`packaging/source-inventory.json`), not from a directory walk and not
  from a git index. The default mode therefore works in a clone, in a
  source ZIP, in a release download and in an AUR checkout alike, and it
  needs no git at all. The maintainer's mode refreshes the inventory from
  the tracked files of the checkout.
- A source file the inventory does not name and a source file the tree
  does not hold are both refused, and so is any path that traverses, that
  is absolute, that is a link or a special file, or that carries a
  payload, a credential or personal material. Every source tree has to
  be a real directory as well, and so has every directory on the way to
  a source file. The recipe files are not part of the archive, because a
  checksum inside the recipe cannot cover the recipe.
- A personal artifact is never a source: a log, a dump, a core file,
  profiler output and generated bytecode are ignored in a working tree,
  and a source may not name one of them. The bytes of the archive are
  decided by the inventory alone: the packing step is given no override
  from the environment, not an option of tar or gzip, not a shell startup
  file and not a function an outer shell exported.
- The maintainer's mode is a transaction. A failing update (a missing or
  a broken makepkg, a source that changed under it, a read-only recipe
  or metadata file) restores the inventory, the recipe and the metadata
  exactly as they were, removes the archive that was still pending and
  leaves the published archive alone, so the recipe and the metadata can
  never disagree about the digest they pin. Every file is restored even
  when one of them cannot be written, and the pending archive is removed
  in any case.
- The archive is built without git: the default mode reads the inventory
  and nothing else, and the maintainer's mode refuses the update when
  there is no checkout to read. The test suite runs with every tool of
  the system except git, with no skipped test.
- `.SRCINFO` is checked in and is written by makepkg itself. The
  maintainer's mode regenerates the pinned checksum and the metadata
  together; the default mode reports a mismatch and never rewrites the
  recipe on someone's machine.
- `pkgrel` moved from 13 to 14 for this packaging change alone. The
  Desktop, Electron and Droid pins are unchanged.

## 0.206.0 support

- The recipe targets Factory Desktop 0.206.0, Electron 42.11.15 and the
  official Linux Droid CLI 0.249.0. The CLI pin was moved forward from
  0.248.0 to 0.249.0, the latest public npm release of
  `@factory/cli-linux-x64`. The 0.206.0 payload declares no CLI version
  requirement, so the pin is not derived from the desktop release; it is
  kept on the current upstream CLI so the port does not deliberately ship
  a release behind. The pin is exact in `versions.json`, the package is
  installed from the public registry with the published integrity hash,
  and the build still fails closed when the binary reports a different
  version than the pin.
- The payload renames its release-specific files (the renderer asset and
  the main-process lifecycle chunk), so every patch anchor was
  re-derived against the new bytes. The anchor self-check still proves
  that each anchor matches exactly once, and the patches still fail
  closed when an anchor is missing, duplicated or ambiguous.
- The brand geometry is unchanged: the official mark carries the same
  path, occurrence count and digest, so the generated icons are identical.

## 0.205.0 support

- The recipe targets Factory Desktop 0.205.0, Electron 42.11.15 and the
  official Linux Droid CLI 0.248.0.
- The upstream Linux branches of the pinned release are used as they are:
  the non-darwin title bar, the inline application menu API, the
  menu-bar hiding and the zoom alignment no longer need a rewrite, so
  the old compatibility patches for those paths were retired.
- The native module `keytar` 7.9.0 is rebuilt against the pinned Linux
  Electron; the Windows prebuilt sidecar is discarded and never shipped.

## Desktop integration

- Glassy coverage across the Settings, Analytics, Wiki, Academy and
  Software Factory navigation, with continuous sidebar content masks.
- The application menu is generated in the renderer and follows the
  Glassy tint when it is active; the duplicate native menu row stays
  hidden.
- The local relay connection recovers after a delayed registration or a
  transient failure, keeps the upstream connect budget, backs retries off
  to at most once per minute and never enables a disabled preference.
- The Omarchy theme follow was extended to the Glassy window tint, and
  the follow control was placed with the theme editor.
- The desktop computer registration runs again after the first sign-in,
  so the local PC is registered with the account without a restart and
  appears as **This Computer** in Settings → Droid Computers. Upstream
  only attempts the registration at startup, before a fresh profile can
  hold an auth token, and never retries; the upstream function itself is
  reused, with the credentials it already read passed to it, and the
  remote-access preference, the relay and the organization policy are
  left alone. A sign-in that completes while an earlier registration is
  still running gets its own attempt with its own credentials, so
  switching accounts during a registration never leaves the new account
  unregistered.

## Usage accounting

- The local accounting was rebuilt around an observed-growth ledger: the
  baseline is the per-counter high-water envelope, the day rows are
  calendar days, the per-model amounts live outside the day buckets so
  the day-chart retention cannot erase them, and the record carries the
  local day its counters belong to.
- Sessions are deduplicated by id and only each session's own token
  usage counts, so child sessions cannot double count.
- The accounting stays device-local. The ledger is keyed by a hashed
  session key, and the sessions seen in more than one local profile keep
  one coherent dominating snapshot. The records of two devices are never
  merged here: the component that would do that is a separate,
  user-local panel and is not part of this repository.
- The account session inventory was added and is explicitly marked
  incomplete; account-global history is not available for personal plans
  and is never fabricated.

## Callback registration

- The registration journals the original associations before any
  mutation, updates desktop-specific override files that already decide
  the scheme, detects third-party changes made during the registration,
  restores all owned changes when verification fails, and refuses
  symbolic links or unexpected pre-existing callback files.
- A file that another action removed after the registration stays
  removed: the rollback restores what survived and never recreates it.

## Packaging

- The recipe installs the port's own `LICENSE` next to the `NOTICE`, and
  declares `MIT` plus `LicenseRef-Proprietary` for the mixed payload.

## Rename (2026-10-24)

- The port was renamed from `factory-desktop-arch` to **Factory Droid
  Desktop**, with the technical slug `factory-droid-desktop` for the
  package, the command and the installed paths. The Arch package, the
  command `/usr/bin/factory-droid-desktop`, the bundle under
  `/opt/factory-droid-desktop`, the desktop entry
  `factory-droid-desktop.desktop`, the generated icons, the license and
  documentation directories, and the assembled bundle under `dist/` all
  follow the new name.
- The recipe declares the previous package name as `conflicts`, `replaces`
  and `provides`: both packages own `/usr/bin/factory-usage` and
  `/usr/bin/factory-callback`, so the handover must leave a single owner.
  No state was migrated: the old data directories stay where they are, and
  the CLI's own profile in `~/.factory/` is untouched. The opt-in
  `factory-desktop://` registration is user-local and is not migrated
  either: the new helper reads only its own journal directory, so the old
  registration has to be rolled back with the old helper *before* the old
  package is replaced. The upgrade guide documents that order.
- The shipped application now carries the port's own visible name. The
  official manifest's `productName` is rewritten (that field only, and
  after the pristine snapshot was taken), and the main process sets the
  same name before the first window exists. The upstream product name, the
  `factory-desktop://` scheme, the vendor's mark and the internal Electron
  binary keep their own names: they are contracts of the payload, not of
  the port.
- The independent commands `factory-usage` and `factory-callback` and the
  vendor's CLI storage were left alone.
- The nominal identity of the port has its own regression test: the
  package name, the desktop entry, the installed paths, the launcher data
  directory, the collector and callback paths, and the visible application
  name are asserted together, and the old slug may not survive in the
  shipped tree.

## Public preparation (2026-10-24)

- The repository was separated into the port and its optional Omarchy
  service. The personal panel, its staged patch and its private
  validation artifacts stay local and are not published.
- The Factory mark is no longer committed. The icons are generated during
  the build from the checksum-pinned official renderer, and the geometry
  is accepted only when its digest and occurrence count match
  `versions.json`.
- The test suite no longer depends on a private vendor checkout: the
  build copies the untouched official files the tests need into an
  ignored snapshot directory before patching.
- The documentation was reorganised into `docs/`, the README was
  rewritten for a public audience, and a minimal CI was added for the
  offline suite.
