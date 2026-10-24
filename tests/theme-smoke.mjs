// Renderer/ThemeSync integration smoke in a disposable, instrumented copy of
// the candidate bundle. No authenticated profile, credential, or model call is
// used. The fixture root mounts the real renderer atoms, `jtf`, `iuf`, `Zu`,
// `oa`, and `Wc`; only the extra test root is synthetic. Target bundle, version and
// renderer asset come from versions.json (Factory Desktop 0.205.0).
//
// Glass scope, stated honestly: upstream mounts `jtf` (the appearance override
// styles that carry the glass tint) only inside the authenticated shell, so a
// signed-out window stays opaque by design (covered by the separate negative
// login smoke). This test measures glass through the real production components
// (`jtf`, `iuf`, the atoms, the real follow row using `oa` and `Wc`) explicitly
// mounted from the fixture root, the same provider set the authenticated shell
// mounts. While measuring alpha the disposable clone hides the original
// signed-out root and body portals so the real `Zu` fixture surface is the only
// composited content; production code is untouched. Alpha is proven with
// capturePage bitmaps because BrowserWindow.getBackgroundColor() reports
// '#000000' even when the native surface is transparent. The glassy windowMode
// is exercised through real toggle markers inside the isolated HOME state root;
// the compositor is never reconfigured and no global Omarchy setting is touched.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rename, rm, copyFile, unlink, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { glassyShellFixtureSource } from './glassy-shell-fixture.mjs';
import { sidebarFadeFixtureSource, runSidebarFadeSmoke } from './sidebar-fade-smoke.mjs';
import { navigationFixtureSource, runNavigationSmoke } from './glassy-navigation-smoke.mjs';
import { runApplicationMenuSmoke, assertNativeMenuFallback, focusDisposableWindow, saveDisposableScreenshot, closeDisposableApp } from './application-menu-smoke.mjs';

const require = createRequire(import.meta.url);
const asar = require('@electron/asar');
const { _electron } = await import(process.env.FACTORY_PLAYWRIGHT_MODULE || 'playwright');
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const versions = JSON.parse(await readFile(path.join(projectRoot, 'versions.json'), 'utf8'));
const bundle = path.resolve(process.argv[2] || `dist/factory-desktop-arch-${versions.desktop}`);
const output = path.resolve(process.argv[3] || 'build/theme-smoke');
const rendererRelative = versions.renderer;
const preloadRelative = '.vite/build/preload.js';
const emptyPalette = { available: false, mode: null, background: null, foreground: null, accent: null, revision: null, windowMode: null };
const palettes = {
  dark: { mode: 'dark', background: '#101019', foreground: '#eeeeee', accent: '#89b4fa', revision: 'fixture-dark-1' },
  light: { mode: 'light', background: '#e4f0ff', foreground: '#17202a', accent: '#ff7043', revision: 'fixture-light-2' },
};

function safeEnvironment(home) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(FACTORY_|OPENAI_|ANTHROPIC_|AWS_|AZURE_)/i.test(key)
        || /(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|CREDENTIAL|GITHUB_TOKEN|GH_TOKEN)/i.test(key)) delete env[key];
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
    HTTP_PROXY: 'http://127.0.0.1:9',
    HTTPS_PROXY: 'http://127.0.0.1:9',
    ALL_PROXY: 'http://127.0.0.1:9',
    http_proxy: 'http://127.0.0.1:9',
    https_proxy: 'http://127.0.0.1:9',
    all_proxy: 'http://127.0.0.1:9',
  });
  for (const key of ['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ASAR',
    'FACTORY_DESKTOP_RENDERER_URL', 'FACTORY_E2E_DAEMON_HOOKS', 'FACTORY_DESKTOP_DAEMON_BINARY']) delete env[key];
  return env;
}

async function writeFixture(home, palette) {
  const current = path.join(home, '.local/state/omarchy/current');
  const theme = path.join(current, 'theme');
  await mkdir(theme, { recursive: true });
  const source = `mode = "${palette.mode}"\nbackground = "${palette.background}"\nforeground = "${palette.foreground}"\naccent = "${palette.accent}"\n`;
  await writeFile(path.join(theme, 'colors.toml'), source);
  await writeFile(path.join(current, 'theme.generation'), `${palette.revision}\n`);
  return { current, theme };
}

async function replaceFixture(fixture, palette) {
  const staged = path.join(fixture.current, 'staged-theme');
  const old = path.join(fixture.current, 'previous-theme');
  await rm(staged, { recursive: true, force: true });
  await rm(old, { recursive: true, force: true });
  await mkdir(staged);
  await writeFile(path.join(staged, 'colors.toml'),
    `mode = "${palette.mode}"\nbackground = "${palette.background}"\nforeground = "${palette.foreground}"\naccent = "${palette.accent}"\n`);
  await rename(fixture.theme, old);
  await rename(staged, fixture.theme);
  await writeFile(path.join(fixture.current, 'theme.generation'), `${palette.revision}\n`);
}

