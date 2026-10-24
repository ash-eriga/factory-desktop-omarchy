# History

A short, factual log of what changed in this repository. Internal
validation reports, machine-specific proofs and personal notes stay out
of the public tree; the methodology behind each change is described in
[validation](validation.md).

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

- The packaged plugin runner keeps its execute permission, and every
  other plugin file stays 0644; the recipe expresses that as a single
  function, so the packaging test runs the recipe's own logic.
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
  package is replaced. The README documents that order.
- The shipped application now carries the port's own visible name. The
  official manifest's `productName` is rewritten (that field only, and
  after the pristine snapshot was taken), and the main process sets the
  same name before the first window exists. The upstream product name, the
  `factory-desktop://` scheme, the vendor's mark and the internal Electron
  binary keep their own names: they are contracts of the payload, not of
  the port.
- The independent commands `factory-usage` and `factory-callback`, the
  Omarchy plugin's own id and the vendor's CLI storage were left alone.
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
