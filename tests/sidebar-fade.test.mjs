import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import vm from 'node:vm';
import { patch } from '../tools/theme-renderer-patches.mjs';
import { factoryPortUpdateSidebarMask, sidebarFadeChanges, sidebarMaskCss } from '../tools/sidebar-fade-patches.mjs';
import { sidebarFadeFixtureSource } from './sidebar-fade-smoke.mjs';

const upstreamFile = new URL('../build/upstream-pristine-0.206.0/app/.vite/renderer/main_window/assets/index-DTd1u_pI.js', import.meta.url);
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
  const component = source.slice(source.indexOf('function yQe('), source.indexOf('function XGr('));
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
  vm.runInNewContext(`${factoryPortUpdateSidebarMask.toString()};${component};yQe(props)`, {
    props: { orientation: 'vertical', viewportRef: { current: element } },
    z: { c: () => [] },
    L: { useState: () => [{ start: false, end: false }, () => {}], Fragment: 'fragment' },
    c: { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: 'fragment' },
    VGr: [], YGr: 'edge', JGr: 'edge-color', WGr: [],
    qGr: { vertical: { start: 'top', end: 'bottom' } },
    QTn: 1,
    Xt: effect => { cleanup = effect(); }, ResizeObserver, MutationObserver,
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
  assert.ok(updated.includes('k7t=[{offset:0,opacity:1},{offset:1,opacity:0}]'));
  assert.ok(updated.includes('colorStops:k7t,orientation:"vertical",scrollbarInset:"0px",size:Z3e,surface:w.bg.page,testIdPrefix:"payment-panel"'));
  assert.ok(updated.includes('colorStops:k7t,orientation:"vertical",scrollbarInset:$uo,size:Z3e,surface:w.bg.surface,testIdPrefix:"session-list"'));
  for (const [, before, after] of [...sidebarFadeChanges].reverse()) updated = updated.replace(after, before);
  assert.equal(updated, source);
});

// The bundle aliases are minified, so the session list is traced through the
// real call site instead of trusting an alias name: the component that owns
// `testIdPrefix:"session-list"`, the styled root it renders, the Radix
// viewport it hands the ref to, and the overlay component it configures.

