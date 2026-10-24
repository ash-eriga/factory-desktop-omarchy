import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { patch } from '../tools/patches.mjs';
import {
  diagnoseThemeMainHelpers, themeMainChanges, themeMainHelperNames,
} from '../tools/theme-main-patches.mjs';

const APP_DIR = '/opt/factory/resources/app.asar/.vite/build';
const EXPECTED_FILE = path.resolve(APP_DIR, '..', 'renderer', 'main_window', 'index.html');
const TRUSTED_URL = pathToFileURL(EXPECTED_FILE).href;

test('main theme bridge patch is unique and syntactically valid', () => {
  const source = `${themeMainChanges.map(([, before]) => before).join('\n')},async()=>{})`;
  const patched = patch(source, themeMainChanges);
  assert.deepEqual(diagnoseThemeMainHelpers(source), []);
  assert.ok(patched.includes('factory-linux-theme:get'));
  assert.ok(patched.includes('factory-linux-theme:changed'));
  assert.ok(patched.includes('factory-linux-theme:follow'));
  assert.ok(patched.includes('process.platform==="linux"&&factoryLinuxOmarchyTrack&&factoryLinuxOmarchyTrack(A,W)'),
    'the vendor background IPC must keep its vendor behavior first and only then call the Linux tracking hook');
  assert.ok(patched.includes('setBackgroundColor("#00000000")'),
    'native transparency is a fully transparent native background, not a fade of the whole window');
  assert.doesNotThrow(() => new vm.Script(patched));
});

test('every injected helper name is tracked for upstream collisions', () => {
  for (const name of ['factoryLinuxOmarchyFollow', 'factoryLinuxOmarchyBase', 'factoryLinuxOmarchyGlass',
    'factoryLinuxOmarchyResize', 'factoryLinuxOmarchyGlassy', 'factoryLinuxOmarchyApply',
    'factoryLinuxOmarchyTrack', 'factoryLinuxOmarchyProviderOptions']) {
    assert.ok(themeMainHelperNames.includes(name), `helper list lacks ${name}`);
  }
});

test('main theme bridge patch refuses missing or duplicate anchors', () => {
  const anchor = themeMainChanges[0][1];
  assert.throws(() => patch('unrelated', themeMainChanges), /precondition failed/);
  assert.throws(() => patch(`${anchor}\n${anchor}`, themeMainChanges), /precondition failed/);
});

