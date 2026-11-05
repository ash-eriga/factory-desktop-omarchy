// Baseline runtime measurement for the port bundle.
//
// Contract: N fresh-process runs of the signed-out app (launched through
// Playwright like tests/gui-smoke.mjs), whole spawned process tree summed
// from /proc, RSS and PSS reported as median and range (PSS null when the
// tree could not be read, never a fake 0), CPU as a delta of cumulative
// per-pid counters over the MEASURED first-to-last-sweep span in percent
// of one core, startup measured separately, raw samples plus bundle/git
// identifiers saved next to the summary. No authenticated profile,
// credential, or network request: temp HOME, dead-end proxy, keyring off.
//
// Usage (headless host: wrap in xvfb-run so every run sees the same screen):
//   FACTORY_PLAYWRIGHT_MODULE=/path/to/pw-esm.mjs \
//     node benchmarks/measure-runtime.mjs dist/factory-droid-desktop-1.3.0 \
//       build/baseline-standin --runs 5 --idle-seconds 30
//
// Artifacts: samples.csv, summary.json, run-1.png. It measures; it never
// changes the bundle.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { readFileSync as readFsFileSync, readdirSync as readFsDirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import {
  cpuPercentOfOneCore, parseProcStat, pssEntry,
  seedCounters, sweepCpuDeltaMs, treeRollup,
} from './stats.mjs';

const { _electron } = await import(process.env.FACTORY_PLAYWRIGHT_MODULE || 'playwright');

function readNumber(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} needs a positive number`);
  return value;
}

const positional = process.argv.slice(2).filter(v => !v.startsWith('--'));
if (positional.length < 2) {
  console.error('Usage: node benchmarks/measure-runtime.mjs <bundle> <output> '
    + '[--runs 5] [--idle-seconds 30] [--settle-seconds 8] [--sample-seconds 1] '
    + '[--ozone-platform=x11|wayland]');
  process.exit(1);
}
const bundle = path.resolve(positional[0]);
const output = path.resolve(positional[1]);
const runs = readNumber('--runs', 5);
const idleSeconds = readNumber('--idle-seconds', 30);
const settleSeconds = readNumber('--settle-seconds', 8);
const sampleSeconds = readNumber('--sample-seconds', 1);
// Explicit render-backend selection. Recorded as REQUESTED plus the
// environment evidence; the helper never guesses what the compositor and
// the app finally negotiated.
const ozoneIndex = process.argv.indexOf('--ozone-platform');
const ozoneRequested = ozoneIndex >= 0 ? process.argv[ozoneIndex + 1] : null;

// Clock tick and page size straight from the running kernel, never assumed
// (utime/stime are in ticks, rss in statm is in pages).
const clockTicks = Number(execFileSync('getconf', ['CLK_TCK']).toString().trim());
const pageBytes = Number(execFileSync('getconf', ['PAGESIZE']).toString().trim());

if (!process.env.DISPLAY) {
  console.error('No DISPLAY: wrap the invocation in xvfb-run (headless) '
    + 'or run on a desktop (real target).');
  process.exit(1);
}

function childPids(root) {
  const parents = new Map();
  for (const entry of readFsDirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFsFileSync(`/proc/${entry}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(') ') + 2).split(' ');
      parents.set(Number(entry), Number(fields[1]));
    } catch { continue; }
  }
  const tree = new Set();
  const frontier = [root];
  while (frontier.length) {
    const pid = frontier.pop();
    if (tree.has(pid)) continue;
    tree.add(pid);
    for (const [child, parent] of parents) if (parent === pid) frontier.push(child);
  }
  return tree;
}

