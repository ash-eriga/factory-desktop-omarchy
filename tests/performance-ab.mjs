// Controlled A/B for the real billing polling hook in the packaged renderer.
// The app bundle is cloned and instrumented in a temporary directory; source
// ASARs, installed app state, credentials, and the keyring are never modified.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename,
  rm, symlink, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { rendererChanges } from '../tools/patches.mjs';

const require = createRequire(import.meta.url);
const asar = require('@electron/asar');
const { _electron } = await import(process.env.FACTORY_PLAYWRIGHT_MODULE || 'playwright');
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const versions = JSON.parse(await readFile(path.join(ROOT, 'versions.json'), 'utf8'));
const CHECKPOINT = path.join(ROOT, 'build', `performance-ab-checkpoint-${versions.desktop}.json`);
const API_ORIGIN = 'https://api.factory.ai';
const BILLING_PATH = '/api/billing/limits';
const BILLING_FIXTURE = {
  limits: {
    standard: { fiveHour: { usedPercent: 42.5, windowEnd: '2026-10-11T16:00:00Z', secondsRemaining: 3600 } },
    core: null,
  },
  extraUsageBalanceCents: 4500,
  extraUsageAllowed: true,
};
const BILLING_JSON = JSON.stringify(BILLING_FIXTURE);
const [PATCH_NAME, BASELINE_HOOK, CANDIDATE_HOOK] = rendererChanges[0];
const ASSET_SUFFIX = `/${versions.renderer}`;
const CLONE_INJECTION = String.raw`
function factoryLinuxAbTestAirgap(){return false}
function factoryLinuxAbTestTo(config,options){
  if(config.endpoint!=="/api/billing/limits")throw new Error("Unexpected billing probe endpoint");
  window.__factoryBillingAbOptions={
    enabled:config.enabled,
    refetchInterval:options.refetchInterval,
    refetchIntervalInBackground:options.refetchIntervalInBackground,
    refetchOnWindowFocus:options.refetchOnWindowFocus,
    retry:options.retry
  };
  (window.__factoryBillingAbOptionsHistory ||= []).push({
    ...window.__factoryBillingAbOptions,
    phase:window.__factoryBillingAbPhase||"unknown",
    atMs:Number(performance.now().toFixed(1))
  });
  return Oa({...options,enabled:config.enabled,queryKey:config.queryKey,queryFn:async()=>{
    const response=await fetch("https://api.factory.ai"+config.endpoint,{
      method:config.method||"GET",credentials:"omit",cache:"no-store",
      headers:{Accept:"application/json"}
    });
    if(!response.ok)throw new Error("Billing fixture request failed");
    return response.json();
  }});
}
function FactoryLinuxBillingAbProbe(){
  const query=Sit();
  window.__factoryBillingAbState={
    status:query.status,isFetching:query.isFetching,dataUpdatedAt:query.dataUpdatedAt
  };
  return null;
}
if(window.__factoryBillingAbTest===true){
  window.__factoryBillingAbEvents=[{
    event:"initial",hasFocus:document.hasFocus(),visibility:document.visibilityState,
    phase:window.__factoryBillingAbPhase||"boot",atMs:Number(performance.now().toFixed(1))
  }];
  const record=event=>window.__factoryBillingAbEvents.push({
    event:event.type,hasFocus:document.hasFocus(),visibility:document.visibilityState,
    phase:window.__factoryBillingAbPhase||"unknown",atMs:Number(performance.now().toFixed(1))
  });
  window.addEventListener("focus",record);
  window.addEventListener("blur",record);
  document.addEventListener("visibilitychange",record);
  const host=document.createElement("div");
  host.id="factory-billing-ab-probe";
  document.body.appendChild(host);
  const client=new Wqs();
  hGo.createRoot(host).render(c.jsx(Vqs,{client,children:c.jsx(FactoryLinuxBillingAbProbe,{})}));
  window.__factoryBillingAbMounted=true;
}
`;

function usage() {
  return 'Usage: node tests/performance-ab.mjs <baseline-bundle> <candidate-bundle> [--pilot]';
}

