// Guards the Linux port's main-process patch recipe against the real,
// checksum-pinned upstream 0.205.0 payload.
//
// These tests are deliberately not fixtures: they load the actual unpatched
// bundle, require every anchor to match it exactly once, apply the recipe,
// and then execute the patched billing hook and theme bridge extracted from
// the patched bytes. If an anchor drifts, a bridge breaks, or the bundle was
// never patched, something here fails. The snapshot itself is produced by
// the build (tools/vendor-snapshot.mjs) from the freshly extracted official
// payload, before any patch is applied; it is never committed. The suite
// skips only when that snapshot is absent, and each skip states that the
// recipe is unvalidated.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  changes, diagnose, patch, preloadChanges, rendererChanges,
  diagnoseRendererHelperCollisions, linuxMenuKeyboardHandler,
} from '../tools/patches.mjs';
import { themeMainChanges, diagnoseThemeMainHelpers } from '../tools/theme-main-patches.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.join(ROOT, 'build', 'upstream-pristine-0.205.0', 'app');
const BUILD = path.join(APP, '.vite', 'build');
const RENDERER_DIR = path.join(APP, '.vite', 'renderer', 'main_window');
const SKIP = `payload ${APP} not present; recipe unvalidated against 0.205.0`;

const present = await access(APP).then(() => true, () => false);

async function discover() {
  const lifecycleFiles = (await readdir(BUILD)).filter(f => /^initLifecycle-.*\.js$/.test(f));
  assert.equal(lifecycleFiles.length, 1, 'expected exactly one initLifecycle chunk');
  const lifecycleName = lifecycleFiles[0];
  const main = await readFile(path.join(BUILD, 'main.js'), 'utf8');
  const authMatch = main.match(/^"use strict";require\("\.\/(index-[^"]+\.js)"\);require\("electron"\);?$/m);
  assert.ok(authMatch, 'main.js entry shape changed');
  const html = await readFile(path.join(RENDERER_DIR, 'index.html'), 'utf8');
  const rendererEntries = [...html.matchAll(/src="\.\/assets\/(index-[^"]+\.js)"/g)].map(m => m[1]);
  assert.equal(rendererEntries.length, 1, 'expected exactly one renderer entry script');
  return {
    lifecycleName,
    authName: authMatch[1],
    rendererName: rendererEntries[0],
    lifecycle: await readFile(path.join(BUILD, lifecycleName), 'utf8'),
    preload: await readFile(path.join(BUILD, 'preload.js'), 'utf8'),
    renderer: await readFile(path.join(RENDERER_DIR, 'assets', rendererEntries[0]), 'utf8'),
    html,
  };
}

let up = null;
if (present) up = await discover();

test('payload identity and versions.json names for 0.205.0', { skip: present ? false : SKIP }, async () => {
  const manifest = JSON.parse(await readFile(path.join(APP, 'package.json'), 'utf8'));
  assert.equal(manifest.version, '0.205.0', 'fixture must be the inspected 0.205.0 payload');
  const versions = JSON.parse(await readFile(path.join(ROOT, 'versions.json'), 'utf8'));
  assert.equal(versions.desktop, manifest.version);
  assert.equal(versions.lifecycle, `.vite/build/${up.lifecycleName}`);
  assert.equal(versions.authModule, `.vite/build/${up.authName}`);
  assert.equal(versions.renderer, `.vite/renderer/main_window/assets/${up.rendererName}`);
  assert.equal(versions.upstreamElectron, manifest.devDependencies.electron);
});

test('every patch anchor matches the real unpatched 0.205.0 source exactly once', { skip: present ? false : SKIP }, () => {
  assert.deepEqual(diagnose(up.lifecycle), [], 'main-process anchors drifted');
  assert.deepEqual(diagnose(up.preload, preloadChanges), []);
  assert.deepEqual(diagnose(up.renderer, rendererChanges), [], 'renderer anchor drifted');
  assert.deepEqual(diagnoseRendererHelperCollisions(up.renderer), []);
  assert.deepEqual(diagnoseThemeMainHelpers(up.lifecycle), []);
});

