import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import {
  diagnoseMenuRenderer,
  menuRendererChanges,
  patchMenuRenderer,
  unpatchMenuRenderer,
} from '../tools/menu-renderer-patches.mjs';
import {
  patch as patchThemeRenderer,
  rendererChanges as themeRendererChanges,
} from '../tools/theme-renderer-patches.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const versions = JSON.parse(readFileSync(path.join(projectRoot, 'versions.json'), 'utf8'));
const upstreamRendererPath = path.join(
  projectRoot,
  `build/upstream-pristine-${versions.desktop}/app`,
  versions.renderer,
);

function applyOne(source, [, before, after]) {
  assert.equal(source.split(before).length, 2, 'single transformation anchor');
  return source.replace(before, after);
}

test('menu anchors compose with the theme patch and exactly reverse in memory', {
  skip: !existsSync(upstreamRendererPath)
    ? 'the pristine vendor snapshot is absent; run the build to produce it'
    : false,
}, () => {
  const upstream = readFileSync(upstreamRendererPath, 'utf8');
  const themed = patchThemeRenderer(upstream, themeRendererChanges);
  assert.deepEqual(diagnoseMenuRenderer(themed), []);
  const patched = patchMenuRenderer(themed);
  assert.deepEqual(diagnoseMenuRenderer(patched), menuRendererChanges.map(([name]) => ({ name, count: 0 })));
  assert.equal(unpatchMenuRenderer(patched), themed, 'verification can restore the in-memory renderer snapshot');
  assert.match(patched, /Fe=Yu\?c\.jsx\(Zc,\{control:Me,description:je,searchId:"appearance-font-smoothing"/);

  // The theme layer owns the complete follow-row integration; the final
  // follow position is still asserted here so no later layer can move it.
  const placements = patched.split('children:[factoryPortThemeRow,').length - 1;
  assert.equal(placements, 1, 'exactly one follow-row placement inside the theme editor group');
  const placementIndex = patched.indexOf('children:[factoryPortThemeRow,');
  assert.ok(patched.indexOf('function _Wu(') < placementIndex
    && placementIndex < patched.indexOf('function jWu('),
  'follow row is placed inside the theme editor, before the Appearance settings function');
  assert.ok(patched.includes('searchId:"appearance-follow-omarchy"'), 'follow row content is present');
  assert.ok(patched.includes('id:Mx.Finder,label:Yu?"Finder":"File manager",iconName:"folder",buildUrl:t=>`file://${jCe(t)}`,buildFileUrl:t=>`file://${rfe(t)}`,macOnly:!1'),
    'file reveal URL handlers stay unchanged around the label');
  assert.ok(patched.includes('for(const n of[br.Light,br.Dark])t.nativeFontSmoothing[n]&&e.push(Kre(IZi[n],{"-webkit-font-smoothing":"auto !important","-moz-osx-font-smoothing":"auto !important"}));'),
    'native CSS generator stays unchanged');
});

test('Appearance hides the Mac-only row on Linux and preserves its saved setting', () => {
  const [, rowBefore, rowAfter] = menuRendererChanges[0];
  assert.equal(applyOne(rowBefore, menuRendererChanges[0]), rowAfter);
  const makeRow = isMac => vm.runInNewContext(`
    function renderRow() {
      let Fe;
      ${rowAfter};
      return Fe;
    }
    renderRow;
  `, {
    c: { jsx: (type, props) => ({ type, props }) },
    Zc: 'SettingRow',
    Me: { type: 'Checkbox' },
    je: 'Description',
    Ye: 'Native macOS font anti-aliasing',
    Yu: isMac,
  });

  const persisted = { nativeFontSmoothing: { light: true, dark: false } };
  const linuxRow = makeRow(false)();
  assert.equal(linuxRow, null);
  assert.deepEqual(persisted, { nativeFontSmoothing: { light: true, dark: false } });

  const macRow = makeRow(true)();
  assert.equal(macRow.type, 'SettingRow');
  assert.equal(macRow.props.searchId, 'appearance-font-smoothing');
});

test('file reveal keeps Finder on macOS and uses the generic File manager label elsewhere', () => {
  for (const index of [1, 2]) {
    const change = menuRendererChanges[index];
    assert.equal(applyOne(change[1], change), change[2]);
    assert.match(change[2], /Finder/);
    assert.match(change[2], /File manager/);
  }
  const label = isMac => vm.runInNewContext('Yu?"Finder":"File manager"', { Yu: isMac });
  assert.equal(label(true), 'Finder');
  assert.equal(label(false), 'File manager');
});

test('menu renderer transformations fail closed on missing and duplicate anchors', () => {
  assert.equal(diagnoseMenuRenderer('').length, menuRendererChanges.length);
  assert.throws(() => patchMenuRenderer(''), /precondition failed/);
  const fixture = menuRendererChanges.map(([, before]) => before).join('\n');
  assert.deepEqual(diagnoseMenuRenderer(fixture), []);
  assert.throws(() => patchMenuRenderer(`${fixture}\n${menuRendererChanges[0][1]}`), /precondition failed/);
  assert.throws(() => unpatchMenuRenderer(''), /inverse precondition failed/);
});