// Real Omarchy window toggles inside the isolated HOME's XDG_STATE_HOME root.
// Only marker presence is used (the bridge never reads the content) and the
// theme.generation file is never touched by these helpers.
async function seedWindowMode(home, mode) {
  const dir = path.join(home, 'state', 'omarchy', 'toggles', 'hypr');
  await rm(path.join(dir, 'window-opaque.lua'), { force: true });
  await rm(path.join(dir, 'window-glassy.lua'), { force: true });
  if (mode) {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, `window-${mode}.lua`), '-- disposable smoke marker; never executed\n');
  }
}

async function instrumentClone(tempRoot) {
  const extracted = path.join(tempRoot, 'asar-unpacked');
  await mkdir(extracted);
  const sourceAsar = path.join(bundle, 'resources/app.asar');
  const rendererPath = path.join(extracted, rendererRelative);
  const preloadPath = path.join(extracted, preloadRelative);
  await asar.extractAll(sourceAsar, extracted);
  const preload = await readFile(preloadPath, 'utf8');
  assert.ok(preload.includes('factory-linux-theme:get'), 'candidate includes the real theme IPC bridge');
  assert.ok(preload.includes('factory-linux-theme:follow'), 'candidate includes the real native follow channel');
  assert.ok(preload.includes('setOmarchyFollow'), 'candidate preload exposes the follow opt-in');
  const renderer = await readFile(rendererPath, 'utf8');
  for (const symbol of ['factoryPortThemeFollow', 'factoryPortThemeSnapshot', 'factoryPortBuildThemeRow',
    'factoryPortGlassCss', 'factoryPortSyncNativeFollow', 'factoryPortNativeFollowAccepted',
    'factoryPortGlassActive', 'function jtf()', 'function iuf(']) {
    assert.ok(renderer.includes(symbol), `candidate renderer contains ${symbol}`);
  }

  // These references and this root exist only in this disposable copy. The
  // row, atom hooks, CSS generator and native ThemeSync are production code.
  // 0.205.0 aliases: ns=useAtom, oa=Checkbox, Wc=SettingRow, hGo=react-dom
  // client, Cfe=jotai default store, jtf=appearance override styles, iuf=
  // ThemeSync, Tmu=Appearance screen, oH=resolved theme, V5e=overrides
  // enabled, eGe=theme preference, W5e=appearance settings. Include the
  // unscoped backdrop, native content wrapper and border-box frame gradient.
  const instrumentation = `\n;window.__factoryThemeSmoke=(()=>{\n` +
    glassyShellFixtureSource('factory-theme-smoke') +
    sidebarFadeFixtureSource() +
    navigationFixtureSource(renderer) +
    `const rootFactory=container=>{\n` +
    `function Fixture(){const[enabled,setEnabled]=ns(factoryPortThemeFollow),[state]=ns(factoryPortThemeSnapshot);` +
    `return c.jsx(NativeContent,{style:{position:"fixed",inset:0,zIndex:2147482999},children:c.jsx(Zu,{id:"factory-theme-smoke-theme",style:{position:"relative",minHeight:"100vh",display:"grid",placeContent:"center",gap:20,padding:32,boxSizing:"border-box",backgroundColor:"var(--core-v2-bg-page)",color:"var(--core-v2-text-primary)"},children:c.jsxs(P.Fragment,{children:[c.jsx("div",{id:"factory-theme-smoke-surface",style:{backgroundColor:"var(--core-v2-bg-page)",color:"var(--core-v2-text-primary)",border:"3px solid var(--core-v2-accent-fill)",padding:"24px"},children:"Omarchy theme fixture"}),factoryPortBuildThemeRow(enabled,state,setEnabled)]})})})}` +
    `const root=hGo.createRoot(container);root.render(c.jsx(iuf,{children:c.jsxs(P.Fragment,{children:[c.jsx(jtf,{}),c.jsx(Fixture,{})]})}));return root};` +
    `const store=Cfe();return{mount:rootFactory,mountSidebarFade,mountNavigation,appearanceComponent:Tmu,themeSync:iuf,themeStyles:jtf,followAtom:factoryPortThemeFollow,snapshotAtom:factoryPortThemeSnapshot,themeActiveAtom:factoryPortThemeActive,themeModeAtom:oH,themeSyncEnabledAtom:V5e,store,themePreferenceAtom:eGe,appearanceSettingsAtom:W5e,getDiagnostics:()=>{const snapshot=store.get(factoryPortThemeSnapshot),appearance=store.get(factoryPortEffectiveAppearance),settings=store.get(W5e),pick=t=>t?{background:t.background??null,foreground:t.foreground??null,accentColor:t.accentColor??null}:null;return{manualPreference:store.get(eGe),effectiveMode:store.get(oH),follow:store.get(factoryPortThemeFollow),available:snapshot.available,snapshot:{mode:snapshot.mode,background:snapshot.background,foreground:snapshot.foreground,accent:snapshot.accent,revision:snapshot.revision,windowMode:snapshot.windowMode},active:store.get(factoryPortThemeActive),glass:store.get(factoryPortGlassActive),followAccepted:store.get(factoryPortNativeFollowAccepted),themeSyncEnabled:store.get(V5e),appearance:{light:pick(appearance.light),dark:pick(appearance.dark)},manualAppearance:{light:pick(settings.light),dark:pick(settings.dark)}}}}})();\n`;
  const activation = 'void api.activate(token, item.command);';
  assert.equal(renderer.split(activation).length - 1, 1);
  const observed = renderer.replace(activation, 'void api.activate(token, item.command).then(accepted=>{window.__factoryMenuSmokeActivation={accepted}});');
  await writeFile(rendererPath, observed + instrumentation);
  try {
    execFileSync(process.execPath, ['--check', rendererPath], { stdio: 'pipe' });
  } catch (error) {
    const diagnostic = error.stderr?.toString() || error.stdout?.toString() || error.message;
    throw new Error(`Instrumented renderer failed syntax check: ${diagnostic}`);
  }
  return { extracted, rendererPath, preloadPath };
}

