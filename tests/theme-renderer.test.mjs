import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import {
  cssChanges,
  diagnose,
  diagnoseThemeHtmlCollisions,
  diagnoseThemeHelperCollisions,
  diagnoseThemePreloadCollisions,
  htmlChanges,
  patch,
  preloadChanges,
  rendererChanges,
  rendererHelpers,
} from '../tools/theme-renderer-patches.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const versions = JSON.parse(readFileSync(path.join(projectRoot, 'versions.json'), 'utf8'));
const upstreamAppRoot = path.join(projectRoot, 'build/upstream-pristine-0.206.0/app');
const rendererPath = path.join(upstreamAppRoot, versions.renderer);
const preloadPath = path.join(upstreamAppRoot, '.vite/build/preload.js');
const htmlPath = path.join(upstreamAppRoot, versions.rendererHtml);

function evaluateHelpers({ locale = 'en-US' } = {}) {
  const values = new Map([
    ['factory-app-startup-locale', locale],
  ]);
  const context = vm.createContext({
    localStorage: {
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value)),
      removeItem: key => values.delete(key),
    },
    navigator: { language: locale },
    c: { jsx: (type, props) => ({ type, props }) },
    ia: 'Checkbox',
    Kc: 'SettingRow',
  });
  const result = vm.runInContext(
    `${rendererHelpers}\n({normalize:factoryPortNormalizeTheme,overlay:factoryPortOverlayAppearance,buildRow:factoryPortBuildThemeRow,glassCss:factoryPortGlassCss,sync:factoryPortSyncNativeFollow})`,
    context,
  );
  return { ...result, values, context };
}

function executeCachedBootstrap({ values, hasApi = true, systemDark = true }) {
  const context = vm.createContext({
    localStorage: {
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value)),
      removeItem: key => values.delete(key),
    },
    window: {
      electronAPI: hasApi ? { theme: { getOmarchy() {} } } : undefined,
      matchMedia: () => ({ matches: systemDark }),
    },
  });
  const sourceSelection = htmlChanges[0][2];
  const backgroundSelection = htmlChanges[1][2];
  return vm.runInContext(`
    var STORAGE_KEY='factory-theme-preference';
    var APPEARANCE_BACKGROUNDS_KEY='factory-appearance-startup-backgrounds';
    ${sourceSelection}
    ${backgroundSelection}
    var backgroundColor=appearanceBackground||(theme==='dark'?'#161413':'#f2f0f0');
    ({theme,appearanceBackground,backgroundColor});
  `, context);
}

const upstreamMissing = !existsSync(rendererPath) || !existsSync(preloadPath) || !existsSync(htmlPath)
  ? 'the pristine vendor snapshot is absent; run the build to produce it' : false;

test('all renderer, preload and HTML anchors match the pinned 0.206.0 upstream exactly once', { skip: upstreamMissing }, () => {
  const renderer = readFileSync(rendererPath, 'utf8');
  const preload = readFileSync(preloadPath, 'utf8');
  const html = readFileSync(htmlPath, 'utf8');
  assert.deepEqual(diagnose(renderer, rendererChanges), []);
  assert.deepEqual(diagnose(preload, preloadChanges), []);
  assert.deepEqual(diagnose(html, htmlChanges), []);
  assert.deepEqual(diagnoseThemeHelperCollisions(renderer), []);
  assert.deepEqual(diagnoseThemePreloadCollisions(preload), []);
  assert.deepEqual(diagnoseThemeHtmlCollisions(html), []);

  const patchedRenderer = patch(renderer, rendererChanges);
  const patchedPreload = patch(preload, preloadChanges);
  const patchedHtml = patch(html, htmlChanges);
  assert.ok(patchedRenderer.includes('Follow Omarchy theme'), 'Appearance control was added');
  assert.ok(patchedPreload.includes('factory-linux-theme:get'), 'preload bridge was added');
  assert.ok(patchedPreload.includes('factory-linux-theme:follow'), 'preload native follow channel was added');
  assert.ok(patchedPreload.includes('setOmarchyFollow:n=>typeof n!=="boolean"?Promise.resolve(!1)'), 'preload follow rejects non-boolean input without invoking');
  assert.ok(patchedHtml.includes('factory-port-theme-cache'), 'first-paint cache was added');
  assert.ok(patchedRenderer.includes('factoryPortGlassCss(t(factoryPortThemeSnapshot))'),
    'override CSS appends the glass tint from the followed snapshot');
  assert.ok(patchedRenderer.includes('t(factoryPortNativeFollowAccepted)===!0'),
    'glass tint is gated on the accepted native follow opt-in');
  assert.ok(patchedRenderer.includes('factoryPortSyncNativeFollow(i,!1)'),
    'ThemeSync cleanup always clears the native follow opt-in');
  assert.ok(patchedRenderer.includes('const f=i.sub(factoryPortThemeFollow,g)'),
    'ThemeSync subscribes the follow atom for live native follow sync');
  assert.throws(() => patch(`${renderer}${rendererChanges[0][1]}`, rendererChanges));
});

