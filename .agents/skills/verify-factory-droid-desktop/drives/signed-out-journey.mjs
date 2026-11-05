// Skill drive: the signed-out launch journey, end to end.
// Launch -> window renders the sign-in screen -> the three real entry
// buttons are present -> real keyboard input (F10) triggers the
// application menu popup exactly once through the app's injected
// before-input-event handler -> dark/light theme source switches render ->
// clean shutdown. Isolation and airgap match tests/gui-smoke.mjs.
//
// Limited proof, stated honestly: signed-out only. Sign-in itself, the
// authenticated shell, and theme follow (which needs sign-in, observed on
// the target too) are out of scope here.
//
// Usage:
//   FACTORY_PLAYWRIGHT_MODULE=/path/to/pw-esm.mjs node drives/signed-out-journey.mjs \
//     <bundleDir> <outDir>
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const { _electron } = await import(process.env.FACTORY_PLAYWRIGHT_MODULE || 'playwright');
const bundle = path.resolve(process.argv[2]);
const output = path.resolve(process.argv[3] || 'build/skill-journey');
await mkdir(output, { recursive: true });

const home = await mkdtemp(path.join(tmpdir(), 'factory-journey-'));
let app;
const summary = { journey: 'signed-out-launch', ok: false, steps: {} };
try {
  app = await _electron.launch({
    executablePath: path.join(bundle, 'factory-desktop'),
    args: [`--user-data-dir=${path.join(home, 'user-data')}`,
      '--proxy-server=http://127.0.0.1:9', '--host-resolver-rules=MAP * ~NOTFOUND',
      '--disable-background-networking', '--disable-component-update'],
    env: {
      PATH: process.env.PATH, LANG: process.env.LANG, HOME: home,
      XDG_CONFIG_HOME: path.join(home, 'config'), XDG_DATA_HOME: path.join(home, 'data'),
      XDG_CACHE_HOME: path.join(home, 'cache'), XDG_STATE_HOME: path.join(home, 'state'),
      FACTORY_HOME_OVERRIDE: path.join(home, 'factory-home'),
      FACTORY_ENV: 'production', FACTORY_RELEASE_CHANNEL: 'production',
      FACTORY_DEPLOYMENT_ENV: 'production', FACTORY_DISABLE_KEYRING: '1',
      DISPLAY: process.env.DISPLAY, XAUTHORITY: process.env.XAUTHORITY,
      HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9',
      ALL_PROXY: 'http://127.0.0.1:9',
    },
    chromiumSandbox: true, timeout: 60000,
  });
  const page = await app.firstWindow({ timeout: 60000 });
  await page.waitForFunction(() => document.body.innerText.includes('Sign in'),
    null, { timeout: 45000 });
  summary.steps.signInScreen = true;
  // Recorded-run ownership: cleanup may only ever act on this exact PID,
  // and only after re-verifying what /proc says it is (see cleanup-run.sh).
  summary.mainPid = await app.evaluate(() => process.pid);

  summary.steps.version = await app.evaluate(({ app }) => app.getVersion());
  const buttons = await page.evaluate(() => [...document.querySelectorAll('button,[role=button]')]
    .map(b => (b.getAttribute('aria-label') || b.textContent || '').trim()).filter(Boolean));
  assert.ok(buttons.includes('Log in') && buttons.some(b => b.startsWith('Sign in to')),
    `real entry buttons present: ${JSON.stringify(buttons)}`);
  summary.steps.entryButtons = buttons;

  // Real keyboard input through the app's injected handler; the popup is
  // intercepted to observe it, the interception never fires it.
  await app.evaluate(({ Menu }) => {
    const menu = Menu.getApplicationMenu();
    globalThis.factoryJourneyPopups = 0;
    globalThis.factoryJourneyOriginalPopup = menu.popup;
    menu.popup = () => { globalThis.factoryJourneyPopups++; };
  });
  await app.evaluate(({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    contents.sendInputEvent({ type: 'keyDown', keyCode: 'F10' });
    contents.sendInputEvent({ type: 'keyUp', keyCode: 'F10' });
  });
  assert.equal(await app.evaluate(() => globalThis.factoryJourneyPopups), 1,
    'F10 opens the application menu exactly once');
  await app.evaluate(({ Menu }) => {
    Menu.getApplicationMenu().popup = globalThis.factoryJourneyOriginalPopup;
  });
  summary.steps.f10MenuPopup = 1;

  await app.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'dark'; });
  await page.screenshot({ path: path.join(output, 'journey-dark.png') });
  await app.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'light'; });
  await page.screenshot({ path: path.join(output, 'journey-light.png') });
  summary.steps.themeScreenshots = ['journey-dark.png', 'journey-light.png'];

  await page.screenshot({ path: path.join(output, 'journey-signin.png') });
  summary.ok = true;
} finally {
  if (app) { try { await app.close(); } catch {} }
  await rm(home, { recursive: true, force: true });
}
await writeFile(path.join(output, 'journey.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary));
process.exit(summary.ok ? 0 : 1);