const args = process.argv.slice(2);
const positional = args.filter(value => !value.startsWith('--'));
if (positional.length !== 2) throw new Error(usage());
const pilot = args.includes('--pilot');
const sources = {
  baseline: path.resolve(positional[0]),
  candidate: path.resolve(positional[1]),
};
for (const [label, source] of Object.entries(sources)) {
  const sourceReal = await realpath(source);
  const relative = path.relative(ROOT, sourceReal);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} bundle must be a disposable project build under ${ROOT}`);
  }
  sources[label] = sourceReal;
}

const durations = pilot
  ? { foreground: 5, unfocused: 1, restored: 1 }
  : { foreground: 25, unfocused: 65, restored: 5 };
const sampleOrder = pilot
  ? ['candidate']
  : ['baseline', 'candidate', 'candidate', 'baseline'];
const work = await mkdtemp(path.join(tmpdir(), 'factory-billing-ab-'));
const sourceHashes = {};
const instrumented = {};
const clonePaths = {};
const runs = [];

async function hashFile(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

function unpackRoots(archivePath) {
  const all = asar.listPackage(archivePath, { isPack: true })
    .map(line => /^unpack\s*:\s*\/(.+)$/.exec(line)?.[1])
    .filter(Boolean);
  const roots = [];
  for (const entry of all) {
    if (!roots.some(root => entry === root || entry.startsWith(`${root}/`))) {
      for (let i = roots.length - 1; i >= 0; i--) {
        if (roots[i].startsWith(`${entry}/`)) roots.splice(i, 1);
      }
      roots.push(entry);
    }
  }
  return roots;
}

async function makeCloneShell(source, clone) {
  await mkdir(clone, { recursive: true });
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(source, entry.name);
    const clonePath = path.join(clone, entry.name);
    if (entry.name === 'factory-desktop') {
      const sourceStat = await lstat(sourcePath);
      assert.equal(sourceStat.isSymbolicLink(), false, 'Source Electron executable must be a file');
      await copyFile(sourcePath, clonePath);
      await chmod(clonePath, sourceStat.mode & 0o7777);
      continue;
    }
    if (entry.name === 'resources') {
      await mkdir(clonePath, { recursive: true });
      for (const resource of await readdir(sourcePath, { withFileTypes: true })) {
        if (resource.name === 'app.asar' || resource.name === 'app.asar.unpacked') continue;
        const from = path.join(sourcePath, resource.name);
        const to = path.join(clonePath, resource.name);
        await symlink(from, to, resource.isDirectory() ? 'dir' : 'file');
      }
      continue;
    }
    await symlink(sourcePath, clonePath, entry.isDirectory() ? 'dir' : 'file');
  }
  const executableStat = await lstat(path.join(clone, 'factory-desktop'));
  assert.equal(executableStat.isFile(), true);
  assert.equal(executableStat.isSymbolicLink(), false, 'Clone executable must not resolve resources from the source bundle');
}

async function instrumentBundle(label) {
  const source = sources[label];
  const sourceArchive = path.join(source, 'resources', 'app.asar');
  const sourceExecutable = path.join(source, 'factory-desktop');
  const sourceAssetMatches = asar.listPackage(sourceArchive)
    .filter(entry => entry.endsWith(ASSET_SUFFIX));
  assert.equal(sourceAssetMatches.length, 1, `${label} renderer asset must be unique`);
  const sourceAssetEntry = sourceAssetMatches[0].replace(/^\/+/, '');
  const sourceAsset = asar.extractFile(sourceArchive, sourceAssetEntry);
  sourceHashes[label] = {
    archive: await hashFile(sourceArchive),
    executable: await hashFile(sourceExecutable),
    renderer: createHash('sha256').update(sourceAsset).digest('hex'),
  };

  const clone = path.join(work, label);
  await makeCloneShell(source, clone);
  const unpacked = path.join(work, `${label}-extract`);
  await mkdir(unpacked, { recursive: true });
  asar.extractAll(sourceArchive, unpacked);
  const clonedAssetPath = path.join(unpacked, sourceAssetEntry);
  const sourceText = await readFile(clonedAssetPath, 'utf8');
  const anchor = label === 'baseline' ? BASELINE_HOOK : CANDIDATE_HOOK;
  const occurrences = sourceText.split(anchor).length - 1;
  assert.equal(occurrences, 1, `${PATCH_NAME} source anchor for ${label} must occur exactly once`);
  const probeHook = anchor
    .replace('Fu()', 'factoryLinuxAbTestAirgap()')
    .replace('io(s,r)', 'factoryLinuxAbTestTo(s,r)');
  assert.notEqual(probeHook, anchor, 'Probe must replace only the auth gate and transport adapter');
  await writeFile(clonedAssetPath, sourceText.replace(anchor, probeHook) + CLONE_INJECTION);
  const instrumentedText = await readFile(clonedAssetPath, 'utf8');
  assert.equal(instrumentedText.split('function FactoryLinuxBillingAbProbe(){').length - 1, 1);
  const cloneArchive = path.join(clone, 'resources', 'app.asar');
  const dirs = unpackRoots(sourceArchive);
  assert.deepEqual(dirs, ['node_modules/keytar'], 'Unexpected ASAR unpack layout; refuse to repack');
  await asar.createPackageWithOptions(unpacked, cloneArchive, { unpackDir: dirs[0] });
  const repackedAsset = asar.extractFile(cloneArchive, sourceAssetEntry);
  instrumented[label] = {
    archiveHash: await hashFile(cloneArchive),
    rendererHash: createHash('sha256').update(repackedAsset).digest('hex'),
  };
  clonePaths[label] = clone;
  assert.notEqual(instrumented[label].rendererHash, sourceHashes[label].renderer);
  assert.equal(await hashFile(sourceArchive), sourceHashes[label].archive, 'Source ASAR changed during clone instrumentation');
  assert.equal(await hashFile(sourceExecutable), sourceHashes[label].executable, 'Source executable changed during clone instrumentation');
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function round(value, places = 2) {
  return Number(value.toFixed(places));
}

async function readPssKiB(pid) {
  try {
    const text = await readFile(`/proc/${pid}/smaps_rollup`, 'utf8');
    const match = /^Pss:\s+(\d+)\s+kB$/m.exec(text);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

async function sampleElectronMetrics(app) {
  return app.evaluate(({ app }) => ({
    sampledAt: performance.now(),
    processes: app.getAppMetrics().map(metric => ({
      pid: metric.pid,
      creationTime: metric.creationTime,
      type: metric.type,
      cpuSeconds: metric.cpu.cumulativeCPUUsage ?? null,
      workingSetKiB: metric.memory.workingSetSize ?? null,
    })),
  }));
}

async function withPss(sample) {
  return Promise.all(sample.processes.map(async process => ({
    ...process,
    pssKiB: await readPssKiB(process.pid),
  })));
}

function memoryByType(processes) {
  const groups = new Map();
  for (const process of processes) {
    let group = groups.get(process.type);
    if (!group) {
      group = { processes: 0, workingSetKiB: 0, pssKiB: 0, pssCount: 0 };
      groups.set(process.type, group);
    }
    group.processes++;
    if (Number.isFinite(process.workingSetKiB)) group.workingSetKiB += process.workingSetKiB;
    if (Number.isFinite(process.pssKiB)) {
      group.pssKiB += process.pssKiB;
      group.pssCount++;
    }
  }
  return Object.fromEntries([...groups].map(([type, group]) => [type, {
    processCount: group.processes,
    workingSetMiB: round(group.workingSetKiB / 1024, 1),
    pssMiB: group.pssCount ? round(group.pssKiB / 1024, 1) : null,
    pssProcessCount: group.pssCount,
  }]));
}

function cpuDeltaByType(before, after, elapsedSeconds) {
  const starts = new Map(before.map(process => [
    `${process.pid}:${process.creationTime}`, process,
  ]));
  const groups = new Map();
  let unmatchedNewProcessCount = 0;
  let matchedProcessCount = 0;
  for (const process of after) {
    if (!Number.isFinite(process.cpuSeconds)) continue;
    const prior = starts.get(`${process.pid}:${process.creationTime}`);
    if (!prior || !Number.isFinite(prior.cpuSeconds)) {
      unmatchedNewProcessCount++;
      continue;
    }
    matchedProcessCount++;
    const delta = Math.max(0, process.cpuSeconds - prior.cpuSeconds);
    const group = groups.get(process.type) ?? { cpuSeconds: 0, processCount: 0 };
    group.cpuSeconds += delta;
    group.processCount++;
    groups.set(process.type, group);
  }
  return {
    matchedProcessCount,
    unmatchedNewProcessCount,
    byProcessType: Object.fromEntries([...groups].map(([type, group]) => [type, {
      cpuSeconds: round(group.cpuSeconds, 3),
      oneCorePercent: elapsedSeconds > 0
        ? round(group.cpuSeconds / elapsedSeconds * 100) : null,
      processCountAtEnd: group.processCount,
    }])),
  };
}

async function samplePhase({ app, page, setPhase, phase, seconds }) {
  await setPhase(phase);
  const before = await sampleElectronMetrics(app);
  const beforePss = await withPss(before);
  await delay(seconds * 1000);
  const after = await sampleElectronMetrics(app);
  const afterPss = await withPss(after);
  const elapsedSeconds = Math.max(0.001, (after.sampledAt - before.sampledAt) / 1000);
  return {
    requestedSeconds: seconds,
    elapsedSeconds: round(elapsedSeconds),
    cpuByProcessType: cpuDeltaByType(before.processes, after.processes, elapsedSeconds),
    memoryStartByProcessType: memoryByType(beforePss),
    memoryEndByProcessType: memoryByType(afterPss),
    fixtureRequestStarts: null,
    rendererMetrics: null,
  };
}

function countsByPhase(counts) {
  return Object.fromEntries(Object.entries(counts).map(([phase, count]) => [phase, count]));
}

async function waitForPagePredicate(page, expression, timeout = 5000) {
  await page.waitForFunction(expression, null, { timeout, polling: 100 });
}

async function pollUntil(readValue, predicate, timeoutMs = 5000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const value = await readValue();
    if (predicate(value)) return value;
    await delay(100);
  }
  throw new Error('Timed out waiting for renderer state');
}

async function runOne(label, { pilot = false } = {}) {
  const bundle = clonePaths[label];
  const home = await mkdtemp(path.join(work, `home-${label}-`));
  const xdg = path.join(home, 'xdg');
  const env = {
    PATH: process.env.PATH || '/usr/bin:/bin',
    HOME: home,
    TMPDIR: tmpdir(),
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
  const requestCounts = {};
  const nonGetFixtureCounts = {};
  const blockedHttpCounts = {};
  let activePhase = 'warmup';
  let app;
  let page;
  let browserWindow;
  let cdp;
  const invalidReasons = [];
  const phaseValidity = {
    warmup: null,
    foreground: null,
    unfocused: null,
    restored: null,
  };
  const phaseInvalidReasons = {
    warmup: [],
    foreground: [],
    unfocused: [],
    restored: [],
  };
  const invalidatePhase = (phase, reason) => {
    phaseValidity[phase] = false;
    if (!phaseInvalidReasons[phase].includes(reason)) phaseInvalidReasons[phase].push(reason);
  };
  const markPhaseValid = phase => {
    if (phaseValidity[phase] === null) phaseValidity[phase] = true;
  };
  let requestRouteReady = false;
  let appInfo;
  let windowInfo;
  let hookOptions;
  let phases = {};
  let focusEvents = [];
  let initialState;
  let hiddenState;
  let restoredState;
  let hiddenObserved = false;
  let restoredObserved = false;
  let focusFallbackUsed = false;
  const progress = (event, phase = undefined, extra = {}) => {
    process.stderr.write(`${JSON.stringify({ event, run: label, ...(phase ? { phase } : {}), ...extra })}\n`);
  };
  const capturePhase = async (phase, seconds) => {
    progress('phase-start', phase, { seconds });
    const sample = await samplePhase({ app, page, setPhase, phase, seconds });
    sample.fixtureRequestStarts = requestCounts[phase] || 0;
    sample.blockedHttpStarts = blockedHttpCounts[phase] || 0;
    progress('phase-end', phase, {
      fixtureGetStarts: sample.fixtureRequestStarts,
      blockedHttpStarts: sample.blockedHttpStarts,
    });
    return sample;
  };

  const setPhase = async phase => {
    activePhase = phase;
    if (browserWindow) await browserWindow.evaluate((win, value) =>
      win.webContents.executeJavaScript(`window.__factoryBillingAbPhase=${JSON.stringify(value)}`), phase);
  };
  const readRendererState = async () => {
    const serialized = await browserWindow.evaluate(win => win.webContents.executeJavaScript(
      `JSON.stringify({focused:document.hasFocus(),visibility:document.visibilityState,options:window.__factoryBillingAbOptions,optionsHistory:window.__factoryBillingAbOptionsHistory||[],query:window.__factoryBillingAbState,events:window.__factoryBillingAbEvents||[]})`,
    ));
    return JSON.parse(serialized);
  };

  try {
    progress('run-start');
    await mkdir(path.join(home, 'tmp'));
    app = await _electron.launch({
      executablePath: path.join(bundle, 'factory-desktop'),
      args: [
        `--user-data-dir=${path.join(home, 'user-data')}`,
        '--proxy-server=http://127.0.0.1:9',
        '--disable-background-networking',
      ],
      env,
      chromiumSandbox: true,
      timeout: 60000,
    });
    page = await app.firstWindow({ timeout: 60000 });
    browserWindow = await app.browserWindow(page);
    await page.route('**/*', async route => {
      const rawUrl = route.request().url();
      if (!rawUrl.startsWith('http://') && !rawUrl.startsWith('https://')) {
        await route.continue();
        return;
      }
      let url;
      try { url = new URL(rawUrl); }
      catch {
        blockedHttpCounts[activePhase] = (blockedHttpCounts[activePhase] || 0) + 1;
        await route.abort('blockedbyclient');
        return;
      }
      if (url.origin === API_ORIGIN && url.pathname === BILLING_PATH) {
        const method = route.request().method();
        if (method === 'GET') {
          requestCounts[activePhase] = (requestCounts[activePhase] || 0) + 1;
        } else {
          nonGetFixtureCounts[activePhase] = (nonGetFixtureCounts[activePhase] || 0) + 1;
        }
        await route.fulfill({
          status: method === 'OPTIONS' ? 204 : method === 'GET' ? 200 : 405,
          headers: {
            'access-control-allow-origin': '*',
            'access-control-allow-methods': 'GET, OPTIONS',
            'access-control-allow-headers': 'accept, content-type',
            'content-type': 'application/json',
            'cache-control': 'no-store',
          },
          body: method === 'GET' ? BILLING_JSON : '',
        });
        return;
      }
      blockedHttpCounts[activePhase] = (blockedHttpCounts[activePhase] || 0) + 1;
      await route.abort('blockedbyclient');
    });
    requestRouteReady = true;
    await page.addInitScript(() => {
      window.__factoryBillingAbTest = true;
      window.__factoryBillingAbPhase = 'warmup';
    });
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 });
    await waitForPagePredicate(page,
      () => window.__factoryBillingAbMounted === true && window.__factoryBillingAbState?.status === 'success',
      30000);
    progress('warmup-ready', 'warmup', { fixtureGetStarts: requestCounts.warmup || 0 });
    if (requestCounts.warmup === 1) markPhaseValid('warmup');
    else invalidatePhase('warmup', `unexpected-fixture-get-count-${requestCounts.warmup || 0}-expected-1`);

    appInfo = await app.evaluate(({ app }, expectedHome) => ({
      version: app.getVersion(),
      platform: process.platform,
      appReady: app.isReady(),
      noSandbox: app.commandLine.hasSwitch('no-sandbox'),
      executableInsideClone: process.execPath.includes('/factory-billing-ab-'),
      resourcesInsideClone: process.resourcesPath.includes('/factory-billing-ab-'),
      appPathInsideClone: app.getAppPath().includes('/factory-billing-ab-'),
      userDataIsTemp: app.getPath('userData').startsWith(expectedHome + '/'),
    }), home);
    windowInfo = await browserWindow.evaluate(win => {
      const prefs = win.webContents.getLastWebPreferences();
      return {
        visible: win.isVisible(),
        minimized: win.isMinimized(),
        sandbox: prefs.sandbox === true,
        contextIsolation: prefs.contextIsolation !== false,
        nodeIntegration: prefs.nodeIntegration === true,
        backgroundThrottling: win.webContents.getBackgroundThrottling(),
      };
    });
    assert.equal(appInfo.platform, 'linux');
    assert.equal(appInfo.appReady, true);
    assert.equal(appInfo.noSandbox, false);
    assert.equal(appInfo.executableInsideClone, true);
    assert.equal(appInfo.resourcesInsideClone, true);
    assert.equal(appInfo.appPathInsideClone, true);
    assert.equal(appInfo.userDataIsTemp, true);
    assert.equal(windowInfo.sandbox, true);
    assert.equal(windowInfo.contextIsolation, true);
    assert.equal(windowInfo.nodeIntegration, false);
    assert.equal(windowInfo.backgroundThrottling, true);
    assert.equal(requestRouteReady, true);
    assert.equal(await page.evaluate(() => window.__factoryBillingAbMounted), true);
    cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
    await cdp.detach();
    cdp = null;
    initialState = await readRendererState();
    hookOptions = initialState.options;
    if (hookOptions?.refetchInterval !== 20_000) {
      invalidatePhase('unfocused', 'billing-query-interval-was-not-20000ms');
    }
    if (hookOptions?.refetchIntervalInBackground !== (label === 'baseline')) {
      invalidatePhase('unfocused', `${label}-background-poll-policy-was-unexpected`);
    }
    if (label === 'candidate' && hookOptions?.refetchOnWindowFocus !== true) {
      invalidatePhase('restored', 'candidate-focus-refetch-policy-was-not-preserved');
    }
    if (hookOptions?.retry !== false) {
      invalidatePhase('warmup', 'billing-query-retry-policy-was-not-preserved');
    }
    assert.equal(initialState.query.status, 'success');
    const expectedInitiallyEnabled = label === 'baseline' || initialState.focused;
    if (initialState.focused && hookOptions.enabled === expectedInitiallyEnabled) markPhaseValid('foreground');
    else invalidatePhase('foreground', 'renderer-did-not-start-focused-with-query-enabled');

    const foreground = await capturePhase('foreground', durations.foreground);
    phases.foreground = foreground;
    const afterForeground = await readRendererState();
    if (!afterForeground.focused || afterForeground.events.some(event =>
      event.phase === 'foreground' && event.event === 'blur')) {
      invalidatePhase('foreground', 'focus-lost-during-foreground');
    } else markPhaseValid('foreground');

    await setPhase('hide-transition');
    await browserWindow.evaluate(win => win.hide());
    try {
      await pollUntil(readRendererState, state => state.focused === false);
      hiddenObserved = true;
    } catch {
      invalidatePhase('unfocused', 'hide-did-not-blur-renderer');
    }
    if (label === 'candidate' && hiddenObserved) {
      try {
        await pollUntil(readRendererState, state => state.options?.enabled === false);
      } catch {
        invalidatePhase('unfocused', 'candidate-query-did-not-disable-on-blur');
      }
    }
    hiddenState = await readRendererState();
    const expectedUnfocusedEnabled = label === 'baseline';
    if (hiddenObserved && hiddenState.focused === false
      && hiddenState.options?.enabled === expectedUnfocusedEnabled) {
      markPhaseValid('unfocused');
    } else if (hiddenObserved && hiddenState.options?.enabled !== expectedUnfocusedEnabled) {
      invalidatePhase('unfocused', `${label}-query-enabled-policy-wrong-at-phase-start`);
    }
    if (hiddenObserved) {
      phases.unfocused = await capturePhase('unfocused', durations.unfocused);
      const unfocusedEndState = await readRendererState();
      const unfocusedFocusEvents = unfocusedEndState.events.filter(event =>
        event.phase === 'unfocused' && (event.event === 'focus' || event.event === 'blur'));
      const unfocusedPolicyEvents = (unfocusedEndState.optionsHistory || []).filter(event =>
        event.phase === 'unfocused');
      if (unfocusedEndState.focused !== false) {
        invalidatePhase('unfocused', 'renderer-was-focused-at-phase-end');
      }
      if (unfocusedFocusEvents.length > 0) {
        invalidatePhase('unfocused', 'renderer-focus-or-blur-event-during-unfocused-phase');
      }
      if (unfocusedEndState.options?.enabled !== expectedUnfocusedEnabled
        || unfocusedPolicyEvents.some(event => event.enabled !== expectedUnfocusedEnabled)) {
        invalidatePhase('unfocused', `${label}-query-enabled-policy-changed-during-unfocused-phase`);
      }
    }

    const preRestoreRequestCount = requestCounts.restored || 0;
    const preRestoreDataUpdatedAt = (await readRendererState()).query?.dataUpdatedAt ?? 0;
    await setPhase('restored');
    await browserWindow.evaluate(win => win.show());
    try {
      await pollUntil(readRendererState, state => state.focused === true);
      restoredObserved = true;
    } catch {}
    if (!restoredObserved) {
      focusFallbackUsed = true;
      await browserWindow.evaluate(win => win.focus());
      try {
        await pollUntil(readRendererState, state => state.focused === true);
        restoredObserved = true;
      } catch {}
    }
    if (!restoredObserved) {
      invalidatePhase('restored', 'show-and-focus-did-not-focus-renderer');
    } else if (!focusFallbackUsed) {
      markPhaseValid('restored');
    } else {
      invalidatePhase('restored', 'restore-required-programmatic-focus-fallback');
    }
    if (restoredObserved && label === 'candidate') {
      try {
        await pollUntil(readRendererState, state => (requestCounts.restored || 0) > preRestoreRequestCount
          && state.query?.dataUpdatedAt > preRestoreDataUpdatedAt
          && state.query?.status === 'success' && state.query?.isFetching === false);
      } catch {
        invalidatePhase('restored', 'candidate-query-did-not-settle-after-focus');
      }
    }
    restoredState = await readRendererState();
    if (restoredObserved) {
      phases.restored = await capturePhase('restored', durations.restored);
    }
    const restoredEndState = await readRendererState();
    focusEvents = restoredEndState.events;
    const restoreFocusEvents = focusEvents.filter(event =>
      event.phase === 'restored' && (event.event === 'focus' || event.event === 'blur'));
    if (restoredObserved && (restoredEndState.focused !== true
      || restoreFocusEvents.filter(event => event.event === 'focus').length !== 1
      || restoreFocusEvents.some(event => event.event === 'blur'))) {
      invalidatePhase('restored', 'renderer-focus-oscillated-or-was-unstable-after-restore');
    }
    for (const [phase, sample] of Object.entries(phases)) {
      sample.fixtureRequestStarts = requestCounts[phase] || 0;
      sample.blockedHttpStarts = blockedHttpCounts[phase] || 0;
    }
    if (!pilot) {
      const expectCount = (phase, expected) => {
        const actual = requestCounts[phase] || 0;
        if (actual !== expected) {
          invalidatePhase(phase, `unexpected-fixture-get-count-${actual}-expected-${expected}`);
        }
      };
      expectCount('warmup', 1);
      expectCount('foreground', 1);
      if (label === 'baseline') expectCount('unfocused', 3);
      if (label === 'candidate') {
        expectCount('unfocused', 0);
        expectCount('restored', 1);
      }
    }
    for (const phase of Object.keys(phaseValidity)) {
      if (phaseValidity[phase] === null) invalidatePhase(phase, 'phase-not-measured');
      invalidReasons.push(...phaseInvalidReasons[phase].map(reason => `${phase}:${reason}`));
    }
    const valid = Object.values(phaseValidity).every(value => value === true);
    const primaryValid = phaseValidity.warmup === true && phaseValidity.unfocused === true;
    return {
      label,
      valid,
      primaryValid,
      phaseValidity,
      phaseInvalidReasons,
      invalidReasons,
      app: {
        version: appInfo.version,
        platform: appInfo.platform,
        sandbox: windowInfo.sandbox,
        contextIsolation: windowInfo.contextIsolation,
        nodeIntegration: windowInfo.nodeIntegration,
        backgroundThrottling: windowInfo.backgroundThrottling,
        cloneExecutableAndResources: appInfo.executableInsideClone && appInfo.resourcesInsideClone && appInfo.appPathInsideClone,
        tempUserData: appInfo.userDataIsTemp,
        testRouteInstalledBeforeInstrumentedReload: requestRouteReady,
      },
      durationsSeconds: durations,
      hookOptionsAtStart: hookOptions,
      initialState,
      hiddenState,
      restoredState,
      preRestoreDataUpdatedAt,
      hiddenObserved,
      restoredObserved,
      phases,
      requestStartsByPhase: countsByPhase(requestCounts),
      nonGetFixtureStartsByPhase: countsByPhase(nonGetFixtureCounts),
      blockedHttpStartsByPhase: countsByPhase(blockedHttpCounts),
      focusEvents,
      focusFallbackUsed,
      limits: [
        'Controlled integration: real Sit hook, React/compiler runtime, useQuery, QueryClientProvider, and QueryClient from each packaged renderer.',
        'The isolated test adapter replaces only Fu() with false and io(s,r) transport with a credential-free local fixture query; polling and focus policy remain the original hook options.',
        'Only /api/billing/limits is fulfilled by Playwright with a fixed local JSON fixture; other HTTP(S) requests are aborted, and Chromium has a dead local proxy as startup fail-safe.',
        'Each run uses a temporary HOME/profile and FACTORY_DISABLE_KEYRING=1; no login, real API credentials, model request, or user app profile is used.',
        'CPU and memory report Electron app.getAppMetrics process aggregates; external Droid daemon is excluded.',
        'Request counts are recorded when the fake endpoint request starts; URLs, paths, query strings, headers, bodies, and process IDs are never emitted.',
      ],
    };
  } finally {
    if (app) {
      try { if (cdp) await cdp.detach(); } catch {}
      try {
        await browserWindow?.evaluate(win => win.show());
      } catch {}
      try {
        await Promise.race([app.close(), delay(5000).then(() => { throw new Error('Electron close timed out'); })]);
      } catch {
        const child = app.process();
        if (child && child.exitCode === null && child.signalCode === null) {
          const exited = once(child, 'exit');
          try { child.kill('SIGTERM'); } catch {}
          const ended = await Promise.race([exited.then(() => true), delay(1500).then(() => false)]);
          if (!ended) {
            try { child.kill('SIGKILL'); } catch {}
            await Promise.race([exited, delay(2500)]);
          }
        }
        assert.ok(!child || child.exitCode !== null || child.signalCode !== null,
          'Electron process did not exit after cleanup');
      }
    }
    await rm(home, { recursive: true, force: true });
  }
}

function metricDelta(candidate, baseline, selector) {
  const c = selector(candidate), b = selector(baseline);
  return Number.isFinite(c) && Number.isFinite(b) ? round(c - b) : null;
}

function pairDelta(baseline, candidate) {
  const phases = {};
  for (const phase of ['foreground', 'unfocused', 'restored']) {
    const b = baseline.phases[phase], c = candidate.phases[phase];
    const baselineValid = baseline.phaseValidity?.[phase] === true;
    const candidateValid = candidate.phaseValidity?.[phase] === true;
    if (!b || !c || !baselineValid || !candidateValid) {
      phases[phase] = {
        valid: false,
        baselinePhaseValid: baselineValid,
        candidatePhaseValid: candidateValid,
        baselineReasons: baseline.phaseInvalidReasons?.[phase] || [],
        candidateReasons: candidate.phaseInvalidReasons?.[phase] || [],
      };
      continue;
    }
    const cpuTypes = new Set([
      ...Object.keys(b.cpuByProcessType.byProcessType),
      ...Object.keys(c.cpuByProcessType.byProcessType),
    ]);
    const pssTypes = new Set([
      ...Object.keys(b.memoryEndByProcessType), ...Object.keys(c.memoryEndByProcessType),
    ]);
    phases[phase] = {
      valid: true,
      baselinePhaseValid: true,
      candidatePhaseValid: true,
      fixtureRequestStartsCandidateMinusBaseline: c.fixtureRequestStarts - b.fixtureRequestStarts,
      electronOneCorePercentCandidateMinusBaseline: Object.fromEntries([...cpuTypes].map(type => [
        type,
        metricDelta(c, b, run => run.cpuByProcessType.byProcessType[type]?.oneCorePercent),
      ])),
      electronEndPssMiBCandidateMinusBaseline: Object.fromEntries([...pssTypes].map(type => [
        type,
        metricDelta(c, b, run => run.memoryEndByProcessType[type]?.pssMiB),
      ])),
    };
  }
  return { baselineRun: baseline.label, candidateRun: candidate.label, phases };
}

try {
  for (const label of pilot ? ['candidate'] : ['baseline', 'candidate']) {
    await instrumentBundle(label);
  }
  const order = sampleOrder;
  for (const label of order) {
    const run = await runOne(label, { pilot });
    runs.push(run);
    const checkpoint = JSON.stringify({
      mode: pilot ? 'pilot' : 'ABBA',
      sourceHashes,
      instrumentedCloneHashes: instrumented,
      completedRuns: runs,
    }, null, 2);
    const checkpointTemp = `${CHECKPOINT}.tmp`;
    await writeFile(checkpointTemp, checkpoint);
    await rename(checkpointTemp, CHECKPOINT);
    process.stderr.write(`${JSON.stringify({ event: 'checkpoint-saved', run: label, completedRuns: runs.length })}\n`);
  }
  const sourceHashesAfter = {};
  for (const label of pilot ? ['candidate'] : ['baseline', 'candidate']) {
    const archive = path.join(sources[label], 'resources', 'app.asar');
    sourceHashesAfter[label] = await hashFile(archive);
    assert.equal(sourceHashesAfter[label], sourceHashes[label].archive, `${label} source ASAR changed`);
  }

  const output = {
    mode: pilot ? 'pilot' : 'ABBA',
    order,
    durationsSeconds: durations,
    sourceHashes: Object.fromEntries(Object.entries(sourceHashes).map(([label, hashes]) => [label, hashes])),
    instrumentedCloneHashes: instrumented,
    sourceAsarHashesUnchanged: Object.fromEntries(Object.keys(sourceHashesAfter).map(label => [
      label, sourceHashesAfter[label] === sourceHashes[label].archive,
    ])),
    runs,
    pairedDeltas: pilot ? [] : [
      pairDelta(runs[0], runs[1]),
      pairDelta(runs[3], runs[2]),
    ],
    interpretationLimits: [
      'The A/B controls the billing polling hook and TanStack query execution; it does not test authenticated chat, first-token latency, or production billing credentials.',
      'A single ABBA sequence is a local diagnostic sample; CPU and PSS variation can reflect unrelated desktop load.',
      'The test adapter changes only the auth/airgap gate and transport boundary required to run without credentials; its fixture body and response behavior are identical across versions.',
      'Validity is phase-specific: CPU and PSS deltas are emitted only when both paired phases passed their checks. Focus instability in foreground or restoration does not discard an independently valid unfocused phase; it remains recorded as invalid for that phase and in the run summary.',
      'The primary idle result requires a valid warmup and an unfocused phase that started and ended with document.hasFocus() false, had no focus/blur events, retained the expected query enabled policy throughout, and produced the expected poll count.',
    ],
  };
  if (runs.some(run => !run.primaryValid)) process.exitCode = 2;
  console.log(JSON.stringify(output));
} finally {
  await rm(work, { recursive: true, force: true });
}
