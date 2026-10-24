// Isolated Electron performance smoke test. It never signs in or sends prompts.
// Network output is aggregated by origin/status; request URLs and bodies are discarded.
// FACTORY_PLAYWRIGHT_MODULE can point to a locally bundled Playwright module.
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const { _electron } = await import(process.env.FACTORY_PLAYWRIGHT_MODULE || 'playwright');

function readOption(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isFinite(value)) throw new Error(`${name} needs a number of seconds`);
  return value;
}

const bundle = process.argv[2] && path.resolve(process.argv[2]);
if (!bundle) throw new Error('Usage: node tests/performance-smoke.mjs <bundle-dir> [--seconds 20]');
const seconds = readOption('--seconds', 20);
if (seconds < 1 || seconds > 25) throw new Error('--seconds must be between 1 and 25');

const home = await mkdtemp(path.join(tmpdir(), 'factory-performance-'));
const xdg = path.join(home, 'xdg');

// Keep the desktop session variables needed to open a Linux window, but do not
// forward shell/API credentials or the user's config, cache, or data directories.
const env = {
  PATH: process.env.PATH || '/usr/bin:/bin',
  HOME: home,
  TMPDIR: path.join(home, 'tmp'),
  XDG_CONFIG_HOME: path.join(xdg, 'config'),
  XDG_DATA_HOME: path.join(xdg, 'data'),
  XDG_CACHE_HOME: path.join(xdg, 'cache'),
  XDG_STATE_HOME: path.join(xdg, 'state'),
  FACTORY_HOME_OVERRIDE: path.join(home, 'factory-home'),
  FACTORY_ENV: 'production',
  FACTORY_RELEASE_CHANNEL: 'production',
  FACTORY_DEPLOYMENT_ENV: 'production',
  FACTORY_DISABLE_KEYRING: '1',
};
for (const key of [
  'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'XDG_SESSION_TYPE',
  'XDG_CURRENT_DESKTOP', 'XDG_SESSION_DESKTOP', 'DBUS_SESSION_BUS_ADDRESS',
  'XAUTHORITY', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'ELECTRON_OZONE_PLATFORM_HINT',
]) {
  if (process.env[key]) env[key] = process.env[key];
}

const requestStarted = new WeakMap();
const recordedRequests = new WeakSet();
const networkGroups = new Map();
let currentPhase = 'startup';
let app;
let cdp;
let page;
let browserWindow;
let targetWebContentsId;

function originOf(rawUrl) {
  try { return new URL(rawUrl).origin; }
  catch { return 'unknown'; }
}

function recordNetwork(request, status) {
  if (recordedRequests.has(request)) return;
  recordedRequests.add(request);
  const origin = originOf(request.url());
  const start = requestStarted.get(request);
  requestStarted.delete(request);
  const phase = start?.phase || currentPhase;
  const elapsed = start?.startedAt === undefined
    ? null : Math.max(0, performance.now() - start.startedAt);
  const key = JSON.stringify([phase, origin, status]);
  let group = networkGroups.get(key);
  if (!group) {
    group = { phase, origin, status, count: 0, durations: [] };
    networkGroups.set(key, group);
  }
  group.count++;
  if (elapsed !== null) group.durations.push(elapsed);
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.ceil(fraction * ordered.length) - 1)];
}

function summarizeNetwork() {
  return [...networkGroups.values()].map(({ durations, ...group }) => ({
    ...group,
    requestToHeadersMs: durations.length ? {
      mean: Number((durations.reduce((sum, value) => sum + value, 0) / durations.length).toFixed(2)),
      p95: Number(percentile(durations, 0.95).toFixed(2)),
    } : null,
  }));
}

