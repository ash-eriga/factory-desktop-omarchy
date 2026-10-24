import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import vm from 'node:vm';
import { glassyNavigationChanges, glassyNavigationCss } from '../tools/glassy-navigation-patches.mjs';
import { patch, rendererChanges } from '../tools/theme-renderer-patches.mjs';
import { navigationFixtureSource } from './glassy-navigation-smoke.mjs';

const vendor = new URL('../build/upstream-pristine-0.205.0/app/.vite/renderer/main_window/assets/', import.meta.url);
const renderer = new URL('index-Czx_74nj.js', vendor);

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
  const { Wni, V5e } = vm.runInNewContext(change[2].replace(/,$/, ';') + '({Wni,V5e})', {
    c4e: () => ({}), ZRc: {}, Qx: {}, ITr: {},
    as: value => typeof value === 'function' ? value : { initial: value },
    factoryPortGlassActive: glass, factoryPortThemeSnapshot: snapshot,
    factoryPortNavigationGlassCss: glassyNavigationCss,
    HTr: () => 'base;', factoryPortGlassCss: () => 'glass;',
  });
  const get = (enabled, active) => atom => atom === V5e ? enabled : atom === glass ? active : {};
  assert.equal(Wni(get(false, true)), '');
  assert.equal(Wni(get(true, false)), 'base;');
  assert.equal(Wni(get(true, true)), 'base;glass;' + glassyNavigationCss);
});

test('pinned settings component is marked without altering its routing, search or control logic', {
  skip: !existsSync(renderer),
}, () => {
  const source = readFileSync(renderer, 'utf8');
  const updated = patch(source, glassyNavigationChanges);
  const [, before, after] = glassyNavigationChanges[0];
  assert.equal(updated.replace(after, before), source);
  const css = readFileSync(new URL('index-CqyrAZ3T.css', vendor), 'utf8');
  for (const selector of ['data-analytics-nav-root-v2', 'data-wiki-nav-pane-v2', 'data-academy-nav-root-v2']) {
    assert.ok(css.includes(`[${selector}]{display:flex;flex:1;flex-direction:column;min-height:0;background:var(--core-v2-bg-surface)}`));
  }
  assert.ok(source.includes('Q=G,oe=f,de=w.bg.surface,le=!0,ae="column",ue=1,Se="100%"'),
    'Software Factory has its own surface painter too');
});

test('test-only settings layout adapters retain valid renderer syntax', {
  skip: !existsSync(renderer),
}, () => {
  assert.doesNotThrow(() => new vm.Script(navigationFixtureSource(readFileSync(renderer, 'utf8'))));
});
