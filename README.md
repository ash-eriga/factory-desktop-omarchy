# Factory Droid Desktop

Unofficial Factory Desktop port for Arch Linux / Omarchy, x86_64.

<!-- Replace this placeholder with the demonstration video. -->
> Demo video coming soon.

## Features

- Desktop profile separate from the standalone Droid CLI.
- Omarchy theme integration.
- Remote Control, enabled when you choose.

## Install

Requires Arch Linux or an Arch-based distribution on x86_64, with user namespaces enabled. Run the build as a regular user, not root.

```bash
sudo pacman -S --needed git base-devel nodejs npm libsecret python librsvg desktop-file-utils
git clone https://github.com/ash-eriga/factory-droid-desktop.git
cd factory-droid-desktop
npm run package:sources
SRCDEST="$PWD/build" makepkg -si
```

The build downloads and patches the official Desktop locally. Vendor binaries are not stored in this repository.

**AUR support is planned for the future.** For now, build from this repository.

## Usage

Open **Factory Droid Desktop** from your app launcher or run `factory-droid-desktop`.

Sign in through your browser and accept the prompt to return to the app. Enable **Remote Control** in Settings when you want remote access. To follow your Omarchy theme, enable **Follow Omarchy theme** in Settings → Appearance.

The Desktop keeps its own profile and does not modify your standalone Droid CLI.

## Uninstall

Quit the app, then run:

```bash
sudo pacman -R factory-droid-desktop
```

Your Desktop data and standalone Droid CLI are preserved.

## Documentation

[Architecture](docs/architecture.md) · [Validation](docs/validation.md) · [History and upgrades](docs/history.md) · [Contributing](CONTRIBUTING.md)

## License

The port's own code is [MIT](LICENSE). Factory Desktop, Droid and Factory marks retain their respective licenses and ownership. See [NOTICE](packaging/NOTICE).