// One sweep of the tree: per-process ProcessSample rows plus a rollup.
// Each row carries { pid, starttime, cpu_ms, rss_kb, pss } where pss is
// { kind: 'available', kb } or { kind: 'unavailable', reason } with the
// kernel's own reason; RSS comes from stat in pages times the real page
// size. A pid that died between childPids and its stat read is simply
// absent: no fabricated values.
function sampleTree(pids) {
  const samples = [];
  for (const pid of pids) {
    let parsed;
    try {
      parsed = parseProcStat(readFsFileSync(`/proc/${pid}/stat`, 'utf8'), pageBytes, clockTicks);
    } catch { continue; }
    if (!parsed) continue;
    try {
      parsed.pss = pssEntry(readFsFileSync(`/proc/${pid}/smaps_rollup`, 'utf8'));
    } catch (error) {
      parsed.pss = pssEntry(undefined, error);
    }
    samples.push(parsed);
  }
  return { samples, rollup: treeRollup(samples) };
}

function safeEnvironment(home) {
  const env = {
    PATH: process.env.PATH || '/usr/bin:/bin',
    HOME: home,
    TMPDIR: path.join(home, 'tmp'),
    XDG_CONFIG_HOME: path.join(home, 'config'),
    XDG_DATA_HOME: path.join(home, 'data'),
    XDG_CACHE_HOME: path.join(home, 'cache'),
    XDG_STATE_HOME: path.join(home, 'state'),
    FACTORY_HOME_OVERRIDE: path.join(home, 'factory-home'),
    FACTORY_ENV: 'production',
    FACTORY_RELEASE_CHANNEL: 'production',
    FACTORY_DEPLOYMENT_ENV: 'production',
    FACTORY_DISABLE_KEYRING: '1',
    DISPLAY: process.env.DISPLAY,
    HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9',
    ALL_PROXY: 'http://127.0.0.1:9',
    http_proxy: 'http://127.0.0.1:9', https_proxy: 'http://127.0.0.1:9',
    all_proxy: 'http://127.0.0.1:9',
  };
  for (const key of ['LANG', 'LC_ALL', 'ELECTRON_OZONE_PLATFORM_HINT',
    'XAUTHORITY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'XDG_SESSION_TYPE',
    'DBUS_SESSION_BUS_ADDRESS']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

async function runOnce(runIndex) {
  const home = await mkdtemp(path.join(tmpdir(), 'factory-baseline-'));
  const started = performance.now();
  let app;
  try {
    app = await _electron.launch({
      executablePath: path.join(bundle, 'factory-desktop'),
      args: [
        `--user-data-dir=${path.join(home, 'user-data')}`,
        ...(ozoneRequested ? [`--ozone-platform=${ozoneRequested}`] : []),
      ],
      env: safeEnvironment(home),
      chromiumSandbox: true, timeout: 60000,
    });
    const page = await app.firstWindow({ timeout: 60000 });
    await page.waitForFunction(() => document.body.innerText.includes('Sign in'),
      null, { timeout: 45000 });
    const startupMs = Math.round(performance.now() - started);
    const mainPid = await app.evaluate(() => process.pid);

    await new Promise(resolve => setTimeout(resolve, settleSeconds * 1000));
    const rows = [];
    const counters = new Map();
    let windowCpuMs = 0;
    let windowFirstMark = null;
    let windowLastMark = null;
    const idleDeadline = performance.now() + idleSeconds * 1000;
    while (performance.now() < idleDeadline) {
      const mark = performance.now();
      const { samples, rollup } = sampleTree(childPids(mainPid));
      if (windowFirstMark === null) {
        seedCounters(counters, samples);
        windowFirstMark = mark;
      } else {
        windowCpuMs += sweepCpuDeltaMs(counters, samples);
      }
      windowLastMark = mark;
      rows.push({
        run: runIndex,
        t_s: Math.round((mark - started) / 10) / 100,
        pids: rollup.pids,
        cpu_ms: rollup.cpu_ms,
        rss_kb: Math.round(rollup.rss_kb),
        pss_kb: rollup.pss.kb,
        pss_status: rollup.pss.kind,
        pss_failures: rollup.pss.failures,
      });
      const remaining = sampleSeconds * 1000 - (performance.now() - mark);
      if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining));
    }
    assert.ok(rows.length >= 2, 'idle window produced samples');
    // CPU over the MEASURED span between the first and last sweep, as
    // percent of one core: 1000 ms of CPU over a 1000 ms span reads 100.
    // The nominal --idle-seconds value is only the loop budget.
    const measuredSpanMs = windowLastMark - windowFirstMark;
    const idleCpuPct = cpuPercentOfOneCore(windowCpuMs, measuredSpanMs);
    const idleRows = rows.slice(-Math.round(idleSeconds / sampleSeconds));
    if (runIndex === 1) await page.screenshot({ path: path.join(output, 'run-1.png') });
    // PSS is only a number when every idle sweep could read the whole
    // tree; otherwise null with the real failure count, never a fake 0.
    const pssComplete = idleRows.every(r => r.pss_status === 'available');
    return {
      run: runIndex, startup_ms: startupMs, idle_cpu_pct_one_core: idleCpuPct,
      cpu_window_ms: Math.round(measuredSpanMs),
      rss_kb_median: median(idleRows.map(r => r.rss_kb)),
      pss_kb_median: pssComplete ? median(idleRows.map(r => r.pss_kb)) : null,
      pss_status: pssComplete ? 'available' : 'incomplete',
      pss_failures: rows.reduce((n, r) => n + r.pss_failures, 0),
      pids_sampled_max: Math.max(...rows.map(r => r.pids)),
      samples: rows,
    };
  } finally {
    if (app) { try { await app.close(); } catch {} }
    await rm(home, { recursive: true, force: true });
  }
}