async function readPssKiB(pid) {
  try {
    const contents = await readFile(`/proc/${pid}/smaps_rollup`, 'utf8');
    const match = /^Pss:\s+(\d+)\s+kB$/m.exec(contents);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

async function sampleProcesses() {
  const raw = await app.evaluate(({ app }) => app.getAppMetrics().map(metric => ({
    // PIDs are retained only in memory to match samples. They are never reported.
    pid: metric.pid,
    creationTime: metric.creationTime,
    type: metric.type,
    cpuSeconds: metric.cpu.cumulativeCPUUsage ?? null,
    workingSetKiB: metric.memory.workingSetSize ?? null,
  })));
  const withPss = await Promise.all(raw.map(async metric => ({
    ...metric,
    pssKiB: await readPssKiB(metric.pid),
  })));
  return withPss;
}

function memoryByType(processes) {
  const groups = new Map();
  for (const process of processes) {
    let group = groups.get(process.type);
    if (!group) {
      group = { processCount: 0, workingSetKiB: 0, pssKiB: 0, pssProcessCount: 0 };
      groups.set(process.type, group);
    }
    group.processCount++;
    if (Number.isFinite(process.workingSetKiB)) group.workingSetKiB += process.workingSetKiB;
    if (Number.isFinite(process.pssKiB)) {
      group.pssKiB += process.pssKiB;
      group.pssProcessCount++;
    }
  }
  return Object.fromEntries([...groups].map(([type, group]) => [type, {
    processCount: group.processCount,
    workingSetMiB: Number((group.workingSetKiB / 1024).toFixed(1)),
    pssMiB: group.pssProcessCount
      ? Number((group.pssKiB / 1024).toFixed(1)) : null,
    pssProcessCount: group.pssProcessCount,
  }]));
}

async function sampleRenderer() {
  const { metrics } = await cdp.send('Performance.getMetrics');
  const result = {};
  for (const { name, value } of metrics) result[name] = value;
  return result;
}

function metricDelta(start, end, key, multiplier = 1) {
  const a = start[key], b = end[key];
  return Number.isFinite(a) && Number.isFinite(b) && b >= a
    ? Number(((b - a) * multiplier).toFixed(2)) : null;
}

function signedGaugeDelta(start, end, key, multiplier = 1) {
  const a = start[key], b = end[key];
  return Number.isFinite(a) && Number.isFinite(b)
    ? Number(((b - a) * multiplier).toFixed(2)) : null;
}

function rendererDelta(start, end) {
  return {
    taskMs: metricDelta(start, end, 'TaskDuration', 1000),
    scriptMs: metricDelta(start, end, 'ScriptDuration', 1000),
    layoutMs: metricDelta(start, end, 'LayoutDuration', 1000),
    styleRecalcMs: metricDelta(start, end, 'RecalcStyleDuration', 1000),
    jsHeapEndMiB: Number.isFinite(end.JSHeapUsedSize)
      ? Number((end.JSHeapUsedSize / 1048576).toFixed(1)) : null,
    jsHeapDeltaMiB: signedGaugeDelta(start, end, 'JSHeapUsedSize', 1 / 1048576),
    domNodeDelta: signedGaugeDelta(start, end, 'Nodes'),
    layoutCountDelta: metricDelta(start, end, 'LayoutCount'),
  };
}

function cpuDeltaByType(before, after, elapsedMs) {
  const startById = new Map(before.map(process => [
    `${process.pid}:${process.creationTime}`, process,
  ]));
  const totals = new Map();
  for (const process of after) {
    if (!Number.isFinite(process.cpuSeconds)) continue;
    const prior = startById.get(`${process.pid}:${process.creationTime}`);
    const delta = prior && Number.isFinite(prior.cpuSeconds)
      ? Math.max(0, process.cpuSeconds - prior.cpuSeconds)
      : process.cpuSeconds;
    totals.set(process.type, (totals.get(process.type) || 0) + delta);
  }
  const output = {};
  for (const [type, cpuSeconds] of totals) {
    output[type] = {
      cpuSeconds: Number(cpuSeconds.toFixed(3)),
      oneCorePercent: elapsedMs > 0
        ? Number((cpuSeconds / (elapsedMs / 1000) * 100).toFixed(2)) : null,
    };
  }
  return output;
}

async function measurePhase(name, durationSeconds) {
  currentPhase = name;
  const startedAt = performance.now();
  const [processesBefore, rendererBefore] = await Promise.all([
    sampleProcesses(), sampleRenderer(),
  ]);
  await new Promise(resolve => setTimeout(resolve, durationSeconds * 1000));
  const [processesAfter, rendererAfter] = await Promise.all([
    sampleProcesses(), sampleRenderer(),
  ]);
  const elapsedMs = performance.now() - startedAt;
  return {
    secondsRequested: durationSeconds,
    elapsedSeconds: Number((elapsedMs / 1000).toFixed(2)),
    cpuByProcessType: cpuDeltaByType(processesBefore, processesAfter, elapsedMs),
    memoryStart: memoryByType(processesBefore),
    memoryEnd: memoryByType(processesAfter),
    renderer: rendererDelta(rendererBefore, rendererAfter),
  };
}

async function measureAppPhase(name, durationSeconds) {
  currentPhase = name;
  const startedAt = performance.now();
  const processesBefore = await sampleProcesses();
  await new Promise(resolve => setTimeout(resolve, durationSeconds * 1000));
  const processesAfter = await sampleProcesses();
  const elapsedMs = performance.now() - startedAt;
  return {
    secondsRequested: durationSeconds,
    elapsedSeconds: Number((elapsedMs / 1000).toFixed(2)),
    cpuByProcessType: cpuDeltaByType(processesBefore, processesAfter, elapsedMs),
    memoryStart: memoryByType(processesBefore),
    memoryEnd: memoryByType(processesAfter),
    renderer: null,
  };
}

async function waitForSignIn(timeout = 45000) {
  await page.waitForFunction(
    () => document.body?.innerText?.includes('Sign in'),
    null,
    { timeout },
  );
}

async function waitForVisibility(state, timeout = 1000) {
  try {
    await page.waitForFunction(
      expected => document.visibilityState === expected,
      state,
      { timeout, polling: 100 },
    );
    return true;
  } catch (error) {
    if (error.name === 'TimeoutError') return false;
    throw error;
  }
}

async function windowVisibilityState() {
  const selected = await browserWindow.evaluate(async win => {
    let documentState = 'unavailable';
    let documentFocused = null;
    try {
      [documentState, documentFocused] = await Promise.all([
        win.webContents.executeJavaScript('document.visibilityState'),
        win.webContents.executeJavaScript('document.hasFocus()'),
      ]);
    }
    catch {}
    return { visible: win.isVisible(), minimized: win.isMinimized(), documentState, documentFocused };
  });
  const windows = await app.evaluate(({ BrowserWindow }, targetId) =>
    BrowserWindow.getAllWindows().map(win => ({
      selectedForPage: win.webContents.id === targetId,
      visible: win.isVisible(),
      minimized: win.isMinimized(),
    })), targetWebContentsId,
  );
  return { ...selected, windows };
}

try {
  await mkdir(path.join(home, 'tmp'));
  const launchStarted = performance.now();
  app = await _electron.launch({
    executablePath: path.join(bundle, 'factory-desktop'),
    args: [`--user-data-dir=${path.join(home, 'user-data')}`],
    env,
    chromiumSandbox: true,
    timeout: 60000,
  });
  page = await app.firstWindow({ timeout: 60000 });
  browserWindow = await app.browserWindow(page);
  targetWebContentsId = await browserWindow.evaluate(win => win.webContents.id);
  page.on('request', request => requestStarted.set(request, {
    startedAt: performance.now(),
    phase: currentPhase,
  }));
  page.on('response', response => recordNetwork(response.request(), response.status()));
  page.on('requestfailed', request => recordNetwork(request, 'failed'));
  await waitForSignIn();
  const signInReadyMs = performance.now() - launchStarted;

  const appInfo = await app.evaluate(({ app }) => ({
    version: app.getVersion(),
    platform: process.platform,
    appReady: app.isReady(),
    browserBehaviorSwitches: Object.fromEntries([
      'no-sandbox',
      'disable-background-timer-throttling',
      'disable-backgrounding-occluded-windows',
      'disable-renderer-backgrounding',
    ].map(name => [name, app.commandLine.hasSwitch(name)])),
  }));
  const initialWindows = await windowVisibilityState();
  const windowInfo = await browserWindow.evaluate(win => {
    const prefs = win.webContents.getLastWebPreferences();
    return {
      windowVisible: win.isVisible(),
      sandbox: prefs.sandbox !== false,
      sandboxSetting: prefs.sandbox === undefined ? 'electron-default' : prefs.sandbox,
      contextIsolation: prefs.contextIsolation !== false,
      nodeIntegration: prefs.nodeIntegration === true,
      backgroundThrottling: win.webContents.getBackgroundThrottling(),
    };
  });
  Object.assign(appInfo, windowInfo);
  assert.equal(appInfo.platform, 'linux', 'This smoke harness targets Linux bundles');
  assert.equal(typeof appInfo.version, 'string');
  assert.notEqual(appInfo.version, '');
  assert.equal(appInfo.appReady, true);
  assert.equal(appInfo.windowVisible, true);
  assert.equal(appInfo.sandbox, true, 'Renderer sandbox must remain enabled');
  assert.equal(appInfo.browserBehaviorSwitches['no-sandbox'], false,
    'Playwright must not disable Chromium sandbox');
  assert.equal(appInfo.contextIsolation, true);
  assert.equal(appInfo.nodeIntegration, false);
  assert.equal(appInfo.backgroundThrottling, true);

  await page.evaluate(() => {
    window.__factoryPerformanceFocusVisibility = [{
      event: 'initial',
      state: document.visibilityState,
      hasFocus: document.hasFocus(),
      atMs: Number(performance.now().toFixed(1)),
    }];
    const record = event => {
      window.__factoryPerformanceFocusVisibility.push({
        event: event.type,
        state: document.visibilityState,
        hasFocus: document.hasFocus(),
        atMs: Number(performance.now().toFixed(1)),
      });
    };
    window.addEventListener('focus', record);
    window.addEventListener('blur', record);
    document.addEventListener('visibilitychange', record);
  });
  cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  // Playwright marks pages focused by default. Disable that emulation so hide/minimize
  // tests observe the Electron window's real visibility state.
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });

  const visible = await measurePhase('visible', seconds);
  currentPhase = 'hideTransition';
  assert.equal(await page.evaluate(() => document.visibilityState), 'visible');
  // Detach CDP during the native hide/show probe. Debugger attachment can alter
  // background visibility behavior, which would make the focus events misleading.
  await cdp.detach();
  cdp = null;
  const hideCallState = await browserWindow.evaluate(async win => {
    win.hide();
    let documentState = 'unavailable';
    try { documentState = await win.webContents.executeJavaScript('document.visibilityState'); }
    catch {}
    return { visible: win.isVisible(), minimized: win.isMinimized(), documentState };
  });
  await new Promise(resolve => setTimeout(resolve, 1000));
  const hideAfter1s = await windowVisibilityState();
  let hiddenObserved = await waitForVisibility('hidden', 1000);
  const hidden = hiddenObserved ? await measureAppPhase('hidden', seconds) : null;
  const hiddenEndState = await windowVisibilityState();
  currentPhase = 'restoreTransition';
  const showCallState = await browserWindow.evaluate(async win => {
    win.show();
    let documentState = 'unavailable';
    let documentFocused = null;
    try {
      [documentState, documentFocused] = await Promise.all([
        win.webContents.executeJavaScript('document.visibilityState'),
        win.webContents.executeJavaScript('document.hasFocus()'),
      ]);
    } catch {}
    return { visible: win.isVisible(), minimized: win.isMinimized(), documentState, documentFocused };
  });
  await new Promise(resolve => setTimeout(resolve, 1000));
  const showAfter1s = await windowVisibilityState();
  let focusCallState = null;
  let focusAfter1s = null;
  if (!showAfter1s.documentFocused) {
    focusCallState = await browserWindow.evaluate(async win => {
      win.focus();
      let documentState = 'unavailable';
      let documentFocused = null;
      try {
        [documentState, documentFocused] = await Promise.all([
          win.webContents.executeJavaScript('document.visibilityState'),
          win.webContents.executeJavaScript('document.hasFocus()'),
        ]);
      } catch {}
      return { visible: win.isVisible(), minimized: win.isMinimized(), documentState, documentFocused };
    });
    await new Promise(resolve => setTimeout(resolve, 1000));
    focusAfter1s = await windowVisibilityState();
  }
  const restoredObserved = await waitForVisibility('visible');
  const restoredState = await windowVisibilityState();
  const focusVisibilityEvents = await page.evaluate(() => window.__factoryPerformanceFocusVisibility || []);
  let restored = null;
  if (restoredObserved) {
    cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
    restored = await measurePhase('restored', seconds);
  }
  const initialPaintTimings = await page.evaluate(() => Object.fromEntries(
    performance.getEntriesByType('paint').map(entry => [entry.name, Number(entry.startTime.toFixed(1))]),
  ));
  currentPhase = 'warmReload';
  const reloadStarted = performance.now();
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 });
  await waitForSignIn();
  const warmReloadMs = performance.now() - reloadStarted;
  const warmReloadPaintTimings = await page.evaluate(() => Object.fromEntries(
    performance.getEntriesByType('paint').map(entry => [entry.name, Number(entry.startTime.toFixed(1))]),
  ));

  const report = {
    version: appInfo.version,
    platform: appInfo.platform,
    securityAndVisibility: {
      appReady: appInfo.appReady,
      sandbox: appInfo.sandbox,
      sandboxSetting: appInfo.sandboxSetting,
      contextIsolation: appInfo.contextIsolation,
      nodeIntegration: appInfo.nodeIntegration,
      backgroundThrottling: appInfo.backgroundThrottling,
      playwrightBrowserBehaviorSwitches: appInfo.browserBehaviorSwitches,
    },
    hiddenMethod: 'BrowserWindow.hide() and BrowserWindow.show(); no minimize fallback',
    readiness: {
      criterion: 'Sign in text present; no authentication performed',
      signInReadyMs: Number(signInReadyMs.toFixed(1)),
      warmReloadMs: Number(warmReloadMs.toFixed(1)),
      initialPaintTimingsMs: initialPaintTimings,
      warmReloadPaintTimingsMs: warmReloadPaintTimings,
    },
    visibilityProbe: {
      initialWindows,
      hiddenObserved,
      hideCallState,
      hideAfter1s,
      hiddenEndState,
      showCallState,
      showAfter1s,
      focusCallState,
      focusAfter1s,
      restoredObserved,
      restoredState,
    },
    phases: { visible, hidden, restored },
    focusVisibilityEvents,
    networkAggregates: summarizeNetwork(),
    limits: [
      'One unauthenticated profile and one run; this is a diagnostic sample, not a benchmark distribution.',
      'No login, model request, request path/query, request/response body, or process ID is recorded.',
      'Request duration is measured only through response headers; failed requests are counted without details.',
      'Memory reports process working set and /proc PSS when readable; neither is a GPU-memory measurement.',
      'CPU and process memory come from Electron app.getAppMetrics; the external Droid daemon is excluded.',
      'The sign-in screen does not exercise authenticated billing polling or chat streaming.',
      'The native hide/show focus probe runs without a CDP debugger session; CDP is attached only for visible/restored sampling.',
      'A hidden phase is omitted when document.visibilityState does not reach hidden after BrowserWindow.hide(); when present, its Electron process sample has no CDP renderer metrics.',
    ],
  };
  console.log(JSON.stringify(report));
} finally {
  if (app) {
    try {
      if (cdp) await cdp.detach();
    } catch {}
    try {
      let closeTimer;
      try {
        await Promise.race([
          app.close(),
          new Promise((_, reject) => {
            closeTimer = setTimeout(() => reject(new Error('Electron close timed out')), 5000);
          }),
        ]);
      } finally {
        clearTimeout(closeTimer);
      }
    } catch {
      try { app.process()?.kill('SIGKILL'); } catch {}
    }
  }
  await rm(home, { recursive: true, force: true });
}