function getCssState(page) {
  return page.evaluate(() => {
    const themeRoot = document.getElementById('factory-theme-smoke-theme');
    const style = getComputedStyle(themeRoot || document.documentElement);
    const surface = document.getElementById('factory-theme-smoke-surface');
    const surfaceStyle = surface ? getComputedStyle(surface) : null;
    const attr = themeRoot?.getAttribute('data-core-ui-v2-theme')
      || document.documentElement.getAttribute('data-theme');
    const color = name => style.getPropertyValue(name).trim();
    const injectedThemeRules = [];
    const styleElements = [...document.querySelectorAll('style')];
    for (const element of styleElements) {
      const cssText = element.textContent || '';
      for (const marker of ['--core-v2-bg-page', '--core-v2-accent-fill', 'data-core-ui-v2-theme']) {
        const index = cssText.indexOf(marker);
        if (index >= 0) {
          injectedThemeRules.push({ marker, snippet: cssText.slice(Math.max(0, index - 180), index + 320) });
          break;
        }
      }
      if (injectedThemeRules.length >= 24) break;
    }
    return {
      mode: attr === 'dark' ? 'dark' : 'light',
      documentTheme: document.documentElement.getAttribute('data-theme'),
      documentBackground: getComputedStyle(document.documentElement).backgroundColor,
      themeContainer: themeRoot ? {
        tag: themeRoot.tagName,
        theme: themeRoot.getAttribute('data-core-ui-v2-theme'),
        background: getComputedStyle(themeRoot).backgroundColor,
        foreground: getComputedStyle(themeRoot).color,
      } : null,
      page: color('--core-v2-bg-page'),
      foreground: color('--core-v2-text-primary'),
      accent: color('--core-v2-accent-fill'),
      visibleSurface: surfaceStyle ? {
        background: surfaceStyle.backgroundColor,
        foreground: surfaceStyle.color,
        accentBorder: surfaceStyle.borderTopColor,
      } : null,
      injectedThemeRuleCount: injectedThemeRules.length,
      styleElementCount: styleElements.length,
      injectedThemeRules,
    };
  });
}

async function getDiagnosticState(page) {
  const css = await getCssState(page);
  let atoms = null;
  try { atoms = await page.evaluate(() => window.__factoryThemeSmoke?.getDiagnostics() ?? null); } catch {}
  let documentState = null;
  try {
    documentState = await page.evaluate(() => ({
      readyState: document.readyState,
      bodyTextIncludesSignIn: document.body.innerText.includes('Sign in'),
      fixtureRootExists: !!document.getElementById('factory-theme-smoke-root'),
      followControl: (() => {
        const element = document.querySelector('[aria-label="Follow Omarchy theme"]');
        return element ? { tag: element.tagName, checked: element.getAttribute('aria-checked'), disabled: element.getAttribute('aria-disabled') } : null;
      })(),
      storage: Object.fromEntries(['factory-port-theme-source', 'factory-port-theme-cache', 'factory-theme-preference']
        .map(key => [key, localStorage.getItem(key)])),
    }));
  } catch {}
  return { at: new Date().toISOString(), css, atoms, document: documentState };
}

function cssColorHex(value) {
  if (typeof value !== 'string') return null;
  const hex = value.trim().match(/^#([\da-f]{6})$/i);
  if (hex) return `#${hex[1].toLowerCase()}`;
  const rgb = value.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:\s*[,/]\s*[^)]*)?\s*\)/i);
  if (!rgb) return null;
  return `#${rgb.slice(1, 4).map(part => Number(part).toString(16).padStart(2, '0')).join('')}`;
}

function assertColor(actual, expected, message) {
  assert.equal(cssColorHex(actual), expected.toLowerCase(), message);
}

async function waitForElectronTheme(app, expected) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const state = await app.evaluate(({ nativeTheme, BrowserWindow }) => ({
      themeSource: nativeTheme.themeSource,
      windowBackground: BrowserWindow.getAllWindows()[0]?.getBackgroundColor(),
    }));
    if (state.themeSource === expected) return state;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail(`Electron nativeTheme did not switch to ${expected}`);
}