// Executes the patched vendor fragment against Electron-shaped mocks (see
// harness below); ops record native repaints and broadcasts in global order.
function harness({ state, stateFn, env, platform = 'linux' } = {}) {
  const handlers = new Map();
  const appEvents = new Map();
  const registeredSet = new Set();
  const windows = [];
  const bridgeOptions = [];
  const vendorBackground = [];
  let clock = 0;
  const ops = [];
  const provider = {
    listener: null, reads: 0, stops: 0,
    start(listener) { this.listener = listener; return Promise.resolve(); },
    getState() { this.reads++; return stateFn ? stateFn() : state; },
    stop() { this.stops++; this.listener = null; },
  };
  const bridge = {
    createOmarchyThemeProvider(options) { bridgeOptions.push(options); return provider; },
    unavailableState: () => ({ available: false, mode: null, background: null,
      foreground: null, accent: null, revision: null, windowMode: null }),
  };
  function makeWindow(url, { registered = true } = {}) {
    const id = `w${windows.length}`;
    const frame = { url };
    const listeners = new Map();
    const window = {
      id, destroyed: false, sent: [], backgrounds: [], registered,
      webContents: {
        mainFrame: frame,
        isDestroyed: () => false,
        isCrashed: () => false,
        isLoading: () => false,
        send: (...message) => { ops.push({ window: id, op: 'send', at: ++clock }); window.sent.push(message); },
      },
      isDestroyed: () => window.destroyed,
      setBackgroundColor: color => { ops.push({ window: id, op: 'background', at: ++clock, color }); window.backgrounds.push(color); },
      on: (name, listener) => { const list = listeners.get(name) || []; listeners.set(name, list); list.push(listener); },
      once: (name, listener) => { const list = listeners.get(name) || []; listeners.set(name, list); list.push(listener); },
      emit: name => { for (const listener of [...(listeners.get(name) || [])]) listener(); },
      destroy: () => { window.destroyed = true; window.emit('closed'); },
    };
    if (registered) registeredSet.add(window);
    windows.push(window);
    return window;
  }
  const context = {
    factoryLinuxApplicationMenu: undefined,
    URL,
    process: { platform, resourcesPath: '/opt/factory/resources', env },
    __dirname: APP_DIR,
    require: request => {
      assert.equal(request, path.resolve('/opt/factory/resources', '..', 'port', 'theme-bridge.cjs'));
      return bridge;
    },
    // 0.206.0 initLifecycle-2n3P7GZx.js module aliases verified upstream:
    Q: path,
    vv: { fileURLToPath },
    i: { DESKTOP_RENDERER_ORIGIN: undefined },
    x: {
      app: { getPath: name => { assert.equal(name, 'home'); return '/tmp/theme-fixture'; },
        on: (name, listener) => appEvents.set(name, listener) },
      ipcMain: { handle: (channel, listener) => handlers.set(channel, listener) },
      BrowserWindow: { fromWebContents: sender => windows.find(w => w.webContents === sender) ?? null },
    },
    fr: registeredSet,
    $r: sender => !sender.isDestroyed() && !sender.isCrashed(),
    ps: () => windows,
    // Vendor main-bundle collaborators the integration reaches through:
    ww: () => '#17181c',
    kne: (color, win) => {
      vendorBackground.push([color, win]);
      if (win && !win.isDestroyed()) { win.setBackgroundColor(color); return; }
      for (const w of windows) if (!w.isDestroyed()) w.setBackgroundColor(color);
    },
  };
  // Executes the real patched vendor fragment (the unmodified
  // window:setBackgroundColor handler plus the injected integration) against
  // Electron-shaped mocks. The op log records every native background repaint
  // and every renderer broadcast in global order, so tests can prove the
  // vendor hte call runs first, the glass repaint lands last, and unfollowed
  // windows are never touched.
  const vendorFragment = `${themeMainChanges.map(([, before]) => before).join('\n')},async()=>{})`;
  const patched = patch(vendorFragment, themeMainChanges).replace(
    'void factoryLinuxOmarchyStart();',
    'void factoryLinuxOmarchyStart();'
    + 'globalThis.themeBridgeTest={provider:factoryLinuxOmarchyProvider,publish:factoryLinuxOmarchyPublish,'
    + 'apply:factoryLinuxOmarchyApply,follow:factoryLinuxOmarchyFollow,base:factoryLinuxOmarchyBase,'
    + 'glass:factoryLinuxOmarchyGlass,resize:factoryLinuxOmarchyResize};');
  vm.runInNewContext(patched, context);
  const event = window => ({ sender: window.webContents, senderFrame: window.webContents.mainFrame });
  return {
    handlers, appEvents, windows, bridgeOptions, provider, ops, vendorBackground, context,
    event, makeWindow,
    follow: (window, enabled) => handlers.get('factory-linux-theme:follow')(event(window), enabled),
    setBackground: (window, color) =>
      handlers.get('window:setBackgroundColor')({ sender: window?.webContents ?? { id: -1 } }, { color }),
    publish: state => context.themeBridgeTest.publish(state),
  };
}

const glassyState = () => ({ available: true, mode: 'dark', background: '#101019',
  foreground: '#eeeeee', accent: '#89b4fa', revision: 'fixture-1', windowMode: 'glassy' });