test('follow row is placed inside the theme editor before the preset row with exact memo-cache slots', { skip: upstreamMissing }, () => {
  const renderer = readFileSync(rendererPath, 'utf8');
  const patched = patch(renderer, rendererChanges);

  // pCu (Appearance screen) grows its cache only for the follow state hooks
  // and the three new prop dependencies of the editor call site.
  assert.ok(patched.includes(
    'function pCu(){const t=z.c(235),{t:e}=ce("settings"),[n,i]=cs(Ske),'
    + '[factoryPortFollow,setFactoryPortFollow]=cs(factoryPortThemeFollow),'
    + '[factoryPortState]=cs(factoryPortThemeSnapshot),'
    + '{theme:o,themePreference:s,setThemePreference:r}=bD(),',
  ), 'pCu reads the follow atoms and grew its memo cache from 232 to 235');
  assert.ok(patched.includes(
    't[29]!==a||t[30]!==l||t[31]!==m||t[32]!==k||t[232]!==factoryPortFollow'
    + '||t[233]!==factoryPortState||t[234]!==setFactoryPortFollow'
    + '?(R=c.jsx(iCu,{mode:a,onChange:k,onChoose:m,theme:l,factoryPortFollow,'
    + 'factoryPortState,setFactoryPortFollow},a)',
  ), 'the editor call site declares all follow prop dependencies');
  assert.ok(!patched.includes('function pCu(){const t=z.c(232),'), 'stale pCu cache size removed');

  // iCu (theme editor) receives the props, grows its cache, memoizes the row
  // and places it as the first child, immediately before the preset row.
  assert.ok(patched.includes(
    'function iCu(t){const e=z.c(211),{mode:n,onChange:i,onChoose:o,theme:s,'
    + 'factoryPortFollow,factoryPortState,setFactoryPortFollow}=t,{t:r}=ce("settings"),',
  ), 'iCu receives the follow props and grew its memo cache from 206 to 211');
  assert.ok(patched.includes(
    'const{palette:b}=v;let factoryPortThemeRow;e[206]!==factoryPortFollow'
    + '||e[207]!==factoryPortState||e[208]!==setFactoryPortFollow'
    + '?(factoryPortThemeRow=factoryPortBuildThemeRow(factoryPortFollow,factoryPortState,'
    + 'setFactoryPortFollow),e[206]=factoryPortFollow,e[207]=factoryPortState,'
    + 'e[208]=setFactoryPortFollow,e[209]=factoryPortThemeRow):factoryPortThemeRow=e[209];'
    + 'let C;if(e[11]!==n||e[12]!==s.preset){',
  ), 'the row is memoized from its three controlled props before the preset options memo');
  assert.ok(patched.includes(
    'e[188]!==Xe||e[210]!==factoryPortThemeRow'
    + '?(ct=c.jsxs($g,{children:[factoryPortThemeRow,ee,te,Se,ve,be,we,_e,Ee,Fe,He,Xe]})',
  ), 'the follow row renders immediately before the preset row inside the editor');
  assert.ok(!patched.includes('function iCu(t){const e=z.c(206),'), 'stale iCu cache size removed');

  // The screen-level fragment stays untouched: the row lives only in the editor.
  assert.ok(patched.includes(
    'Et=c.jsxs(c.Fragment,{children:[T,R,We,Rt,Pt]}),t[226]=T,t[227]=R,t[228]=We,t[229]=Rt,t[230]=Pt,t[231]=Et',
  ), 'the Appearance screen fragment keeps its original children and return cache');
  assert.equal(patched.split('factoryPortBuildThemeRow(factoryPortFollow').length - 1, 1,
    'the row is built from exactly one call site');
});