test('patched real lifecycle is valid and unpatched lacks every Linux guard', { skip: present ? false : SKIP }, () => {
  const patched = patch(patch(up.lifecycle, changes), themeMainChanges);
  assert.doesNotThrow(() => new vm.Script(patched));
  for (const [name, , after] of changes) {
    assert.ok(patched.includes(after), `patched lifecycle lacks: ${name}`);
    assert.ok(!up.lifecycle.includes(after), `unpatched lifecycle already contains: ${name}`);
  }
  assert.ok(patched.includes('factory-linux-theme:get'));
  assert.ok(patched.includes('factory-linux-theme:changed'));
  assert.ok(!up.lifecycle.includes('factory-linux-theme:get'),
    'unpatched lifecycle must not expose the bridge channel');
  // The injected keyboard handler is genuinely absent upstream: without the
  // patch, the hidden Linux menu has no keyboard affordance at all.
  assert.ok(!up.lifecycle.includes('before-input-event'),
    'upstream gained its own before-input-event handler; revisit the keyboard patch');
  assert.ok(patched.includes('before-input-event'));
  assert.ok(patched.includes('factory-desktop-arch.desktop'), 'desktop entry name not set');
  // Native daemon IPC transport and hardening survive the patch untouched.
  assert.ok(patched.includes('DesktopDaemonTransportMode.Ipc'));
  assert.ok(patched.includes('contextIsolation:!0'));
  assert.ok(patched.includes('nodeIntegration:!1'));
  assert.ok(up.lifecycle.includes('DesktopDaemonTransportMode.Ipc'));
});

test('upstream native Linux branches are present and stay enabled', { skip: present ? false : SKIP }, () => {
  // 0.205.0 upstream supports these on its own; the recipe must neither
  // patch over them nor disable them.
  assert.ok(up.preload.includes('window:{showApplicationMenu:process.platform==="darwin"?void 0:'),
    'preload no longer exposes the menu API on non-darwin platforms');
  assert.ok(!up.preload.includes('showApplicationMenu:process.platform==="win32"?'),
    'preload regressed to a win32-only gate; a preload patch is needed again');
  const menuHandler = up.lifecycle.indexOf('T.ipcMain.handle("window:showApplicationMenu"');
  assert.ok(menuHandler !== -1, 'inline menu IPC handler missing');
  assert.ok(up.lifecycle.slice(menuHandler, menuHandler + 400).includes('if(process.platform==="darwin")return;'),
    'inline menu handler is no longer darwin-gated');
  assert.ok(up.lifecycle.includes('const t=process.platform!=="darwin"'),
    'window factory no longer treats Linux like Windows for title-bar integration');
  assert.ok(up.lifecycle.includes('for(const l of ts())l.setMenuBarVisibility(!1)'),
    'menu rebuild no longer hides the separate menu bar on non-darwin');
  // The vendor's own Linux external-install updater boundary (pacman and
  // every other non-vendor package manager) must remain in force.
  assert.ok(up.lifecycle.includes('process.platform==="linux"&&!es()&&!Uc()'),
    'upstream removed its Linux external-install updater gate');
  assert.ok(up.lifecycle.includes('start-skipped-external-install'));
  assert.ok(up.lifecycle.includes('factory.daemon.ready'),
    'daemon ready contract changed; ipc smoke needs review');
});

