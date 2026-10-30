import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import vm from 'node:vm';
import { glassyNavigationChanges, glassyNavigationCss } from '../tools/glassy-navigation-patches.mjs';
import { patch, rendererChanges } from '../tools/theme-renderer-patches.mjs';
import { navigationFixtureSource } from './glassy-navigation-smoke.mjs';

const versions = JSON.parse(readFileSync(new URL('../versions.json', import.meta.url), 'utf8'));
const vendor = new URL(`../build/upstream-pristine-${versions.desktop}/app/.vite/renderer/main_window/assets/`, import.meta.url);
const renderer = new URL(versions.renderer.split('/').pop(), vendor);

test('navigation transparency is restricted to structural painters inside the sidebar', () => {
  const selectors = glassyNavigationCss.slice(0, glassyNavigationCss.indexOf('{')).trim().split(',').map(s => s.trim());
  assert.equal(selectors.length, 5);
  assert.ok(selectors.every(selector => selector.startsWith('[data-sidebar-visible] [')));
  assert.match(glassyNavigationCss, /background-color: transparent !important/);
  assert.doesNotMatch(glassyNavigationCss, /opacity|filter|--core-v2-bg|input|button|dialog|popover/);
});

test('actual appearance atom appends navigation CSS only inside the existing Glassy gate', () => {
  const change = rendererChanges.find(([name]) => name === 'derive palette tokens without changing stored Factory settings');
  const glass = Symbol('glass'), snapshot = Symbol('snapshot');
  const { S0i, TMe } = vm.runInNewContext(change[2].replace(/,$/, ';') + '({S0i,TMe})', {
    LDe: () => ({}), Sod: {}, wk: {}, UGr: {},
    cs: value => typeof value === 'function' ? value : { initial: value },
    SK: Symbol('SK'), $r: { Dark: 'dark', Light: 'light' },
    p0e: () => ({}), rWr: () => 'base;',
    factoryPortOverlayAppearance: (base) => base,
    factoryPortThemeActive: Symbol('active'),
    factoryPortThemeEmpty: {},
    factoryPortGlassActive: glass, factoryPortThemeSnapshot: snapshot,
    factoryPortNavigationGlassCss: glassyNavigationCss,
    factoryPortGlassCss: () => 'glass;',
  });
  const get = (enabled, active) => atom => atom === TMe ? enabled : atom === glass ? active : {};
  assert.equal(S0i(get(false, true)), '');
  assert.equal(S0i(get(true, false)), 'base;');
  assert.equal(S0i(get(true, true)), 'base;glass;' + glassyNavigationCss);
});

test('pinned settings component is marked without altering its routing, search or control logic', {
  skip: !existsSync(renderer),
}, () => {
  const source = readFileSync(renderer, 'utf8');
  const updated = patch(source, glassyNavigationChanges);
  const [, before, after] = glassyNavigationChanges[0];
  assert.equal(updated.replace(after, before), source);
  const css = readFileSync(new URL(versions.rendererCss.split('/').pop(), vendor), 'utf8');
  for (const selector of ['data-analytics-nav-root-v2', 'data-wiki-nav-pane-v2', 'data-academy-nav-root-v2']) {
    assert.ok(css.includes(`[${selector}]{display:flex;flex:1;flex-direction:column;min-height:0;background:var(--core-v2-bg-surface)}`));
  }
  assert.ok(source.includes('c.jsxs(z,{...oe,bg:se,"data-software-factory-nav-v2":ce,direction:ue,flex:Ae,height:be'),
    'Software Factory has its own surface painter too');
});

test('test-only settings layout adapters retain valid renderer syntax', {
  skip: !existsSync(renderer),
}, () => {
  assert.doesNotThrow(() => new vm.Script(navigationFixtureSource(readFileSync(renderer, 'utf8'))));
});
