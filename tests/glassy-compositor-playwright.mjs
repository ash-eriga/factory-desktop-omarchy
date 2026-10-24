// Extends theme-smoke.mjs with a compositor proof after its assertions finish.
// FACTORY_PLAYWRIGHT_MODULE=<absolute path to this file>
// FACTORY_REAL_PLAYWRIGHT_MODULE=<absolute path to real Playwright>
// node tests/theme-smoke.mjs <bundle> <output>
//
// This uses the real Factory main/preload/renderer in the smoke's disposable
// clone. Its theme UI is test-mounted, not an authenticated Appearance route.
// No compositor configuration or user's Omarchy markers are changed.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const real = await import(process.env.FACTORY_REAL_PLAYWRIGHT_MODULE || 'playwright');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const output = path.join(path.resolve(process.argv[3] || 'build/theme-smoke'), 'compositor-proof');
const manualKeys = ['factory-theme-preference', 'factory-appearance-settings', 'factory-appearance-startup-backgrounds'];
const getManual = page => page.evaluate(keys => Object.fromEntries(keys.map(key =>
  [key, localStorage.getItem(key)])), manualKeys);

async function proof(app, options) {
  const smokeOutput = path.dirname(output);
  const smoke = JSON.parse(await readFile(path.join(smokeOutput, 'report.json'), 'utf8'));
  assert.equal(smoke.signedIn, false);
  const page = await app.firstWindow();
  const handle = await app.browserWindow(page);
  const mainId = await handle.evaluate(win => win.id);
  const home = options.env.HOME;
  const stateHome = options.env.XDG_STATE_HOME;
  assert.ok(path.isAbsolute(home) && path.isAbsolute(stateHome));
  assert.ok(path.relative(home, stateHome) && !path.relative(home, stateHome).startsWith('..'),
    'only disposable HOME state can be changed');
  const toggles = path.join(stateHome, 'omarchy/toggles/hypr');
  await mkdir(toggles, { recursive: true });
  await rm(path.join(toggles, 'window-opaque.lua'), { force: true });
  await writeFile(path.join(toggles, 'window-glassy.lua'), '-- disposable test marker; never executed\n');
  const current = path.join(home, '.local/state/omarchy/current');
  await mkdir(path.join(current, 'theme'), { recursive: true });
  await writeFile(path.join(current, 'theme/colors.toml'),
    'mode = "dark"\nbackground = "#101019"\nforeground = "#eeeeee"\naccent = "#89b4fa"\n');
  await writeFile(path.join(current, 'theme.generation'), 'compositor-proof-dark\n');
  await page.waitForFunction(async () => {
    const state = await window.electronAPI.theme.getOmarchy();
    return state.available && state.background === '#101019';
  }, null, { timeout: 10000 });
  const before = await getManual(page);
  const follow = page.locator('[aria-label="Follow Omarchy theme"]');
  if (await follow.getAttribute('aria-checked') !== 'true') await follow.click();
  await page.waitForFunction(() => localStorage.getItem('factory-port-theme-source') === 'omarchy');

  await app.evaluate(async ({ BrowserWindow }, mainId) => {
    const win = BrowserWindow.fromId(mainId);
    const bg = new BrowserWindow({
      width: 1100, height: 760, title: 'factory-glassy-proof-backdrop',
      backgroundColor: '#000000',
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    await bg.loadURL('data:text/html,' + encodeURIComponent(
      '<!doctype html><html><head><title>factory-glassy-proof-backdrop</title>' +
      '<style>html,body{margin:0;width:100%;height:100%;background:#000}</style></head><body></body></html>'));
    globalThis.factoryGlassyCompositorProof = { win, bg };
    win.setTitle('factory-glassy-proof-main');
    win.setParentWindow(bg);
    win.show();
    win.focus();
  }, mainId);
  await delay(600);
  const pid = app.process().pid;
  const clients = () => JSON.parse(execFileSync('hyprctl', ['clients', '-j'], { encoding: 'utf8' }))
    .filter(client => client.pid === pid && /^factory-glassy-proof-/.test(client.title));
  const initial = clients();
  assert.equal(initial.length, 2, 'both controlled test windows must be mapped');
  for (const client of initial) {
    assert.equal(client.xwayland, false, 'proof must exercise native Wayland');
    assert.match(client.address, /^0x[0-9a-f]+$/i);
    const target = `window="address:${client.address}"`;
    const bg = client.title.endsWith('-backdrop');
    for (const dispatcher of [
      `hl.dsp.window.float({action="on",${target}})`,
      `hl.dsp.window.resize({x=${bg ? 1100 : 720},y=${bg ? 760 : 480},relative=false,${target}})`,
      `hl.dsp.window.center({${target}})`,
    ]) execFileSync('hyprctl', ['dispatch', dispatcher], { encoding: 'utf8', timeout: 5000 });
  }
  // Electron focus() is advisory on Wayland. Use Omarchy's own dock
  // focus/alter_zorder sequence, scoped to this disposable main window.
  const foreground = initial.find(client => client.title === 'factory-glassy-proof-main');
  const initialBackdrop = initial.find(client => client.title === 'factory-glassy-proof-backdrop');
  assert.ok(Number.isSafeInteger(foreground.workspace.id) && foreground.workspace.id > 0);
  // The user may switch workspaces while the base smoke runs. Move only our
  // disposable backdrop to its foreground, without following or changing rules.
  execFileSync('hyprctl', ['dispatch',
    `hl.dsp.window.move({workspace="${foreground.workspace.id}",follow=false,window="address:${initialBackdrop.address}"})`,
  ], { encoding: 'utf8', timeout: 5000 });
  const raise = () => {
    for (const dispatcher of [
      `hl.dsp.focus({window="address:${foreground.address}"})`,
      `hl.dsp.window.alter_zorder({mode="top",window="address:${foreground.address}"})`,
    ]) execFileSync('hyprctl', ['dispatch', dispatcher], { encoding: 'utf8', timeout: 5000 });
  };
  raise();
  await delay(700);

  const rawSample = async () => app.evaluate(async ({ app }) => {
    const { win } = globalThis.factoryGlassyCompositorProof;
    const image = await win.webContents.capturePage();
    const size = image.getSize(), data = image.toBitmap();
    const at = (x, y) => [...data.subarray((y * size.width + x) * 4, (y * size.width + x) * 4 + 4)];
    const prefs = win.webContents.getLastWebPreferences();
    return {
      size, backgroundPixel: at(216, 140), sidebarPixel: at(16, 140), titlebarPixel: at(300, 16), sandbox: prefs.sandbox !== false,
      contextIsolation: prefs.contextIsolation !== false, nodeIntegration: prefs.nodeIntegration === true,
      noSandbox: app.commandLine.hasSwitch('no-sandbox'),
    };
  });
  let raw;
  for (let attempt = 0; attempt < 30; attempt++) {
    raw = await rawSample();
    if (raw.backgroundPixel[3] >= 160 && raw.backgroundPixel[3] <= 172) break;
    await delay(100);
  }
  assert.ok(raw.backgroundPixel[3] >= 160 && raw.backgroundPixel[3] <= 172,
    `real Factory framebuffer must have alpha near .65: ${JSON.stringify(raw)}`);
  const bridge = await page.evaluate(() => window.electronAPI.theme.getOmarchy());
  assert.equal(bridge.windowMode, 'glassy');
  assert.equal(raw.sandbox, true);
  assert.equal(raw.contextIsolation, true);
  assert.equal(raw.nodeIntegration, false);
  assert.equal(raw.noSandbox, false);
  for (const name of ['sidebarPixel', 'titlebarPixel']) {
    assert.ok(raw[name][3] >= 85 && raw[name][3] <= 94, `${name} retains Glassy Bar alpha`);
  }
  const control = await follow.boundingBox();
  assert.ok(control);
  const controlAlpha = await app.evaluate(async (_, point) => {
    const image = await globalThis.factoryGlassyCompositorProof.win.webContents.capturePage();
    const { width } = image.getSize(), data = image.toBitmap();
    return data[(point.y * width + point.x) * 4 + 3];
  }, { x: Math.floor(control.x + control.width / 2), y: Math.floor(control.y + control.height / 2) });
  assert.equal(controlAlpha, 255, 'real Follow control must stay opaque');

  const main = clients().find(client => client.title === 'factory-glassy-proof-main');
  const backdrop = clients().find(client => client.title === 'factory-glassy-proof-backdrop');
  assert.ok(main && backdrop);
  assert.equal(main.workspace.id, backdrop.workspace.id);
  const [x, y] = main.at, [width, height] = main.size;
  assert.equal(width, raw.size.width, 'compositor and captured surface geometry must agree');
  assert.equal(height, raw.size.height);
  const captures = {};
  for (const [name, background] of Object.entries({
    black: '#000000', white: '#ffffff',
    checker: 'repeating-conic-gradient(#000 0% 25%,#fff 0% 50%) 0 0/4px 4px',
  })) {
    await app.evaluate(async (_, background) => {
      await globalThis.factoryGlassyCompositorProof.bg.webContents.executeJavaScript(
        `document.body.style.background=${JSON.stringify(background)}`);
    }, background);
    raise();
    await delay(400);
    const filename = path.join(output, `${name}.png`);
    execFileSync('grim', ['-g', `${x},${y} ${width}x${height}`, filename], { timeout: 10000 });
    captures[name] = await app.evaluate(({ nativeImage }, filename) => {
      const image = nativeImage.createFromPath(filename), { width } = image.getSize(), data = image.toBitmap();
      const values = [];
      for (let y = 120; y < 160; y++) for (let x = 212; x < 228; x++) values.push(data[(y * width + x) * 4]);
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      return { mean, stddev: Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length) };
    }, filename);
  }
  await writeFile(path.join(output, 'measurements.json'), JSON.stringify({ raw, controlAlpha, captures }, null, 2) + '\n');
  assert.ok(captures.white.mean - captures.black.mean > 30,
    `the actual controlled backdrop must be transmitted: ${JSON.stringify(captures)}`);
  assert.ok(captures.checker.stddev < 12, `fine checker must be blurred, not sharply transmitted: ${JSON.stringify(captures)}`);
  await follow.click();
  await page.waitForFunction(() => localStorage.getItem('factory-port-theme-source') === 'factory');
  let restored;
  for (let attempt = 0; attempt < 30; attempt++) {
    restored = await rawSample();
    if (restored.backgroundPixel[3] === 255) break;
    await delay(100);
  }
  assert.equal(restored.backgroundPixel[3], 255, 'Follow off must restore an opaque native/renderer surface');
  assert.deepEqual(await getManual(page), before, 'manual preference bytes must remain unchanged');
  return {
    scope: 'real Factory main/preload/renderer; test-mounted theme UI; isolated HOME; controlled backdrop',
    nativeWayland: true, bridge, raw, controlAlpha, captures, restored,
    manualStorageIdentical: true, persistentCompositorChanges: false,
    screenshot: path.join(output, 'checker.png'),
  };
}

export const _electron = {
  async launch(options) {
    const launchedAt = Date.now();
    const app = await real._electron.launch(options);
    const close = app.close.bind(app);
    let closed = false;
    app.close = async () => {
      if (closed) return;
      closed = true;
      await mkdir(output, { recursive: true });
      try {
        const base = await stat(path.join(path.dirname(output), 'report.json')).catch(() => null);
        if (!base || base.mtimeMs < launchedAt) {
          process.exitCode = 1;
          const blocked = { status: 'blocked', reason: 'base theme smoke did not finish successfully in this run' };
          await writeFile(path.join(output, 'failure.json'), JSON.stringify(blocked, null, 2) + '\n');
          console.error('Compositor proof blocked by unfinished base theme smoke.');
          return;
        }
        const report = await proof(app, options);
        await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
        console.log(JSON.stringify({ compositorProof: report }));
      } catch (error) {
        process.exitCode = 1; // theme-smoke intentionally catches close errors.
        await writeFile(path.join(output, 'failure.json'), JSON.stringify({
          error: error.message, stack: error.stack,
        }, null, 2) + '\n');
        console.error('Factory compositor proof failed:', error);
      } finally {
        await close();
      }
    };
    return app;
  },
};