function osReleaseIsArchFamily() {
  try {
    const release = readFsFileSync('/etc/os-release', 'utf8');
    const field = name => release.match(new RegExp(`^${name}="?([^"\\n]+)"?`, 'm'))?.[1] || '';
    return ['arch', 'omarchy'].includes(field('ID'))
      || field('ID_LIKE').split(/\s+/).includes('arch');
  } catch { return false; }
}

await mkdir(output, { recursive: true });
const summary = {
  bundle,
  bundle_manifest_sha256: createHash('sha256')
    .update(readFsFileSync(path.join(bundle, 'manifest.json'))).digest('hex'),
  git_commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  git_dirty: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }) !== '',
  kernel: readFsFileSync('/proc/sys/kernel/osrelease', 'utf8').trim(),
  scenario: 'signed-out idle window, airgapped proxy, temp profile',
  runs_requested: runs,
  idle_seconds: idleSeconds,
  settle_seconds: settleSeconds,
  sample_seconds: sampleSeconds,
  command: process.argv.slice(2).join(' '),
  started_utc: new Date().toISOString(),
  display: process.env.DISPLAY,
  stand_in_host: !osReleaseIsArchFamily(),
  // Render-backend evidence, NOT an assumption: what was requested and what
  // the environment could offer. Under Xvfb this is x11; under a Wayland
  // compositor the app may pick native Wayland or XWayland unless
  // --ozone-platform pins it. Record the same selection for both sides of
  // any comparison.
  ozone_platform_requested: ozoneRequested,
  render_backend_env: {
    DISPLAY: process.env.DISPLAY || null,
    WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY || null,
    XDG_SESSION_TYPE: process.env.XDG_SESSION_TYPE || null,
    ELECTRON_OZONE_PLATFORM_HINT: process.env.ELECTRON_OZONE_PLATFORM_HINT || null,
    likely_backend: ozoneRequested
      ? ozoneRequested
      : (process.env.WAYLAND_DISPLAY ? 'auto (wayland compositor present; XWayland possible)' : 'x11'),
  },
  ambient_secret_presence: Object.fromEntries(
    ['FACTORY_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GH_TOKEN', 'GITHUB_TOKEN']
      .map(name => [name, name in process.env])),
  // Sampling caveat: 1 Hz walks of /proc can miss short-lived children
  // (zygote-spawned helpers that live under one second), so transient
  // spikes are undercounted. Long-lived processes (main, zygotes, gpu,
  // network, daemon) are always caught. For burst profiles use a CDP-based
  // sampler instead of raising this one's rate.
  sampling_caveat: '1 Hz /proc walk undercounts short-lived children',
};