// Raw framebuffer alpha via capturePage. getBackgroundColor() reports
// '#000000' even for a transparent native surface, so bitmap alpha is the
// only honest proof that the glass tint reached the compositor.
const capturePixels = async points => app.evaluate(async (electron, points) => {
  const win = electron.BrowserWindow.getAllWindows()[0];
  const image = await win.webContents.capturePage();
  const { width } = image.getSize();
  const data = image.toBitmap();
  return points.map(([x, y]) => [...data.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)]);
}, points);
const captureAlpha = async points => (await capturePixels(points)).map(pixel => pixel[3]);
const alphaWithinGlass = alpha => alpha >= 160 && alpha <= 172;

// Every pixel of the fixture text interior (3px accent border + 24px padding
// excluded) from the capturePage bitmap. A coarse grid can slip between thin
// glyph strokes, so the scan is exhaustive. On a transparent backdrop Chromium
// drops LCD subpixel antialiasing for grayscale AA, which legitimately leaves
// the glyph max at or just below 255; callers assert the measured max instead
// of claiming synthetic alpha-255 glyphs.
const scanTextInterior = async (id = 'factory-theme-smoke-surface', inset = 27) => {
  const rect = await page.evaluate(id => {
    const box = document.getElementById(id).getBoundingClientRect();
    return { left: Math.round(box.left), top: Math.round(box.top), width: Math.round(box.width), height: Math.round(box.height) };
  }, id);
  return app.evaluate(async (electron, scan) => {
    const win = electron.BrowserWindow.getAllWindows()[0];
    const image = await win.webContents.capturePage();
    const { width } = image.getSize();
    const data = image.toBitmap();
    let max = 0, opaquePixels = 0;
    for (let y = scan.top + scan.inset; y < scan.top + scan.height - scan.inset; y++) {
      for (let x = scan.left + scan.inset; x < scan.left + scan.width - scan.inset; x++) {
        const alpha = data[(y * width + x) * 4 + 3];
        if (alpha > max) max = alpha;
        if (alpha >= 200) opaquePixels++;
      }
    }
    return { max, opaquePixels };
  }, { ...rect, inset });
};

// The vendor stylesheet animates body background-color (0.2s linear). Glass
// toggles fade body between opaque and transparent, so alpha may only be
// measured after that transition settles on the expected value.
async function waitForSettledSurfaces(expectedDocument, expectedBody, glass) {
  await page.waitForFunction(expected => {
    const state = window.__factoryThemeSmoke?.getDiagnostics?.() ?? null;
    return state?.glass === expected.glass
      && getComputedStyle(document.documentElement).backgroundColor === expected.document
      && getComputedStyle(document.body).backgroundColor === expected.body;
  }, { glass, document: expectedDocument, body: expectedBody }, { timeout: 10000 });
}

const tempRoot = await mkdtemp(path.join(tmpdir(), 'factory-theme-smoke-'));
const cloneParent = path.join(tempRoot, 'candidate-copy');
const clone = path.join(cloneParent, path.basename(bundle));
const home = path.join(tempRoot, 'home');
const appAsar = path.join(clone, 'resources/app.asar');
let app;
let page;
const blockedNetwork = new Map();
const pageErrors = [];
const report = { mode: 'controlled renderer integration fixture', rendererErrors: pageErrors, blockedNetworkByOriginAndMethod: {}, diagnostics: {} };