test('renderer snapshot store lets a newer live event win over initial IPC and cleans up', async () => {
  const storeSetup = rendererChanges[0][2].slice(0, rendererChanges[0][2].lastIndexOf('XWe.onMount='));
  const values = new Map([
    ['factory-port-theme-source', 'omarchy'],
    ['factory-port-theme-cache', JSON.stringify({
      available: true, mode: 'dark', background: '#101010', foreground: '#eeeeee', accent: '#ff6600', revision: 'cached',
    })],
  ]);
  let resolveInitial;
  let eventListener;
  let unsubscribeCount = 0;
  const updates = [];
  const api = {
    getOmarchy: () => new Promise(resolve => { resolveInitial = resolve; }),
    onOmarchyChanged: callback => { eventListener = callback; return () => { unsubscribeCount++; }; },
  };
  const atoms = [];
  const fs = initial => {
    const atom = { value: initial, onMount: null };
    atoms.push(atom);
    return atom;
  };
  const jne = (key, initial, storage) => ({ key, initial, storage });
  const context = vm.createContext({
    localStorage: {
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value)),
      removeItem: key => values.delete(key),
    },
    navigator: { language: 'en-US' },
    window: { electronAPI: { theme: api } },
    fs, jne, wMc: () => ({}),
  });
  vm.runInContext(`${storeSetup}\nglobalThis.__snapshot = factoryPortThemeSnapshot;`, context);
  const snapshot = context.__snapshot;
  const cleanup = snapshot.onMount(value => { snapshot.value = value; updates.push(value); });
  await Promise.resolve();
  assert.equal(typeof resolveInitial, 'function', 'initial IPC request was started');

  eventListener({
    available: true, mode: 'light', background: '#f0f0f0', foreground: '#111111', accent: '#0088ff', revision: 'live-2',
  });
  resolveInitial({
    available: true, mode: 'dark', background: '#101010', foreground: '#eeeeee', accent: '#ff6600', revision: 'old-1',
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(snapshot.value.revision, 'live-2');
  assert.equal(updates.length, 1, 'stale initial response did not overwrite the live event');
  assert.equal(JSON.parse(values.get('factory-port-theme-cache')).revision, 'live-2');

  eventListener({ available: false });
  assert.equal(snapshot.value.available, false);
  assert.equal(values.has('factory-port-theme-cache'), false, 'unavailable source clears stale first-paint cache');
  cleanup();
  assert.equal(unsubscribeCount, 1);
  eventListener({ available: true, mode: 'dark', background: '#000000', foreground: '#ffffff', accent: '#00ff00', revision: 'late' });
  assert.equal(snapshot.value.available, false, 'unmounted store ignores later events');
});

// Minimal jotai-shaped store: primitive atoms hold values, derived atoms
// re-evaluate on every read, atomWithStorage persists through its storage.
function miniAtomStore() {
  const values = new Map();
  const getters = new Map();
  const subs = new Map();
  const storages = new Map();
  const fs = initial => {
    const atom = Symbol('atom');
    if (typeof initial === 'function') getters.set(atom, initial); else values.set(atom, initial);
    subs.set(atom, []);
    return atom;
  };
  const jne = (key, initial, storage) => {
    const atom = Symbol('stored-atom');
    values.set(atom, initial);
    storages.set(atom, { key, storage });
    subs.set(atom, []);
    return atom;
  };
  const store = {
    get(atom) {
      if (getters.has(atom)) return getters.get(atom)(store.get);
      return values.get(atom);
    },
    set(atom, value) {
      values.set(atom, value);
      const record = storages.get(atom);
      if (record) { try { record.storage.setItem(record.key, value); } catch { /* test storage */ } }
      for (const listener of [...subs.get(atom) ?? []]) listener(value);
    },
    sub(atom, listener) {
      const list = subs.get(atom);
      if (!list) throw new Error(`subscribing an unknown atom: ${String(atom)}`);
      list.push(listener);
      return () => {
        const index = list.indexOf(listener);
        if (index >= 0) list.splice(index, 1);
      };
    },
  };
  return { fs, jne, store };
}

function evaluateStoreSetup(context = {}) {
  const storeSetup = rendererChanges[0][2].slice(0, rendererChanges[0][2].lastIndexOf('XWe.onMount='));
  const values = new Map();
  const vmContext = vm.createContext({
    localStorage: {
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value)),
      removeItem: key => values.delete(key),
    },
    navigator: { language: 'en-US' },
    ...context,
  });
  vm.runInContext(`${storeSetup}\nglobalThis.__port={follow:factoryPortThemeFollow,snapshot:factoryPortThemeSnapshot,accepted:factoryPortNativeFollowAccepted,glassActive:factoryPortGlassActive,source:factoryPortThemeSource};`,
    vmContext);
  return { context: vmContext, values };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const glassyPalette = {
  available: true, mode: 'dark', background: '#101019', foreground: '#eeeeee',
  accent: '#89b4fa', revision: 'glassy-1', windowMode: 'glassy',
};

