// Live Electron checks in a disposable profile. No login or model requests.
// FACTORY_PLAYWRIGHT_MODULE can point to a locally bundled playwright module.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const { _electron } = await import(process.env.FACTORY_PLAYWRIGHT_MODULE || 'playwright');
const bundle = path.resolve(process.argv[2]);
const output = path.resolve(process.argv[3] || 'build/gui-smoke');
const baseline = process.argv.includes('--baseline');
const home = await mkdtemp(path.join(tmpdir(), 'factory-gui-'));
await mkdir(output, { recursive: true });
const displayEnv = {};
for (const key of ['PATH','USER','LOGNAME','LANG','LC_ALL','DISPLAY','WAYLAND_DISPLAY',
  'XAUTHORITY','XDG_RUNTIME_DIR','DBUS_SESSION_BUS_ADDRESS','XDG_SESSION_TYPE',
  'ELECTRON_OZONE_PLATFORM_HINT','GDK_BACKEND','TMPDIR']) {
  if (process.env[key] !== undefined) displayEnv[key] = process.env[key];
}
const env = { ...displayEnv, HOME: home,
  XDG_CONFIG_HOME: path.join(home,'config'), XDG_DATA_HOME: path.join(home,'data'),
  XDG_CACHE_HOME: path.join(home,'cache'), XDG_STATE_HOME: path.join(home,'state'),
  FACTORY_HOME_OVERRIDE: path.join(home,'factory-home'), FACTORY_ENV:'production',
  FACTORY_RELEASE_CHANNEL:'production', FACTORY_DEPLOYMENT_ENV:'production',
  HTTP_PROXY:'http://127.0.0.1:9', HTTPS_PROXY:'http://127.0.0.1:9',
  ALL_PROXY:'http://127.0.0.1:9' };
for (const key of ['NODE_OPTIONS','ELECTRON_RUN_AS_NODE','ELECTRON_NO_ASAR',
  'FACTORY_DESKTOP_RENDERER_URL','FACTORY_E2E_DAEMON_HOOKS','FACTORY_DESKTOP_DAEMON_BINARY',
  'FACTORY_API_KEY']) delete env[key];
env.FACTORY_DISABLE_KEYRING = '1';
let app;
try {
  app = await _electron.launch({ executablePath: path.join(bundle,'factory-desktop'),
    args:[`--user-data-dir=${path.join(home,'user-data')}`,
      '--proxy-server=http://127.0.0.1:9','--host-resolver-rules=MAP * ~NOTFOUND',
      '--disable-background-networking','--disable-component-update'], env,
    chromiumSandbox:true, timeout:60000 });
  const page = await app.firstWindow({timeout:60000});
  const browserWindow = await app.browserWindow(page);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => document.body.innerText.includes('Sign in'), null, {timeout:45000});
  const appInfo = await app.evaluate(({app}) => ({version:app.getVersion(),
    platform:process.platform, noSandbox:app.commandLine.hasSwitch('no-sandbox')}));
  const windowInfo = await browserWindow.evaluate(win => {
    const bounds = win.getBounds(), content = win.getContentBounds();
    const prefs = win.webContents.getLastWebPreferences();
    return {menuBarVisible:win.isMenuBarVisible(), bounds, content,
      preload:prefs.preload?.split('/').at(-1),
      sandbox:prefs.sandbox !== false,
      contextIsolation:prefs.contextIsolation !== false,
      nodeIntegration:prefs.nodeIntegration === true};
  });
  const main={...appInfo,...windowInfo};
  await page.screenshot({path:path.join(output,'window.png')});
  assert.equal(main.platform,'linux');
  assert.equal(main.noSandbox,false);
  assert.equal(main.sandbox,true);
  assert.equal(main.contextIsolation,true);
  assert.equal(main.nodeIntegration,false);
  if (!baseline) {
    assert.equal(main.menuBarVisible,false);
    // Real keyboard input exercises before-input-event through Electron.
    await app.evaluate(({Menu}) => {
      const menu=Menu.getApplicationMenu();
      globalThis.factoryTestPopupCount=0;
      globalThis.factoryTestOriginalPopup=menu.popup;
      menu.popup=()=>{globalThis.factoryTestPopupCount++};
    });
    await app.evaluate(({BrowserWindow}) => {
      const contents=BrowserWindow.getAllWindows()[0].webContents;
      contents.sendInputEvent({type:'keyDown',keyCode:'F10'});
      contents.sendInputEvent({type:'keyUp',keyCode:'F10'});
    });
    assert.equal(await app.evaluate(()=>globalThis.factoryTestPopupCount),1);
    await page.keyboard.press('Alt+ArrowLeft');
    assert.equal(await app.evaluate(()=>globalThis.factoryTestPopupCount),1);
    await app.evaluate(({Menu}) => {Menu.getApplicationMenu().popup=globalThis.factoryTestOriginalPopup});
    await app.evaluate(({nativeTheme}) => {nativeTheme.themeSource='dark'});
    await page.screenshot({path:path.join(output,'window-dark.png')});
    await app.evaluate(({nativeTheme}) => {nativeTheme.themeSource='light'});
    await page.screenshot({path:path.join(output,'window-light.png')});
  }
  const report={...main,rendererErrors:errors};
  await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report));
  assert.deepEqual(errors,[]);
} finally {
  if(app) await app.close();
  await rm(home,{recursive:true,force:true});
}
