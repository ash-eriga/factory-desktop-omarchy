# Factory Desktop Omarchy

Unofficial, experimental Factory Desktop port for Arch Linux and Omarchy on x86_64.

![Factory Desktop Omarchy following Omarchy themes, animated demo](media/demo.webp)

## Features

- Separate Desktop profile. Your standalone Droid CLI stays unchanged.
- Optional Omarchy theme colors and transparency.
- Remote Control, enabled only when you choose.

## Install

Requires an Arch-based x86_64 system with user namespaces enabled. Build as your regular user, not root.

```bash
sudo pacman -S --needed git base-devel nodejs npm libsecret python librsvg desktop-file-utils
git clone https://github.com/ash-eriga/factory-desktop-omarchy.git
cd factory-desktop-omarchy
npm run package:sources
SRCDEST="$PWD/build" makepkg -si
```

The build downloads the official app and applies the Linux port locally. No vendor binaries are committed.

The package is not in the AUR yet. The [AUR publishing guide](docs/aur.md) covers how the maintainer prepares the release, exports the submission and pushes it by hand. After that first push, `yay -S factory-droid-desktop` installs it and `yay -Syu` updates it. `pacman -Syu` does not update AUR packages.

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

[Update and rollback](docs/update.md) · [AUR publishing](docs/aur.md) · [Architecture](docs/architecture.md) · [Validation](docs/validation.md) · [History](docs/history.md) · [Contributing](CONTRIBUTING.md)

## Contributors

[Factory Droid](https://github.com/apps/factory-droid) contributed to implementation, testing, and review, credited as `factory-droid[bot]` in commits.

## License

The port's code is [MIT](LICENSE). Factory Desktop, Droid, and Factory marks retain their own rights. This port is not supported or endorsed by Factory. See [NOTICE](packaging/NOTICE).
