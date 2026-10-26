# Update and roll back

Run these commands as your regular user, not root. Updates preserve your Desktop profile and do not modify your standalone Droid CLI.

## Back up your profile

Finish your sessions and quit the Desktop. Create a private backup:

```bash
backup="$HOME/factory-droid-desktop-backup-$(date +%Y%m%d-%H%M%S)"
(umask 077; mkdir "$backup" && cp -a "${XDG_DATA_HOME:-$HOME/.local/share}/factory-droid-desktop" "$backup/profile")
```

The backup can contain credentials and session data. Keep it private. Do not delete the original profile or clear your system keyring.

## Build the update

Read the release notes for migration instructions. In your existing clone, run:

```bash
git pull --ff-only
npm run package:sources
SRCDEST="$PWD/build" makepkg -Csi
```

`-C` clears the generated build workspace, not your Desktop profile. If Git reports local changes or the build fails, stop. Do not reset the checkout or uninstall the working app.

Reopen the Desktop and check your sessions, settings, and Remote Control.

If you are replacing the older `factory-desktop-arch` package, follow the [handover steps](history.md#upgrading-from-factory-desktop-arch) before updating.

## Keep a rollback copy

Keep the previous `.pkg.tar.zst` and its matching profile backup. Downgrading the package alone may not undo a profile migration.

Quit the app before any rollback. Do not combine an older package with a newer profile unless the release notes say that combination is supported.

## Update notifications

The app checks this port's stable GitHub releases, not untested Factory releases. Pre-releases are ignored. Checks run on startup or focus, at most once a day, and never install anything automatically.

Use **File → Check for port updates…** for a manual check. The same menu lets you disable automatic checks.

When no stable release is available, or GitHub cannot be reached, the check reports unavailable. That does not prove your installation is current.