const completed = [];
for (let index = 1; index <= runs; index++) {
  console.log(`run ${index}/${runs}: launching`);
  const result = await runOnce(index);
  console.log(`run ${index}: startup ${result.startup_ms} ms, `
    + `idle CPU ${result.idle_cpu_pct_one_core.toFixed(2)}% of one core `
    + `over ${result.cpu_window_ms} ms measured, `
    + `RSS median ${result.rss_kb_median} kB, `
    + `PSS ${result.pss_kb_median === null
      ? `unavailable (${result.pss_status}, ${result.pss_failures} unreadable)`
      : `median ${result.pss_kb_median} kB`}, `
    + `max pids ${result.pids_sampled_max}`);
  completed.push(result);
  const csv = ['run,t_s,pids,rss_kb,pss_kb,pss_status,pss_failures,cpu_ms',
    ...completed.flatMap(r => r.samples.map(s =>
      `${s.run},${s.t_s},${s.pids},${s.rss_kb},${s.pss_kb ?? ''},${s.pss_status},${s.pss_failures},${s.cpu_ms}`))]
    .join('\n') + '\n';
  await writeFile(path.join(output, 'samples.csv'), csv);
}

const aggregate = key => {
  const values = completed.map(r => r[key]);
  return {
    median: median(values),
    min: Math.min(...values),
    max: Math.max(...values),
  };
};
const pssMedians = completed.filter(r => r.pss_kb_median !== null).map(r => r.pss_kb_median);
Object.assign(summary, {
  runs_completed: completed.length,
  startup_ms: aggregate('startup_ms'),
  idle_cpu_pct_one_core: aggregate('idle_cpu_pct_one_core'),
  cpu_window_ms: aggregate('cpu_window_ms'),
  cpu_method: 'summed per-pid /proc stat deltas (keyed by pid+starttime) over the '
    + 'measured first-to-last-sweep span, as percent of one core',
  // A process that exits between sweeps contributes nothing after its last
  // sighting, so very short bursts inside the window are undercounted.
  cpu_exit_undercount_caveat: 'sub-second exits between sweeps lose their final consumption',
  rss_kb_idle_median: aggregate('rss_kb_median'),
  // Summed RSS counts shared pages once per process, so the whole-tree
  // figure double-counts shared mappings; PSS is the honest whole-tree
  // number where the kernel provides it.
  rss_shared_pages_caveat: 'whole-tree RSS double-counts shared pages; '
    + 'prefer PSS for whole-tree memory comparisons',
  pss_kb_idle_median: pssMedians.length
    ? { median: median(pssMedians), min: Math.min(...pssMedians), max: Math.max(...pssMedians) }
    : null,
  pss_status: completed.every(r => r.pss_status === 'available') ? 'available' : 'incomplete',
  pss_failures_total: completed.reduce((n, r) => n + r.pss_failures, 0),
  pids_sampled_max: aggregate('pids_sampled_max'),
});
await writeFile(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify({
  runs_completed: summary.runs_completed,
  startup_ms: summary.startup_ms,
  idle_cpu_pct_one_core: summary.idle_cpu_pct_one_core,
  cpu_window_ms: summary.cpu_window_ms,
  rss_kb_idle_median: summary.rss_kb_idle_median,
  pss_kb_idle_median: summary.pss_kb_idle_median,
  pss_status: summary.pss_status,
}));
console.log(`stand_in_host=${summary.stand_in_host} (true means NOT the Arch target)`);
