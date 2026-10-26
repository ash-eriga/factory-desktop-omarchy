# Architecture

How the port is put together, from the vendor payload to the installed
program. Every layer below lives in this repository; the vendor payload
itself never does.

## 1. Sources of truth

| File | Role |
|---|---|
| `versions.json` | pinned versions, payload checksum, official file names, brand pin |
| `PKGBUILD` | the Arch recipe: dependencies, source, build, check, package |
| `.SRCINFO` | the metadata makepkg writes for that recipe, checked in |
| `tools/package-sources.mjs` | builds the source archive the recipe consumes |
| `packaging/source-inventory.json` | the checked-in inventory of the archive's contents |
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
| `tools/patches.mjs` | Linux main-process and renderer compatibility: native platform branches, the non-darwin title bar, the inline menu API, menu-bar hiding, zoom alignment, the billing polling gate, the injected keyboard handler, and the visible application name |
| `tools/app-identity.mjs` | the port's own identity: the visible product name and the technical slug, and the single rewrite of the official manifest's display name |
| `tools/theme-main-patches.mjs` | main-process theme bridge: the palette reader, the follow opt-in, the native transparency decision |
| `tools/theme-renderer-patches.mjs` | preload and renderer side of the theme bridge: validated DTOs, the follow channel, the appearance overrides, the Glassy tint scope, the navigation transparency, the follow control placement |
| `tools/menu-renderer-patches.mjs` | the generated application menu in the renderer |
| `tools/remote-control-patches.mjs` | recovery of the upstream local relay registration, with the upstream connect budget and a back-off |
| `tools/computer-registration-patches.mjs` | recovery of the upstream desktop computer registration, so the local PC is registered after the first sign-in |
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

### The application name

Upstream's own manifest names the application "Factory". The port ships
under its own name, **Factory Droid Desktop**, and the name is set in
three places, because no single one of them is enough:

- `tools/app-identity.mjs` rewrites the `productName` field of the
  official manifest, and only that field. The rewrite happens *after* the
  pristine snapshot was taken, so the snapshot keeps the vendor's own bytes
  and the anchor checks still run against an untouched payload. The field
  must be there exactly once: a payload that dropped or duplicated it
  fails the build instead of shipping an application under the upstream
  name.
- the `application name` patch in `tools/patches.mjs` calls
  `app.setName()` during the startup sequence, before the first window
  exists, so the taskbar entry and the application menu read the port's
  name.
- the window title is owned by the page and by the renderer, and Electron
  propagates a page title to the native window. The `rendererTitleChanges`
  layer renames the renderer's default title and the session title
  suffix (the session title itself is preserved), and the
  `htmlTitleChanges` layer renames the initial page title. Without them
  the window would keep showing the upstream name, whatever
  `app.setName()` says.

The same layer fixes the XDG desktop entry name to the package's own
entry (`factory-droid-desktop.desktop`), so the window and the launcher
entry describe the same application. Chromium derives the window class
from the product name, so the entry's `StartupWMClass` is
`factory-droid-desktop` as well: the class was measured on the payload's
own Electron (42.11.15), where "Factory" produced the class "factory" and
"Factory Droid Desktop" produced "factory-droid-desktop", in the X11
`WM_CLASS` property and in the Wayland application id alike. An entry that
kept the upstream class would still launch the application, but the
launcher would not match the window with its own entry.

The upstream product name ("Factory Desktop"), the `factory-desktop://`
scheme and the vendor's mark are contracts of the payload, not of the
port's name, and are not renamed. The vendor's own startup copy
("Starting Factory" and its translations) is upstream interface text and
is left alone.

### The desktop computer registration

The local PC has to be registered with the account for the desktop to
show it as **This Computer** in Settings → Droid Computers. Upstream
owns that registration entirely: its main process holds the whole flow
in one function, and that function has exactly one call site, the
startup sequence.

The startup sequence runs before a fresh profile can hold an auth
token. When the token is missing, upstream logs

```
[computer] No auth token available, skipping auto-registration
```

and stops there. Neither sign-in path reaches the registration
afterwards: the browser sign-in stores the credentials and tells the
renderer that the account is ready, and the customer-owned sign-in
commits its credentials through its own session object, but neither
leads back to the registration. The local host configuration therefore
never gains a `computerRegistration`, `computer:getLocalId` answers
null, and the card is never drawn.

The failure is specific to the first sign-in. A profile that was
already signed in when the app started has a token at startup, the
registration runs, and the local computer id is there.

`tools/computer-registration-patches.mjs` closes that gap without
reimplementing anything. A single driver owns the attempt, and it calls
upstream's own registration function, which keeps upstream's account,
organization, payload and backend checks. The driver:

- runs the startup attempt through itself, so there is exactly one
  registration flow;
