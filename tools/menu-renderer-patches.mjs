// Small renderer-only corrections for platform-specific appearance controls
// and keyboard hints. Applied after theme-renderer-patches.mjs, which owns
// the complete Follow Omarchy row integration and placement.

export const menuRendererChanges = [
  ['hide native macOS font smoothing control off macOS',
    'je=c.jsx(ad,{control:Me,description:Fe,searchId:"appearance-font-smoothing",title:We})',
    'je=Yf?c.jsx(ad,{control:Me,description:Fe,searchId:"appearance-font-smoothing",title:We}):null'],
  ['use a generic non-Mac file manager label in the editor list',
    'label:Yf?"Finder":"File Explorer"',
    'label:Yf?"Finder":"File manager"'],
  ['use a generic non-Mac file manager label in file actions',
    'children:Yf?"Finder":"File Explorer"',
    'children:Yf?"Finder":"File manager"'],
];

export function diagnoseMenuRenderer(source) {
  const collisions = [];
  for (const [name, before] of menuRendererChanges) {
    const count = source.split(before).length - 1;
    if (count !== 1) collisions.push({ name, count });
  }
  return collisions;
}

export function patchMenuRenderer(source) {
  let result = source;
  for (const [name, before, after] of menuRendererChanges) {
    if (result.split(before).length !== 2) {
      throw new Error(`Menu renderer patch precondition failed: ${name}`);
    }
    result = result.replace(before, after);
  }
  return result;
}

export function unpatchMenuRenderer(source) {
  let result = source;
  for (const [name, before, after] of [...menuRendererChanges].reverse()) {
    if (result.split(after).length !== 2) {
      throw new Error(`Menu renderer inverse precondition failed: ${name}`);
    }
    result = result.replace(after, before);
  }
  return result;
}