test('main bridge accepts only a registered trusted main frame and broadcasts only to trusted windows', async () => {
  const h = harness({ state: { available: true, mode: 'dark', background: '#101019',
    foreground: '#eeeeee', accent: '#89b4fa', revision: 'fixture-1', windowMode: 'transparent' } });
  await Promise.resolve();

  const trusted = h.windows[0] ?? h.makeWindow(TRUSTED_URL);
  const wrongUrl = h.makeWindow('file:///untrusted/index.html');
  const unregistered = h.makeWindow(TRUSTED_URL, { registered: false });
  const getState = h.handlers.get('factory-linux-theme:get');
  assert.equal(typeof getState, 'function');
  assert.equal(h.handlers.has('factory-linux-theme:changed'), false,
    'the change channel is outbound only, not an arbitrary renderer subscription handler');
  assert.equal((await getState({ sender: trusted.webContents, senderFrame: { url: trusted.webContents.mainFrame.url } })).available,
    false, 'a different frame object cannot impersonate mainFrame');
  assert.equal((await getState(h.event(unregistered))).available, false,
    'a window outside the registered set is rejected');
  assert.equal((await getState(h.event(wrongUrl))).available, false,
    'a main frame at an unrelated file URL is rejected');
  assert.equal(h.provider.reads, 0, 'rejected requests do not reach the provider');

  const result = await getState(h.event(trusted));
  assert.equal(result.revision, 'fixture-1');
  assert.equal(result.windowMode, 'transparent', 'the provider windowMode is passed through untouched');
  assert.equal(h.provider.reads, 1);
  h.publish(result);
  assert.equal(trusted.sent.length, 1, 'trusted app window receives the sanitized update');
  assert.equal(wrongUrl.sent.length, 0, 'untrusted app window receives no palette update');
  assert.deepEqual(trusted.backgrounds, [], 'publishing a non-glassy state never repaints natives');

  h.appEvents.get('window-all-closed')();
  assert.equal(h.provider.stops, 1, 'all-window cleanup stops the watcher');
});

test('webview frames can never authenticate the bridge or opt into transparency', async () => {
  const handlers = new Map();
  const backgrounds = [];
  const provider = {
    start() { return Promise.resolve(); },
    getState() { return glassyState(); },
    stop() {},
  };
  const bridge = {
    createOmarchyThemeProvider: () => provider,
    unavailableState: () => ({ available: false, revision: null, windowMode: null }),
  };
  const frame = { url: TRUSTED_URL };
  const webContents = {
    mainFrame: { url: 'about:blank' },
    isDestroyed: () => false, isCrashed: () => false, isLoading: () => false,
    send: () => {},
  };
  const owner = { isDestroyed: () => false, setBackgroundColor: color => backgrounds.push(color) };
  const context = {
    URL,
    process: { platform: 'linux', resourcesPath: '/opt/factory/resources' },
    __dirname: APP_DIR,
    require: () => bridge,
    Q: path,
    vv: { fileURLToPath },
    i: { DESKTOP_RENDERER_ORIGIN: undefined },
    x: {
      app: { getPath: () => '/tmp/theme-fixture', on: () => {} },
      ipcMain: { handle: (channel, listener) => handlers.set(channel, listener) },
      BrowserWindow: { fromWebContents: () => owner },
    },
    fr: new Set([owner]),
    $r: () => true,
    ps: () => [owner],
  };
  vm.runInNewContext(patch(
    `${themeMainChanges.map(([, before]) => before).join('\n')},async()=>{})`, themeMainChanges),
    context);
  await Promise.resolve();
  const spoofed = { sender: webContents, senderFrame: frame };
  assert.equal((await handlers.get('factory-linux-theme:get')(spoofed)).available, false,
    'a frame object different from the main frame is rejected even with a trusted URL');
  assert.equal(await handlers.get('factory-linux-theme:follow')(spoofed, true), false,
    'a spoofed frame cannot opt a window into native transparency');
  assert.deepEqual(backgrounds, [], 'no native background is ever touched for a spoofed frame');
});

