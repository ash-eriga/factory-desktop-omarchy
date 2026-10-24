# Factory Droid Desktop (unofficial)

**Factory Droid Desktop** is an unofficial, personal-use port of **Factory
Desktop 0.205.0** for Arch-based systems, built and validated on Omarchy,
x86_64.

The port was published as `factory-desktop-arch` until it was renamed. The
Arch package, the command and the installed paths now use the technical
slug `factory-droid-desktop`; the visible name is **Factory Droid Desktop**.
See [Renamed](#renamed) for the handover and for what the rename does not
move.

This repository holds the port's own sources: the Linux compatibility
recipe, the hardened launcher, the usage collector, the optional Omarchy
service plugin, and the tests. It redistributes nothing from the vendor.

> **Not affiliated with Factory.** Factory Desktop, Droid and the Factory
> mark are products of **The San Francisco AI Factory, Inc.** This port is
> neither endorsed nor supported by them, and it claims no rights over
> their software, names or brand assets. See [`packaging/NOTICE`](packaging/NOTICE)
> and [Licensing](#licensing).

## What it does

The recipe assembles the port locally from the vendor's own published
Windows installer (downloaded as data, SHA-256 pinned, never executed),
extracts the application archive, applies the exact main-process,
preload and renderer patches, rebuilds the single native module (keytar
7.9.0) against the pinned Linux Electron, and ships the result under
`/opt/factory-droid-desktop` with a hardened launcher.

The shipped application carries the port's own name: its manifest, the
main process, the window title and the desktop entry all say **Factory
Droid Desktop**. The upstream product it is built from is still called
Factory Desktop, and that name is kept wherever the vendor's own payload,
protocol or brand is meant. The vendor's own interface copy inside the
sign-in flow ("Starting Factory") is upstream text and is left as it is.

On top of that, the port adds:

- an isolated Factory home and Chromium profile (no ambient `FACTORY_*`
  overrides, no writes outside `~/.local/share/factory-droid-desktop/`),
- an optional Omarchy theme follow (palette, background and accent, plus
  Glassy window tint) that never changes Omarchy or system settings,
- recovery of the upstream local relay/daemon connection, without enabling
  a disabled preference or bypassing organization policy,
- recovery of the upstream desktop computer registration, so the local PC
  is registered with the account on the first sign-in and appears as
  **This Computer** in Settings → Droid Computers. The recovery is covered
  by automated regression tests that run the patched sign-in path and the
  registration driver against the patched bytes; a real first sign-in on a
  fresh account was not exercised for this release, and no cross-device
  behavior is claimed. None of this is official Linux support from
  Factory,
- an opt-in `factory-desktop://` callback registration with a faithful
  rollback,
- an account usage collector (`factory-usage`) that reports subscription
  limits, extra-usage balance and honest device-local token accounting,
- an optional Omarchy service plugin that keeps that usage record fresh.

Nothing is registered, enabled or started at install time.

## Pinned versions

| Component | Version |
|---|---|
| Factory Desktop (vendor payload) | 0.205.0 |
| Electron runtime | 42.11.15 |
| Droid CLI | 0.248.0 |
| keytar | 7.9.0 |
| Theme bridge schema | 1 |

The payload is pinned by SHA-256 in [`versions.json`](versions.json). The
vendor's **publisher signature is not verified**: the build trusts the
pinned checksum only, and says so in the bundle manifest
(`"publisherSignature": "not verified"`).

## Requirements

For the packaged install:

- Arch-based **x86_64** (Arch, Omarchy). The recipe checks `ID`/`ID_LIKE`.
- `pacman` with the dependencies listed in [`PKGBUILD`](PKGBUILD).

For building from source:

- `nodejs`, `npm`, `base-devel`, `libsecret` (with headers), `python`,
  `librsvg` (renders the icons), `desktop-file-utils`,
- working user namespaces (`unshare -Ur true`): the Chromium sandbox
  helper stays non-setuid on purpose.

`mise`-managed Node and npm do **not** satisfy `makepkg`: the recipe
depends on the distribution's `nodejs` and `npm` packages.

## Install

The package is built from this repository; there is no binary release and
no remote repository is published yet.

```bash
git clone <REPOSITORY_URL>          # or download the ZIP and unpack it
cd <REPOSITORY_NAME>
makepkg -si
```

- `-s` installs the missing dependencies with `pacman`, which asks for
  elevation. `makepkg` itself must **not** run as root.
- The build step runs `npm ci`, so the machine needs network access to the
  npm registry and to the vendor's release host.
- Inspect the result first if you prefer: `makepkg` writes the package in
  the current directory; `pacman -Qqlp <file>` lists its contents. The `-p`
  option is what selects a package file instead of an installed package,
  so the inspection works before anything is installed.

Without the `i` flag the package is only built, and you install it later
with `pacman -U <file>`.

### What the package installs

| Path | Purpose |
|---|---|
| `/opt/factory-droid-desktop/` | the assembled bundle |
| `/usr/bin/factory-droid-desktop` | launcher for the desktop app |
| `/usr/bin/factory-usage` | prints the usage record as JSON |
| `/usr/bin/factory-callback` | opt-in `factory-desktop://` registration |
| `/usr/share/applications/factory-droid-desktop.desktop` | desktop entry |
| `/usr/share/icons/hicolor/…/factory-droid-desktop.{svg,png}` | icons, generated at build time |
| `/usr/share/licenses/factory-droid-desktop/` | `LICENSE` and `NOTICE` |
| `/usr/share/doc/factory-droid-desktop/omarchy/` | the optional service plugin, as a copyable extra |

### Renamed

The port was named `factory-desktop-arch` before. The new package is
`factory-droid-desktop`, and the Arch handover is declared in the recipe:

- `conflicts=('factory-desktop-arch')` and `replaces=('factory-desktop-arch')`,
  because both packages own `/usr/bin/factory-usage` and
  `/usr/bin/factory-callback`: only one of them may own them, and
  installing the new package hands them over;
- `provides=('factory-desktop-arch')`, so anything that still depends on
  the old name stays satisfiable.

Nothing else is migrated. The state of the old package stays where it is
(`~/.local/share/factory-desktop-arch/`, `~/.cache/factory-desktop-arch/`,
`~/.local/state/factory-desktop-arch/`), the new package uses the new
paths, and the old directories are yours to delete or to keep. The CLI
keeps its own profile in `~/.factory/`, untouched by the rename. No
credential, profile or keyring entry is imported, and the package never
writes your user configuration.

#### The handover, in order

The opt-in `factory-desktop://` registration is user-local, and it is not
migrated. The new helper reads only its own journal directory, so it
cannot undo a registration made by the old helper: a rollback with it
would be a no-op and would leave the old entry pointing at the launcher
the old package owned. Order matters:

1. While the old package is still installed, roll the old registration
   back with the old helper: `factory-callback rollback`. It restores the
   associations that were in place before the registration.
2. Then install the new package (`pacman -U <package file>`), which
   replaces the old one.
3. If you want the scheme back, register it again with the new helper:
   `factory-callback register`.

Skipping the first step leaves a stale handler that names a command the
new package does not install. Nothing about the scheme itself changes:
the `factory-desktop://` scheme belongs to the upstream protocol.

### Update, remove, reset

```bash
pacman -U <new package file>   # update
pacman -R factory-droid-desktop  # remove
```

Neither the update nor the removal touches your data. The port's state
lives in `~/.local/share/factory-droid-desktop/` (isolated Factory home and
Chromium profile), the usage record lives in
`~/.local/state/omarchy/agents/usage/factory.json`, and the local
accounting ledger lives in the user cache. `pacman -R` removes the
program files only; if you want a clean slate, delete those paths
yourself.

Removing the package also does **not** undo an opt-in callback
registration. Do that explicitly:

```bash
factory-callback rollback
```

## Usage

```bash
factory-droid-desktop       # the desktop app
factory-usage                 # print the usage record as JSON
factory-usage --write         # also write the Omarchy agents-panel record
factory-usage --force         # bypass the 5-minute cache
```

The launcher isolates all Factory state under
`~/.local/share/factory-droid-desktop/` and scrubs ambient `FACTORY_*`
overrides. It does not auto-register the `factory-desktop://` scheme.

### Callback registration (opt-in)

```bash
factory-callback status     # show the current handler
factory-callback register   # register, saving the previous state
factory-callback rollback   # restore exactly the pre-registration state
```

Registration is user-local, journals the original associations before any
mutation, detects third-party changes made during registration, restores
all owned changes if verification fails, and refuses symbolic links or
unexpected pre-existing callback files. A file that another action removed
after the registration is left removed. Nothing registers automatically at
package installation or app startup.

### Omarchy usage service (optional)

[`omarchy/factory-usage-service/`](omarchy/factory-usage-service/) is a
small service plugin that refreshes the usage record on a timer, using
its own copy of the collector, so the record can be deployed without
reinstalling the package. It is **not** enabled by the package: you copy
the tree into your plugin folder and enable it yourself. See the
[plugin README](omarchy/factory-usage-service/README.md) for the exact
commands.

The panel that renders the record is a separate, user-local component and
is **not** part of this repository.

### Follow the Omarchy theme (optional)

In **Settings → Appearance**, enable **Follow Omarchy theme** to use the
active Omarchy mode, background, foreground and accent colors in Factory.
The port reads four whitelisted values from
`~/.local/state/omarchy/current/theme/colors.toml` and its companion
`theme.generation` marker. It does not run theme scripts, change Omarchy
or system settings, or replace Factory's saved Light/Dark/System
preference. Missing or invalid palette data falls back to Factory's normal
appearance.

The same toggle follows **Glassy Windows** automatically: the bridge reads
only marker metadata under
`${XDG_STATE_HOME:-$HOME/.local/state}/omarchy/toggles/hypr/`, never
their Lua content. Valid Glassy mode enables one tint per region (0.65
alpha for content, 0.35 for the title bar and sidebar). Omarchy's
compositor supplies the blur; other modes keep Factory's backgrounds
opaque, and saved manual settings stay intact.

## Build from source

```bash
npm ci --ignore-scripts --no-audit --no-fund   # toolchain; lifecycle scripts disabled
npm test                                       # offline test suite
npm run build                                  # assembles dist/factory-droid-desktop-0.205.0
npm run verify                                 # re-checks hashes, modes, ELF, recipe identity, application name
npm run brand                                  # regenerates the icons from the vendor snapshot
```

The build downloads the vendor installer (SHA-256 pinned in
`versions.json`) and the pinned Electron zip (checksum taken from the
locked `checksums.json`). Nothing is installed on the system, and the app
is never launched by the build.

If `dist/` already contains a bundle, `npm run build` reuses it only when
the recorded recipe fingerprint matches the current sources; otherwise it
refuses and asks you to delete the stale bundle. `npm run verify` fails on
the same mismatch. A reused bundle also has its four generated icons
verified against the pinned geometry: a missing or altered icon is
regenerated before anything is packaged, and the build fails with a clear
message when the pristine vendor snapshot is gone.

The build also writes two ignored helper outputs:

- `build/upstream-pristine-0.205.0/` — the untouched official files the
  test suite validates the patch anchors against, copied **before** any
  patch is applied. They are proprietary vendor files: they stay in the
  ignored build directory and are never committed, packaged or uploaded.
- `build/brand/` — the icons, generated from the checksum-pinned official
  renderer. The Factory mark is proprietary, so this repository ships no
  copy of it: the geometry is extracted at build time and accepted only
  when its SHA-256 digest and occurrence count match `versions.json`.

The optional Electron smoke scripts accept a bundle and an output
directory, and need a Playwright module. Point `FACTORY_PLAYWRIGHT_MODULE`
at a locally available Playwright installation, and use a short writable
temporary path, for example `mkdir -p build/t && export TMPDIR="$PWD/build/t"`.
Chromium's singleton socket has a Unix path length limit.

## Tests

```bash
npm test
```

The suite is offline: no network, no credentials, no real account, no GUI
session. It covers the patch recipes, the launcher, the collector and its
Python tests, the callback rollback, the theme bridge, the menus, the
recipe fingerprint and the package modes. The nominal identity of the port
— the package name, the command, the desktop entry, the installed paths
and the visible application name — has its own regression test, so a
rename that reaches only half of the tree fails the suite.

Tests that need the official payload run against the pristine snapshot the
build produces; they report an explicit skip when it is absent, and the
skip states that the recipe is unvalidated. See
[`docs/validation.md`](docs/validation.md) for what the suite covers and
what it cannot cover.

## Documentation

- [`docs/architecture.md`](docs/architecture.md) — how the port is put
  together, patch by patch.
- [`docs/validation.md`](docs/validation.md) — validation methodology,
  coverage and limits.
- [`docs/history.md`](docs/history.md) — what changed over time.

## Licensing

Two separate things live here:

1. **This project's own work** — the recipe, `runtime/`, `tools/`,
   `tests/`, `omarchy/` and the documentation — is licensed under the
   **MIT License**. See [`LICENSE`](LICENSE). It permits reuse,
   modification and redistribution, including commercially, provided the
   copyright and permission notice are preserved.
2. **The vendor's components** — Factory Desktop, Droid, the Factory mark,
   Electron, keytar and the other dependencies — are **not** covered by
   that license. They keep their own terms, and the assembled payload is
   a mixed work, which the package declares as `MIT` plus
   `LicenseRef-Proprietary`. Redistribution of Factory components requires
   permission from the rights holder.
3. **The names** — *Factory Droid Desktop* and *factory-droid-desktop* are
   the port's own names. They are not Factory trademarks, they grant no
   rights over Factory's products, and they do not extend the vendor's
   license to anything.

`packaging/NOTICE` states the same split inside the package. No Factory
authorship, endorsement or sponsorship of this port is implied, and this
port does not relicense any Factory component.

## Provenance

- The vendor installer and app are proprietary. The pinned SHA-256 and the
  extracted manifest document exactly what was assembled.
- All scripts in `tools/`, `runtime/` and `tests/` were written for this
  project. No code was copied from third-party port repositories.
- Do not publish generated bundles, extracted vendor files, or
  credentials.
