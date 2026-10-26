import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { access } from 'node:fs/promises';
import { ROOT, SNAPSHOT_DIR, versions, portVersion } from '../tools/common.mjs';
import { patch, changes } from '../tools/patches.mjs';
import { themeMainChanges } from '../tools/theme-main-patches.mjs';
import { applicationMenuMainChanges } from '../tools/application-menu-patches.mjs';
import { computerRegistrationMainChanges } from '../tools/computer-registration-patches.mjs';
import { updateNotificationMainChanges, diagnoseUpdateNotificationHelpers,
  unpatchUpdateNotifications } from '../tools/update-notification-patches.mjs';

const require = createRequire(import.meta.url);
const { versionParts, compareVersions, checkForUpdate, createUpdateNotifier,
  RELEASE_API, GUIDE_URL } = require('../runtime/update-notifier.cjs');
const DAY = 24 * 60 * 60 * 1000;
const release = (tag = 'v0.206.0-17', extra = {}) => ({
  tag_name: tag, draft: false, prerelease: false,
  published_at: '2026-10-25T12:00:00Z', html_url: 'https://untrusted.invalid/run',
  ...extra,
});
const response = body => new Response(JSON.stringify(body), { status: 200 });
const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };

async function fixture({ saved, locale = 'en-US', getRelease = async () => response(release()) } = {}) {
  const home = await mkdtemp(path.join(tmpdir(), 'factory-updates-'));
  const stateFile = path.join(home, 'port-updates.json');
  if (saved !== undefined) await writeFile(stateFile, typeof saved === 'string' ? saved : JSON.stringify(saved));
  const app = new EventEmitter();
  app.getPath = name => { assert.equal(name, 'userData'); return home; };
  app.getLocale = () => locale;
  const calls = [], opened = [], requests = [], timers = new Map();
  const win = { isDestroyed: () => false };
  const env = { time: DAY * 10, focused: win, allowed: true, canAutoCheck: true, answer: 2, menus: 0 };
  const notifier = createUpdateNotifier({
    electron: {
      app, BrowserWindow: { getFocusedWindow: () => env.focused },
      dialog: { async showMessageBox(...args) { calls.push(args.at(-1)); return { response: env.answer }; } },
      shell: { async openExternal(url) { opened.push(url); } },
    },
    version: '0.206.0-16', allowed: () => env.allowed, canAutoCheck: () => env.canAutoCheck,
    rebuildMenu: () => env.menus++,
    now: () => env.time,
    fetchImpl: async (...args) => { requests.push(args); return getRelease(...args); },
    schedule: (callback, delay) => {
      const id = { unref() {} }; timers.set(id, { callback, delay }); return id;
    },
    cancel: id => timers.delete(id),
  });
  const tick = async () => {
    const entries = [...timers.values()]; timers.clear();
    for (const entry of entries) { assert.equal(entry.delay, 15000); entry.callback(); }
    // Wait for response streams and the dialog, not real wall-clock timers.
    await flush();
    await new Promise(resolve => setImmediate(resolve));
    await flush();
  };
  return { app, env, notifier, home, stateFile, calls, opened, requests, timers, tick,
    async close() { notifier.stop(); await rm(home, { recursive: true, force: true }); } };
}

test('port versions compare numeric upstream components and package revisions', () => {
  assert.equal(compareVersions('0.206.0-17', '0.206.0-16'), 1);
  assert.equal(compareVersions('0.206.0-9', '0.206.0-16'), -1);
  assert.equal(compareVersions('0.207.0-1', '0.206.0-99'), 1);
  assert.equal(compareVersions('0.206.0-16', '0.206.0-16'), 0);
  for (const value of ['0.206.0', 'v0.206.0-16', '0.206.0-0', '0.206.0-016',
    '0.206.0-16-beta', '1:0.206.0-16', '0.206.0-9007199254740992', '../0.206.0-17'])
    assert.equal(versionParts(value), null, value);
});