test('glass tint is gated on follow, availability, the glassy windowMode and main acceptance', () => {
  const { fs, jne, store } = miniAtomStore();
  const { context, values } = evaluateStoreSetup({
    fs, jne, wMc: () => ({}),
    window: { electronAPI: { theme: { getOmarchy() {} } } },
  });
  const { follow, snapshot, accepted, glassActive } = context.__port;

  store.set(follow, true);
  assert.equal(values.get('factory-port-theme-source'), 'omarchy', 'the follow opt-in persists');
  store.set(snapshot, glassyPalette);
  assert.equal(store.get(glassActive), false, 'no glass before the trusted main accepts the opt-in');

  store.set(accepted, true);
  assert.equal(store.get(glassActive), true, 'glass activates once follow, palette, glassy and acceptance line up');

  store.set(accepted, false);
  assert.equal(store.get(glassActive), false, 'a rejected follow opt-in never paints fake transparency');

  store.set(accepted, true);
  store.set(snapshot, { ...glassyPalette, windowMode: 'transparent' });
  assert.equal(store.get(glassActive), false, 'a transparent windowMode keeps the window opaque');

  store.set(snapshot, { ...glassyPalette, windowMode: 'opaque' });
  assert.equal(store.get(glassActive), false, 'the opaque marker wins over glassy');

  store.set(snapshot, glassyPalette);
  store.set(follow, false);
  assert.equal(store.get(glassActive), false, 'turning following off immediately stops glass');
  assert.equal(values.get('factory-port-theme-source'), 'factory');
});

test('glass keeps inverted text readable by seeding an opaque page color', () => {
  const { glassCss } = evaluateHelpers();
  const css = glassCss(glassyPalette);
  assert.ok(css.includes('--factory-port-page-color:#101019'),
    'the glass scope must carry the opaque followed background so inverted text stays readable');
});

test('inverted-text color seed anchors exactly once in the pristine vendor stylesheet', { skip: upstreamMissing }, () => {
  const css = readFileSync(path.join(upstreamAppRoot, versions.rendererCss), 'utf8');
  assert.equal(css.split(cssChanges[0][1]).length - 1, 1,
    'the vendor seeds --text-inverted from the page token exactly once');
  assert.ok(!css.includes(cssChanges[0][2]),
    'the opaque fallback seed must not already exist upstream');
});