- runs a forced attempt when the browser sign-in completes and when the
  customer-owned sign-in completes. The attempt is not awaited, so the
  sign-in flow is never delayed by the backend round trip;
- lets `computer:getLocalId` wait for an attempt in flight, so the
  renderer reads the registered id instead of the empty one;
- keeps one attempt at a time, and holds a cooldown between attempts so
  a renderer re-render cannot turn into a request loop. Only an attempt
  that actually ran moves the cooldown deadline, so a caller that merely
  observes the cooldown never postpones the retry;
- queues a forced attempt that arrives while an older attempt is still
  running, and runs it once that attempt settles, so a sign-in that
  lands mid-attempt is not lost. The queue marker is released when the
  queued attempt starts, not when it ends: a sign-in that completes
  while the queued attempt is already running gets its own attempt with
  its own credentials, instead of joining an attempt that may be
  registering an account that was revoked in the meantime. Sign-ins that
  arrive before the queued attempt starts still coalesce onto it,
  because that attempt has not read any credentials yet;
- reads the credentials once and hands them to upstream's registration
  function, which now accepts them as an optional argument. Upstream
  keeps the hosted-services gate and the missing-credentials decision;
  only the repeated credential read is gone. The driver reads the
  system clock directly, so no clock seam exists in its API.

The renderer side refreshes the account's computer list when the local
computer id appears, because the list fetched before the registration
cannot contain the computer. The refresh is sequenced: the first read
may be the request the page already had in flight, which was sent
before the registration, and a second read after that one settles is a
fresh one. The upstream effect runs on mount only, so this is one extra
read per mount and never a refetch loop.

Registration is not remote access. This layer never touches the
remote-access preference, the local relay or the organization policy;
the relay still needs the user's own toggle and the organization's own
decision.

## 4. Native module

`keytar` 7.9.0 is the only native module in the payload. The Windows
prebuilt binary is discarded, and the sources are rebuilt against the
pinned Linux Electron with `@electron/rebuild`. The result is checked to
be an x86_64 ELF, and the verifier asserts that exactly one `.node` file
ships and that its libraries resolve.

Chromium's sandbox helper stays non-setuid: the port relies on user
namespaces, and the build probes that with `unshare -Ur true`.

## 5. Assembly

The bundle is assembled under `dist/factory-droid-desktop-0.206.0`:

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

The fingerprint is computed inside the extracted sources, not in the
checkout: the recipe's `prepare()` step copies the canonical `PKGBUILD`
and `.SRCINFO` into the source root, so the build and the test suite
inside that tree validate the recipe that is really being executed and
not an older copy that travelled with the archive.

## 7. Generated outputs

Two directories under `build/` are produced by the build and ignored by
Git. Neither is ever packaged as a source, uploaded, or committed.

### `build/upstream-pristine-0.206.0/`

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
of truth. When a bundle is reused, the build verifies both desktop icons
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
| `runtime/update-notifier.cjs` | public port release checks and native notifications; never installs packages |

The installed desktop entry declares `x-scheme-handler/factory-desktop`.
Arch's desktop database hook makes it discoverable on a clean machine,
without a launch-time command or a user `mimeapps.list` override. An existing
default handler is preserved; the callback helper remains an explicit
repair/override tool, not a prerequisite for first login.

The `accountRecentSessions` inventory carries `sessionCount`,
`creditsSampleTotal`, `unknownOwnerRows`, `hasMore` and `complete`.
It is explicitly incomplete: account-global day and model history is not
available for personal plans, and the collector never fabricates it.

### Port update notifications

`tools/update-notification-patches.mjs` initializes the notifier before the
application menu is built. File-menu commands check manually or disable
automatic checks; no new renderer IPC is exposed. The proprietary updater
remains disabled on Linux.

The notifier queries only this repository's public GitHub latest-release
endpoint, without credentials, redirects, account identifiers or telemetry.
It accepts published stable tags in `vMAJOR.MINOR.PATCH-REVISION` form and
compares all four numeric components against `port/release.json`, generated
from the current `PKGBUILD`. A package-only revision therefore counts as an
update. Drafts, prereleases, upstream-only tags and malformed responses are
not update candidates.

Automatic checks wait 15 seconds after startup/focus and run at most once
per day while a window is focused. Deployment, airgap and organization
policy gates apply; automatic checks also honor the upstream automatic
update preference. A new release shows a native dialog once, with links
to the update guide and canonical release notes. URLs are constructed
locally, never taken from the response. No packages or scripts are fetched.
Network requests have an eight-second timeout and metadata is limited to
256 KiB. Failures are silent automatically and explicit on manual checks;
a private repository or no published release is unavailable, not current.

