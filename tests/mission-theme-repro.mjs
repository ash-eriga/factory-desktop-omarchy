// Disposable reproduction harness for the vantablack-in-missions toolbar bug.
// Mounts the REAL upstream composer (pen) and its actions row (Hsl, EWt, fol,
// gol, mol) inside the real ThemeSync (pAf) and appearance styles (Ncf), with
// the Omarchy follow active over a vantablack-shaped fixture palette
// (dark #000000/#ffffff/#8d8d8d) and the glassy window mode. Two mounts:
// a plain root (what an unscoped toolbar subtree sees) and a Gk-wrapped root
// (explicit core-ui-v2 dark scope). Screenshots both and scans for a solid
// light box that should not exist in a dark theme.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, unlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const asar = require('@electron/asar');
const playwrightModule = process.env.FACTORY_PLAYWRIGHT_MODULE || 'playwright';
const { _electron } = playwrightModule.endsWith('.js')
  ? require(playwrightModule)
  : await import(playwrightModule);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const versions = JSON.parse(await readFile(path.join(projectRoot, 'versions.json'), 'utf8'));
const bundle = path.resolve(process.argv[2] || `dist/factory-droid-desktop-${versions.desktop}`);
const output = path.resolve(process.argv[3] || 'build/mission-theme-repro');
const rendererRelative = versions.renderer;
const preloadRelative = '.vite/build/preload.js';

// Vantablack fixture: the real theme's exact colors.toml values.
const vantablack = { mode: 'dark', background: '#000000', foreground: '#ffffff', accent: '#8d8d8d', revision: 'fixture-vantablack-1' };

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
  await writeFile(path.join(theme, 'colors.toml'),
    `mode = "${palette.mode}"\nbackground = "${palette.background}"\nforeground = "${palette.foreground}"\naccent = "${palette.accent}"\n`);
  await writeFile(path.join(current, 'theme.generation'), `${palette.revision}\n`);
}

async function seedWindowMode(home, mode) {
  const dir = path.join(home, 'state', 'omarchy', 'toggles', 'hypr');
  await rm(path.join(dir, 'window-opaque.lua'), { force: true });
  await rm(path.join(dir, 'window-glassy.lua'), { force: true });
  if (mode) {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, `window-${mode}.lua`), '-- disposable repro marker; never executed\n');
  }
}

async function instrumentClone(tempRoot) {
  const extracted = path.join(tempRoot, 'asar-unpacked');
  await mkdir(extracted);
  const sourceAsar = path.join(bundle, 'resources/app.asar');
  const rendererPath = path.join(extracted, rendererRelative);
  await asar.extractAll(sourceAsar, extracted);
  const renderer = await readFile(rendererPath, 'utf8');
  for (const symbol of ['function pen(', 'function Hsl(', 'function fol(', 'function gol(', 'function mol(',
    'function Gk(', 'function Jot(', 'function df(', 'function pAf(', 'function Ncf()',
    'factoryPortThemeFollow', 'factoryPortThemeSnapshot', 'factoryPortBuildThemeRow']) {
    assert.ok(renderer.includes(symbol), `renderer contains ${symbol}`);
  }
  const instrumentation = `
;window.__missionRepro=(()=>{
  const selectorProps = { onUpdateSettings(){}, availableModels: [{id:'gpt-6.1', label:'GPT-6.1 Sol'}], currentModelId: 'gpt-6.1' };
  const autonomyProps = { onLevelChange(){}, currentLevel: 'high', onModeChange(){}, currentMode: 'mission' };
  const mcpProps = { connectedConnectorCount: 3, connectedServerCount: 2, serverCount: 1, onClick(){} };
  const skillsProps = { skillCount: 74, onClick(){} };
  function ReproComposer() {
    return c.jsx(pen, {
      attachmentProps: {},
      autonomySelectorProps: autonomyProps,
      mcpButtonProps: mcpProps,
      skillsButtonProps: skillsProps,
      placeholder: 'Describe your mission',
      onSubmit(){},
      userId: 'repro',
      sessionId: 'repro',
      style: { width: '820px' },
    });
  }
  function FollowRow() {
    const [enabled, setEnabled] = cs(factoryPortThemeFollow);
    const [state] = cs(factoryPortThemeSnapshot);
    return factoryPortBuildThemeRow(enabled, state, setEnabled);
  }
  function ScopedComposer() {
    return c.jsx(Gk, { theme: Jot(), children: c.jsx(ReproComposer, {}) });
  }
  function mount(container, scoped) {
    try { Lhe().set(JWe, 'dark'); } catch {}
    const content = c.jsxs(L.Fragment, { children: [
      // The mission view renders the composer inside a v2 scope whose CSS
      // remaps legacy tokens onto core-v2 tokens (the glass regression lives
      // in that remap), so the fixture carries the same marker.
      c.jsx('div', { 'data-mission-control-v2': 'true', children: c.jsx(ReproComposer, {}) }),
      c.jsx('div', { style: { height: 12 } }),
      scoped ? c.jsx(ScopedComposer, {}) : null,
      c.jsx('div', { style: { height: 12 } }),
      c.jsx(FollowRow, {}),
    ] });
    const root = IKo.createRoot(container);
    root.render(c.jsx(pAf, { children: c.jsxs(L.Fragment, { children: [
      c.jsx(Ncf, {}),
      c.jsx(df, { id: 'mission-repro-surface', style: { background: 'var(--core-v2-bg-page)', color: 'var(--core-v2-text-primary)', minHeight: '100vh', padding: 24 }, children: content }),
    ] }) }));
    return root;
  }
  return { mount };
})();\n`;
  await writeFile(rendererPath, renderer + instrumentation);
  execFileSync(process.execPath, ['--check', rendererPath], { stdio: 'pipe' });
  return { extracted };
}