test('the query uses a fixed public endpoint, omits credentials and ignores external release URLs', async () => {
  let request;
  const value = await checkForUpdate('0.206.0-16', async (...args) => {
    request = args; return response(release());
  });
  assert.equal(request[0], RELEASE_API);
  assert.equal(RELEASE_API, 'https://api.github.com/repos/ash-eriga/factory-desktop-omarchy/releases/latest');
  assert.equal(request[1].credentials, 'omit');
  assert.equal(request[1].redirect, 'error');
  assert.ok(request[1].signal instanceof AbortSignal);
  assert.deepEqual(Object.keys(request[1].headers).sort(), ['Accept', 'User-Agent']);
  assert.equal(value.status, 'available');
  assert.equal(value.releaseUrl, 'https://github.com/ash-eriga/factory-desktop-omarchy/releases/tag/v0.206.0-17');
  assert.equal(value.installedVersion, '0.206.0-16');
});

test('equal or older published versions never prompt an update or downgrade', async () => {
  for (const version of ['v0.206.0-16', 'v0.206.0-15', 'v0.205.0-99']) {
    const value = await checkForUpdate('0.206.0-16', async () => response(release(version)));
    assert.equal(value.status, 'current');
  }
});

test('draft, prerelease, upstream-only and malformed releases are unavailable', async () => {
  for (const body of [release('v0.206.0-17', { draft: true }), release('v0.206.0-17', { prerelease: true }),
    release('v0.207.0'), release('v0.206.0-17', { published_at: null }), {}, null]) {
    const value = await checkForUpdate('0.206.0-16', async () => response(body));
    assert.equal(value.status, 'unavailable');
  }
});

test('private repo, no releases, rate limit, offline, bad JSON and oversized metadata are not up to date', async () => {
  for (const fetchImpl of [
    ...[404, 403, 429, 500].map(status => async () => new Response('', { status })),
    async () => { throw new Error('offline'); },
    async () => new Response('invalid JSON'),
    async () => new Response('x'.repeat(256 * 1024 + 1)),
  ]) {
    assert.deepEqual(await checkForUpdate('0.206.0-16', fetchImpl), { status: 'unavailable' });
  }
});

test('automatic check is delayed, non-installing, persisted privately and shown once per release', async () => {
  const h = await fixture();
  try {
    assert.equal(h.requests.length, 0);
    await h.tick();
    assert.equal(h.requests.length, 1);
    assert.equal(h.calls.length, 1);
    assert.match(h.calls[0].message, /0\.206\.0-17/);
    assert.match(h.calls[0].detail, /Nothing is installed automatically/);
    assert.deepEqual(h.opened, []);
    const state = JSON.parse(await readFile(h.stateFile));
    assert.equal(state.notified, '0.206.0-16:0.206.0-17');
    assert.equal((await stat(h.stateFile)).mode & 0o777, 0o600);
    h.app.emit('browser-window-focus'); await h.tick();
    assert.equal(h.requests.length, 1, 'no repeated request within 24 hours');
    h.env.time += DAY; h.app.emit('browser-window-focus'); await h.tick();
    assert.equal(h.requests.length, 2);
    assert.equal(h.calls.length, 1, 'same release is not shown repeatedly');
  } finally { await h.close(); }
});

test('saved daily throttle survives restarts; a new release can notify later', async () => {
  const h = await fixture({ saved: { automatic: true, lastChecked: DAY * 10,
    notified: '0.206.0-16:0.206.0-17' }, getRelease: async () => response(release('v0.206.0-18')) });
  try {
    await h.tick();
    assert.equal(h.requests.length, 0);
    h.env.time += DAY; h.app.emit('browser-window-focus'); await h.tick();
    assert.equal(h.calls.length, 1);
    assert.match(h.calls[0].message, /0\.206\.0-18/);
  } finally { await h.close(); }
});

test('manual check bypasses the daily throttle and opens only the guide or canonical release', async () => {
  const h = await fixture({ saved: { lastChecked: DAY * 10, automatic: false } });
  try {
    await h.tick();
    assert.equal(h.requests.length, 0);
    h.env.answer = 0; await h.notifier.menuItems()[0].click();
    assert.equal(h.opened[0], GUIDE_URL);
    h.env.answer = 1; await h.notifier.check();
    assert.equal(h.opened[1], 'https://github.com/ash-eriga/factory-desktop-omarchy/releases/tag/v0.206.0-17');
    assert.equal(h.requests.length, 2);
  } finally { await h.close(); }
});