function functionBody(source, start) {
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < source.length; index++) {
    const character = source[index];
    if (character === '"' || character === "'" || character === '`') {
      const quote = character;
      for (index++; index < source.length && source[index] !== quote; index++) {
        if (source[index] === '\\') index++;
      }
      continue;
    }
    if (character === '{') depth++;
    else if (character === '}') {
      depth--;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error('unterminated function body');
}

function styledBase(source, alias) {
  return new RegExp(`${alias}=J\\(([A-Za-z0-9_$]+)\\)`).exec(source)?.[1];
}

function traceSessionList(source) {
  const call = source.indexOf('testIdPrefix:"session-list"');
  assert.ok(call > 0, 'the session-list overlay call site exists');
  const declaration = source.lastIndexOf('function ', call);
  const wrapper = /function ([A-Za-z0-9_$]+)\(/.exec(source.slice(declaration))?.[1];
  assert.ok(wrapper, 'a component renders the session-list overlay');
  const body = functionBody(source, source.indexOf(`function ${wrapper}(`));
  assert.ok(body.includes('testIdPrefix:"session-list"'), 'the traced body owns the call site');
  const roots = [...body.matchAll(/c\.jsxs\(([A-Za-z0-9_$]+),\{/g)].map(match => match[1]);
  assert.equal(roots.length, 1, 'the wrapper renders exactly one styled root');
  const rendered = [...body.matchAll(/c\.jsx\(([A-Za-z0-9_$]+),\{([^{}]*)\}/g)]
    .map(match => ({ alias: match[1], props: match[2] }));
  const viewport = rendered.find(entry => entry.props.includes('ref:'));
  const overlay = rendered.find(entry => entry.props.includes('testIdPrefix:"session-list"'));
  assert.ok(viewport, 'the wrapper renders the Radix viewport');
  assert.ok(overlay, 'the wrapper renders the session-list overlay');
  const aliases = [...body.matchAll(/c\.jsx(?:s)?\(([A-Za-z0-9_$]+),/g)].map(match => match[1]);
  return {
    wrapper, body, root: roots[0], viewport: viewport.alias, overlay: overlay.alias,
    aliases: [...new Set(aliases)],
  };
}

// The real wrapper, executed with narrowly mocked hooks, so the traced root
// and the traced viewport come from the shipped bundle and not from a mock.
function renderSessionList(trace) {
  const context = {
    z: { c: count => Array(count).fill(Symbol.for('react.memo_cache_sentinel')) },
    L: { useState: initial => [initial, () => {}], Fragment: 'fragment' },
    c: { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: 'fragment' },
    k7t: [{ offset: 0, opacity: 1 }, { offset: 1, opacity: 0 }],
    $uo: '0px', Z3e: '40px',
    w: { bg: { surface: '#000000' } },
  };
  for (const alias of trace.aliases) context[alias] = { [alias]: function () {} }[alias];
  const viewportRef = { current: null };
  context.viewportRef = viewportRef;
  const tree = vm.runInNewContext(`${trace.body};${trace.wrapper}({children:"rows",viewportRef})`, context);
  return { tree, viewportRef };
}

function toDom(node) {
  const element = { type: node.type.name, props: node.props, attrs: {}, children: [], parent: null };
  const children = node.props.children;
  for (const child of Array.isArray(children) ? children : children === undefined ? [] : [children]) {
    if (!child || typeof child !== 'object') continue;
    const childElement = toDom(child);
    childElement.parent = element;
    element.children.push(childElement);
  }
  element.closest = selector => {
    const attribute = selector.slice(1, -1);
    for (let current = element; current; current = current.parent) {
      if (attribute in current.attrs) return current;
    }
    return null;
  };
  return element;
}

function findElement(element, type) {
  if (element.type === type) return element;
  for (const child of element.children) {
    const found = findElement(child, type);
    if (found) return found;
  }
  return null;
}

function markedAliases(patched) {
  return [...patched.matchAll(/([A-Za-z0-9_$]+)=J\([A-Za-z0-9_$]+\)\.attrs\(\{"data-factory-port-sidebar-scroll":!0\}\)/g)]
    .map(match => match[1]);
}

function assertSessionListRootMarked(patched, trace) {
  const marked = markedAliases(patched);
  assert.deepEqual(marked, [trace.root], `only the session-list root ${trace.root} may carry the marker`);
  const base = styledBase(patched, trace.root);
  assert.ok(base, 'the session-list root is a styled component');
  assert.ok(patched.includes(`${trace.root}=J(${base}).attrs({"data-factory-port-sidebar-scroll":!0})\``));
  const marker = patched.indexOf(`${trace.root}=J(${base}).attrs(`);
  const css = patched.indexOf(sidebarMaskCss);
  assert.ok(css > marker && css - marker < 400, 'the mask CSS belongs to the marked root');
}

function assertSmokeMountsWrapper(fixture, trace) {
  assert.ok(fixture.includes(`c.jsx(${trace.wrapper},{`), `the smoke must mount the session-list wrapper ${trace.wrapper}`);
  assert.ok(fixture.includes('viewportRef:'), 'the smoke must pass the viewport ref to the wrapper');
  assert.ok(fixture.includes('children:'), 'the smoke must pass the session rows to the wrapper');
  assert.ok(!fixture.includes(`c.jsx(${trace.overlay},{`), `the smoke must not mount the overlay ${trace.overlay} directly`);
}

test('the marker sits on the root the real session-list wrapper renders', vendorOptions, () => {
  const source = readFileSync(upstreamFile, 'utf8');
  const trace = traceSessionList(source);
  const patched = patch(source, sidebarFadeChanges);
  assertSessionListRootMarked(patched, trace);

  const { tree, viewportRef } = renderSessionList(trace);
  assert.equal(tree.type.name, trace.root, 'the wrapper renders the traced root');
  const root = toDom(tree);
  const viewport = findElement(root, trace.viewport);
  assert.ok(viewport, 'the wrapper renders the Radix viewport');
  assert.equal(viewport.parent.type, trace.root, 'the viewport is a descendant of the session-list root');
  const overlay = findElement(root, trace.overlay);
  assert.equal(overlay.props.orientation, 'vertical', 'the wrapper configures the overlay orientation');
  assert.equal(overlay.props.testIdPrefix, 'session-list');
  assert.equal(overlay.props.viewportRef, viewportRef);

  // The production guard finds the marked ancestor in the rendered tree, so
  // the real viewport receives the mask depths.
  const marked = findElement(root, trace.root);
  assert.ok(marked, 'the marked root is part of the rendered tree');
  marked.attrs['data-factory-port-sidebar-scroll'] = '';
  const values = new Map();
  viewport.clientHeight = 400;
  viewport.style = { setProperty: (key, value) => values.set(key, value) };
  factoryPortUpdateSidebarMask(viewport, 100, 1000);
  assert.deepEqual([...values], [
    ['--factory-port-sidebar-top-fade', '40px'],
    ['--factory-port-sidebar-bottom-fade', '40px'],
  ]);
});

test('the sidebar smoke mounts the same session-list wrapper the patch targets', vendorOptions, () => {
  const source = readFileSync(upstreamFile, 'utf8');
  const trace = traceSessionList(source);
  assertSmokeMountsWrapper(sidebarFadeFixtureSource(), trace);
});

test('negative controls: a shared scroll root and an overlay-only fixture are rejected', vendorOptions, () => {
  const source = readFileSync(upstreamFile, 'utf8');
  const trace = traceSessionList(source);
  const base = styledBase(source, trace.root);
  const shared = [...source.matchAll(new RegExp(`([A-Za-z0-9_$]+)=J\\(${base}\\)`, 'g'))]
    .map(match => match[1])
    .filter(alias => alias !== trace.root);
  assert.ok(shared.length, 'the bundle has another scroll-area root with the same base');

  // The pre-fix recipe marked a shared scroll-area root. It is not part of
  // the session-list tree, so the real viewport keeps no marked ancestor and
  // the mask stays inactive.
  for (const wrongRoot of shared) {
    const wrongChanges = sidebarFadeChanges.map(([name, before, after]) => (
      before.startsWith(`${trace.root}=J(`)
        ? [name, `${wrongRoot}=J(${base})`, after.replace(`${trace.root}=J(${base})`, `${wrongRoot}=J(${base})`)]
        : [name, before, after]
    ));
    const wrongPatched = patch(source, wrongChanges);
    assert.throws(() => assertSessionListRootMarked(wrongPatched, trace), /session-list root/);
    const { tree } = renderSessionList(trace);
    const root = toDom(tree);
    assert.equal(findElement(root, wrongRoot), null, 'the shared root is not part of the session-list tree');
    const viewport = findElement(root, trace.viewport);
    const values = new Map();
    viewport.clientHeight = 400;
    viewport.style = { setProperty: (key, value) => values.set(key, value) };
    factoryPortUpdateSidebarMask(viewport, 100, 1000);
    assert.equal(values.size, 0, 'the real viewport has no marked ancestor');
  }

  // The pre-fix fixture mounted the overlay component. That component reads
  // an orientation it never receives and renders no viewport at all.
  const fixture = sidebarFadeFixtureSource();
  const wrongFixture = fixture.replace(`c.jsx(${trace.wrapper},{`, `c.jsx(${trace.overlay},{`);
  assert.ok(wrongFixture.includes(`c.jsx(${trace.overlay},{`), 'the control fixture mounts the overlay component');
  assert.ok(!wrongFixture.includes(`c.jsx(${trace.wrapper},{`), 'the control fixture mounts no session-list wrapper');
  assert.throws(() => assertSmokeMountsWrapper(wrongFixture, trace), /wrapper/);

  const overlayBody = functionBody(source, source.indexOf(`function ${trace.overlay}(`));
  const overlayContext = {
    z: { c: count => Array(count).fill(Symbol.for('react.memo_cache_sentinel')) },
    L: { useState: initial => [initial, () => {}], Fragment: 'fragment' },
    c: { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: 'fragment' },
    VGr: ['start', 'end'], WGr: [],
    YGr: 'edge', JGr: 'edge-color',
    qGr: { vertical: { start: 'top', end: 'bottom' }, horizontal: { start: 'left', end: 'right' } },
    Xt: () => {},
  };
  assert.throws(
    () => vm.runInNewContext(`${overlayBody};${trace.overlay}({viewportRef:{current:null},children:"rows"})`, overlayContext),
    error => error.name === 'TypeError' && error.message.includes('start'),
  );
  const withOrientation = vm.runInNewContext(
    `${overlayBody};${trace.overlay}({viewportRef:{current:null},children:"rows",orientation:"vertical"})`,
    overlayContext,
  );
  assert.ok(!JSON.stringify(withOrientation).includes('rows'), 'the overlay component discards the session rows');
});
