// Appearance layout smoke in a disposable, instrumented copy of a built
// bundle. It mounts the real pCu and iCu renderer components; no login,
// credential, production profile, or external request is used.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, unlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { glassyShellFixtureSource } from './glassy-shell-fixture.mjs';

const require = createRequire(import.meta.url);
const asar = require('@electron/asar');
const { _electron } = await import(process.env.FACTORY_PLAYWRIGHT_MODULE || 'playwright');
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const versions = JSON.parse(await readFile(path.join(projectRoot, 'versions.json'), 'utf8'));
const bundle = path.resolve(process.argv[2] || `dist/factory-droid-desktop-${versions.desktop}`);
const output = path.resolve(process.argv[3] || `build/menu-smoke-${versions.desktop}`);
const rendererRelative = versions.renderer;

function safeEnvironment(home) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(FACTORY_|OPENAI_|ANTHROPIC_|AWS_|AZURE_|GH_)/i.test(key)
        || /(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|TOKEN|PASSWORD|SECRET|CREDENTIAL)/i.test(key)) {
      delete env[key];
    }
  }
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
    LANG: 'en_US.UTF-8',
    LC_ALL: 'C.UTF-8',
    HTTP_PROXY: 'http://127.0.0.1:9',
    HTTPS_PROXY: 'http://127.0.0.1:9',
    ALL_PROXY: 'http://127.0.0.1:9',
    http_proxy: 'http://127.0.0.1:9',
    https_proxy: 'http://127.0.0.1:9',
    all_proxy: 'http://127.0.0.1:9',
  });
  for (const key of ['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ASAR',
    'LD_PRELOAD', 'FACTORY_DESKTOP_RENDERER_URL', 'FACTORY_E2E_DAEMON_HOOKS',
    'FACTORY_DESKTOP_DAEMON_BINARY']) delete env[key];
  return env;
}

async function instrumentClone(tempRoot) {
  const extracted = path.join(tempRoot, 'asar-unpacked');
  await mkdir(extracted);
  const sourceAsar = path.join(bundle, 'resources/app.asar');
  await asar.extractAll(sourceAsar, extracted);
  const rendererPath = path.join(extracted, rendererRelative);
  const renderer = await readFile(rendererPath, 'utf8');
  for (const symbol of ['function pCu(){', 'function iCu(t){', 'function qOc(t){',
    'function _Mc(t){', 'function KOc(t){', 'function _jc(t){const e=z.c(21),{authContext:n,router:i}=t,',
    'function pAf(t){', 'function Ncf()', 'const JPt=MAf(pHo())', 'c.jsx(kbo,{target:',
    'factoryPortBuildThemeRow', 'factoryPortGlassCss', 'factoryPortGlassActive',
    'appearance-font-smoothing']) {
    assert.ok(renderer.includes(symbol), `candidate renderer contains ${symbol}`);
  }
  const preload = await readFile(path.join(extracted, '.vite/build/preload.js'), 'utf8');
  assert.ok(preload.includes('setOmarchyFollow'), 'candidate preload exposes the native follow opt-in');

  const authCaptureBefore = 'function _jc(t){const e=z.c(21),{authContext:n,router:i}=t,';
  const authCaptureAfter = 'function _jc(t){window.__factoryMenuSmokeAuth=t.authContext;const e=z.c(21),{authContext:n,router:i}=t,';
  assert.equal(renderer.split(authCaptureBefore).length - 1, 1,
    'test-only auth context capture has one exact entrypoint anchor');
  const capturedRenderer = renderer.replace(authCaptureBefore, authCaptureAfter);

  // The test root uses the real app providers, atom store, Appearance page,
  // theme editor and Follow row. It reuses the app's real environment and
  // signed-out auth context; only the extra mount point is synthetic.
  const instrumentation = `\n;window.__factoryMenuSmoke=(()=>{\n` +
    `const store=Lhe();\n` +
    glassyShellFixtureSource('factory-menu-smoke') +
    `const factoryPortMenuSmokeTarget={type:T1.Global};\n` +
    `return{mount(container){const root=IKo.createRoot(container);root.render(c.jsx(_Mc,{env:JPt,children:c.jsx(KOc,{value:window.__factoryMenuSmokeAuth,children:c.jsx(kbo,{target:factoryPortMenuSmokeTarget,children:c.jsx(qOc,{children:c.jsx(pAf,{children:c.jsxs(L.Fragment,{children:[c.jsx(Ncf,{}),c.jsx(NativeContent,{children:c.jsx(df,{id:"factory-menu-smoke-theme",style:{backgroundColor:"var(--core-v2-bg-page)",color:"var(--core-v2-text-primary)",minHeight:"100%",padding:"16px",boxSizing:"border-box"},children:c.jsx(pCu,{})})})]})})})})})}));return root},` +
    `seed(){store.set(JWe,"dark");const saved=store.get(Ske);store.set(Ske,{...saved,dark:{...saved.dark,background:"#20242a"}})},` +
    `glass(){const snapshot=store.get(factoryPortThemeSnapshot);return{active:store.get(factoryPortGlassActive),accepted:store.get(factoryPortNativeFollowAccepted),windowMode:snapshot.windowMode,available:snapshot.available}},` +
    `unmount(root){root.unmount()}}})();\n`;
  await writeFile(rendererPath, capturedRenderer + instrumentation);
  try {
    execFileSync(process.execPath, ['--check', rendererPath], { stdio: 'pipe' });
  } catch (error) {
    const diagnostic = error.stderr?.toString() || error.stdout?.toString() || error.message;
    throw new Error(`Instrumented renderer failed syntax check: ${diagnostic}`);
  }
  return extracted;
}