test('the real patched billing hook pauses when hidden or unfocused', { skip: present ? false : SKIP }, () => {
  const patchedRenderer = patch(up.renderer, rendererChanges);
  const start = patchedRenderer.indexOf('function factoryLinuxBillingFocusSnapshot');
  const end = patchedRenderer.indexOf('io(s,r)}', start);
  assert.ok(start !== -1 && end !== -1, 'patched hook not found in the real renderer');
  const segment = patchedRenderer.slice(start, end + 'io(s,r)}'.length);

  class FakeEventTarget {
    listeners = new Map();
    addEventListener(type, listener) {
      (this.listeners.get(type) ?? this.listeners.set(type, new Set()).get(type)).add(listener);
    }
    removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
    dispatchEvent(type) { for (const l of this.listeners.get(type) ?? []) l({ type }); }
    listenerCount(type) { return this.listeners.get(type)?.size ?? 0; }
  }
  const window = new FakeEventTarget();
  const document = new FakeEventTarget();
  document.visibilityState = 'visible';
  document.hasFocus = () => focused;
  let focused = true;
  let airgap = false;
  const store = { notifications: 0 };
  const hooks = vm.runInNewContext(`${segment}\n({billingLimits:Sit,snapshot:factoryLinuxBillingFocusSnapshot})`, {
    Symbol,
    P: { useSyncExternalStore(subscribe, get) {
      if (subscribe !== store.subscribe) {
        store.unsubscribe?.();
        store.subscribe = subscribe;
        store.unsubscribe = subscribe(() => { store.notifications++; });
      }
      return get();
    } },
    window, document,
    z: { c: () => [Symbol.for('react.memo_cache_sentinel'), null, Symbol.for('react.memo_cache_sentinel')] },
    Fu: () => airgap,
    Xn: { billing: { tokenLimits: ['billing', 'tokenLimits'] } },
    io: (query, options) => ({ query, options }),
  });

  assert.equal(hooks.billingLimits().query.enabled, true);
  focused = false; window.dispatchEvent('blur');
  assert.equal(hooks.snapshot(), false);
  assert.equal(hooks.billingLimits().query.enabled, false, 'real patched hook paused when unfocused');
  document.visibilityState = 'hidden'; document.dispatchEvent('visibilitychange');
  assert.equal(hooks.snapshot(), false);
  document.visibilityState = 'visible';
  focused = true; window.dispatchEvent('focus');
  assert.equal(hooks.snapshot(), true);
  assert.equal(hooks.billingLimits().query.enabled, true, 'real patched hook resumed on focus');
  airgap = true;
  assert.equal(hooks.billingLimits().query.enabled, false, 'airgap gate still enforced');
  airgap = false;
  store.unsubscribe();
  assert.equal(window.listenerCount('focus'), 0);
  assert.equal(document.listenerCount('visibilitychange'), 0);

  // Control: the same mocks against the unpatched real hook show the test
  // detects an unpatched bundle.
  const unpatched = rendererChanges[0][1];
  const unpatchedHooks = vm.runInNewContext(`${unpatched}\n({billingLimits:Sit})`, {
    Symbol,
    P: {},
    window, document,
    z: { c: () => [Symbol.for('react.memo_cache_sentinel'), null, Symbol.for('react.memo_cache_sentinel')] },
    Fu: () => false,
    Xn: { billing: { tokenLimits: ['billing', 'tokenLimits'] } },
    io: (query, options) => ({ query, options }),
  });
  document.visibilityState = 'hidden'; document.dispatchEvent('visibilitychange');
  const hidden = unpatchedHooks.billingLimits();
  assert.equal(hidden.query.enabled, true, 'unpatched real hook keeps polling while hidden');
  assert.equal(hidden.options.refetchIntervalInBackground, true);
});

test('the real theme bridge integration validates only trusted main frames', { skip: present ? false : SKIP }, async () => {
  const patchedLifecycle = patch(patch(up.lifecycle, changes), themeMainChanges);
  const startMarker = 'if(process.platform==="linux"){\nconst factoryLinuxOmarchyBridge=require(';
  const start = patchedLifecycle.indexOf(startMarker);
  const lastCall = patchedLifecycle.indexOf('void factoryLinuxOmarchyStart();', start);
  const closeBrace = patchedLifecycle.indexOf('}', lastCall);
  assert.ok(start !== -1 && lastCall !== -1 && closeBrace !== -1,
    'bridge integration not found in patched lifecycle');
  const integration = patchedLifecycle.slice(start, closeBrace + 1);
  assert.equal(integration.indexOf('factory-linux-theme:get', 0) !== -1, true);

  const handlers = new Map();
  const appEvents = new Map();
  const windows = [];
  let publishListener = null;
  const provider = {
    reads: 0, stops: 0,
    start(listener) { publishListener = listener; return Promise.resolve(); },
    getState() { this.reads++; return { available: true, mode: 'dark', revision: 'real-1' }; },
    stop() { this.stops++; },
  };
  const appDir = '/opt/factory/resources/app.asar/.vite/build';
  const expectedFile = path.resolve(appDir, '..', 'renderer', 'main_window', 'index.html');
  const makeWindow = url => {
    const frame = { url };
    const sent = [];
    const webContents = {
      mainFrame: frame, isDestroyed: () => false, isCrashed: () => false,
      isLoading: () => false, send: (...m) => sent.push(m),
    };
    const owner = { webContents, sent, isDestroyed: () => false };
    windows.push(owner);
    return { owner, frame, webContents, sent };
  };
  const trusted = makeWindow(pathToFileURL(expectedFile).href);
  const wrongUrl = makeWindow('file:///untrusted/index.html');
  const unregistered = makeWindow(pathToFileURL(expectedFile).href);
  const context = {
    URL,
    process: { platform: 'linux', resourcesPath: '/opt/factory/resources' },
    __dirname: appDir,
    require: request => {
      assert.equal(request, path.resolve('/opt/factory/resources', '..', 'port', 'theme-bridge.cjs'));
      return { createOmarchyThemeProvider: () => provider, unavailableState: () => ({ available: false }) };
    },
    X: path,
    $w: { fileURLToPath },
    i: { DESKTOP_RENDERER_ORIGIN: undefined },
    T: {
      app: { getPath: () => '/tmp/theme-fixture', on: (name, listener) => appEvents.set(name, listener) },
      ipcMain: { handle: (channel, listener) => handlers.set(channel, listener) },
      BrowserWindow: { fromWebContents: sender => windows.find(w => w.webContents === sender) ?? null },
    },
    or: new Set([trusted.owner, wrongUrl.owner]),
    Er: sender => !sender.isDestroyed() && !sender.isCrashed(),
    ts: () => windows,
  };
  vm.runInNewContext(integration, context);
  await Promise.resolve();

  const getState = handlers.get('factory-linux-theme:get');
  assert.equal(typeof getState, 'function');
  assert.equal(handlers.has('factory-linux-theme:changed'), false);
  assert.equal((await getState({ sender: trusted.webContents, senderFrame: { url: trusted.frame.url } })).available,
    false, 'an impersonating frame object is rejected');
  assert.equal((await getState({ sender: unregistered.webContents, senderFrame: unregistered.frame })).available,
    false, 'an unregistered window is rejected');
  assert.equal((await getState({ sender: wrongUrl.webContents, senderFrame: wrongUrl.frame })).available,
    false, 'an unrelated file URL is rejected');
  assert.equal(provider.reads, 0);
  assert.equal((await getState({ sender: trusted.webContents, senderFrame: trusted.frame })).revision, 'real-1');
  assert.equal(provider.reads, 1);

  assert.ok(publishListener, 'provider started and received the publish callback');
  publishListener({ revision: 'real-1' });
  assert.equal(trusted.sent.length, 1, 'only the trusted window is broadcast to');
  assert.equal(wrongUrl.sent.length, 0);
  appEvents.get('window-all-closed')();
  assert.equal(provider.stops, 1);
});

