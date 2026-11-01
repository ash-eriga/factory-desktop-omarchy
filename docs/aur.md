# Publish the AUR package

The package is not in the AUR yet. This guide prepares one release, publishes its assets as an experimental GitHub prerelease, and pushes the package to the AUR by hand. It assumes you have an AUR account with a registered SSH key.

`PKGBUILD` is the source of truth. It declares `pkgname`, `pkgver`, `pkgrel`, `url`, the source archive and its digest. Every output name in this guide follows those values, so a later release uses its own numbers. `npm run package:aur` prints the exact paths it wrote.

## Prepare the release

1. Edit `PKGBUILD`, or add the source files of the change. Run `git add` for a new source file. The inventory reads only tracked files.
2. Run `npm run package:sources:update`. It refreshes `packaging/source-inventory.json`, rewrites the pinned digest and regenerates `.SRCINFO` with makepkg.
3. Run `npm test`.
4. Run `npm run package:sources` to confirm the digest the recipe pins, and `SRCDEST="$PWD/build" makepkg -f` on an Arch host to confirm the package builds. Do not install it for this check.
5. Run `npm run package:aur`.

The export mode checks the source archive against the pinned digest and compares `.SRCINFO` with `makepkg --printsrcinfo` byte for byte. It refuses stale metadata, a tampered source, a linked submission file, an unknown option or `--aur` mixed with `--update`. It never writes `PKGBUILD`, `.SRCINFO` or the inventory. It writes two outputs:

- `build/aur/factory-droid-desktop-0.206.0-19/` holds `PKGBUILD`, `.SRCINFO` and `LICENSE`, all mode 0644.
- `build/factory-droid-desktop-aur-0.206.0-19.tar.gz` extracts to `factory-droid-desktop/` with the same three files.

Run the command twice to confirm it reproduces the same bytes. An existing directory or archive with other content is refused, not deleted or overwritten. Move the old output aside and run the command again.

## Publish the release assets on GitHub

The recipe downloads the source archive from its release URL, so the release must exist publicly before anyone can build the AUR package. Publish it as a prerelease. The in-app updater ignores prereleases, so an experimental package revision does not notify existing users.

Commit and push the reviewed changes first. Create the prerelease at that exact commit with the two named assets only:

```bash
gh release create v0.206.0-19 \
  build/factory-droid-desktop-port-0.206.0-19.tar.gz \
  build/factory-droid-desktop-aur-0.206.0-19.tar.gz \
  --repo ash-eriga/factory-desktop-omarchy \
  --target "$(git rev-parse HEAD)" \
  --prerelease \
  --latest=false \
  --title v0.206.0-19
```

Do not upload the `build` directory, a wildcard, vendor binaries, built packages or credentials. The source archive is the one `PKGBUILD` pins. The recipe archive is there so a reviewer can read the submission without cloning.

Check the public download and its digest from a fresh directory with no source cache:

```bash
check="$(mktemp -d)"
install -m644 build/aur/factory-droid-desktop-0.206.0-19/{PKGBUILD,.SRCINFO,LICENSE} "$check/"
(cd "$check" && SRCDEST="$check" makepkg --verifysource)
```

## Push to the AUR by hand

The AUR checkout is a repository of its own on the `master` branch. Keep it separate from the port's checkout. The first push creates the package under your account. If the package name is already taken, the push fails.

```bash
aur="$HOME/aur/factory-droid-desktop"
mkdir -p "$HOME/aur"
git -c init.defaultBranch=master clone ssh://aur@aur.archlinux.org/factory-droid-desktop.git "$aur"
install -Dm644 build/aur/factory-droid-desktop-0.206.0-19/PKGBUILD "$aur/PKGBUILD"
install -Dm644 build/aur/factory-droid-desktop-0.206.0-19/.SRCINFO "$aur/.SRCINFO"
install -Dm644 build/aur/factory-droid-desktop-0.206.0-19/LICENSE "$aur/LICENSE"
git -C "$aur" add PKGBUILD .SRCINFO LICENSE
git -C "$aur" diff --cached
git -C "$aur" commit -m "Add factory-droid-desktop 0.206.0-19"
git -C "$aur" push origin master
```

Review the staged diff before the commit. Copy only the three files. Do not run `git add -A` and do not copy a build directory.

## Update the package

Bump `pkgrel` for a packaging change. For a new upstream release, update `pkgver` and `versions.json` and reset `pkgrel=1`. Run the preparation steps again and publish the matching GitHub prerelease before the AUR push, because the recipe downloads its source from that release.

In the AUR checkout, pull first, then repeat the install, review, commit and push for the new release:

```bash
git -C "$aur" pull --ff-only origin master
install -Dm644 build/aur/factory-droid-desktop-0.206.0-20/PKGBUILD "$aur/PKGBUILD"
install -Dm644 build/aur/factory-droid-desktop-0.206.0-20/.SRCINFO "$aur/.SRCINFO"
install -Dm644 build/aur/factory-droid-desktop-0.206.0-20/LICENSE "$aur/LICENSE"
git -C "$aur" add PKGBUILD .SRCINFO LICENSE
git -C "$aur" diff --cached
git -C "$aur" commit -m "factory-droid-desktop 0.206.0-20"
git -C "$aur" push origin master
```

## What the AUR does with a submission

The AUR has no routine human approval queue for a new package. A push runs server-side checks, and the package becomes visible when they pass. Those checks do not prove that the package builds or is safe. Community moderation happens after that. Users can comment or flag a package as out of date. Arch Package Maintainers can remove packages that break the [AUR submission rules](https://wiki.archlinux.org/title/AUR_submission_guidelines).

An AUR package is user-submitted content. It grants no permission to redistribute Factory components. The recipe is MIT licensed and builds from the official download, and the Factory components keep their own rights. Read `packaging/NOTICE` before you change how the build obtains the payload.

## How users install and update

After your push, an AUR helper can find the package:

```bash
yay -S factory-droid-desktop
```

A later AUR update arrives through the helper, for example `yay -Syu`. `pacman -Syu` updates packages from configured binary repositories, not from the AUR. Use an AUR helper or rebuild the updated recipe manually.

The manual clone instructions in the [README](../README.md) remain the alternative for users who do not use an AUR helper. The in-app updater does not announce prereleases of this port.
