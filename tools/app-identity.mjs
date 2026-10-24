// The identity of the port: the visible product name and the technical
// slug that names the package, the command, the desktop entry and the
// bundle.
//
// One owner for both, so the shipped application, the desktop entry and
// the recipe cannot drift apart. The upstream payload keeps its own name
// ("Factory"); the port presents itself under the names below.
export const PRODUCT_NAME = 'Factory Droid Desktop';
export const PRODUCT_SLUG = 'factory-droid-desktop';
export const DESKTOP_ENTRY = `${PRODUCT_SLUG}.desktop`;

// The package name this port replaced. The recipe declares it as
// `conflicts`, `replaces` and `provides`, because both packages own
// /usr/bin/factory-usage and /usr/bin/factory-callback and only one of
// them may own them.
export const PREVIOUS_PACKAGE = 'factory-desktop-arch';

// The metadata keys makepkg writes into .PKGINFO. PKGBUILD's plural
// `conflicts` array is serialized under the singular `conflict` key;
// `replaces` and `provides` keep their names. The proof checks the real
// serialized keys, not the recipe's spelling.
export const PKGINFO_KEYS = { conflicts: 'conflict', replaces: 'replaces', provides: 'provides' };

// The .PKGINFO lines that declare the package's relationship with the
// previous package name.
export function pkgInfoRelationshipLines(value = PREVIOUS_PACKAGE) {
  return Object.entries(PKGINFO_KEYS).map(([, key]) => `${key} = ${value}`);
}

// The official manifest names the application "Factory". Only that one
// field is rewritten, so the rest of the vendor's manifest keeps its own
// bytes. The field must be there exactly once: a payload that dropped or
// duplicated it fails loudly instead of shipping an application under the
// upstream name.
const PRODUCT_NAME_PATTERN = /("productName"\s*:\s*)"[^"]*"/;

export function applyAppIdentity(manifestText) {
  const matches = manifestText.match(new RegExp(PRODUCT_NAME_PATTERN, 'g')) || [];
  if (matches.length !== 1)
    throw new Error(`Application name anchor matched ${matches.length} times, expected once`);
  return manifestText.replace(PRODUCT_NAME_PATTERN, `$1"${PRODUCT_NAME}"`);
}
