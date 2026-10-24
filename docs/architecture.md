# Architecture

How the port is put together, from the vendor payload to the installed
program. Every layer below lives in this repository; the vendor payload
itself never does.

## 1. Sources of truth

| File | Role |
|---|---|
| `versions.json` | pinned versions, payload checksum, official file names, brand pin |
| `PKGBUILD` | the Arch recipe: dependencies, build, check, package |
| `package.json` / `package-lock.json` | the toolchain used by the build and the tests |
| `LICENSE` / `packaging/NOTICE` | the licensing split of the port and of the payload |

`versions.json` names the official files the recipe anchors on (the
lifecycle chunk, the preload, the renderer entry, the renderer HTML and
stylesheet) and pins the vendor installer by SHA-256. The payload's
publisher signature is **not** verified; the checksum is the only trust
anchor, and the bundle manifest records that explicitly.

## 2. Payload acquisition (`tools/build.mjs`)

1. The vendor installer is downloaded into the ignored `build/downloads`
   cache and checked against the pinned SHA-256. A cached file whose hash
   changed is rejected.
2. The archive listing is validated before extraction: no absolute paths,
   no `..` segments, no duplicate names, no links, bounded entry count
   and size.
3. The application archive is extracted with `@electron/asar`. Every
   listed path is checked for safety, and symlinks inside the archive are
   refused.
4. The extracted `package.json` is checked against the pinned Desktop
   version and Electron major.

Nothing from the vendor is executed at this point: the Windows installer
is treated as data.

## 3. Patch layers

The port keeps its changes in narrow, reviewable layers. Each layer
rewrites an exact anchor and refuses to run when the anchor is missing or
ambiguous, so a changed vendor payload fails loudly instead of silently
shipping a half-patched application.

| Module | Layer |
|---|---|
| `tools/patches.mjs` | Linux main-process and renderer compatibility: native platform branches, the non-darwin title bar, the inline menu API, menu-bar hiding, zoom alignment, the billing polling gate, the injected keyboard handler |
| `tools/theme-main-patches.mjs` | main-process theme bridge: the palette reader, the follow opt-in, the native transparency decision |
| `tools/theme-renderer-patches.mjs` | preload and renderer side of the theme bridge: validated DTOs, the follow channel, the appearance overrides, the Glassy tint scope, the navigation transparency, the follow control placement |
| `tools/menu-renderer-patches.mjs` | the generated application menu in the renderer |
| `tools/remote-control-patches.mjs` | recovery of the upstream local relay registration, with the upstream connect budget and a back-off |
| `tools/application-menu-patches.mjs` | main-process side of the application menu |

Two invariants are enforced for every layer:

- **Exact anchors.** A patch applies only when its anchor matches exactly
  once. The build refuses to continue on a zero or duplicated match.
- **No helper collisions.** The names the port injects are checked against
  the vendor source, so a future vendor release that ships the same
  helper name is caught instead of shadowed.

`tools/verify.mjs` re-checks the finished bundle against the same
anchors: it reverses the newer layers in memory and asserts that every
expected string is present exactly once in the shipped archive.

## 4. Native module

`keytar` 7.9.0 is the only native module in the payload. The Windows
prebuilt binary is discarded, and the sources are rebuilt against the
pinned Linux Electron with `@electron/rebuild`. The result is checked to
be an x86_64 ELF, and the verifier asserts that exactly one `.node` file
ships and that its libraries resolve.

Chromium's sandbox helper stays non-setuid: the port relies on user
namespaces, and the build probes that with `unshare -Ur true`.

## 5. Assembly

The bundle is assembled under `dist/factory-desktop-arch-0.205.0`:

- the Electron runtime, with the application archive and the rebuilt
  native module,
- the official Linux Droid CLI, checked for its version and ELF type,
- `port/` — the port's own runtime files, copied read-only, without
  Python bytecode caches,
- `manifest.json` — versions, checksums, the recipe fingerprint and the
  hash and mode of every shipped file.

File modes are normalized by policy: directories 0755, files 0644, and
exactly the executable set (`factory-desktop`, `chrome-sandbox`,
`chrome_crashpad_handler`, `resources/bin/droid`, `port/*.sh`) 0755.
The verifier fails if anything else is executable.

## 6. Recipe fingerprint

`tools/common.mjs` computes the recipe identity: the static inputs
(`package.json`, `package-lock.json`, `versions.json`, `PKGBUILD`,
`LICENSE`) plus every file of the `tools/`, `runtime/` and `packaging/`
trees, with hash and mode. The fingerprint is recorded in the bundle
manifest, so a stale bundle cannot be reused or shipped: both
`npm run build` and `npm run verify` refuse a bundle whose recorded
recipe differs from the current sources.

## 7. Generated outputs

Two directories under `build/` are produced by the build and ignored by
Git. Neither is ever packaged as a source, uploaded, or committed.

### `build/upstream-pristine-0.205.0/`

The untouched official files the test suite validates the anchors
against. `tools/vendor-snapshot.mjs` copies them out of the freshly
extracted application **before the first patch is applied**, so the
anchors are checked against the vendor's own bytes.

### `build/brand/`

The icons, generated by `tools/brand-assets.mjs`. The Factory mark is
proprietary, so no copy of it is committed. The geometry is read, as
data, out of the official renderer: every occurrence must carry the same
path, the occurrence count and the SHA-256 digest must match
`versions.json`, and the characters must be the plain path alphabet. A
changed payload fails instead of producing a wrong icon. `rsvg-convert`
renders the raster from the vector, so the vector stays the single source
of truth. When a bundle is reused, the build verifies all four outputs
against that pinned geometry and regenerates the ones that are missing or
altered; the recipe does not repeat that decision.

## 8. Runtime helpers

| File | Role |
|---|---|
| `runtime/launch.sh` | launcher: isolated Factory home, dedicated Chromium profile, scrubbed environment, no automatic callback registration |
| `runtime/theme-bridge.cjs` | read-only Omarchy palette and window-mode reader; it reads marker metadata, never executes Lua |
| `runtime/auth-helper.mjs` | runs the bundled Electron in Node mode, loads the vendor's own compiled auth module, and returns whitelisted metrics; credentials never leave that process |
| `runtime/collector.py` | turns validated metrics into the usage record; it writes only counters, model ids and titles |
| `runtime/local_usage.py` | device-local accounting from the local session files: observed growth per model, session totals, Factory Standard Credits |
| `runtime/factory-callback.sh`, `runtime/factory-callback.py` | opt-in callback registration with journaling and rollback |

The account inventory is explicitly incomplete: account-global day and
model history is not available for personal plans, and the collector
never fabricates it.

## 9. The Omarchy service plugin

`omarchy/factory-usage-service/` is a self-contained Quickshell service
plugin. It carries its own copy of the collector, the auth helper and the
local accounting, so the usage record can be updated without reinstalling
the package. The package ships it as documentation under
`/usr/share/doc/`; it is not enabled, registered or scanned by the
recipe. The user copies the tree into `~/.config/omarchy/plugins/` and
enables it explicitly.

## 10. Packaging and licensing

`PKGBUILD` builds the bundle, runs the test suite, and installs the
program files, the desktop entry, the generated icons, `LICENSE` and
`packaging/NOTICE`. The optional plugin tree is copied as a copyable
extra, with its runner kept executable and its data files kept 0644.

The package declares `MIT` plus `LicenseRef-Proprietary`: the port's own
sources are MIT licensed, and the assembled payload contains proprietary
vendor components that keep their own rights. `packaging/NOTICE` states
the split inside the package itself.