function waitForRendererCondition(page, condition, pageErrorSignal, getPageError, timeout = 15000) {
  if (getPageError()) throw getPageError();
  return Promise.race([
    page.waitForFunction(condition, null, { timeout }),
    pageErrorSignal.then(() => { throw getPageError(); }),
  ]);
}

const tempRoot = await mkdtemp(path.join(tmpdir(), 'factory-menu-smoke-'));
const cloneParent = path.join(tempRoot, 'candidate-copy');
const clone = path.join(cloneParent, path.basename(bundle));
const home = path.join(tempRoot, 'home');
const appAsar = path.join(clone, 'resources/app.asar');
let app;
let page;
const pageErrors = [];
const blockedNetwork = new Map();
const report = { mode: 'isolated actual-renderer Appearance layout smoke', pageErrors };

try {
  await mkdir(output, { recursive: true });
  await mkdir(home, { recursive: true });
  const current = path.join(home, '.local/state/omarchy/current');
  const theme = path.join(current, 'theme');
  await mkdir(theme, { recursive: true });
  await writeFile(path.join(theme, 'colors.toml'),
    'mode = "dark"\nbackground = "#101019"\nforeground = "#eeeeee"\naccent = "#89b4fa"\n');
  await writeFile(path.join(current, 'theme.generation'), 'menu-smoke-1\n');
  const extracted = await instrumentClone(tempRoot);
  const instrumentedAsar = path.join(tempRoot, 'instrumented-app.asar');
  await asar.createPackageWithOptions(extracted, instrumentedAsar, {
    unpackDir: 'node_modules/keytar',
  });

  // Copy the built candidate before replacing only the clone's ASAR.
  await mkdir(cloneParent, { recursive: true });
  execFileSync('cp', ['-a', '--reflink=auto', bundle, cloneParent], { stdio: 'ignore' });
  await unlink(appAsar);
  await copyFile(instrumentedAsar, appAsar);

  app = await _electron.launch({
    executablePath: path.join(clone, 'factory-desktop'),
    args: [
      `--user-data-dir=${path.join(home, 'user-data')}`,
      '--lang=en-US',
      '--proxy-server=http://127.0.0.1:9',
      '--proxy-bypass-list=<-loopback>',
      '--host-resolver-rules=MAP * ~NOTFOUND',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-domain-reliability',
    ],
    env: safeEnvironment(home),
    chromiumSandbox: true,
    timeout: 60000,
  });
  page = await app.firstWindow({ timeout: 60000 });
  let signalPageError;
  let firstPageError = null;
  const pageErrorSignal = new Promise(resolve => { signalPageError = resolve; });
  page.on('pageerror', error => {
    pageErrors.push(error.message);
    firstPageError ??= new Error(`Renderer pageerror: ${error.message}`);
    signalPageError();
  });
  await page.route(/^https?:\/\//, async route => {
    const request = route.request();
    const key = `${new URL(request.url()).origin} ${request.method()}`;
    blockedNetwork.set(key, (blockedNetwork.get(key) || 0) + 1);
    await route.abort('blockedbyclient');
  });
  await page.waitForLoadState('load', { timeout: 45000 });
  await page.waitForFunction(() => typeof window.electronAPI?.theme?.getOmarchy === 'function',
    null, { timeout: 15000 });
  const themeBridge = await page.evaluate(() => window.electronAPI.theme.getOmarchy());
  assert.deepEqual({ ...themeBridge }, {
    available: true, mode: 'dark', background: '#101019', foreground: '#eeeeee',
    accent: '#89b4fa', revision: 'menu-smoke-1', windowMode: 'transparent',
  });
  await page.addInitScript(() => localStorage.setItem('factory-app-startup-locale', 'en-US'));
  await page.reload();
  await page.waitForLoadState('load', { timeout: 45000 });
  await page.waitForFunction(() => typeof window.electronAPI?.theme?.getOmarchy === 'function',
    null, { timeout: 15000 });
  await waitForRendererCondition(page,
    () => window.__factoryMenuSmokeAuth && typeof window.__factoryMenuSmokeAuth === 'object',
    pageErrorSignal, () => firstPageError, 15000);
  const capturedAuthState = await page.evaluate(() => ({
    isAuthenticated: window.__factoryMenuSmokeAuth?.isAuthenticated,
  }));
  assert.equal(capturedAuthState.isAuthenticated, false, 'captured app auth context is signed out');

  const runtime = await app.evaluate(({ app, BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    const prefs = win.webContents.getLastWebPreferences();
    return {
      version: app.getVersion(),
      sandbox: prefs.sandbox !== false,
      contextIsolation: prefs.contextIsolation !== false,
      nodeIntegration: prefs.nodeIntegration === true,
      noSandbox: app.commandLine.hasSwitch('no-sandbox'),
    };
  });
  assert.equal(runtime.version, versions.desktop);
  assert.equal(runtime.sandbox, true);
  assert.equal(runtime.contextIsolation, true);
  assert.equal(runtime.nodeIntegration, false);
  assert.equal(runtime.noSandbox, false);

  await page.evaluate(() => {
    const surface = document.createElement('main');
    surface.id = 'factory-menu-smoke-root';
    Object.assign(surface.style, {
      position: 'fixed', inset: '0', zIndex: '2147483000',
      overflow: 'auto', background: 'transparent',
    });
    document.body.appendChild(surface);
    window.__factoryMenuSmoke.mount(surface);
  });
  await waitForRendererCondition(page,
    () => document.querySelector('#factory-menu-smoke-root')?.innerText.includes('Preset'),
    pageErrorSignal, () => firstPageError, 15000);
  await page.evaluate(() => window.__factoryMenuSmoke.seed());
  await page.waitForFunction(() => {
    const root = document.querySelector('#factory-menu-smoke-root');
    return root?.innerText.includes('Reset') && root.innerText.includes('Follow Omarchy theme');
  }, null, { timeout: 10000 });
  await page.waitForFunction(() => {
    try { return JSON.parse(localStorage.getItem('factory-appearance-settings') || 'null')
      ?.dark?.background === '#20242a'; } catch { return false; }
  }, null, { timeout: 5000 });

  const appearance = await page.evaluate(() => {
    const root = document.querySelector('#factory-menu-smoke-root');
    const text = root.innerText;
    const labels = ['Reset', 'Import', 'Copy theme', 'Follow Omarchy theme', 'Preset'];
    return {
      text,
      positions: Object.fromEntries(labels.map(label => [label, text.indexOf(label)])),
      nativeFontSmoothingVisible: text.includes('Use native macOS font anti-aliasing'),
      followRowCount: [...root.querySelectorAll('*')]
        .filter(element => element.getAttribute('aria-label') === 'Follow Omarchy theme').length,
      nativeFontSmoothingControlCount: root.querySelectorAll(
        '[aria-label="Use native macOS font anti-aliasing"]').length,
    };
  });
  await page.screenshot({ path: path.join(output, 'appearance-order.png'), fullPage: false });
  let previous = -1;
  for (const label of ['Reset', 'Import', 'Copy theme', 'Follow Omarchy theme', 'Preset']) {
    const position = appearance.positions[label];
    assert.ok(position >= 0, `Appearance contains ${label}`);
    assert.ok(position > previous, `${label} follows the previous theme-editor item`);
    previous = position;
  }
  assert.equal(appearance.followRowCount, 1, 'one follow row is mounted in the theme editor');
  assert.equal(appearance.nativeFontSmoothingVisible, false, 'macOS-only font option is hidden');
  assert.equal(appearance.nativeFontSmoothingControlCount, 0, 'font option control is not mounted');

  const follow = page.locator('[aria-label="Follow Omarchy theme"]');
  await page.waitForFunction(() => {
    const control = document.querySelector('[aria-label="Follow Omarchy theme"]');
    return control && control.getAttribute('aria-disabled') !== 'true' && !control.matches(':disabled');
  }, null, { timeout: 10000 });
  const beforeFollowing = await page.evaluate(() => {
    const settings = JSON.parse(localStorage.getItem('factory-appearance-settings') || 'null');
    return {
      manualPreference: localStorage.getItem('factory-theme-preference'),
      nativeFontSmoothing: settings?.nativeFontSmoothing ?? null,
      settings: localStorage.getItem('factory-appearance-settings'),
    };
  });
  assert.equal(beforeFollowing.manualPreference, 'dark');
  assert.equal(await follow.isEnabled(), true, 'valid fixture enables the follow control');
  assert.equal(await follow.getAttribute('aria-checked'), 'false');
  await follow.click();
  await page.waitForFunction(() => localStorage.getItem('factory-port-theme-source') === 'omarchy'
    && document.querySelector('[aria-label="Follow Omarchy theme"]')?.getAttribute('aria-checked') === 'true',
  null, { timeout: 10000 });
  const afterFollowing = await page.evaluate(() => {
    const settings = JSON.parse(localStorage.getItem('factory-appearance-settings') || 'null');
    return {
      manualPreference: localStorage.getItem('factory-theme-preference'),
      nativeFontSmoothing: settings?.nativeFontSmoothing ?? null,
      settings: localStorage.getItem('factory-appearance-settings'),
    };
  });
  assert.equal(afterFollowing.manualPreference, beforeFollowing.manualPreference,
    'following does not overwrite the manual Light/Dark/System preference');
  assert.deepEqual(afterFollowing.nativeFontSmoothing, beforeFollowing.nativeFontSmoothing,
    'following does not overwrite the stored native font smoothing preference');
  assert.equal(afterFollowing.settings, beforeFollowing.settings,
    'following does not overwrite Factory appearance settings');

  // With the default (missing markers) Omarchy windowMode the DTO reports
  // 'transparent': the trusted main accepts the opt-in, but glass must stay
  // off and the window must remain an opaque followed surface, never fake
  // transparency painted over a native opaque window.
  const glassWhileFollowing = await page.evaluate(() => window.__factoryMenuSmoke.glass());
  assert.equal(glassWhileFollowing.windowMode, 'transparent');
  assert.equal(glassWhileFollowing.available, true);
  assert.equal(glassWhileFollowing.accepted, true, 'the trusted main accepted the follow opt-in');
  assert.equal(glassWhileFollowing.active, false, 'a transparent windowMode never activates glass');
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor),
    'rgb(16, 16, 25)',
    'following a transparent-mode Omarchy keeps an opaque followed document background');

  await follow.click();
  await page.waitForFunction(() => localStorage.getItem('factory-port-theme-source') === 'factory'
    && document.querySelector('[aria-label="Follow Omarchy theme"]')?.getAttribute('aria-checked') === 'false',
  null, { timeout: 10000 });
  const afterUnfollowing = await page.evaluate(() => {
    const settings = JSON.parse(localStorage.getItem('factory-appearance-settings') || 'null');
    return {
      manualPreference: localStorage.getItem('factory-theme-preference'),
      nativeFontSmoothing: settings?.nativeFontSmoothing ?? null,
      settings: localStorage.getItem('factory-appearance-settings'),
    };
  });
  assert.equal(afterUnfollowing.manualPreference, beforeFollowing.manualPreference,
    'turning following off preserves the manual preference');
  assert.deepEqual(afterUnfollowing.nativeFontSmoothing, beforeFollowing.nativeFontSmoothing,
    'turning following off preserves the stored native font smoothing preference');
  assert.equal(afterUnfollowing.settings, beforeFollowing.settings,
    'turning following off preserves Factory appearance settings');
  const glassAfterUnfollowing = await page.evaluate(() => window.__factoryMenuSmoke.glass());
  assert.equal(glassAfterUnfollowing.active, false, 'glass stays off after unfollowing');
  assert.equal(glassAfterUnfollowing.accepted, false, 'unfollowing clears the native follow acceptance');
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor),
    'rgb(32, 36, 42)', 'the manual seeded background is restored after unfollowing');

  // Reproduce mdf's real Linux/native-menu wrapper around Appearance.
  // Keeping this structural sidebar-bg paint opaque used to mask all glass.
  const toggles = path.join(home, 'state/omarchy/toggles/hypr');
  await mkdir(toggles, { recursive: true });
  await writeFile(path.join(toggles, 'window-glassy.lua'), '-- isolated test marker\n');
  await page.waitForFunction(() => window.__factoryMenuSmoke.glass().windowMode === 'glassy');
  await follow.click();
  await page.waitForFunction(() => window.__factoryMenuSmoke.glass().active === true
    && getComputedStyle(document.body).backgroundColor === 'rgba(0, 0, 0, 0)');
  assert.equal(await page.evaluate(() =>
    getComputedStyle(document.getElementById('factory-menu-smoke-native-content')).backgroundColor),
  'rgba(0, 0, 0, 0)', 'the real structural content wrapper must not paint sidebar-bg over glass');
  // Exclude the unrelated signed-out route under this test-mounted tree.
  await page.evaluate(() => {
    const root = document.getElementById('factory-menu-smoke-root');
    for (const child of document.body.children) if (child !== root) child.style.display = 'none';
  });
  const box = await follow.boundingBox();
  assert.ok(box);
  const frameBox = await page.locator('#factory-menu-smoke-frame').boundingBox();
  assert.ok(frameBox);
  const contentPoint = [Math.floor(frameBox.x + 16), 400];
  const points = [contentPoint, [Math.floor(box.x + box.width / 2), Math.floor(box.y + box.height / 2)]];
  report.glassLayers = await page.evaluate(point => document.elementsFromPoint(...point).map(el => ({
    tag: el.tagName, background: getComputedStyle(el).backgroundColor,
    image: getComputedStyle(el).backgroundImage,
  })), contentPoint);
  const alphaAt = points => app.evaluate(async ({ BrowserWindow }, points) => {
    const image = await BrowserWindow.getAllWindows()[0].webContents.capturePage();
    const data = image.toBitmap(), { width } = image.getSize();
    return points.map(([x, y]) => data[(y * width + x) * 4 + 3]);
  }, points);
  let [contentAlpha, controlAlpha] = await alphaAt(points);
  report.alphaSettling = [contentAlpha];
  for (let i = 0; i < 20 && (contentAlpha < 160 || contentAlpha > 172); i++) {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    [contentAlpha, controlAlpha] = await alphaAt(points);
    report.alphaSettling.push(contentAlpha);
  }
  assert.ok(contentAlpha >= 160 && contentAlpha <= 172, `Appearance content must transmit glass, got ${contentAlpha}`);
  assert.equal(controlAlpha, 255, 'the actual Appearance Follow control stays opaque');
  await page.screenshot({ path: path.join(output, 'appearance-glassy.png') });
  await follow.click();
  await page.waitForFunction(() => !window.__factoryMenuSmoke.glass().active
    && !window.__factoryMenuSmoke.glass().accepted
    && getComputedStyle(document.documentElement).backgroundColor === 'rgb(32, 36, 42)');
  const [restoredAlpha] = await alphaAt([contentPoint]);
  assert.equal(restoredAlpha, 255, 'turning Follow off restores an opaque content surface');
  assert.equal(await page.evaluate(() => localStorage.getItem('factory-appearance-settings')),
    beforeFollowing.settings, 'the additional Glassy cycle preserves saved settings exactly');

  report.nativeContentGlass = {
    contentAlpha, controlAlpha, restoredAlpha, manualSettingsIdentical: true,
    scope: 'real pCu/Ue/Om, unscoped opaque-token backdrop and upstream frame gradient; test-mounted, not an authenticated route',
  };
  report.runtime = runtime;
  report.appearance = appearance;
  report.omarchyBridge = themeBridge;
  report.glassGuard = { whileFollowing: glassWhileFollowing, afterUnfollowing: glassAfterUnfollowing };
  report.preferencePreservation = {
    before: beforeFollowing,
    afterFollow: afterFollowing,
    afterUnfollow: afterUnfollowing,
  };
  report.blockedNetwork = Object.fromEntries(blockedNetwork);
  report.signedIn = false;
  await writeFile(path.join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  assert.deepEqual(pageErrors, []);
  console.log(JSON.stringify(report));
} catch (error) {
  report.failure = { name: error?.name || 'Error', message: error?.message || String(error) };
  if (page) {
    try {
      report.failureText = await page.locator('#factory-menu-smoke-root').innerText({ timeout: 1000 });
      await page.screenshot({ path: path.join(output, 'failure.png') });
    } catch (captureError) {
      report.captureFailure = captureError?.message || String(captureError);
    }
  }
  report.blockedNetwork = Object.fromEntries(blockedNetwork);
  await writeFile(path.join(output, 'failure-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  throw error;
} finally {
  if (app) {
    try { await app.close(); } catch {
      const child = app.process();
      try { await app.evaluate(({ app: electronApp }) => electronApp.quit()); } catch {}
      if (child && child.exitCode === null) {
        child.kill('SIGTERM');
        await new Promise(resolve => {
          const timer = setTimeout(resolve, 2500);
          child.once('exit', () => { clearTimeout(timer); resolve(); });
        });
        if (child.exitCode === null) child.kill('SIGKILL');
      }
    }
  }
  await rm(tempRoot, { recursive: true, force: true });
}