test('manual unavailable result is explicit while automatic failure stays quiet', async () => {
  const h = await fixture({ getRelease: async () => new Response('', { status: 404 }) });
  try {
    await h.tick();
    assert.equal(h.calls.length, 0);
    await h.notifier.check();
    assert.match(h.calls[0].message, /Could not check/);
    assert.match(h.calls[0].detail, /private repository/);
  } finally { await h.close(); }
});

test('manual current result reports a published release, not upstream compatibility', async () => {
  const h = await fixture({ getRelease: async () => response(release('v0.206.0-16')) });
  try {
    h.env.answer = 0; await h.notifier.check();
    assert.match(h.calls[0].message, /No newer published port release/);
    assert.deepEqual(h.opened, []);
  } finally { await h.close(); }
});

test('automatic checks can be disabled persistently without disabling manual checks', async () => {
  const h = await fixture();
  try {
    h.notifier.menuItems()[1].click({ checked: false });
    await h.tick();
    assert.equal(h.requests.length, 0);
    assert.equal(JSON.parse(await readFile(h.stateFile)).automatic, false);
    assert.equal(h.env.menus, 1);
    await h.notifier.check();
    assert.equal(h.requests.length, 1);
  } finally { await h.close(); }
});

test('deployment policy and upstream automatic-update preference are respected', async () => {
  const h = await fixture();
  try {
    h.env.allowed = false; await h.tick(); await h.notifier.check();
    assert.deepEqual(h.notifier.menuItems(), []);
    assert.equal(h.requests.length, 0);
    h.env.allowed = true; h.env.canAutoCheck = false;
    h.app.emit('browser-window-focus'); await h.tick();
    assert.equal(h.requests.length, 0);
    assert.equal(h.notifier.menuItems()[1].enabled, false);
    await h.notifier.check();
    assert.equal(h.requests.length, 1);
  } finally { await h.close(); }
});

test('focus loss does not interrupt other work or lose a completed notification', async () => {
  let resolve;
  const pending = new Promise(r => { resolve = r; });
  const h = await fixture({ getRelease: () => pending });
  try {
    await h.tick();
    h.env.focused = null; resolve(response(release()));
    await flush(); await new Promise(r => setImmediate(r));
    assert.equal(h.calls.length, 0);
    h.env.focused = { isDestroyed: () => false };
    h.app.emit('browser-window-focus'); await h.tick();
    assert.equal(h.calls.length, 1);
    assert.equal(h.requests.length, 1, 'reuse the checked metadata');
  } finally { await h.close(); }
});

test('concurrent manual checks share one request and one dialog', async () => {
  let resolve;
  const h = await fixture({ getRelease: () => new Promise(r => { resolve = r; }) });
  try {
    const a = h.notifier.check(), b = h.notifier.check();
    assert.equal(a, b);
    resolve(response(release())); await a;
    assert.equal(h.requests.length, 1);
    assert.equal(h.calls.length, 1);
  } finally { await h.close(); }
});

test('stopping removes listeners and suppresses late responses', async () => {
  let resolve;
  const h = await fixture({ getRelease: () => new Promise(r => { resolve = r; }) });
  try {
    const task = h.notifier.check();
    h.app.emit('will-quit');
    assert.equal(h.timers.size, 0);
    assert.equal(h.app.listenerCount('browser-window-focus'), 0);
    resolve(response(release())); await task;
    assert.equal(h.calls.length, 0);
    assert.deepEqual(h.notifier.menuItems(), []);
  } finally { await h.close(); }
});

test('a corrupt or unwritable preferences file never blocks a manual check', async () => {
  const h = await fixture({ saved: '{invalid' });
  try {
    // Replacing the profile directory with a file makes persistence fail,
    // without relying on root-sensitive chmod behavior.
    await rm(h.home, { recursive: true }); await writeFile(h.home, 'read-only profile fixture');
    await h.notifier.check();
    assert.equal(h.calls.length, 1);
  } finally { await h.close(); }
});

