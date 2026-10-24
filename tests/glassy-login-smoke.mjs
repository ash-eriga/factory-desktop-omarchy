// Signed-out fail-solid proof against the unmodified application.
// Upstream tdf (the app-providers route component) mounts Ncf, not on
// login. Stored Follow must not produce an unpainted transparent login window.
// Positive Glassy proof belongs to theme-smoke + glassy-compositor-playwright.
// Uses a disposable HOME. No login, credential, or model request.
// Usage: node tests/glassy-login-smoke.mjs <absolute-bundle> <absolute-output>
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const { _electron } = await import(process.env.FACTORY_PLAYWRIGHT_MODULE || 'playwright');
assert.ok(process.argv[2], 'provide the unmodified bundle');
const bundle = path.resolve(process.argv[2]);
const output = path.resolve(process.argv[3] || 'build/glassy-login-smoke');
const home = await mkdtemp(path.join(tmpdir(), 'fgl-'));
const theme = path.join(home, '.local/state/omarchy/current/theme');
const toggles = path.join(home, 'state/omarchy/toggles/hypr');
const keys = ['factory-theme-preference', 'factory-appearance-settings', 'factory-appearance-startup-backgrounds'];
const env = {};
for (const key of ['PATH', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'DISPLAY', 'WAYLAND_DISPLAY',
  'XAUTHORITY', 'XDG_RUNTIME_DIR', 'XDG_SESSION_TYPE', 'ELECTRON_OZONE_PLATFORM_HINT', 'TMPDIR']) {
  if (process.env[key] !== undefined) env[key] = process.env[key];
}
Object.assign(env, {
  HOME: home, XDG_CONFIG_HOME: path.join(home, 'config'), XDG_DATA_HOME: path.join(home, 'data'),
  XDG_CACHE_HOME: path.join(home, 'cache'), XDG_STATE_HOME: path.join(home, 'state'),
  FACTORY_HOME_OVERRIDE: path.join(home, 'factory-home'), FACTORY_DISABLE_KEYRING: '1',
  DBUS_SESSION_BUS_ADDRESS: `unix:path=${home}/no-bus`,
  HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', ALL_PROXY: 'http://127.0.0.1:9',
});
await mkdir(theme, { recursive: true });
await mkdir(toggles, { recursive: true });
await mkdir(output, { recursive: true });
await writeFile(path.join(theme, 'colors.toml'),
  'mode = "dark"\nbackground = "#101019"\nforeground = "#eeeeee"\naccent = "#89b4fa"\n');
