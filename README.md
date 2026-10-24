# Factory Droid Desktop

Unofficial Factory Desktop port for **Arch Linux / Omarchy, x86_64**.
Not affiliated with, endorsed by, or supported by Factory.

| Component | Pinned version |
|---|---|
| Factory Desktop payload | 0.206.0 |
| Linux Electron | 42.11.15 |
| Bundled Droid CLI | 0.249.0 |

## Features

- Isolated Desktop profile, separate from your standalone Droid CLI.
- Optional Omarchy theme and Glassy tint integration.
- First-login computer registration and local relay recovery.
- Usage collector and optional [Omarchy service plugin](omarchy/factory-usage-service/).

Remote control, callback registration and the plugin are never enabled automatically.
The personal usage panel is not included.

## Build and install

Requires Arch-based x86_64, system Node/npm, build tools and working user
namespaces (`unshare -Ur true`). Do not run `makepkg` as root.

```bash
sudo pacman -S --needed git base-devel nodejs npm libsecret python librsvg desktop-file-utils
git clone https://github.com/ash-eriga/factory-droid-desktop.git
cd factory-droid-desktop
makepkg -si
```

Repository access is required while it is private. The build downloads the
official Windows installer as data, verifies its pinned SHA-256, applies
Linux patches and rebuilds keytar for Linux Electron. The Windows installer
is never executed. **The vendor publisher signature is not verified.**

Use `makepkg -s` instead to build without installing. Generated payloads
and packages are not published by this repository.

## Usage

```bash
factory-droid-desktop
factory-usage                     # usage JSON
factory-callback register         # optional browser sign-in callback
factory-callback rollback         # restore previous callback associations
```

Enable **Follow Omarchy theme** in Settings → Appearance if wanted.
Desktop state lives under `~/.local/share/factory-droid-desktop/`;
the standalone CLI's `~/.factory/` profile is not migrated.

### Upgrading from factory-desktop-arch

The new package replaces the old package but does not migrate its profile.

#### The handover, in order

The new callback helper cannot undo a registration made by the old helper:

1. Before removing or replacing the old package, run `factory-callback rollback`.
2. Install the new package: `sudo pacman -U <package-file>`.
3. Optionally run `factory-callback register` again.

### Uninstall

Quit the app first. If you registered the callback, roll it back before removal:

```bash
factory-callback rollback         # only if previously registered
sudo pacman -R factory-droid-desktop
```

Removal preserves Desktop data and the standalone Droid CLI.
No credential or keyring deletion is performed.

## Development and validation

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run build
npm run verify
npm test
```

Build before testing to create the pristine vendor snapshot; without it,
upstream-dependent tests explicitly skip. Builds do not install or launch
the Desktop GUI. Existing bundles are reused only when their recipe matches.

The 0.206.0 port passed a fresh package build, 218 automated tests with no
skips, and independent review. GUI, fresh authenticated login and
cross-device remote control were not tested for this release.
Release-version alignment does not guarantee macOS/Windows feature parity.

See [architecture](docs/architecture.md), [validation](docs/validation.md),
[history](docs/history.md) and [contributing](CONTRIBUTING.md).

## License

The port's own code is [MIT](LICENSE). Factory Desktop, Droid and Factory
marks remain the property of The San Francisco AI Factory, Inc.; their
licenses and terms are separate. Other dependencies retain their own licenses.
No vendor installer, extracted payload, generated brand asset, credentials
or personal profile is included in this repository. See [NOTICE](packaging/NOTICE).