test('provider options pass an absolute XDG_STATE_HOME through and nothing else', async () => {
  const absolute = harness({ state: glassyState(), env: { XDG_STATE_HOME: '/tmp/xdg-state' } });
  await Promise.resolve();
  assert.equal(absolute.bridgeOptions[0].home, '/tmp/theme-fixture');
  assert.equal(absolute.bridgeOptions[0].stateHome, '/tmp/xdg-state');
  const relative = harness({ state: glassyState(), env: { XDG_STATE_HOME: 'relative/state' } });
  await Promise.resolve();
  assert.equal(relative.bridgeOptions[0].home, '/tmp/theme-fixture');
  assert.equal('stateHome' in relative.bridgeOptions[0], false,
    'a relative XDG_STATE_HOME is not forwarded; the bridge falls back to its own default');
  const unset = harness({ state: glassyState() });
  await Promise.resolve();
  assert.equal(unset.bridgeOptions[0].home, '/tmp/theme-fixture');
  assert.equal('stateHome' in unset.bridgeOptions[0], false);
});

test('a trusted window with glassy provider state goes natively transparent, per window', async () => {
  const h = harness({ state: glassyState() });
  await Promise.resolve();
  const first = h.makeWindow(TRUSTED_URL);
  const second = h.makeWindow(TRUSTED_URL);

  for (const malformed of ['yes', 1, null, undefined, {}, true && 'truthy']) {
    assert.equal(await h.follow(first, malformed), false,
      'only a real boolean is accepted; malformed input changes nothing');
  }
  assert.deepEqual(first.backgrounds, [], 'malformed follow flags never touch the native window');

  assert.equal(await h.follow(first, true), true, 'a trusted main frame follow is accepted');
  assert.deepEqual(first.backgrounds, ['#00000000'],
    'glassy follow applies a fully transparent native background');
  assert.deepEqual(second.backgrounds, [],
    'the second window stays opaque: follow is per window');

  assert.equal(await h.follow(second, true), true);
  assert.deepEqual(second.backgrounds, ['#00000000']);
  assert.equal(await h.follow(first, false), true);
  assert.deepEqual(first.backgrounds, ['#00000000', '#17181c'],
    'unfollowing restores the vendor baseline when no cached RGB exists');
  assert.deepEqual(second.backgrounds, ['#00000000'], 'the other window keeps its glass');

  // The follow state lives only in WeakMaps held by the main process; no
  // provider stop or persistence side effects exist while toggling.
  assert.equal(h.provider.stops, 0);
});

test('only a valid glassy windowMode from an available provider makes windows transparent', async () => {
  let current = { available: true, mode: 'dark', background: '#101019',
    foreground: '#eeeeee', accent: '#89b4fa', revision: 'r1', windowMode: 'transparent' };
  const h = harness({ stateFn: () => current });
  await Promise.resolve();
  const win = h.makeWindow(TRUSTED_URL);
  assert.equal(await h.follow(win, true), true);
  assert.deepEqual(win.backgrounds, [], 'windowMode transparent never repaints natives');

  for (const windowMode of ['opaque', null, undefined, 'glassy ']) {
    current = { ...current, windowMode };
    assert.equal(await h.follow(win, true), true);
  }
  assert.deepEqual(win.backgrounds, [], 'opaque, null, missing, or malformed modes stay solid');

  current = glassyState();
  h.publish(current);
  assert.deepEqual(win.backgrounds, ['#00000000'],
    'a provider update re-applies transparency to the opted-in window');
  assert.ok(win.sent.some(m => m[0] === 'factory-linux-theme:changed'),
    'the state is published to the opted-in renderer');

  current = { ...glassyState(), windowMode: 'opaque' };
  h.publish(current);
  assert.deepEqual(win.backgrounds, ['#00000000', '#17181c'],
    'an opaque provider state restores the vendor baseline');

  current = { available: false, mode: null, background: null, foreground: null,
    accent: null, revision: null, windowMode: null };
  h.publish(current);
  assert.deepEqual(win.backgrounds, ['#00000000', '#17181c'],
    'an unavailable provider state does not repaint again: the window was already restored');

  current = glassyState();
  h.publish(current);
  assert.deepEqual(win.backgrounds, ['#00000000', '#17181c', '#00000000'],
    'glassy returns on a later provider update');
});

