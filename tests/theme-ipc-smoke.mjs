// Live IPC smoke for the optional Omarchy theme bridge. This launches only a
// disposable packaged app/profile with fake theme data and blocked networking.
// Usage: node tests/theme-ipc-smoke.mjs <bundle> [output-directory]
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const { _electron } = await import(process.env.FACTORY_PLAYWRIGHT_MODULE || 'playwright');
const bundle = path.resolve(process.argv[2] || '');
if (!process.argv[2]) throw new Error('Usage: node tests/theme-ipc-smoke.mjs <bundle> [output-directory]');
const output = path.resolve(process.argv[3] || 'build/theme-ipc-smoke');
const work = await mkdtemp(path.join(tmpdir(), 'factory-theme-ipc-'));
await mkdir(output, { recursive: true });

const emptyDto = {
  available: false, mode: null, background: null, foreground: null, accent: null, revision: null,
  windowMode: null,
};
const palette = (mode, background, foreground, accent) =>
  `mode = "${mode}"\nbackground = "${background}"\nforeground = "${foreground}"\naccent = "${accent}"\n`;

function isolatedEnv(home) {
  // Keep only display/runtime variables needed for a real Linux window. In
  // particular, never forward API keys, keyring state, node injection, or the
  // user's application directories into the test process.
  const env = {};
  for (const key of [
    'PATH', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'DISPLAY', 'WAYLAND_DISPLAY',
    'XAUTHORITY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_SESSION_TYPE',
    'ELECTRON_OZONE_PLATFORM_HINT', 'GDK_BACKEND', 'LD_LIBRARY_PATH', 'TMPDIR',
  ]) if (process.env[key] !== undefined) env[key] = process.env[key];

  Object.assign(env, {
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, 'config'),
    XDG_DATA_HOME: path.join(home, 'data'),
    XDG_CACHE_HOME: path.join(home, 'cache'),
    XDG_STATE_HOME: path.join(home, 'state'),
    FACTORY_HOME_OVERRIDE: path.join(home, 'factory-home'),
    FACTORY_ENV: 'production',
    FACTORY_RELEASE_CHANNEL: 'production',
    FACTORY_DEPLOYMENT_ENV: 'production',
    FACTORY_DISABLE_KEYRING: '1',
    HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9',
    ALL_PROXY: 'http://127.0.0.1:9', http_proxy: 'http://127.0.0.1:9',
    https_proxy: 'http://127.0.0.1:9', all_proxy: 'http://127.0.0.1:9',
    NO_PROXY: '', no_proxy: '',
  });
  return env;
}

async function makeOmarchyFixture(home) {
  const current = path.join(home, '.local', 'state', 'omarchy', 'current');
  const theme = path.join(current, 'theme');
  await mkdir(theme, { recursive: true });
  await writeFile(path.join(theme, 'colors.toml'),
    palette('dark', '#101019', '#eeeeee', '#89b4fa'));
  await writeFile(path.join(current, 'theme.generation'), 'fixture-dark-1\n');
  return { current, theme };
}

async function launch(bundlePath, home) {
  return _electron.launch({
    executablePath: path.join(bundlePath, 'factory-desktop'),
    args: [
      `--user-data-dir=${path.join(home, 'user-data')}`,
      '--proxy-server=http://127.0.0.1:9',
      '--host-resolver-rules=MAP * ~NOTFOUND',
      '--disable-background-networking',
      '--disable-component-update',
    ],
    env: isolatedEnv(home),
    chromiumSandbox: true,
    timeout: 60000,
  });
}

async function waitForApi(page) {
  await page.waitForLoadState('load', { timeout: 45000 });
  await page.waitForFunction(
    () => typeof window.electronAPI?.theme?.getOmarchy === 'function'
      && typeof window.electronAPI.theme.onOmarchyChanged === 'function'
      && typeof window.electronAPI.theme.setOmarchyFollow === 'function',
    null, { timeout: 45000 },
  );
}