try {
  await mkdir(output, { recursive: true });
  await mkdir(home, { recursive: true });
  const fixture = await writeFixture(home, palettes.dark);
  await seedWindowMode(home, 'glassy');
  const generationPath = path.join(fixture.current, 'theme.generation');
  const generationContent = await readFile(generationPath, 'utf8');
  const { extracted } = await instrumentClone(tempRoot);
  const candidateAsar = path.join(tempRoot, 'instrumented-app.asar');
  await asar.createPackageWithOptions(extracted, candidateAsar, { unpackDir: 'node_modules/keytar' });

  // A reflink or ordinary copy is used, never a symlink. The cloned app.asar
  // is unlinked before the test-only archive is moved into place.
  await mkdir(cloneParent, { recursive: true });
  execFileSync('cp', ['-a', '--reflink=auto', bundle, cloneParent], { stdio: 'ignore' });
  await unlink(appAsar);
  await copyFile(candidateAsar, appAsar);
  const executableStat = await lstat(path.join(clone, 'factory-desktop'));
  assert.equal(executableStat.isFile(), true, 'cloned Electron executable is a regular file, not a symlink');

  const env = safeEnvironment(home);
  app = await _electron.launch({
    executablePath: path.join(clone, 'factory-desktop'),
    args: [`--user-data-dir=${path.join(home, 'user-data')}`, '--proxy-server=http://127.0.0.1:9', '--proxy-bypass-list=<-loopback>'],
    env,
    chromiumSandbox: true,
    timeout: 60000,
  });
  page = await app.firstWindow({ timeout: 60000 });
  await page.route(/^https?:\/\//, async route => {
    const request = route.request();
    const origin = new URL(request.url()).origin;
    const key = `${origin} ${request.method()}`;
    blockedNetwork.set(key, (blockedNetwork.get(key) || 0) + 1);
    await route.abort('blockedbyclient');
  });
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.waitForFunction(() => document.body.innerText.includes('Sign in'), null, { timeout: 30000 });
  await focusDisposableWindow(app, page);
  const appInfo = await app.evaluate(({ app, nativeTheme, BrowserWindow }) => ({
    version: app.getVersion(),
    sandbox: BrowserWindow.getAllWindows()[0]?.webContents.getLastWebPreferences().sandbox !== false,
    contextIsolation: BrowserWindow.getAllWindows()[0]?.webContents.getLastWebPreferences().contextIsolation !== false,
    nodeIntegration: BrowserWindow.getAllWindows()[0]?.webContents.getLastWebPreferences().nodeIntegration === true,
    noSandbox: app.commandLine.hasSwitch('no-sandbox'),
    themeSource: nativeTheme.themeSource,
  }));
  assert.equal(appInfo.sandbox, true);
  assert.equal(appInfo.contextIsolation, true);
  assert.equal(appInfo.nodeIntegration, false);
  assert.equal(appInfo.noSandbox, false);
  assert.equal(appInfo.version, versions.desktop);

  // Use the real bridge on the signed-out app; no account or Droid is started.
  const bridge = await page.evaluate(() => window.electronAPI.theme.getOmarchy());
  assert.deepEqual({ ...bridge }, { available: true, ...palettes.dark, windowMode: 'glassy' });

  // Seed a manual dark choice and mount the controlled subtree with the real
  // row and providers. Settings/auth routing is intentionally bypassed.
  await page.addInitScript(() => {
    if (sessionStorage.getItem('factory-theme-smoke-seeded')) return;
    localStorage.setItem('factory-theme-preference', 'dark');
    localStorage.setItem('factory-appearance-startup-backgrounds', JSON.stringify({ light: '#fafafa', dark: '#20242a' }));
    sessionStorage.setItem('factory-theme-smoke-seeded', '1');
  });
  await page.reload();
  await page.waitForFunction(() => document.body.innerText.includes('Sign in'), null, { timeout: 30000 });
  await page.evaluate(() => {
    const root = document.createElement('div');
    root.id = 'factory-theme-smoke-root';
    document.body.appendChild(root);
    // Test-only isolation inside this disposable clone: hide the signed-out
    // app root and body portals so the real Zu fixture surface below is the
    // only composited content when alpha is measured. The production
    // components stay mounted (display only) and keep driving ThemeSync.
    for (const child of [...document.body.children]) {
      if (child !== root) child.style.display = 'none';
    }
    const { store, themePreferenceAtom, appearanceSettingsAtom } = window.__factoryThemeSmoke;
    store.set(themePreferenceAtom, 'dark');
    const saved = store.get(appearanceSettingsAtom);
    store.set(appearanceSettingsAtom, {
      ...saved,
      dark: { ...saved.dark, background: '#20242a', foreground: '#eef1f4', accentColor: '#b39ddb' },
    });
    window.__factoryThemeSmoke.mount(root);
  });
  const follow = page.locator('[aria-label="Follow Omarchy theme"]');
  await follow.waitFor({ state: 'visible', timeout: 10000 });
  await page.waitForFunction(() => {
    const theme = document.getElementById('factory-theme-smoke-theme');
    return theme && getComputedStyle(theme).getPropertyValue('--core-v2-bg-page').trim().toLowerCase() === '#20242a';
  }, null, { timeout: 10000 });
  await page.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'dark');
  await page.waitForFunction(() => localStorage.getItem('factory-theme-preference') === 'dark'
    && localStorage.getItem('factory-appearance-settings') !== null);
  await waitForSettledSurfaces('rgb(32, 36, 42)', 'rgb(32, 36, 42)', false);
  const manualStorage = await page.evaluate(() => Object.fromEntries(
    ['factory-theme-preference', 'factory-appearance-settings', 'factory-appearance-startup-backgrounds']
      .map(key => [key, localStorage.getItem(key)])));
  const manualCss = await getCssState(page);
  report.structuralBaseline = await page.evaluate(() => {
    const backdrop = document.getElementById('factory-theme-smoke-backdrop');
    return {
      backdrop: getComputedStyle(backdrop).backgroundColor,
      backdropThemeScope: backdrop.hasAttribute('data-core-ui-v2-theme'),
      frameImage: getComputedStyle(document.getElementById('factory-theme-smoke-frame')).backgroundImage,
    };
  });
  assert.equal(report.structuralBaseline.backdrop, 'rgb(6, 11, 30)');
  assert.equal(report.structuralBaseline.backdropThemeScope, false);
  assert.notEqual(report.structuralBaseline.frameImage, 'none', 'load the real upstream frame gradient');
  report.diagnostics.manual = await getDiagnosticState(page);
  await saveDisposableScreenshot(app, page, path.join(output, 'manual-before-follow.png'));
  assertColor(manualCss.page, '#20242a', 'manual dark page token uses saved Factory background');
  assertColor(manualCss.foreground, '#eef1f4', 'manual dark text token uses saved Factory foreground');
  assertColor(manualCss.accent, '#b39ddb', 'manual dark accent token uses saved Factory accent');
  assert.equal(manualCss.mode, 'dark');
  assert.equal(manualCss.documentBackground, 'rgb(32, 36, 42)',
    'the manual document background is opaque and untracked by glass');
  const manualNative = await waitForElectronTheme(app, 'dark');
  assert.equal((await captureAlpha([[216, 140]]))[0], 255,
    'before following, the framebuffer is fully opaque');

  await follow.click();
  await page.waitForFunction(() => localStorage.getItem('factory-port-theme-source') === 'omarchy');
  // Glass needs the trusted main to accept the native follow opt-in, the
  // single-tint CSS to replace the opaque document background, and the body
  // fade-out to settle before alpha is meaningful.
  await waitForSettledSurfaces('rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0)', true);
  const followedDarkNative = await waitForElectronTheme(app, 'dark');
  assert.equal(followedDarkNative.themeSource, 'dark');
  const followedDarkCss = await getCssState(page);
  report.diagnostics.followedDark = await getDiagnosticState(page);
  await saveDisposableScreenshot(app, page, path.join(output, 'follow-dark.png'));
  assert.equal(followedDarkCss.page, 'transparent',
    'the glassy page token is transparent so exactly one tint layer paints');
  assertColor(followedDarkCss.foreground, palettes.dark.foreground, 'dark text token uses Omarchy foreground');
  assertColor(followedDarkCss.accent, palettes.dark.accent, 'dark accent token uses Omarchy accent');
  assert.equal(followedDarkCss.visibleSurface.background, 'rgba(0, 0, 0, 0)',
    'the real Zu surface stays transparent over the content frame tint');
  assertColor(followedDarkCss.visibleSurface.foreground, palettes.dark.foreground, 'visible fixture text uses the foreground token');
  assertColor(followedDarkCss.visibleSurface.accentBorder, palettes.dark.accent, 'visible fixture border uses the accent token');
  assert.equal(followedDarkCss.mode, 'dark');
  assert.equal(followedDarkCss.documentBackground, 'rgba(0, 0, 0, 0)',
    'html does not add a second tint beneath the regional surfaces');
  const darkGlassAlpha = (await captureAlpha([[216, 140]]))[0];
  assert.ok(alphaWithinGlass(darkGlassAlpha),
    `the glassy dark framebuffer must carry alpha near .65 at a clear surface, got ${darkGlassAlpha}`);
  // Dense glyph proof over the glass tint: a global opacity fade would clamp
  // every text pixel to the .65 tint (~166); real glyphs must rise far above
  // it. The glyph max is reported as measured because grayscale AA on a
  // transparent backdrop does not guarantee alpha-255 pixels.
  const darkText = await scanTextInterior();
  assert.ok(darkText.max >= 250,
    `fixture text paints near-opaque glyphs over the glass tint; grayscale AA reports a real glyph max of ${darkText.max}`);
  assert.ok(darkText.opaquePixels >= 100,
    'the dense glyph scan found real text pixels well above the glass tint alpha');
  const followControlBox = await follow.boundingBox();
  assert.ok(followControlBox, 'the follow control is visible for control-pixel sampling');
  const darkControlAlpha = (await captureAlpha([[
    Math.floor(followControlBox.x + followControlBox.width / 2),
    Math.floor(followControlBox.y + followControlBox.height / 2),
  ]]))[0];
  assert.equal(darkControlAlpha, 255, 'the real follow control stays opaque over glass');
  async function assertChrome() {
    const selected = await page.locator('#factory-theme-smoke-sidebar-selected').boundingBox();
    assert.ok(selected);
    const [sidebar, titlebar, active] = await captureAlpha([[16, 140], [300, 16],
      [Math.floor(selected.x + 2), Math.floor(selected.y + 2)]]);
    assert.ok(sidebar >= 85 && sidebar <= 94, `Glassy Bar sidebar alpha: ${sidebar}`);
    assert.ok(titlebar >= 85 && titlebar <= 94, `Glassy Bar title bar alpha: ${titlebar}`);
    assert.equal(active, 255, 'selected sidebar rows retain their solid highlight');
    const glyphs = await scanTextInterior('factory-theme-smoke-sidebar-label', 2);
    assert.ok(glyphs.max >= 250 && glyphs.opaquePixels >= 10, 'sidebar text is not faded');
    return { sidebar, titlebar, active, glyphs };
  }
  report.chrome = { dark: await assertChrome() };
  report.applicationMenu = { dark: await runApplicationMenuSmoke({ app, page, output, mode: 'dark' }) };
  report.sidebarFade = { dark: await runSidebarFadeSmoke({ app, page, output, mode: 'dark' }) };
  report.navigation = { dark: await runNavigationSmoke({ app, page, output, mode: 'dark' }) };

  // Live windowMode changes arrive through the real toggle markers without
  // touching theme.generation: opaque wins, missing markers mean transparent,
  // and a recreated glassy marker re-enables glass.
  await seedWindowMode(home, 'opaque');
  await page.waitForFunction(() => window.__factoryThemeSmoke.getDiagnostics().snapshot.windowMode === 'opaque'
    && window.__factoryThemeSmoke.getDiagnostics().glass === false, null, { timeout: 10000 });
  await waitForSettledSurfaces('rgb(16, 16, 25)', 'rgb(16, 16, 25)', false);
  const opaqueNative = await waitForElectronTheme(app, 'dark');
  const opaqueCss = await getCssState(page);
  report.diagnostics.opaqueMarker = await getDiagnosticState(page);
  await saveDisposableScreenshot(app, page, path.join(output, 'follow-opaque-marker.png'));
  assertColor(opaqueCss.page, palettes.dark.background, 'the opaque marker still follows Omarchy colors');
  assert.equal(opaqueCss.documentBackground, 'rgb(16, 16, 25)',
    'an opaque windowMode removes the tint while colors keep following');
  assert.equal((await captureAlpha([[216, 140]]))[0], 255,
    'the opaque windowMode must not paint fake transparency over the native surface');
  assert.equal(String(opaqueNative.windowBackground).toLowerCase(), palettes.dark.background,
    'the vendor native RGB is restored while the opaque marker is active');
  await assertNativeMenuFallback({ app, page });
  report.applicationMenu.opaqueFallback = true;
  report.navigation.opaque = await runNavigationSmoke({ app, page, output, mode: 'opaque', expectedAlpha: 255 });

  await seedWindowMode(home, null);
  await page.waitForFunction(() => window.__factoryThemeSmoke.getDiagnostics().snapshot.windowMode === 'transparent'
    && window.__factoryThemeSmoke.getDiagnostics().glass === false, null, { timeout: 10000 });
  const transparentCss = await getCssState(page);
  report.diagnostics.transparentDefault = await getDiagnosticState(page);
  assert.equal(transparentCss.documentBackground, 'rgb(16, 16, 25)',
    'missing markers mean Omarchy transparent, which stays opaque in Factory');
  assert.equal((await captureAlpha([[216, 140]]))[0], 255,
    'the transparent default must not fake transparency either');

  await seedWindowMode(home, 'glassy');
  await waitForSettledSurfaces('rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0)', true);
  assert.ok(alphaWithinGlass((await captureAlpha([[216, 140]]))[0]),
    'a live recreated glassy marker restores the .65 glass tint');
  assert.equal(await readFile(generationPath, 'utf8'), generationContent,
    'windowMode toggles never rewrote theme.generation');

  await replaceFixture(fixture, palettes.light);
  await page.waitForFunction(expected => {
    const state = window.__factoryThemeSmoke?.getDiagnostics?.() ?? null;
    return state?.snapshot.mode === 'light' && state?.snapshot.background === expected && state?.glass === true
      && document.documentElement.getAttribute('data-theme') !== 'dark'
      && getComputedStyle(document.getElementById('factory-theme-smoke-frame')).backgroundColor === 'rgba(228, 240, 255, 0.65)';
  }, palettes.light.background, { timeout: 10000 });
  await waitForSettledSurfaces('rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0)', true);
  const followedLightNative = await waitForElectronTheme(app, 'light');
  assert.equal(followedLightNative.themeSource, 'light');
  const followedLightCss = await getCssState(page);
  report.diagnostics.followedLight = await getDiagnosticState(page);
  await saveDisposableScreenshot(app, page, path.join(output, 'follow-light.png'));
  assert.equal(followedLightCss.page, 'transparent',
    'the glassy light page token stays a single transparent layer');
  assertColor(followedLightCss.foreground, palettes.light.foreground, 'light text token uses Omarchy foreground');
  assertColor(followedLightCss.accent, palettes.light.accent, 'light accent token uses Omarchy accent');
  assert.equal(followedLightCss.visibleSurface.background, 'rgba(0, 0, 0, 0)',
    'the real Zu surface stays transparent in light glass');
  assertColor(followedLightCss.visibleSurface.foreground, palettes.light.foreground, 'visible fixture text uses the light foreground token');
  assertColor(followedLightCss.visibleSurface.accentBorder, palettes.light.accent, 'visible fixture border uses the light accent token');
  assert.equal(followedLightCss.mode, 'light');
  assert.equal(followedLightCss.documentBackground, 'rgba(0, 0, 0, 0)',
    'the light glass tint stays regional, with no extra html paint');
  assert.ok(alphaWithinGlass((await captureAlpha([[216, 140]]))[0]),
    'the glassy light framebuffer keeps alpha near .65 through a live mode change');
  report.chrome.light = await assertChrome();
  report.applicationMenu.light = await runApplicationMenuSmoke({ app, page, output, mode: 'light' });
  report.sidebarFade.light = await runSidebarFadeSmoke({ app, page, output, mode: 'light' });
  report.navigation.light = await runNavigationSmoke({ app, page, output, mode: 'light' });
  await follow.click();
  await page.waitForFunction(() => localStorage.getItem('factory-port-theme-source') === 'factory');
  await page.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'dark');
  await waitForSettledSurfaces('rgb(32, 36, 42)', 'rgb(32, 36, 42)', false);
  const fallbackNative = await waitForElectronTheme(app, 'dark');
  const fallbackCss = await getCssState(page);
  report.diagnostics.fallback = await getDiagnosticState(page);
  await saveDisposableScreenshot(app, page, path.join(output, 'follow-off-manual-dark.png'));
  const afterManualStorage = await page.evaluate(() => Object.fromEntries(
    ['factory-theme-preference', 'factory-appearance-settings', 'factory-appearance-startup-backgrounds']
      .map(key => [key, localStorage.getItem(key)])));
  assert.deepEqual(afterManualStorage, manualStorage, 'manual Factory preference bytes remain unchanged');
  assert.deepEqual({
    mode: fallbackCss.mode,
    page: fallbackCss.page,
    foreground: fallbackCss.foreground,
    accent: fallbackCss.accent,
    documentBackground: fallbackCss.documentBackground,
    visibleSurface: fallbackCss.visibleSurface,
  }, {
    mode: manualCss.mode,
    page: manualCss.page,
    foreground: manualCss.foreground,
    accent: manualCss.accent,
    documentBackground: manualCss.documentBackground,
    visibleSurface: manualCss.visibleSurface,
  }, 'turning following off restores manual CSS tokens');
  assert.equal((await captureAlpha([[216, 140]]))[0], 255,
    'turning following off restores a fully opaque framebuffer');
  assert.deepEqual(await captureAlpha([[16, 140], [300, 16]]), [255, 255],
    'Follow off also restores an opaque sidebar and title bar');
  assert.equal(fallbackNative.themeSource, manualNative.themeSource);
  assert.equal(fallbackNative.windowBackground, manualNative.windowBackground);
  await assertNativeMenuFallback({ app, page });
  report.applicationMenu.followOffNativeFallback = true;
  report.navigation.followOff = await runNavigationSmoke({ app, page, output, mode: 'follow-off', expectedAlpha: 255 });
  assert.equal(await readFile(generationPath, 'utf8'), `${palettes.light.revision}\n`,
    'the smoke never rewrote theme.generation outside replaceFixture');
  report.app = appInfo;
  report.bridge = { available: bridge.available, mode: bridge.mode, revision: bridge.revision, windowMode: bridge.windowMode };
  report.manualCss = manualCss;
  report.followedDark = { css: followedDarkCss, nativeThemeSource: followedDarkNative.themeSource, glassAlpha: darkGlassAlpha, textPixels: darkText, controlAlpha: darkControlAlpha };
  report.markerPhases = { opaque: { css: opaqueCss, nativeBackground: opaqueNative.windowBackground }, transparent: transparentCss };
  report.followedLight = { css: followedLightCss, nativeThemeSource: followedLightNative.themeSource };
  report.fallback = { css: fallbackCss, nativeTheme: fallbackNative, manualStorageIdentical: true };
  report.generationUntouched = true;
  report.alphaProof = 'capturePage bitmap alpha; getBackgroundColor() is not trusted for transparency';
  report.checkbox = 'real renderer setting row factoryPortBuildThemeRow using oa and Wc; test-mounted with original hooks';
  report.signedIn = false;
  report.glassScope = 'real jtf/iuf/atoms/row, unscoped opaque-token backdrop, Fe/gm native content and upstream border-gradient frame; test-mounted, not an authenticated session';
  report.blockedNetworkByOriginAndMethod = Object.fromEntries(blockedNetwork);
  await writeFile(path.join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
  assert.deepEqual(pageErrors, []);
} catch (error) {
  report.failure = { name: error?.name || 'Error', message: error?.message || String(error) };
  if (page) {
    try {
      report.diagnostics.failure = await getDiagnosticState(page);
      await saveDisposableScreenshot(app, page, path.join(output, 'failure.png'));
    } catch (captureError) {
      report.diagnostics.captureFailure = captureError?.message || String(captureError);
    }
  }
  report.blockedNetworkByOriginAndMethod = Object.fromEntries(blockedNetwork);
  await writeFile(path.join(output, 'failure-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  throw error;
} finally {
  if (app) {
    try {
      report.cleanup = await closeDisposableApp(app);
      if (!report.failure) assert.equal(report.cleanup.forcedDisposableExit, false,
        'a successful smoke must close normally, not hide a blocking main-process error');
      await writeFile(path.join(output, report.failure ? 'failure-report.json' : 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    }
    catch (error) { if (!report.failure) throw error; console.error(error.message); }
  }
  await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