const tempRoot = await mkdtemp(path.join(tmpdir(), 'mission-repro-'));
const cloneParent = path.join(tempRoot, 'candidate-copy');
const clone = path.join(cloneParent, path.basename(bundle));
const home = path.join(tempRoot, 'home');
let app;
let page;
try {
  await mkdir(output, { recursive: true });
  await mkdir(home, { recursive: true });
  await writeFixture(home, vantablack);
  await seedWindowMode(home, 'glassy');
  const { extracted } = await instrumentClone(tempRoot);
  const candidateAsar = path.join(tempRoot, 'instrumented-app.asar');
  await asar.createPackageWithOptions(extracted, candidateAsar, { unpackDir: 'node_modules/keytar' });
  await mkdir(cloneParent, { recursive: true });
  execFileSync('cp', ['-a', '--reflink=auto', bundle, cloneParent], { stdio: 'ignore' });
  await unlink(path.join(clone, 'resources/app.asar'));
  await copyFile(candidateAsar, path.join(clone, 'resources/app.asar'));

  app = await _electron.launch({
    executablePath: path.join(clone, 'factory-desktop'),
    args: [`--user-data-dir=${path.join(home, 'user-data')}`, '--proxy-server=http://127.0.0.1:9', '--proxy-bypass-list=<-loopback>'],
    env: safeEnvironment(home),
    chromiumSandbox: true,
    timeout: 60000,
  });
  page = await app.firstWindow({ timeout: 60000 });
  await page.route(/^https?:\/\//, route => route.abort('blockedbyclient'));
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  const consoleErrors = [];
  page.on('console', message => {
    if (['error', 'warning'].includes(message.type())) consoleErrors.push(`${message.type()}: ${message.text().slice(0, 300)}`);
  });
  await page.waitForFunction(() => document.body.innerText.includes('Sign in'), null, { timeout: 30000 });

  // Follow Omarchy via the real preload bridge and the real follow row.
  await page.evaluate(() => {
    localStorage.setItem('factory-theme-preference', 'dark');
    const root = document.createElement('div');
    root.id = 'mission-repro-root';
    root.style.cssText = 'position:fixed;inset:0;z-index:2147483000;overflow:auto;';
    document.body.appendChild(root);
    for (const child of [...document.body.children]) {
      if (child !== root) child.style.display = 'none';
    }
    window.__missionRepro.mount(root, true);
  });
  await page.waitForTimeout(1500);
  const mountState = await page.evaluate(() => ({
    htmlLen: document.getElementById('mission-repro-root')?.innerHTML.length ?? -1,
    hasFollowLabel: !!document.querySelector('[aria-label="Follow Omarchy theme"], [aria-label="Seguir o tema do Omarchy"]'),
    text: document.getElementById('mission-repro-root')?.innerText?.slice(0, 400) ?? '',
    html: document.getElementById('mission-repro-root')?.innerHTML?.slice(0, 600) ?? '',
  }));
  console.log('MOUNT STATE:', JSON.stringify(mountState), 'pageErrors:', JSON.stringify(pageErrors), 'console:', JSON.stringify(consoleErrors.slice(0, 8)));
  const follow = page.locator('[aria-label="Follow Omarchy theme"], [aria-label="Seguir o tema do Omarchy"]');
  await follow.waitFor({ state: 'visible', timeout: 10000 });
  await follow.click();
  await page.waitForFunction(() => localStorage.getItem('factory-port-theme-source') === 'omarchy', null, { timeout: 10000 });
  await page.waitForFunction(() => {
    const state = window.__factoryThemeSmoke?.getDiagnostics?.();
    return state?.follow === true && state?.active === true && state?.glass === true;
  }, null, { timeout: 15000 }).catch(async () => {
    // theme-smoke's diagnostics may not be present in this harness; fall back to the html attribute
    await page.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'dark', null, { timeout: 10000 });
  });
  await page.waitForTimeout(1200); // let shimmer/transition settle

  const shot = path.join(output, 'repro-vantablack.png');
  const buffer = await page.screenshot({ path: shot });
  const analysis = await page.evaluate(() => {
    const root = document.getElementById('mission-repro-root');
    const findings = [];
    const visit = (element, depth) => {
      if (depth > 40) return;
      for (const child of element.children) {
        const style = getComputedStyle(child);
        const bg = style.backgroundColor;
        const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
        if (m) {
          const [r, g, b, a = 1] = m.slice(1).map(Number);
          const light = a > 0.5 && r > 150 && g > 150 && b > 150;
          const rect = child.getBoundingClientRect();
          if (light && rect.width >= 40 && rect.height >= 14) {
            findings.push({
              tag: child.tagName, cls: String(child.className).slice(0, 100), bg, color: style.color,
              scope: child.getAttribute('data-core-ui-v2-theme'),
              rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
              text: child.textContent?.slice(0, 60) ?? '',
            });
          }
        }
        visit(child, depth + 1);
      }
    };
    visit(root, 0);
    // The active mission-mode chip: button[aria-pressed="true"] in the composer
    const chip = root.querySelector('[data-mission-control-v2] button[aria-pressed]');
    const chipStyle = chip ? getComputedStyle(chip) : null;
    const label = chip ? chip.textContent : null;
    const textElement = chip ? (() => {
      const walker = document.createTreeWalker(chip, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.textContent.trim()) return node.parentElement;
      }
      return null;
    })() : null;
    const textProbe = textElement ? (() => {
      const style = getComputedStyle(textElement);
      const read = name => style.getPropertyValue(name).trim();
      return {
        tag: textElement.tagName, color: style.color,
        textInverted: read('--text-inverted'),
        coreTextInverse: read('--core-v2-text-inverse'),
        textLabel: read('--text-label'),
        pageColor: read('--factory-port-page-color'),
        coreBgPage: read('--core-v2-bg-page'),
        coreTextPrimary: read('--core-v2-text-primary'),
      };
    })() : null;
    let glassRulePresent = false;
    for (const sheet of document.styleSheets) {
      try {
        for (const rule of sheet.cssRules) {
          if (rule.cssText && rule.cssText.includes('--factory-port-page-color')) { glassRulePresent = true; break; }
        }
      } catch {}
      if (glassRulePresent) break;
    }
    return {
      htmlTheme: document.documentElement.getAttribute('data-theme'),
      glassRulePresent,
      coreBgPage: getComputedStyle(document.documentElement).getPropertyValue('--core-v2-bg-page').trim(),
      textInvertedAtChip: chip ? getComputedStyle(chip).getPropertyValue('--text-inverted').trim() : null,
      surfaceInvertedAtChip: chip ? getComputedStyle(chip).getPropertyValue('--surface-inverted').trim() : null,
      textProbe,
      chip: chipStyle ? { bg: chipStyle.backgroundColor, color: chipStyle.color, text: label, pressed: chip.getAttribute('aria-pressed') } : null,
      findings,
    };
  });
  await writeFile(path.join(output, 'analysis.json'), `${JSON.stringify(analysis, null, 2)}\n`);
  console.log(JSON.stringify(analysis, null, 2));
  console.log('screenshot:', shot, buffer.length, 'bytes');
  assert.ok(analysis.chip, 'the active mission-mode chip rendered');
  assert.equal(analysis.chip.pressed, 'true', 'the mission-mode chip is the active one');
  assert.ok(analysis.textProbe, 'the chip label text element was found');
  assert.notEqual(analysis.textProbe.color, analysis.chip.bg,
    `the active mission-mode chip label must stay readable over glass: text ${analysis.textProbe.color} on ${analysis.chip.bg}`);
  assert.notEqual(analysis.textProbe.color, 'rgba(0, 0, 0, 0)',
    'the chip label must not fall back to a fully transparent color');
} catch (error) {
  console.error('REPRO FAILURE:', error?.message || error);
  try {
    if (page) await page.screenshot({ path: path.join(output, 'failure.png') });
  } catch {}
  throw error;
} finally {
  if (app) { try { await app.close(); } catch {} }
  await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