test('glass clears the native content wrapper without fading controls or all sidebar tokens', () => {
  const { glassCss } = evaluateHelpers();
  const css = glassCss(glassyPalette);
  assert.match(css, /\[data-windows-content-surface\][^{]*\{background-color:transparent!important\}/,
    'the real Linux/native-menu content wrapper must not cover the glass tint with sidebar-bg');
  assert.ok(!css.includes('--sidebar-bg:transparent'),
    'only the structural wrapper is cleared, not every sidebar-colored control or panel');
  assert.ok(!css.includes('opacity') && !css.includes('filter'));
});

test('glass clears the unscoped backdrop and full-pane border gradient while retaining a solid border', () => {
  const { glassCss } = evaluateHelpers();
  const css = glassCss(glassyPalette);
  assert.match(css, /\[data-window-backdrop-v2\]\{background-color:transparent!important\}/,
    'clear the structural backdrop even when a local legacy token remains opaque');
  assert.match(css, /\[data-windows-content-frame='true'\]\{background:rgba\(16, 16, 25, .65\)!important;border-color:var\(--border-1\)!important\}/,
    'replace the border-box gradient with exactly one content tint');
  assert.ok(!css.includes('--sidebar-bg:transparent'));
  assert.ok(!css.includes('--core-v2-bg-surface:transparent'));
  assert.equal(glassCss({ ...glassyPalette, windowMode: 'opaque' }), '');
  assert.equal(glassCss({ ...glassyPalette, windowMode: 'transparent' }), '');
});

test('Glassy Bar chrome is scoped, keeps solid control tokens and supports both palette modes', () => {
  const { glassCss } = evaluateHelpers();
  const dark = glassCss(glassyPalette);
  assert.ok(dark.includes('[data-sidebar-visible], [data-windows-title-bar-v2]{background-color:rgba(16, 16, 25, .35)!important}'));
  assert.ok(dark.includes('[data-sidebar-visible] [data-factory-port-sidebar-surface]'));
  assert.ok(dark.includes('[data-windows-title-bar-v2] [data-factory-port-titlebar-surface]'));
  assert.ok(dark.includes('--core-v2-text-primary:#eeeeee!important'));
  assert.ok(dark.includes('text-shadow:0 1px 2px rgba(0,0,0,.8)'));
  assert.ok(glassCss({ ...glassyPalette, mode: 'light' }).includes('text-shadow:0 1px 2px rgba(255,255,255,.8)'));
  for (const token of ['--sidebar-bg:', '--sidebar-hover:', '--sidebar-active:', '--core-v2-bg-overlay:', '--core-v2-bg-surface:']) {
    assert.ok(!dark.includes(token), `do not fade the ${token} control/panel token`);
  }
});

test('ThemeSync lifecycle syncs one live native follow per change and never leaks subscriptions', async () => {
  const { fs, jne, store } = miniAtomStore();
  const { context } = evaluateStoreSetup({
    fs, jne, wMc: () => ({}),
    window: { electronAPI: { theme: { getOmarchy() {}, setOmarchyFollow: () => {} } } },
  });
  const { follow, accepted } = context.__port;
  const sync = vm.runInContext('factoryPortSyncNativeFollow', context);

  const invocations = [];
  const resolvers = [];
  let followValue = false;
  const acceptedValues = [];
  const subscriptions = [];
  const subCalls = [];
  const nufCalls = [];
  const fakeStore = {
    get: atom => (atom === follow ? followValue : atom === $H ? 'dark' : atom === source ? 'dark'
      : atom === background ? '#1a1a2a' : undefined),
    set: (atom, value) => { if (atom === accepted) acceptedValues.push(value); },
    sub: (atom, listener) => {
      subCalls.push(atom);
      subscriptions.push({ atom, listener });
      return () => {
        const index = subscriptions.findIndex(entry => entry.listener === listener);
        if (index >= 0) subscriptions.splice(index, 1);
      };
    },
  };
  context.window.electronAPI.theme.setOmarchyFollow = value => {
    invocations.push(value);
    return new Promise(resolve => { resolvers.push(resolve); });
  };

  const iufChange = rendererChanges.find(change => change[1].startsWith('const r=i.sub($H,s)'));
  assert.ok(iufChange, 'the ThemeSync subscription change exists');
  const effectSource = 'const s=()=>{hAf({appearanceBackground:i.get(Zsi),theme:i.get($H),'
    + 'themePreference:i.get(factoryPortThemeSource)})};s();' + iufChange[2];
  const makeEffect = vm.runInContext(
    '(hAf,$H,factoryPortThemeSource,Zsi,factoryPortThemeFollow,factoryPortSyncNativeFollow)'
    + '=>(i,Xt)=>{' + effectSource + '}', context);
  const $H = Symbol('$H'), source = Symbol('source'), background = Symbol('background');
  const cleanup = makeEffect(
    payload => { nufCalls.push(payload); }, $H, source, background, follow, sync,
  )(fakeStore, () => {});

  assert.equal(invocations.length, 1, 'mounting ThemeSync syncs the follow opt-in exactly once');
  assert.equal(invocations[0], false, 'a signed-out follow starts as false');
  assert.deepEqual(acceptedValues, [false]);
  assert.deepEqual({ ...nufCalls[0] }, { appearanceBackground: '#1a1a2a', theme: 'dark', themePreference: 'dark' },
    'ThemeSync still performs its original vendor theme sync');
  assert.deepEqual(subCalls, [$H, source, background, follow],
    'ThemeSync subscribes the vendor atoms plus exactly one follow atom');
  const followListener = subscriptions.find(entry => entry.atom === follow).listener;

  followValue = true;
  followListener(true);
  assert.equal(invocations.length, 2, 'one follow change produces one native sync');
  assert.equal(invocations[1], true);
  assert.equal(acceptedValues.at(-1), false, 'acceptance is still unknown until main answers');

  // A newer opt-in invalidates a stale in-flight acceptance.
  followValue = false;
  followListener(false);
  assert.equal(acceptedValues.at(-1), false, 'opting out clears acceptance immediately');
  resolvers[1](true);
  await settle();
  assert.equal(acceptedValues.at(-1), false, 'a stale acceptance for an older opt-in is discarded');

  resolvers[2](true);
  await settle();
  assert.equal(acceptedValues.at(-1), false, 'opting out stays off regardless of late answers');

  followValue = true;
  followListener(true);
  resolvers[3](true);
  await settle();
  assert.equal(acceptedValues.at(-1), true, 'main accepting the live opt-in unlocks glass');

  cleanup();
  assert.equal(invocations.at(-1), false, 'cleanup always sends follow false');
  assert.equal(subscriptions.length, 0, 'every ThemeSync subscription is released');
  assert.equal(subCalls.filter(atom => atom === follow).length, 1, 'no leaked subscriptions');
  assert.equal(acceptedValues.at(-1), false, 'cleanup clears acceptance so no glass survives unmount');
  resolvers[4](true);
  await settle();
  assert.equal(acceptedValues.at(-1), false, 'a late acceptance after unmount is discarded');

  // Without a supported bridge the opt-in never reaches IPC and stays off.
  context.window.electronAPI.theme.setOmarchyFollow = undefined;
  acceptedValues.length = 0;
  sync(fakeStore);
  assert.equal(acceptedValues.at(-1), false, 'a missing follow API fails closed');
  assert.equal(invocations.length, 5, 'no IPC call was added for the unsupported bridge');
});

test('renderer DTO validation is strict and palette overlay preserves saved Factory settings', () => {
  const { normalize, overlay, glassCss } = evaluateHelpers();
  const valid = normalize({
    available: true,
    mode: 'dark',
    background: '#101010',
    foreground: '#eeeeee',
    accent: '#ff6600',
    revision: 'generation-4',
    windowMode: 'glassy',
    ignored: 'never copied',
  });
  assert.deepEqual({ ...valid }, {
    available: true,
    mode: 'dark',
    background: '#101010',
    foreground: '#eeeeee',
    accent: '#ff6600',
    revision: 'generation-4',
    windowMode: 'glassy',
  });
  assert.equal(normalize({ ...valid, foreground: 'red' }).available, false);
  assert.equal(normalize({ ...valid, mode: 'system' }).available, false);
  assert.equal(normalize({ ...valid, accent: null }).available, false);
  assert.equal(normalize({ ...valid, available: false }).available, false);
  const invalidWindowMode = normalize({ ...valid, windowMode: 'frosted' });
  assert.equal(invalidWindowMode.available, true, 'an invalid windowMode sanitizes to null while valid colors still follow');
  assert.equal(invalidWindowMode.windowMode, null);
  assert.equal(valid.windowMode, 'glassy');
  assert.equal(normalize({ ...valid, windowMode: undefined }).windowMode, null);
  assert.equal(normalize(null).windowMode, null);

  // Each region paints once, not a tint composited over another html tint.
  const css = glassCss(valid);
  assert.ok(css.includes("html{background-color:transparent!important}"));
  assert.ok(css.includes("background:rgba(16, 16, 16, .65)!important"),
    'the content frame keeps the effective Omarchy background at alpha .65');
  assert.ok(css.includes('--core-v2-bg-page:transparent'));
  assert.ok(css.includes('--surface-1:transparent'));
  assert.ok(css.includes('body, #root{background-color:transparent!important}'));
  assert.equal((css.match(/\.65/g) || []).length, 1, 'one content tint rule');
  assert.equal((css.match(/\.35/g) || []).length, 1, 'one shared chrome tint rule');
  assert.ok(!css.includes('opacity') && !css.includes('filter'),
    'glass never uses whole-document opacity or filter');
  assert.equal(glassCss({ ...valid, windowMode: 'transparent' }), '',
    'no glass CSS unless the followed snapshot itself is glassy');
  assert.equal(glassCss({ ...valid, available: false }), '');
  assert.equal(glassCss({ ...valid, background: '#c0c0c' }), '');
  assert.equal(glassCss({ ...valid, foreground: 'red;opacity:.1' }), '');
  assert.equal(glassCss(null), '');
  assert.equal(glassCss({ ...valid, background: '#C0FFEE' }).includes('rgba(192, 255, 238, .65)'), true,
    'the tint follows the effective palette RGB');

  const manual = {
    light: { preset: 'Dracula', background: '#181818', foreground: '#f0f0f0', customField: 'kept' },
    dark: { preset: 'Nord', background: '#202030', foreground: '#ddeeff', userMessageBubble: '#303040' },
    uiFontSize: 13,
  };
  const defaults = {
    light: { preset: 'Factory', accent: 'Default' },
    dark: { preset: 'Factory', accent: 'Default' },
  };
  const followed = overlay(manual, valid, defaults);
  assert.notEqual(followed, manual);
  assert.notEqual(followed.dark, manual.dark);
  assert.deepEqual({ ...followed.dark }, {
    ...manual.dark,
    preset: 'Factory',
    accent: 'Default',
    accentColor: '#ff6600',
    background: '#101010',
    foreground: '#eeeeee',
  });
  assert.equal(followed.light, manual.light, 'inactive mode remains the same saved object');
  assert.equal(followed.uiFontSize, 13);
  assert.equal(overlay(manual, normalize(null), defaults), manual, 'fallback returns original settings');
  assert.equal(manual.dark.background, '#202030', 'the persisted settings object was not mutated');
});

test('the theme copy helper takes the theme alone and keeps both languages', () => {
  // The copy never read the follow state: it only needs the theme, so it
  // must not carry a parameter it would ignore.
  const helper = rendererHelpers.split('\n').find(line => line.startsWith('function factoryPortThemeUiCopy('));
  assert.ok(helper, 'the copy helper must be part of the injected renderer helpers');
  assert.match(helper, /^function factoryPortThemeUiCopy\(e\)\{/,
    'the copy helper takes the theme and nothing else');
  const builder = rendererHelpers.split('\n').find(line => line.startsWith('function factoryPortBuildThemeRow('));
  assert.match(builder, /factoryPortThemeUiCopy\(e\)/,
    'the caller hands the theme to the copy helper');
  assert.match(builder, /checked:t/, 'the follow state still reaches the checkbox');

  const english = evaluateHelpers({ locale: 'en-US' });
  const portuguese = evaluateHelpers({ locale: 'pt-BR' });
  for (const [helpers, title, description] of [
    [english, 'Follow Omarchy theme', /saved Factory appearance stays intact/],
    [portuguese, 'Seguir o tema do Omarchy', /preservada/],
  ]) {
    const copy = vm.runInContext(
      'factoryPortThemeUiCopy({ available: true })', helpers.context);
    assert.equal(copy.title, title);
    assert.match(copy.description, description);
  }
});

test('Appearance follow control explains temporary override, availability and Portuguese', () => {
  const { buildRow } = evaluateHelpers({ locale: 'pt-BR' });
  const unavailable = buildRow(false, { available: false }, () => {});
  assert.equal(unavailable.type, 'SettingRow');
  assert.equal(unavailable.props.title, 'Seguir o tema do Omarchy');
  assert.equal(unavailable.props.control.type, 'Checkbox');
  assert.equal(unavailable.props.control.props.disabled, true);
  assert.match(unavailable.props.description, /não estão disponíveis/);

  let selected;
  const enabled = buildRow(true, { available: false }, value => { selected = value; });
  assert.equal(enabled.props.control.props.disabled, false, 'a stale opt-in can still be turned off');
  enabled.props.control.props.onCheckedChange(false);
  assert.equal(selected, false);
  const available = buildRow(false, { available: true }, () => {});
  assert.equal(available.props.control.props.disabled, false);
  assert.match(available.props.description, /preservada/);
});

test('first paint uses a valid opt-in cache and never modifies manual Factory keys', () => {
  const values = new Map([
    ['factory-theme-preference', 'dark'],
    ['factory-appearance-startup-backgrounds', JSON.stringify({ light: '#fafafa', dark: '#222222' })],
    ['factory-port-theme-source', 'omarchy'],
    ['factory-port-theme-cache', JSON.stringify({
      available: true, mode: 'light', background: '#d0e0f0', foreground: '#102030', accent: '#ff6600', revision: 'r1', windowMode: 'glassy',
    })],
  ]);
  const manualTheme = values.get('factory-theme-preference');
  const manualBackgrounds = values.get('factory-appearance-startup-backgrounds');
  assert.deepEqual({ ...executeCachedBootstrap({ values }) }, {
    theme: 'light', appearanceBackground: '#d0e0f0', backgroundColor: '#d0e0f0',
  });
  assert.equal(values.get('factory-theme-preference'), manualTheme);
  assert.equal(values.get('factory-appearance-startup-backgrounds'), manualBackgrounds);
});

test('first-paint cache falls back to saved Factory appearance when malformed, opted out or API missing', () => {
  const makeValues = cache => new Map([
    ['factory-theme-preference', 'dark'],
    ['factory-appearance-startup-backgrounds', JSON.stringify({ light: '#fafafa', dark: '#222222' })],
    ['factory-port-theme-source', 'omarchy'],
    ['factory-port-theme-cache', JSON.stringify(cache)],
  ]);
  const invalid = makeValues({ available: true, mode: 'light', background: '#d0e0f0', foreground: '#102030', accent: 'orange' });
  assert.deepEqual({ ...executeCachedBootstrap({ values: invalid }) }, {
    theme: 'dark', appearanceBackground: '#222222', backgroundColor: '#222222',
  });

  // The first paint consumes only palette mode/background. Window-mode
  // validation belongs to the renderer store before native acceptance.
  const badWindowMode = makeValues({ available: true, mode: 'light', background: '#d0e0f0', foreground: '#102030', accent: '#ff6600', windowMode: 'frosted' });
  assert.deepEqual({ ...executeCachedBootstrap({ values: badWindowMode }) }, {
    theme: 'light', appearanceBackground: '#d0e0f0', backgroundColor: '#d0e0f0',
  });

  const optedOut = makeValues({ available: true, mode: 'light', background: '#d0e0f0', foreground: '#102030', accent: '#ff6600' });
  optedOut.set('factory-port-theme-source', 'factory');
  assert.equal(executeCachedBootstrap({ values: optedOut }).theme, 'dark');

  const noBridge = makeValues({ available: true, mode: 'light', background: '#d0e0f0', foreground: '#102030', accent: '#ff6600' });
  assert.equal(executeCachedBootstrap({ values: noBridge, hasApi: false }).theme, 'dark');
});

test('preload bridge exposes validated DTOs, a boolean-gated follow opt-in and removes only its own event listener', async () => {
  const insertion = preloadChanges[0][2];
  const start = insertion.indexOf('theme:');
  const end = insertion.lastIndexOf(',getBugReportLogs:');
  const property = insertion.slice(start, end);
  const listeners = new Map();
  const invoked = [];
  const ipcRenderer = {
    invoke: async (channel, payload) => {
      invoked.push([channel, payload]);
      if (channel === 'factory-linux-theme:follow') return payload === true;
      assert.equal(channel, 'factory-linux-theme:get');
      return { available: true, mode: 'dark', background: '#101010', foreground: '#eeeeee',
        accent: '#FF6600', revision: 'rev-2', windowMode: 'glassy', path: '/private/path' };
    },
    on(channel, listener) {
      assert.equal(channel, 'factory-linux-theme:changed');
      listeners.set(channel, listener);
    },
    removeListener(channel, listener) {
      if (listeners.get(channel) === listener) listeners.delete(channel);
    },
  };
  const api = vm.runInNewContext(`({${property}})`, { M: { ipcRenderer } });
  const current = await api.theme.getOmarchy();
  assert.deepEqual({ ...current }, {
    available: true, mode: 'dark', background: '#101010', foreground: '#eeeeee', accent: '#ff6600',
    revision: 'rev-2', windowMode: 'glassy',
  });

  let eventValue;
  const unsubscribe = api.theme.onOmarchyChanged(value => { eventValue = value; });
  listeners.get('factory-linux-theme:changed')({}, {
    available: true, mode: 'light', background: '#FAFAFA', foreground: '#101010', accent: '#00AAFF',
    revision: 'rev-3', windowMode: 'frosted', secret: 'discard',
  });
  assert.equal(eventValue.mode, 'light');
  assert.equal(eventValue.background, '#fafafa');
  assert.equal(eventValue.accent, '#00aaff');
  assert.equal(eventValue.windowMode, null, 'an invalid windowMode sanitizes to null while colors still follow');
  assert.equal('secret' in eventValue, false);
  listeners.get('factory-linux-theme:changed')({}, {
    available: true, mode: 'dark', background: '#0A0A0A', foreground: '#F0F0F0', accent: '#00FF00',
    revision: 'rev-4', windowMode: 'opaque',
  });
  assert.equal(eventValue.windowMode, 'opaque');
  unsubscribe();
  assert.equal(listeners.size, 0);

  // The follow opt-in only ever invokes the fixed follow channel with a
  // boolean; anything else resolves false without touching IPC.
  const gateCount = invoked.length;
  assert.equal(await api.theme.setOmarchyFollow('true'), false);
  assert.equal(await api.theme.setOmarchyFollow(1), false);
  assert.equal(await api.theme.setOmarchyFollow(undefined), false);
  assert.equal(await api.theme.setOmarchyFollow(null), false);
  assert.equal(invoked.length, gateCount, 'non-boolean input never reaches IPC');
  assert.equal(await api.theme.setOmarchyFollow(true), true);
  assert.deepEqual(invoked.at(-1), ['factory-linux-theme:follow', true]);
  assert.equal(await api.theme.setOmarchyFollow(false), false);
  assert.deepEqual(invoked.at(-1), ['factory-linux-theme:follow', false],
    'main accepts the request but the result is the accepted state, not a mirror of the input');
  assert.equal(invoked.filter(([channel]) => channel === 'factory-linux-theme:follow').length, 2,
    'only the two valid booleans reached the follow channel');

  const rejecting = vm.runInNewContext(`({${property}})`, {
    M: { ipcRenderer: { invoke: async () => { throw new Error('No handler registered'); } } },
  });
  assert.equal(await rejecting.theme.setOmarchyFollow(true), false, 'a rejected invoke fails closed');
});