Only `port-updates.json` in the isolated Electron profile is written, with
mode 0600 and atomic replacement. It stores the opt-out, last-check time
and notified version, not credentials. Installation stays with pacman;
the [README update guide](../README.md#update) describes backup and rebuild.

## 9. Packaging and licensing

`PKGBUILD` builds the bundle, runs the test suite, and installs the
program files, the desktop entry, the generated icons, `LICENSE` and
`packaging/NOTICE`.

The package is named `factory-droid-desktop` and installs under
`/opt/factory-droid-desktop`, with the command `/usr/bin/factory-droid-desktop`
and the desktop entry `factory-droid-desktop.desktop`. The previous name,
`factory-desktop-arch`, is declared in the recipe as `conflicts`,
`replaces` and `provides`: both packages own `/usr/bin/factory-usage` and
`/usr/bin/factory-callback`, so only one of them may own them, and the
handover must not leave two owners. No state is migrated: the old data
directories are left alone, and the CLI's own profile in `~/.factory/` is
never touched by the desktop package.

The package declares `MIT` plus `LicenseRef-Proprietary`: the port's own
sources are MIT licensed, and the assembled payload contains proprietary
vendor components that keep their own rights. `packaging/NOTICE` states
the split inside the package itself.

## 10. One recipe, two workflows

The recipe does not build from a checkout. It declares one source, the
port's own source archive, and one pinned SHA-256 for it:

```
source=('https://github.com/ash-eriga/factory-droid-desktop/releases/download/v0.206.0-18/factory-droid-desktop-port-0.206.0-18.tar.gz')
sha256sums=('<digest>')
```

Both packaging workflows consume that one artifact:

- the **GitHub clone** builds the archive locally with
  `npm run package:sources` and hands it to `makepkg` as the source
  directory; the tool checks the archive against the pinned digest and
  stops on a mismatch;
- the **AUR** downloads the very same file from the release. The AUR
  checkout holds the recipe, its `.SRCINFO` and the license, and nothing
  else.

The AUR path is prepared but not published. It requires a public source
release and the AUR's own rules and license review. A release in a private
repository is available only to authenticated users with access.

`tools/package-sources.mjs` builds the archive:

- the sources are the files of an explicit scope (`package.json`,
  `package-lock.json`, `versions.json`, `LICENSE`, `README.md`,
  `CONTRIBUTING.md` and the `tools/`, `runtime/`, `packaging/`, `tests/`,
  `docs/` trees) as the **checked-in source inventory**
  (`packaging/source-inventory.json`) names them, with the mode each one
  ships with. The recipe files are not part of them: a checksum inside the
  recipe cannot cover the recipe;
- the inventory is checked-in **data**, not a directory walk and not a
  git index. That is what lets the same command build and verify the
  archive in a clone, in a source ZIP, in a release download and in an
  AUR checkout: none of them carries a git index, and the default mode
  needs no git at all. The inventory names itself and carries no digest
  of its own contents: the archive's checksum is what covers it;
- the tree and the inventory have to agree. A source file the tree does
  not hold is refused, and a file of a source tree the inventory does not
  name is refused as well, so a local note or a leftover file can never
  reach a release;
- every path is checked before it is archived: no traversal, no absolute
  path, no link, no special file, no forbidden segment (a cache, a build
  output, the vendor payload, a profile, a keyring, the personal panel)
  and no payload-shaped, credential or personal file. Every source tree
  has to be a real directory as well, and so has every directory on the
  way to a source file: a link would carry the bytes of a copy that
  lives outside the tree;
- an artifact of a working tree is never a source. A log, a dump, a core
  file, profiler output and generated bytecode are ignored in a tree, and
  a source may not name one of them, so a tracked or a listed artifact
  is refused;
- the archive is **deterministic**: sorted paths, zeroed timestamps,
  numeric root ownership, directories 0755, files 0644 unless they are
  executable in the checkout, and a gzip stream without a name and
  without a timestamp. The same tree produces the same bytes on every
  machine, so the pinned digest is a checksum of the sources and not of
  one directory. The packing step is given no override from the
  environment (`TAR_OPTIONS`, `GZIP`, the shell startup files and the
  functions an outer shell exported are removed), so the bytes are the
  ones the inventory asks for.

`npm run package:sources:update` is the maintainer's mode: it refreshes
the inventory from the tracked files of the checkout (an untracked file
inside the source trees is refused), rebuilds the archive, pins its
digest and regenerates `.SRCINFO` with makepkg itself. The default mode
never rewrites the recipe, and a refused run leaves no archive behind.

The update is a transaction: the candidate inventory, the archive, the
recipe and the metadata are all prepared before anything is replaced,
and a failure restores the bytes and the modes the inventory, the recipe
and the metadata had before, removes the archive that was still pending
and leaves the published archive alone. Every file is restored even
when one of them cannot be written, and the archive that was pending is
removed in any case; a rollback that could not finish is reported next
to the failure that caused it. The tree is therefore never left with a
recipe that pins one digest next to a metadata that pins another.
