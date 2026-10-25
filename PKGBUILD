# Builds the inspected proprietary app locally. Do not publish the payload.
pkgname=factory-droid-desktop
pkgver=0.206.0
pkgrel=15
pkgdesc='Unofficial Factory Droid Desktop port for Arch and Omarchy'
arch=('x86_64')
# The port was renamed from factory-desktop-arch. Both packages ship
# /usr/bin/factory-usage and /usr/bin/factory-callback under the same
# names, so they must never be installed at the same time: conflicts keeps
# a single owner of the shared paths and replaces hands them over during
# the transition. provides keeps the old name satisfiable for anything
# that still depends on it. No data is migrated: the old package's
# state directories are left untouched.
conflicts=('factory-desktop-arch')
replaces=('factory-desktop-arch')
provides=('factory-desktop-arch')
# The recipe's own sources are MIT licensed; the assembled payload contains
# proprietary Factory components, which keep their own rights. The NOTICE
# file states the split and is shipped next to the license.
license=('MIT' 'LicenseRef-Proprietary')
depends=('alsa-lib' 'at-spi2-core' 'cairo' 'cups' 'dbus' 'expat' 'glib2'
         'gtk3' 'libdrm' 'libsecret' 'libx11' 'libxcb' 'libxcomposite'
         'libxdamage' 'libxext' 'libxfixes' 'libxkbcommon' 'libxrandr'
         'mesa' 'nspr' 'nss' 'pango' 'python' 'xdg-utils')
makedepends=('nodejs' 'npm' 'base-devel' 'desktop-file-utils' 'librsvg' 'python')
options=('!strip' '!debug')

# The recipe builds from the port's own source archive, not from a
# checkout: the same archive serves the GitHub clone and the AUR, so both
# workflows ship the same bytes. The release asset does not exist yet, so
# a clone generates the very same archive locally with
# `npm run package:sources` before makepkg runs.
source=('https://github.com/ash-eriga/factory-droid-desktop/releases/download/v0.206.0-15/factory-droid-desktop-port-0.206.0-15.tar.gz')
sha256sums=('8cabaaa7cf66686e38ab401499125763f58436a1b5aa066f1a2eed901299e426')

# The root directory of the archive. It is derived from the source name,
# so the recipe and the archive cannot disagree about it.
_source_root="${source[0]##*/}"
_source_root="${_source_root%.tar.gz}"

prepare() {
  # The canonical recipe travels with the sources: the build and the test
  # suite inside the source tree must see the recipe that is really being
  # executed, not an older copy that was archived with it.
  install -Dm644 "$startdir/PKGBUILD" "$srcdir/$_source_root/PKGBUILD"
  install -Dm644 "$startdir/.SRCINFO" "$srcdir/$_source_root/.SRCINFO"
}

build() {
  cd "$srcdir/$_source_root"
  npm ci --ignore-scripts --no-audit --no-fund
  # The build owns the generated icons: it generates them for a fresh
  # bundle and verifies every one of them when a bundle is reused. The
  # recipe does not repeat that decision.
  npm run build
  npm run verify
}

check() {
  cd "$srcdir/$_source_root"
  npm test
}

# Modes of the optional Omarchy plugin tree shipped as documentation:
# directories 0755, data files 0644, and the runner 0755 because the
# service executes bin/factory-usage directly (Service.qml) and the plugin
# README copies this tree with `cp -r`, which keeps the mode. Normalizing
# every file to 0644 shipped a runner the service could not execute.
# Kept as a function so the packaging test runs this exact recipe logic on
# a temporary copy instead of re-implementing it.
normalize_plugin_modes() {
  local root="$1"
  find "$root" -type d -exec chmod 755 {} +
  find "$root" -type f -exec chmod 644 {} +
  chmod 755 "$root/factory-usage-service/bin/factory-usage"
}

package() {
  cd "$srcdir/$_source_root"
  install -d "$pkgdir/opt"
  cp -a "dist/$pkgname-$pkgver" "$pkgdir/opt/$pkgname"
  find "$pkgdir/opt/$pkgname" -type d -exec chmod 755 {} +
  install -Dm755 packaging/factory-droid-desktop "$pkgdir/usr/bin/factory-droid-desktop"
  install -Dm755 packaging/factory-usage "$pkgdir/usr/bin/factory-usage"
  install -Dm755 packaging/factory-callback "$pkgdir/usr/bin/factory-callback"
  install -Dm644 packaging/factory-droid-desktop.desktop "$pkgdir/usr/share/applications/factory-droid-desktop.desktop"
  install -Dm644 LICENSE "$pkgdir/usr/share/licenses/$pkgname/LICENSE"
  install -Dm644 packaging/NOTICE "$pkgdir/usr/share/licenses/$pkgname/NOTICE"
  # The icons are generated during the build from the checksum-pinned
  # official payload: this repository ships no copy of the mark.
  install -Dm644 build/brand/factory.svg "$pkgdir/usr/share/icons/hicolor/scalable/apps/factory-droid-desktop.svg"
  install -Dm644 build/brand/factory.png "$pkgdir/usr/share/icons/hicolor/256x256/apps/factory-droid-desktop.png"
  # Optional Omarchy service plugin: shipped as a copyable extra. It is not
  # enabled, registered, or scanned from here; see its README.
  install -d "$pkgdir/usr/share/doc/$pkgname/omarchy"
  cp -a omarchy/factory-usage-service "$pkgdir/usr/share/doc/$pkgname/omarchy/"
  # The plugin's own marks are generated too, for the same reason.
  install -Dm644 build/brand/factory-mark.svg \
    "$pkgdir/usr/share/doc/$pkgname/omarchy/factory-usage-service/assets/factory.svg"
  install -Dm644 build/brand/factory-mark-light.svg \
    "$pkgdir/usr/share/doc/$pkgname/omarchy/factory-usage-service/assets/factory-light.svg"
  normalize_plugin_modes "$pkgdir/usr/share/doc/$pkgname/omarchy"
  desktop-file-validate "$pkgdir/usr/share/applications/factory-droid-desktop.desktop"
}
