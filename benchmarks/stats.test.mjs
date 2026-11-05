// Focused unit gates for the runtime benchmark's pure statistics.
// Run: node --test benchmarks/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  cpuPercentOfOneCore, parsePssKb, parseProcStat, pssEntry,
  sampleKey, seedCounters, sweepCpuDeltaMs, treeRollup,
} from './stats.mjs';

// A realistic /proc/<pid>/stat line: comm with a space and parens, then
// fields 3..24 and tail filler. Fields 14/15 (utime/stime) = 370/130
// ticks, field 22 (starttime) = 8311, field 24 (rss) = 25600 pages.
const STAT_TEXT = [
  '5389 (chrome: worker) S 1 5389 5389 0 -1 4194560', // pid comm state..flags (3..9)
  '11 12 13 14',                                       // minflt..cmajflt (10..13)
  '370 130',                                           // utime stime (14..15)
  '210 211 212 213 214 215',                           // cutime..itrealvalue (16..21)
  '8311',                                              // starttime (22)
  '20',                                                // vsize (23)
  '25600',                                             // rss pages (24)
  ...Array.from({ length: 19 }, (_, i) => 300 + i),    // tail filler
].join(' ');

test('cpu percent gates: 1000 ms CPU over 1 s is 100, 2000 ms is 200, idle is 0', () => {
  assert.equal(cpuPercentOfOneCore(1000, 1000), 100);
  assert.equal(cpuPercentOfOneCore(2000, 1000), 200);
  assert.equal(cpuPercentOfOneCore(0, 29_000), 0);
});

test('cpu percent uses the actually measured span, not a nominal window', () => {
  // 1000 ms of CPU over a real 29 s first-to-last-sample span: (1000/29000)*100.
  const pct = cpuPercentOfOneCore(1000, 29_000);
  assert.ok(Math.abs(pct - 100 / 29) < 1e-9, `expected 100/29, got ${pct}`);
  assert.equal(Math.round(pct * 100) / 100, 3.45);
});

test('cpu percent rejects a non-positive measured span', () => {
  assert.throws(() => cpuPercentOfOneCore(1000, 0), RangeError);
  assert.throws(() => cpuPercentOfOneCore(1000, -5), RangeError);
});

test('parseProcStat: cpu in ms from CLK_TCK, rss from real page size, starttime kept', () => {
  const s = parseProcStat(STAT_TEXT, 4096, 100);
  assert.equal(s.pid, 5389);
  assert.equal(s.starttime, 8311);
  assert.equal(s.cpu_ms, (370 + 130) * 1000 / 100);       // 5000 ms
  assert.equal(s.rss_kb, 25600 * 4096 / 1024);            // 102400 kB
});

test('parseProcStat: no 4 KiB page assumption (16 KiB kernel pages)', () => {
  const s = parseProcStat(STAT_TEXT, 16 * 1024, 100);
  assert.equal(s.rss_kb, 25600 * 16 * 1024 / 1024);
});

test('parseProcStat: malformed input yields null, never fabricated values', () => {
  assert.equal(parseProcStat('garbage', 4096, 100), null);
  assert.equal(parseProcStat('123 () x y z', 4096, 100), null);
});

test('parsePssKb: Pss line parses with whitespace variants', () => {
  assert.equal(parsePssKb('Rss: 100 kB\nPss: 123 kB\nSwap: 0 kB'), 123);
  assert.equal(parsePssKb('Pss:\t456 kB'), 456);
  assert.equal(parsePssKb('  Pss: 0 kB'), 0); // kernel said 0: report 0
});

test('parsePssKb: missing Pss line yields null, not 0', () => {
  assert.equal(parsePssKb('Rss: 100 kB\nPssCmp: 9 kB'), null);
  assert.equal(parsePssKb(''), null);
});

test('pssEntry: readable rollup is available, unreadable carries the real reason', () => {
  assert.deepEqual(pssEntry('Pss: 123 kB\n'), { kind: 'available', kb: 123 });
  const entry = pssEntry(undefined, Object.assign(new Error('Permission denied'), { code: 'EACCES' }));
  assert.equal(entry.kind, 'unavailable');
  assert.equal(entry.reason, 'EACCES'); // kernel's own code, no invented diagnosis
  assert.deepEqual(pssEntry('', undefined), { kind: 'unavailable', reason: 'no Pss line' });
});

const mk = (pid, starttime, cpuMs, rssKb, pss) => ({
  pid, starttime, cpu_ms: cpuMs, rss_kb: rssKb,
  pss: pss === undefined ? { kind: 'unavailable', reason: 'EACCES' } : { kind: 'available', kb: pss },
});

test('treeRollup: partial-tree PSS sums readable entries, never reports 0 total', () => {
  const rollup = treeRollup([mk(1, 5, 10, 2000, 123), mk(2, 6, 20, 3000)]);
  assert.equal(rollup.pids, 2);
  assert.equal(rollup.cpu_ms, 30);
  assert.equal(rollup.rss_kb, 5000);
  assert.equal(rollup.pss.kind, 'partial');
  assert.equal(rollup.pss.kb, 123); // the readable one, not 0
  assert.equal(rollup.pss.failures, 1);
});

test('treeRollup: no readable PSS entry is unavailable with kb null, never 0', () => {
  const rollup = treeRollup([mk(1, 5, 10, 2000), mk(2, 6, 20, 3000)]);
  assert.equal(rollup.pss.kind, 'unavailable');
  assert.equal(rollup.pss.kb, null);
  assert.equal(rollup.pss.failures, 2);
  assert.equal(rollup.pss.failures > 0 && rollup.pss.kb !== 0, true);
});

test('window cpu: exited pid counters are retained, contribute no negative delta', () => {
  const counters = seedCounters(new Map(), [mk(100, 5, 5000, 0, 1)]);
  const delta = sweepCpuDeltaMs(counters, [mk(200, 9, 8000, 0, 1)]); // pid 100 gone
  assert.equal(delta, 8000); // only the new pid's in-window time; no negative contribution
  assert.equal(counters.get(sampleKey(100, 5)), 5000); // counter retained
});

test('window cpu: a recycled pid (same pid, new starttime) never goes negative', () => {
  const counters = seedCounters(new Map(), [mk(100, 5, 5000, 0, 1)]);
  // Same pid, different start time, small cumulative counter: a new key.
  const delta = sweepCpuDeltaMs(counters, [mk(100, 9, 40, 0, 1)]);
  assert.equal(delta, 40);
  assert.equal(counters.get(sampleKey(100, 9)), 40);
});

test('window cpu: 1000 ms of CPU between sweeps over 1 s reads 100 percent', () => {
  const counters = seedCounters(new Map(), [mk(7, 3, 1000, 0, 1)]);
  const delta = sweepCpuDeltaMs(counters, [mk(7, 3, 2000, 0, 1)]);
  assert.equal(cpuPercentOfOneCore(delta, 1000), 100);
});

test('window cpu: 2000 ms between sweeps over 1 s reads 200 percent; idle reads 0', () => {
  const counters = seedCounters(new Map(), [mk(7, 3, 1000, 0, 1)]);
  assert.equal(cpuPercentOfOneCore(sweepCpuDeltaMs(counters, [mk(7, 3, 3000, 0, 1)]), 1000), 200);
  const idle = sweepCpuDeltaMs(seedCounters(new Map(), [mk(7, 3, 1000, 0, 1)]), [mk(7, 3, 1000, 0, 1)]);
  assert.equal(cpuPercentOfOneCore(idle, 29_000), 0);
});