test('Portuguese menu and notification use safe local text', async () => {
  const h = await fixture({ locale: 'pt-BR' });
  try {
    assert.match(h.notifier.menuItems()[0].label, /Verificar atualizações/);
    await h.notifier.check();
    assert.match(h.calls[0].message, /Nova versão do port/);
    assert.equal(h.calls[0].buttons[0], 'Como atualizar');
  } finally { await h.close(); }
});

test('build package identity includes the Linux revision and rejects invalid metadata', async () => {
  const recipe = await readFile(path.join(ROOT, 'PKGBUILD'), 'utf8');
  assert.equal(await portVersion(), `${versions.desktop}-${recipe.match(/^pkgrel=(\d+)$/m)[1]}`);
  const dir = await mkdtemp(path.join(tmpdir(), 'factory-update-version-'));
  try {
    for (const body of ['pkgver=0.0.0\npkgrel=16\n', `pkgver=${versions.desktop}\npkgrel=0\n`]) {
      await writeFile(path.join(dir, 'PKGBUILD'), body);
      await assert.rejects(portVersion(dir));
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

const lifecycleFile = path.join(SNAPSHOT_DIR, 'app', versions.lifecycle);
const present = await access(lifecycleFile).then(() => true, () => false);
test('real upstream integration compiles, retains updater guards and initializes the separate notifier', {
  skip: present ? false : 'pristine upstream snapshot missing; build to validate patch anchors',
}, async () => {
  const source = await readFile(lifecycleFile, 'utf8');
  assert.deepEqual(diagnoseUpdateNotificationHelpers(source), []);
  assert.deepEqual(diagnoseUpdateNotificationHelpers('var factoryPortUpdates;'), ['factoryPortUpdates']);
  const previous = patch(patch(patch(patch(source, changes), themeMainChanges),
    applicationMenuMainChanges), computerRegistrationMainChanges);
  const result = patch(previous, updateNotificationMainChanges);
  assert.doesNotThrow(() => new vm.Script(result));
  assert.equal(unpatchUpdateNotifications(result), previous);
  assert.throws(() => unpatchUpdateNotifications(previous));
  assert.throws(() => patch(result, updateNotificationMainChanges));
  assert.ok(result.includes('async function hj(){if(process.platform==="linux")return;'));
  assert.ok(result.includes('async function vc({onAborted:e}={}){if(process.platform==="linux"){e?.();return;}'));
  let captured, menus = 0;
  const x = {};
  const env = { hosted: true, airgap: false, policy: false, auto: true };
  const context = {
    process: { platform: 'linux', resourcesPath: '/opt/factory-droid-desktop/resources' }, Q: path,
    x, ul: () => env.auto, G1: () => menus++,
    i: { startupTracker: { beginPhase() {} }, getHostedServicesEnabled: () => env.hosted,
      getRuntimeAuthConfig: () => ({ airgapEnabled: env.airgap }),
      areDesktopUpdatesDisabledByCachedOrgSettings: () => env.policy },
    require: filename => {
      if (filename.endsWith('/release.json')) return { version: '0.206.0-16' };
      assert.equal(filename, '/opt/factory-droid-desktop/port/update-notifier.cjs');
      return { createUpdateNotifier: options => { captured = options; return { menuItems: () => [] }; } };
    },
  };
  vm.runInNewContext(`${updateNotificationMainChanges[1][2]};`, context);
  assert.equal(menus, 1);
  assert.equal(captured.electron, x);
  assert.equal(captured.version, '0.206.0-16');
  assert.equal(captured.allowed(), true);
  for (const [key, value] of [['hosted', false], ['airgap', true], ['policy', true]]) {
    const old = env[key]; env[key] = value; assert.equal(captured.allowed(), false); env[key] = old;
  }
  env.auto = false; assert.equal(captured.canAutoCheck(), false);
  // Negative control: the original Linux guard hides all update entries.
  assert.ok(previous.includes('r=process.platform==="linux"||!t||'));
  assert.ok(result.includes('r=process.platform==="linux"?(factoryPortUpdates?.menuItems()??[])'));
});