test('the real integration drives native transparency per followed window', { skip: present ? false : SKIP }, async () => {
  const patchedLifecycle = patch(patch(up.lifecycle, changes), themeMainChanges);
  // Linux main windows must be created transparent-capable while the native
  // title bar controls and the vendor's transparent overlay stay untouched.
  assert.ok(patchedLifecycle.includes('transparent:process.platform==="linux"||void 0,titleBarStyle:"hidden",titleBarOverlay:t?'),
    'Linux main windows are not created transparent-capable');
  assert.equal(
    patchedLifecycle.split('a.on("resize",()=>{ua&&a.setBackgroundColor(ua)})').length - 1, 1,
    'the vendor resize repaint must stay intact; the port re-glasses through its own listener');
  assert.ok(patchedLifecycle.includes('hte(v,W);process.platform==="linux"&&factoryLinuxOmarchyTrack&&factoryLinuxOmarchyTrack(v,W)'),
    'the vendor background IPC must keep vendor hte behavior first');
  assert.ok(patchedLifecycle.includes('factory-linux-theme:follow'),
    'the follow channel is missing from the patched lifecycle');

  const startMarker = 'if(process.platform==="linux"){\nconst factoryLinuxOmarchyBridge=require(';
  const start = patchedLifecycle.indexOf(startMarker);
  const lastCall = patchedLifecycle.indexOf('void factoryLinuxOmarchyStart();', start);
  const closeBrace = patchedLifecycle.indexOf('}', lastCall);
  assert.ok(start !== -1 && lastCall !== -1 && closeBrace !== -1,
    'bridge integration not found in patched lifecycle');
  const integration = patchedLifecycle.slice(start, closeBrace + 1).replace(
    'void factoryLinuxOmarchyStart();',
    'void factoryLinuxOmarchyStart();globalThis.themeBridgeTest={publish:factoryLinuxOmarchyPublish,'
    + 'follow:factoryLinuxOmarchyFollow,base:factoryLinuxOmarchyBase,glass:factoryLinuxOmarchyGlass,'
    + 'track:factoryLinuxOmarchyTrack};');

  const handlers = new Map();
  const appEvents = new Map();
  const registered = new Set();
  const windows = [];
  const provider = {
    listener: null, reads: 0,
    start(listener) { this.listener = listener; return Promise.resolve(); },
    getState() { this.reads++; return { available: true, mode: 'dark', revision: 'real-1', windowMode: 'glassy' }; },
    stop() { this.listener = null; },
  };
  const appDir = '/opt/factory/resources/app.asar/.vite/build';
  const expectedFile = path.resolve(appDir, '..', 'renderer', 'main_window', 'index.html');
  const makeWindow = url => {
    const frame = { url };
    const listeners = new Map();
    const window = {
      backgrounds: [],
      isDestroyed: () => false,
      webContents: {
        mainFrame: frame, isDestroyed: () => false, isCrashed: () => false,
        isLoading: () => false, send: () => {},
      },
      on: (name, listener) => { const list = listeners.get(name) || []; listeners.set(name, list); list.push(listener); },
      once: (name, listener) => { const list = listeners.get(name) || []; listeners.set(name, list); list.push(listener); },
      emit: name => { for (const listener of [...(listeners.get(name) || [])]) listener(); },
      setBackgroundColor: color => { window.backgrounds.push(color); },
    };
    registered.add(window);
    windows.push(window);
    return window;
  };
  const followed = makeWindow(pathToFileURL(expectedFile).href);
  const other = makeWindow(pathToFileURL(expectedFile).href);
  const context = {
    URL,
    process: { platform: 'linux', resourcesPath: '/opt/factory/resources' },
    __dirname: appDir,
    require: () => ({ createOmarchyThemeProvider: () => provider,
      unavailableState: () => ({ available: false, windowMode: null }) }),
    X: path,
    $w: { fileURLToPath },
    i: { DESKTOP_RENDERER_ORIGIN: undefined },
    T: {
      app: { getPath: () => '/tmp/theme-fixture', on: (name, listener) => appEvents.set(name, listener) },
      ipcMain: { handle: (channel, listener) => handlers.set(channel, listener) },
      BrowserWindow: { fromWebContents: sender => windows.find(w => w.webContents === sender) ?? null },
    },
    or: registered,
    Er: sender => !sender.isDestroyed() && !sender.isCrashed(),
    ts: () => windows,
    O7: () => '#17181c',
  };
  vm.runInNewContext(integration, context);
  await Promise.resolve();

  const follow = handlers.get('factory-linux-theme:follow');
  assert.equal(typeof follow, 'function', 'real integration registers the follow channel');
  const event = window => ({ sender: window.webContents, senderFrame: window.webContents.mainFrame });
  assert.equal(await follow({ sender: followed.webContents, senderFrame: { url: followed.webContents.mainFrame.url } }, true), false,
    'an impersonating frame cannot follow');
  assert.equal(await follow(event(followed), 'yes'), false, 'malformed flags are rejected by the real bytes');
  assert.deepEqual(followed.backgrounds, [], 'rejections never touch the native window');
  assert.equal(await follow(event(followed), true), true);
  assert.deepEqual(followed.backgrounds, ['#00000000'],
    'the real integration applies a fully transparent native background for glassy state');
  assert.deepEqual(other.backgrounds, [], 'the second window is untouched');

  context.themeBridgeTest.track('#2a2b31', followed);
  assert.deepEqual(followed.backgrounds, ['#00000000', '#00000000'],
    'the real track hook caches the vendor RGB and re-applies glass');
  context.themeBridgeTest.publish({ available: true, mode: 'dark', revision: 'real-2', windowMode: 'opaque' });
  assert.deepEqual(followed.backgrounds, ['#00000000', '#00000000', '#2a2b31'],
    'an opaque provider state restores the last known vendor RGB');

  followed.setBackgroundColor('#101019');
  followed.emit('resize');
  assert.deepEqual(followed.backgrounds, ['#00000000', '#00000000', '#2a2b31', '#101019', '#00000000'],
    'the follow-time resize listener re-glasses after the vendor resize repaint');

  assert.equal(await follow(event(followed), false), true);
  assert.deepEqual(followed.backgrounds, ['#00000000', '#00000000', '#2a2b31', '#101019', '#00000000', '#2a2b31'],
    'unfollowing restores the cached vendor RGB');
});

test('the exported keyboard handler is the one injected into the real lifecycle', { skip: present ? false : SKIP }, () => {
  const patchedLifecycle = patch(patch(up.lifecycle, changes), themeMainChanges);
  assert.ok(patchedLifecycle.includes(linuxMenuKeyboardHandler),
    'the exported handler string must match what the patch injects');
});
