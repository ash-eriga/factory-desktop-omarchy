# Builds the inspected proprietary app locally. Do not publish the payload.
pkgname=factory-droid-desktop
pkgver=0.206.0
pkgrel=17
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
source=('https://github.com/ash-eriga/factory-droid-desktop/releases/download/v0.206.0-17/factory-droid-desktop-port-0.206.0-17.tar.gz')
sha256sums=('58c8a573f45ac7e0701f5171390f50e6b28904c5e199ecc9084a3184160ce0a5')

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
  desktop-file-validate "$pkgdir/usr/share/applications/factory-droid-desktop.desktop"
}