await writeFile(path.dirname(theme) + '/theme.generation', 'glassy-unmodified-login\n');
await writeFile(path.join(toggles, 'window-glassy.lua'), '-- test marker, never executed\n');
const errors = [];
const report = { artifact: bundle, scope: 'unmodified signed-out Factory; no authenticated appearance provider; fail-solid fallback', stages: {} };
let app;
let page;
try {
  app = await _electron.launch({
    executablePath: path.join(bundle, 'factory-desktop'), env, chromiumSandbox: true,
    args: [`--user-data-dir=${path.join(home, 'profile')}`, '--proxy-server=http://127.0.0.1:9',
      '--host-resolver-rules=MAP * ~NOTFOUND', '--disable-background-networking', '--disable-component-update'],
    timeout: 60000,
  });
  page = await app.firstWindow({ timeout: 60000 });
  page.on('pageerror', error => errors.push(error.message));
  await page.route(/^https?:\/\//, route => route.abort('blockedbyclient'));
  const handle = await app.browserWindow(page);
  const waitLogin = () => page.waitForFunction(() => document.body.innerText.includes('Sign in'),
    null, { timeout: 30000 });
  const preferences = () => page.evaluate(keys => Object.fromEntries(keys.map(key =>
    [key, localStorage.getItem(key)])), keys);
  async function frame() {
    return handle.evaluate(async win => {
      const image = await win.webContents.capturePage(), { width, height } = image.getSize();
      const bitmap = image.toBitmap(), offset = (140 * width + 16) * 4;
      const prefs = win.webContents.getLastWebPreferences();
      return {
        size: { width, height }, bgra: [...bitmap.subarray(offset, offset + 4)],
        sandbox: prefs.sandbox !== false, contextIsolation: prefs.contextIsolation !== false,
        nodeIntegration: prefs.nodeIntegration === true,
      };
    });
  }
  async function stage(name, mode, alpha) {
    await page.waitForFunction(async mode => {
      const state = await window.electronAPI.theme.getOmarchy();
      return state.available && state.windowMode === mode;
    }, mode, { timeout: 10000 });
    let sample;
    const deadline = Date.now() + 10000;
    do {
      sample = await frame();
      if (Math.abs(sample.bgra[3] - alpha) <= 3) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    assert.ok(Math.abs(sample.bgra[3] - alpha) <= 3, `${name}: expected alpha ${alpha}; ${JSON.stringify(sample)}`);
    assert.equal(sample.sandbox, true);
    assert.equal(sample.contextIsolation, true);
    assert.equal(sample.nodeIntegration, false);
    report.stages[name] = sample;
    await page.screenshot({ path: path.join(output, `${name}.png`) });
  }
  await waitLogin();
  await page.evaluate(() => {
    localStorage.setItem('factory-theme-preference', 'dark');
    localStorage.setItem('factory-port-theme-source', 'factory');
  });
  await page.reload();
  await waitLogin();
  await stage('manual', 'glassy', 255);
  const manual = await preferences();
  await page.evaluate(() => localStorage.setItem('factory-port-theme-source', 'omarchy'));
  await page.reload();
  await waitLogin();
  await stage('follow-glassy', 'glassy', 255);
  await writeFile(path.join(toggles, 'window-opaque.lua'), '-- opaque wins\n');
  await stage('follow-opaque', 'opaque', 255);
  await rm(path.join(toggles, 'window-opaque.lua'));
  await stage('follow-glassy-restored', 'glassy', 255);
  await rm(path.join(toggles, 'window-glassy.lua'));
  await stage('follow-transparent-mode', 'transparent', 255);
  await writeFile(path.join(toggles, 'window-glassy.lua'), '-- glassy again\n');
  await stage('follow-glassy-again', 'glassy', 255);
  await page.evaluate(() => localStorage.setItem('factory-port-theme-source', 'factory'));
  await page.reload();
  await waitLogin();
  await stage('follow-off', 'glassy', 255);
  assert.deepEqual(await preferences(), manual, 'manual preference bytes remain unchanged');
  assert.deepEqual(errors, []);
  report.manualStorageIdentical = true;
  report.rendererErrors = errors;
  report.process = await app.evaluate(({ app }) => ({
    version: app.getVersion(), executable: process.execPath, appPath: app.getAppPath(),
    noSandbox: app.commandLine.hasSwitch('no-sandbox'),
  }));
  assert.equal(report.process.noSandbox, false);
  const source = JSON.parse(await readFile(path.join(bundle, 'manifest.json'), 'utf8'));
  assert.equal(report.process.version, source.desktop);
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} catch (error) {
  report.failure = { message: error.message, stack: error.stack };
  if (page) {
    try {
      report.dom = await page.evaluate(() => ({
        theme: document.documentElement.getAttribute('data-theme'),
        htmlBackground: getComputedStyle(document.documentElement).backgroundColor,
        bodyBackground: getComputedStyle(document.body).backgroundColor,
        source: localStorage.getItem('factory-port-theme-source'),
      }));
      await page.screenshot({ path: path.join(output, 'failure.png') });
    } catch {}
  }
  await writeFile(path.join(output, 'failure.json'), JSON.stringify(report, null, 2) + '\n');
  throw error;
} finally {
  if (app) await app.close();
  await rm(home, { recursive: true, force: true });
}
