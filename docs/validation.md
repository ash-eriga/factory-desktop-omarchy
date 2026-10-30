# Validation

What the port's checks prove, what they do not, and how to run each
layer. The layers are deliberately separated: the automated suite must
stay runnable without the vendor payload, without an account and without
a GUI session.

## Layer 1 — the offline suite (`npm test`)

Runs on Node and Python, with no network, no credentials, no real
account, no installed package and no GUI session.

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm test
```

`npm test` runs `node --test tests/*.test.mjs`; the Python suite is
driven from `tests/python.test.mjs`, so one command covers both
languages. The suite is also what `makepkg` runs in its `check()` phase.

What it covers:

- the patch recipes and their exact anchors, including the negative
  controls (a duplicated or missing anchor must fail),
- the launcher: isolated home, environment scrubbing, quoting of paths
  that contain spaces, private profile directories without changing the
  caller's project-file permissions,
- the auth helper and the collector, including the field continuity of
  the account inventory, the real-zero and missing-value cases, and the
  credential handling rules,
- the local accounting: per-model growth, session dedup, day buckets and
  credit fractions — all of it device-local; this repository does not
  merge the records of two devices,
- the usage record's private file permissions, including replacement of
  an older world-readable record,
- the callback registration and its rollback, including third-party
  changes and files removed by another action,
- the theme bridge: trusted frames only, validated payloads, no writes
  outside the whitelisted state files,
- the menus, the relay recovery and the billing polling gate,
- the desktop computer registration: the driver on its own, upstream's
  own registration function executed against synthetic dependencies, the
  patched sign-in and local-id paths executed from the patched bytes, and
  a second sign-in that completes while an earlier registration is still
  running, with the untouched upstream bytes as the negative control,
- the recipe fingerprint, the executable policy and the package modes,
- the source archive: that it is byte-identical across paths, timestamps
  and umasks, that it carries the port's sources and no payload, that an
  undeclared file, a missing source, a tampered checksum and a forbidden
  path are all refused, that the default mode runs in a source tree
  without a git index, that the recipe pins the digest of the archive,
  and that an AUR checkout with only the recipe, its metadata and the
  license unpacks the same sources as the clone,
- the guards of the source archive: that a listed or a tracked log, dump,
  core file, profiler output or bytecode is refused, that an artifact a
  tree merely holds is ignored instead, that a source tree that is a
  link, or a link in the middle of a source path, is refused, that the
  archive does not change when the environment asks for something else
  (`TAR_OPTIONS`, `GZIP`, a shell startup file, an exported shell
  function), and that a maintainer's update that fails leaves the
  inventory, the recipe and the metadata exactly as they were and
  publishes no archive,
- the source archive without git: it is built from the inventory with
  every tool of the system except git, and the maintainer's mode refuses
  the update when there is no checkout to read, in the suite and in the
  command alike,
- the rollback of a failed update: a read-only recipe or metadata file
  keeps its bytes and its mode, the published archive survives, no
  pending archive is left behind, and a rollback that cannot finish is
  reported next to the failure that caused it,
- the nominal identity of the port: the package name, the desktop entry,
  the installed paths, the launcher data directory, the collector and
  callback paths, the window title and the window class, and the visible
  application name,
- the generated brand assets and the packaging path that uses them.

Synthetic fixtures are used on purpose: the vendor logo is never
embedded in a test, and the brand extraction is exercised against
synthetic geometry in an isolated fixture.

## Layer 2 — the payload-dependent tests

Some tests are deliberately not fixtures: they load the real, checksum-
pinned upstream sources, require every anchor to match exactly once,
apply the recipe, and then execute the patched billing hook and theme
bridge extracted from the patched bytes.

They read the pristine vendor snapshot that the build produces in
`build/upstream-pristine-<version>/` (see
[architecture](architecture.md#7-generated-outputs)). The snapshot is
copied out of the freshly extracted application before any patch is
applied, and it stays in the ignored build directory: it is proprietary
vendor data and is never committed, packaged or uploaded.

When the snapshot is absent, these tests report an explicit skip whose
message states that the recipe is unvalidated against the pinned
release. After a real build, the suite exercises them without skips.

## Layer 3 — the Arch build and package

Not covered by the automated suite, and not covered by the CI:

```bash
npm run package:sources
SRCDEST="$PWD/build" makepkg -f
```

`npm run package:sources` builds the port's source archive and checks it
against the checksum the recipe pins; it stops when the sources and the
pinned digest disagree. The command reads the checked-in source
inventory, not a git index, so it works in a clone as well as in a
source tree that carries none. `makepkg` then builds from that archive
and never from the checkout: it downloads the vendor installer and the
pinned Electron runtime, rebuilds `keytar` against the pinned Linux
Electron, runs the suite, installs the payload, and produces the package.
`makepkg` needs network access, the distribution's `nodejs`/`npm`,
`base-devel`, `libsecret` headers, `librsvg` and working user
namespaces.

The AUR workflow is the same recipe with the same archive, downloaded
from the release instead of built locally. Downloading the release asset
is a separate network check, not part of the offline suite. Private
release assets require authenticated access. The archive is
unpacked and prepared locally, and the source tree it produces runs the
same suite the clone runs.

The package is then checked with `tests/package-content-proof.mjs`,
which compares the archive against the bundle manifest and against the
recipe: every archived file's hash and mode, the license files, the
generated icons, the absence of the removed service plugin, and the recipe identity.

`makepkg -si` additionally installs the package and the missing
dependencies with `pacman`. `makepkg` itself must not run as root.

## Layer 4 — manual and real-session checks

These require a real account, a real window manager and a real
compositor, and are therefore outside the automated scope:

- the visual result of the theme follow and of the Glassy tint,
- the authenticated relay connection and its recovery,
- the desktop computer registration on a first sign-in: that the local
  PC is registered without a restart, and that **This Computer** appears
  in Settings → Droid Computers,
- the authenticated billing and limits display,
- the panel that renders the usage record — a separate, user-local
  component that is not part of this repository.

The optional Playwright scripts under `tests/` (`gui-smoke.mjs`,
`theme-smoke.mjs`, `menu-smoke.mjs`, `performance-*.mjs`,
`glassy-*.mjs`) drive a built bundle. They need a Playwright module
(`FACTORY_PLAYWRIGHT_MODULE`) and a short writable temporary path, and
they are never part of `npm test`.

Use a disposable profile for runtime checks. These commands do not require
sign-in or change the installed Desktop profile:

```bash
node tests/gui-smoke.mjs "$PWD/dist/factory-droid-desktop-1.0.0" "$PWD/build/gui-smoke"
node tests/theme-ipc-smoke.mjs "$PWD/dist/factory-droid-desktop-1.0.0" "$PWD/build/theme-ipc-smoke"
node tests/ipc-smoke.mjs "$PWD/dist/factory-droid-desktop-1.0.0"
```

Set `FACTORY_PLAYWRIGHT_MODULE` to an existing Playwright module when it is
not installed in the checkout. The GUI checks block external networking
and disable keyring access. They verify a signed-out window, not browser
authentication or an authenticated relay.

## Dependency security

Run `npm audit` before publishing a package revision. The Electron package
is a build dependency in npm metadata, but its runtime ships in the
finished app. An Electron advisory therefore requires a runtime update
and a full package build, not just a clean production-only npm audit.

The build uses the checksum map from the locked Electron package. Keep
that verification enabled when updating Electron, and rerun the real GUI
checks against the new bundle.

## CI

`.github/workflows/ci.yml` runs Layer 1 on a synthetic Linux, with
`contents: read` permissions, a job timeout, no credentials, no
`pull_request_target` and no uploaded artifacts. It does **not** build
the vendor payload, does not run `makepkg`, and does not publish
anything: it checks the sources and the fixtures only. A CI run is
therefore not evidence that a full Arch build succeeds; that remains a
local step (Layer 3).

## Known limits

- The AUR path is prepared but not published. It needs a public source
  release and the AUR's own rules and license review. The recipe,
  `.SRCINFO` and unpacked archive can be validated locally without a
  public release. An authenticated download of a private release does
  not prove that the unauthenticated AUR download works.
- A package build and a disposable signed-out window do not prove a
  successful upgrade of an existing profile. A real installation over
  the previous `factory-desktop-arch` package and a real first sign-in
  on a fresh account remain separate checks. The Arch handover
  (`conflicts`, `replaces`, `provides`) is declared in the recipe and
  asserted in the package content proof against the metadata keys makepkg
  really writes (`conflict`, `replaces`, `provides`), but the transition
  itself is not part of the automated checks. The opt-in `factory-desktop://` registration
  cannot be migrated either: it must be rolled back with the old helper
  before the old package is replaced, which the upgrade guide documents and the
  offline suite asserts, but which was not performed here. The desktop
  computer registration is covered by automated regression tests that
  execute the patched bytes; a fresh real sign-in and any cross-device
  behavior are outside that scope.
- The vendor payload's publisher signature is not verified. The pinned
  SHA-256 is the only trust anchor, and the bundle manifest records
  `"publisherSignature": "not verified"`.
- The CI runs on a synthetic Linux distribution, not on Arch. The recipe
  checks the distribution itself, and only an Arch host can run it.
- The upstream relay budget, the vendor's rounding formula and the
  vendor's own session inventory are re-implemented from the observed
  behaviour of the pinned release. A newer vendor release can change
  them; `npm run upstream:check` reports the latest published version
  only, and the anchors then have to be reviewed by hand.
