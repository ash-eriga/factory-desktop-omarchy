import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import vm from 'node:vm';
import { patch } from '../tools/theme-renderer-patches.mjs';
import { factoryPortUpdateSidebarMask, sidebarFadeChanges, sidebarMaskCss } from '../tools/sidebar-fade-patches.mjs';

const upstreamFile = new URL('../build/upstream-pristine-0.205.0/app/.vite/renderer/main_window/assets/index-Czx_74nj.js', import.meta.url);
const vendorOptions = { skip: existsSync(upstreamFile) ? false : 'the pristine vendor snapshot is absent; run the build to produce it' };

function viewport(scoped = true, height = 600) {
  const values = new Map();
  return {
    values, clientHeight: height, scrollHeight: height + 1000, scrollTop: 0,
    closest: selector => scoped && selector === '[data-factory-port-sidebar-scroll]' ? {} : null,
    style: { setProperty: (key, value) => values.set(key, value) },
  };
}
const depths = element => ['top', 'bottom'].map(edge =>
  element.values.get(`--factory-port-sidebar-${edge}-fade`));

test('sidebar mask grows with the clipped distance instead of popping to full height', () => {
  const element = viewport();
  for (const [offset, expected] of [
    [0, ['0px', '40px']], [1, ['1px', '40px']], [7.5, ['7.5px', '40px']],
    [500, ['40px', '40px']], [999, ['40px', '1px']], [1000, ['40px', '0px']],
  ]) {
    factoryPortUpdateSidebarMask(element, offset, 1000);
    assert.deepEqual(depths(element), expected);
  }
  factoryPortUpdateSidebarMask(element, 0, 0);
  assert.deepEqual(depths(element), ['0px', '0px']);
});

test('sidebar mask clamps overscroll and leaves an opaque center in short viewports', () => {
  const element = viewport(true, 20);
  factoryPortUpdateSidebarMask(element, 500, 1000);
  assert.deepEqual(depths(element), ['5px', '5px']);
  factoryPortUpdateSidebarMask(element, -5, 1000);
  assert.deepEqual(depths(element), ['0px', '5px']);
  factoryPortUpdateSidebarMask(element, 1010, 1000);
  assert.deepEqual(depths(element), ['5px', '0px']);
});

test('unrelated scroll areas receive no mask styles; CSS masks content and suppresses only session overlays', () => {
  const element = viewport(false);
  factoryPortUpdateSidebarMask(element, 500, 1000);
  assert.equal(element.values.size, 0);
  assert.match(sidebarMaskCss, /@supports \(mask-image:/);
  assert.match(sidebarMaskCss, /transparent 0px/);
  assert.match(sidebarMaskCss, /transparent 100%/);
  assert.doesNotMatch(sidebarMaskCss, /backdrop-filter|background:|opacity:/);
  for (const edge of ['top', 'bottom']) {
    assert.ok(sidebarMaskCss.includes(`session-list-${edge}-fade"`));
    assert.ok(sidebarMaskCss.includes(`session-list-${edge}-fade-color"`));
  }
});

test('actual upstream observer updates mask depths on scroll/resize/mutation and cleans up', vendorOptions, () => {
  const source = patch(readFileSync(upstreamFile, 'utf8'), sidebarFadeChanges);
  const component = source.slice(source.indexOf('function IUe('), source.indexOf('function $Ur('));
  const element = viewport(), listeners = new Map(), callbacks = {};
  let cleanup, disconnected = 0;
  element.firstElementChild = { children: [] };
  element.addEventListener = (type, fn) => listeners.set(type, fn);
  element.removeEventListener = type => listeners.delete(type);
  class ResizeObserver {
    constructor(fn) { callbacks.resize = fn; }
    observe() {}
    disconnect() { disconnected++; }
  }
  class MutationObserver {
    constructor(fn) { callbacks.mutation = fn; }
    observe() {}
    disconnect() { disconnected++; }
  }
  vm.runInNewContext(`${factoryPortUpdateSidebarMask.toString()};${component};IUe(props)`, {
    props: { orientation: 'vertical', viewportRef: { current: element } },
    z: { c: () => [] }, P: { useState: () => [{ start: false, end: false }, () => {}], Fragment: 'fragment' },
    c: { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: 'fragment' },
    PUr: [],
    BUr: ['start', 'end'], NUr: { vertical: { start: 'top', end: 'bottom' } },
    FUr: 'blur', UUr: 'color', '$_n': 1,
    Zt: effect => { cleanup = effect(); }, ResizeObserver, MutationObserver,
  });
  assert.deepEqual(depths(element), ['0px', '40px']);
  element.scrollTop = 2;
  listeners.get('scroll')();
  assert.deepEqual(depths(element), ['2px', '40px']);
  element.clientHeight = 20;
  callbacks.resize();
  assert.deepEqual(depths(element), ['2px', '5px']);
  element.scrollHeight = element.clientHeight;
  element.scrollTop = 0;
  callbacks.mutation();
  assert.deepEqual(depths(element), ['0px', '0px']);
  cleanup();
  assert.equal(listeners.size, 0);
  assert.ok(disconnected >= 2);
});

test('only two exact source anchors change; shared colors, sizes and other call sites stay original', vendorOptions, () => {
  const source = readFileSync(upstreamFile, 'utf8');
  let updated = patch(source, sidebarFadeChanges);
  assert.ok(updated.includes('m8t=[{offset:0,opacity:1},{offset:1,opacity:0}]'));
  assert.ok(updated.includes('colorStops:m8t,orientation:"vertical",scrollbarInset:"0px",size:k3e,surface:w.bg.page,testIdPrefix:"payment-panel"'));
  assert.ok(updated.includes('colorStops:m8t,orientation:"vertical",scrollbarInset:plo,size:k3e,surface:w.bg.surface,testIdPrefix:"session-list"'));
  for (const [, before, after] of [...sidebarFadeChanges].reverse()) updated = updated.replace(after, before);
  assert.equal(updated, source);
});