test('vendor background IPC keeps vendor behavior first and re-glasses followed windows', async () => {
  const h = harness({ state: glassyState() });
  await Promise.resolve();
  const followed = h.makeWindow(TRUSTED_URL);
  const unfollowed = h.makeWindow(TRUSTED_URL);
  assert.equal(await h.follow(followed, true), true);
  assert.deepEqual(followed.backgrounds, ['#00000000']);

  // Targeted renderer background change while glassy.
  await h.setBackground(followed, '#2a2b31');
  assert.deepEqual(h.vendorBackground, [['#2a2b31', followed]],
    'the real vendor hte call runs with the exact sender window');
  assert.deepEqual(followed.backgrounds, ['#00000000', '#2a2b31', '#00000000'],
    'vendor repaint lands, then the tracked RGB is cached and glass is re-applied');
  assert.deepEqual(unfollowed.backgrounds, [], 'the other window is untouched by a targeted change');

  assert.equal(await h.follow(followed, false), true);
  assert.deepEqual(followed.backgrounds, ['#00000000', '#2a2b31', '#00000000', '#2a2b31'],
    'unfollow restores the last known vendor RGB, not the original baseline');

  // Broadcast background change (sender has no window).
  await h.setBackground(null, '#53555c');
  assert.deepEqual(unfollowed.backgrounds, ['#53555c'], 'vendor broadcast reaches every live window');
  assert.deepEqual(followed.backgrounds.slice(-1), ['#53555c'],
    'the unfollowed window keeps the vendor broadcast as its native state');
  assert.equal(await h.follow(followed, true), true);
  assert.deepEqual(followed.backgrounds.slice(-1), ['#00000000'],
    'the new broadcast RGB is cached as the baseline and glass applies on top');

  // Malformed colors through the vendor channel never reach any window.
  const before = followed.backgrounds.length + unfollowed.backgrounds.length;
  await h.setBackground(followed, '#00000000');
  await h.setBackground(followed, 'blue');
  await h.setBackground(followed, null);
  assert.equal(followed.backgrounds.length + unfollowed.backgrounds.length, before,
    '8-digit or non-hex colors are rejected before hte or the tracking hook run');
});

test('resize repaints and window close never wedge the glass state', async () => {
  const h = harness({ state: glassyState() });
  await Promise.resolve();
  const win = h.makeWindow(TRUSTED_URL);
  assert.equal(await h.follow(win, true), true);
  assert.deepEqual(win.backgrounds, ['#00000000']);

  // The vendor resize path repaints the cached opaque ua; the follow-time
  // listener must re-apply native transparency right after it.
  win.setBackgroundColor('#101019');
  win.emit('resize');
  assert.deepEqual(win.backgrounds, ['#00000000', '#101019', '#00000000'],
    'the resize listener re-glasses after the vendor resize repaint');

  win.emit('resize');
  assert.deepEqual(win.backgrounds, ['#00000000', '#101019', '#00000000', '#00000000'],
    'the listener is idempotent and never removed');

  win.destroy();
  assert.equal(await h.follow(win, true), false, 'a destroyed window cannot follow again');
  assert.equal(await h.follow(win, false), false);
  assert.deepEqual(win.backgrounds, ['#00000000', '#101019', '#00000000', '#00000000'],
    'a closed window is never repainted; WeakMap state dies with the window');
});
