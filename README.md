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

## Update

The app checks this port's public GitHub releases, not untested Factory releases. It checks on startup or focus, at most once a day, and notifies you once per new release. It **never installs updates automatically**.

Use **File → Check for port updates…** to check manually. You can turn off automatic checks in the same menu. While the repository is private or has no published releases, checking is unavailable; that does not mean your version is current.

1. Finish your sessions and quit the Desktop before updating.
2. Back up the Desktop profile:

   ```bash
   backup="$HOME/factory-droid-desktop-backup-$(date +%Y%m%d-%H%M%S)"
   (umask 077; mkdir "$backup" && cp -a "${XDG_DATA_HOME:-$HOME/.local/share}/factory-droid-desktop" "$backup/profile")
   ```

   Keep this backup private: it can contain credentials and session data. Do not delete the original profile or clear your system keyring.

3. In your existing clone, run:

   ```bash
   git pull --ff-only
   npm run package:sources
   SRCDEST="$PWD/build" makepkg -Csi
   ```

   `--cleanbuild` (`-C`) clears the generated build workspace, not your Desktop profile. Do not run it as root. If Git reports local changes or the build fails, stop rather than resetting the checkout or uninstalling the working app.

4. Reopen the Desktop and check your sessions, settings and Remote Control.

Normal upgrades preserve your Desktop profile and standalone CLI. Keep the previous `.pkg.tar.zst` and its matching profile backup for rollback: downgrading the package alone may not undo a profile migration. Use release notes to check for any special migration steps.

## Uninstall

If you ran `factory-callback register`, restore the previous browser callback
handler before removing the package:

```bash
factory-callback rollback
```

Quit the app, then remove the package:

```bash
sudo pacman -R factory-droid-desktop
```

Your Desktop data and standalone Droid CLI are preserved.

## Documentation

[Architecture](docs/architecture.md) · [Validation](docs/validation.md) · [History and upgrades](docs/history.md) · [Contributing](CONTRIBUTING.md)

## Contributors

[Factory Droid](https://github.com/apps/factory-droid) contributed to implementation,
testing, and review. Droid-assisted commits credit `factory-droid[bot]` as a co-author.

## License

The port's own code is [MIT](LICENSE). Factory Desktop, Droid and Factory marks retain their respective licenses and ownership. See [NOTICE](packaging/NOTICE).