const report = {
  network: 'blocked by proxy sink, Chromium host resolver, and renderer request routes',
  assertions: [],
};
let app;
let secondApp;
try {
  const themedHome = path.join(work, 'with-omarchy');
  await mkdir(themedHome, { recursive: true });
  const fixture = await makeOmarchyFixture(themedHome);
  app = await launch(bundle, themedHome);
  const page = await app.firstWindow({ timeout: 60000 });
  const rendererErrors = [];
  page.on('pageerror', error => rendererErrors.push(error.message));
  await page.route(/^https?:\/\//, route => route.abort('blockedbyclient'));
  await waitForApi(page);

  const appInfo = await app.evaluate(({ app }) => ({
    platform: process.platform,
    noSandbox: app.commandLine.hasSwitch('no-sandbox'),
  }));
  const browserWindow = await app.browserWindow(page);
  const windowInfo = await browserWindow.evaluate(win => {
    const preferences = win.webContents.getLastWebPreferences();
    return {
      sandbox: preferences.sandbox !== false,
      contextIsolation: preferences.contextIsolation !== false,
      nodeIntegration: preferences.nodeIntegration === true,
    };
  });
  assert.equal(appInfo.platform, 'linux');
  assert.equal(appInfo.noSandbox, false);
  assert.equal(windowInfo.sandbox, true);
  assert.equal(windowInfo.contextIsolation, true);
  assert.equal(windowInfo.nodeIntegration, false);
  report.electron = { ...appInfo, ...windowInfo };

  const initial = await page.evaluate(() => window.electronAPI.theme.getOmarchy());
  assert.deepEqual(initial, {
    available: true, mode: 'dark', background: '#101019', foreground: '#eeeeee',
    accent: '#89b4fa', revision: 'fixture-dark-1', windowMode: 'transparent',
  });
  report.assertions.push('getOmarchy returns the sanitized dark DTO with windowMode transparent (no glass markers) from isolated HOME');

  // Follow smoke: the trusted main frame opts in, and with no glassy marker
  // the windowMode stays "transparent", so the native framebuffer must stay
  // fully opaque. The glassy positive path is proven by the parent's native
  // proof (capturePage alpha 166/255); this asserts the negative control.
  const followAccepted = await page.evaluate(() => window.electronAPI.theme.setOmarchyFollow(true));
  assert.equal(followAccepted, true, 'a trusted main frame follow request is accepted');
  const followAlpha = await browserWindow.evaluate(async win => {
    const image = await win.webContents.capturePage();
    const size = image.getSize();
    const bitmap = image.toBitmap();
    const index = (Math.floor(size.height / 2) * size.width + Math.floor(size.width / 2)) * 4 + 3;
    return bitmap[index];
  });
  assert.equal(followAlpha, 255,
    'following with a non-glassy windowMode must not leak any native transparency');
  assert.equal(await page.evaluate(() => window.electronAPI.theme.setOmarchyFollow(false)), true,
    'follow release is accepted');
  report.assertions.push('setOmarchyFollow round-trips and non-glassy windowMode keeps native framebuffer alpha at 255');

  await page.evaluate(() => {
    window.__factoryThemeEvents = [];
    window.__factoryThemeUnsubscribe = window.electronAPI.theme.onOmarchyChanged(state => {
      window.__factoryThemeEvents.push(state);
    });
  });

  const staged = path.join(fixture.current, '.staged-theme');
  await mkdir(staged);
  await writeFile(path.join(staged, 'colors.toml'),
    palette('light', '#f2f0f0', '#201d1c', '#c44738'));
  await rename(fixture.theme, path.join(fixture.current, '.previous-theme'));
  await rename(staged, fixture.theme);
  await writeFile(path.join(fixture.current, 'theme.generation'), 'fixture-light-2\n');
  await page.waitForFunction(() => window.__factoryThemeEvents?.some(
    state => state.available && state.revision === 'fixture-light-2' && state.mode === 'light'),
  null, { timeout: 5000 });
  const live = await page.evaluate(() => window.__factoryThemeEvents.find(
    state => state.available && state.revision === 'fixture-light-2'));
  assert.deepEqual(live, {
    available: true, mode: 'light', background: '#f2f0f0', foreground: '#201d1c',
    accent: '#c44738', revision: 'fixture-light-2', windowMode: 'transparent',
  });
  report.assertions.push('real preload subscription receives the atomic dark-to-light update');

  await writeFile(path.join(fixture.theme, 'colors.toml'),
    'mode = "light"\nbackground = "#f2f0f0"\nforeground = "#201d1c"\naccent = "not-a-color"\n');
  await writeFile(path.join(fixture.current, 'theme.generation'), 'fixture-invalid-3\n');
  await page.waitForFunction(() => window.__factoryThemeEvents?.some(state => !state.available),
    null, { timeout: 5000 });
  assert.deepEqual(await page.evaluate(() => window.electronAPI.theme.getOmarchy()), emptyDto);
  report.assertions.push('malformed palette publishes unavailable and getOmarchy fails closed');

  await rm(path.join(fixture.theme, 'colors.toml'));
  await writeFile(path.join(fixture.current, 'theme.generation'), 'fixture-missing-4\n');
  assert.deepEqual(await page.evaluate(() => window.electronAPI.theme.getOmarchy()), emptyDto);
  report.assertions.push('missing palette returns the unavailable DTO');

  const eventCount = await page.evaluate(() => {
    window.__factoryThemeUnsubscribe();
    return window.__factoryThemeEvents.length;
  });
  const afterUnsubscribe = path.join(fixture.current, '.after-unsubscribe');
  await mkdir(afterUnsubscribe);
  await writeFile(path.join(afterUnsubscribe, 'colors.toml'),
    palette('dark', '#080808', '#fefefe', '#ff9900'));
  await rename(fixture.theme, path.join(fixture.current, '.missing-theme'));
  await rename(afterUnsubscribe, fixture.theme);
  await writeFile(path.join(fixture.current, 'theme.generation'), 'fixture-unsubscribed-5\n');
  await page.waitForTimeout(350);
  assert.equal(await page.evaluate(() => window.__factoryThemeEvents.length), eventCount,
    'unsubscribe must detach the real preload listener');
  report.assertions.push('unsubscribe stops further real IPC events');
  await app.close();
  app = undefined;

  const emptyHome = path.join(work, 'without-omarchy');
  await mkdir(emptyHome, { recursive: true });
  secondApp = await launch(bundle, emptyHome);
  const secondPage = await secondApp.firstWindow({ timeout: 60000 });
  const secondRendererErrors = [];
  secondPage.on('pageerror', error => secondRendererErrors.push(error.message));
  await secondPage.route(/^https?:\/\//, route => route.abort('blockedbyclient'));
  await waitForApi(secondPage);
  assert.deepEqual(await secondPage.evaluate(() => window.electronAPI.theme.getOmarchy()), emptyDto);
  report.assertions.push('a second isolated HOME without Omarchy returns unavailable');

  assert.deepEqual([...rendererErrors, ...secondRendererErrors], [], 'renderer must not raise page errors');
  report.rendererErrors = [...rendererErrors, ...secondRendererErrors];

  await writeFile(path.join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
} finally {
  if (secondApp) { try { await secondApp.close(); } catch {} }
  if (app) { try { await app.close(); } catch {} }
  await rm(work, { recursive: true, force: true });
}
