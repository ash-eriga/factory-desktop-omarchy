# Factory Droid Desktop

Unofficial, experimental Factory Desktop port for Arch Linux and Omarchy on x86_64.

[![Watch Factory Droid Desktop follow Omarchy themes](https://raw.githubusercontent.com/ash-eriga/factory-droid-desktop/main/media/demo-preview.jpg)](https://github.com/ash-eriga/factory-droid-desktop/blob/main/media/demo.mp4)

[Watch the 20-second demo](https://github.com/ash-eriga/factory-droid-desktop/blob/main/media/demo.mp4).

## Features

- Separate Desktop profile. Your standalone Droid CLI stays unchanged.
- Optional Omarchy theme colors and transparency.
- Remote Control, enabled only when you choose.

## Install

Requires an Arch-based x86_64 system with user namespaces enabled. Build as your regular user, not root.

```bash
sudo pacman -S --needed git base-devel nodejs npm libsecret python librsvg desktop-file-utils
git clone https://github.com/ash-eriga/factory-droid-desktop.git
cd factory-droid-desktop
npm run package:sources
SRCDEST="$PWD/build" makepkg -si
```

The build downloads the official app and applies the Linux port locally. No vendor binaries are committed. An AUR package is not available yet.

## Use

Open **Factory Droid Desktop** from your app launcher or run `factory-droid-desktop`.

- Sign in through your browser and allow it to return to the app.
- For theme integration, enable **Settings → Appearance → Follow Omarchy theme**.
- For remote access, enable **Remote Control** in Settings.

## Update

Quit the app and [back up your profile](docs/update.md) first. Then run in your existing clone:

```bash
git pull --ff-only
npm run package:sources
SRCDEST="$PWD/build" makepkg -Csi
```

The app can notify you about stable releases of this port. It never installs updates automatically and does not announce pre-releases. Check manually from **File → Check for port updates…**.

## Uninstall

If you ran `factory-callback register`, restore the previous browser handler first:

```bash
factory-callback rollback
```

Quit the app, then remove the package:

```bash
sudo pacman -R factory-droid-desktop
```

Your Desktop data and standalone Droid CLI are preserved.

## Documentation

[Update and rollback](docs/update.md) · [Architecture](docs/architecture.md) · [Validation](docs/validation.md) · [History](docs/history.md) · [Contributing](CONTRIBUTING.md)

## Contributors

[Factory Droid](https://github.com/apps/factory-droid) contributed to implementation, testing, and review, credited as `factory-droid[bot]` in commits.

## License

The port's code is [MIT](LICENSE). Factory Desktop, Droid, and Factory marks retain their own rights. This port is not supported or endorsed by Factory. See [NOTICE](packaging/NOTICE).
