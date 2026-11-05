// Pure statistics for the runtime benchmark: /proc text parsing and idle
// window rollups. No /proc access and no UI imports here, so the focused
// tests run anywhere with `node --test benchmarks/*.test.mjs`.
//
// One process at one instant is a ProcessSample: { pid, starttime, cpu_ms,
// rss_kb, pss } where pss is { kind: 'available', kb } or
// { kind: 'unavailable', reason }. PSS is never reported as 0 when the
// rollup was unreadable: 0 kB means the kernel said 0.

// Fields after comm are 1-based: utime 14, stime 15, starttime 22, rss
// (pages) 24. comm may contain spaces and parens, so split after the last
// ')': field k then lives at fields[k - 3].
export function parseProcStat(statText, pageBytes, clockTicksPerSecond) {
  const parenEnd = statText.lastIndexOf(')');
  if (parenEnd < 0) return null;
  const fields = statText.slice(parenEnd + 2).split(' ');
  const utime = Number(fields[14 - 3]);
  const stime = Number(fields[15 - 3]);
  const starttime = Number(fields[22 - 3]);
  const rssPages = Number(fields[24 - 3]);
  if (![utime, stime, starttime, rssPages].every(Number.isFinite)) return null;
  return {
    pid: Number(statText.slice(0, statText.indexOf(' '))),
    starttime,
    cpu_ms: (utime + stime) * 1000 / clockTicksPerSecond,
    rss_kb: rssPages * pageBytes / 1024,
  };
}

export function parsePssKb(rollupText) {
  const line = rollupText.split('\n').find(l => l.trimStart().startsWith('Pss:'));
  if (line === undefined) return null;
  const match = line.match(/Pss:\s+(\d+)\s+kB/);
  return match ? Number(match[1]) : null;
}

// Unavailable carries the kernel's own reason (EACCES, ENOENT, ...), never
// a fabricated diagnosis and never a fake 0.
export function pssEntry(rollupText, readError) {
  if (readError) {
    return { kind: 'unavailable', reason: readError.code || String(readError.message || readError) };
  }
  const kb = parsePssKb(rollupText ?? '');
  return kb === null
    ? { kind: 'unavailable', reason: 'no Pss line' }
    : { kind: 'available', kb };
}

// Percent of one core: 1000 ms of CPU over a measured 1000 ms of wall time
// is 100, 2000 ms is 200, 0 is 0. elapsedMs must be the actually measured
// span between the first and last sweep, not a nominal window length.
export function cpuPercentOfOneCore(deltaCpuMs, elapsedMs) {
  if (!(elapsedMs > 0)) throw new RangeError(`elapsedMs must be positive, got ${elapsedMs}`);
  return (deltaCpuMs / elapsedMs) * 100;
}

// Tree rollup of one sweep. PSS sums the readable entries only: a
// partially readable tree is 'partial' with that sum (never 0), a tree
// with no readable entry is 'unavailable' with kb null.
export function treeRollup(samples) {
  let cpuMs = 0, rssKb = 0, pssKb = 0, pssAvailable = 0, pssFailures = 0;
  for (const s of samples) {
    cpuMs += s.cpu_ms;
    rssKb += s.rss_kb;
    if (s.pss.kind === 'available') { pssKb += s.pss.kb; pssAvailable++; }
    else pssFailures++;
  }
  return {
    pids: samples.length,
    cpu_ms: Math.round(cpuMs * 10) / 10,
    rss_kb: rssKb,
    pss: pssAvailable === 0
      ? { kind: 'unavailable', failures: pssFailures, kb: null }
      : { kind: pssFailures > 0 ? 'partial' : 'available', failures: pssFailures, kb: pssKb },
  };
}

// Cumulative-CPU bookkeeping across sweeps, keyed by pid AND starttime so
// a recycled pid (same pid, new start time) is a new key and deltas never
// go negative. Exited pids keep their last counter in the table; they
// simply stop contributing.
export const sampleKey = (pid, starttime) => `${pid}:${starttime}`;

// First sweep of a window: seed the table, contribute no delta.
export function seedCounters(counters, samples) {
  for (const s of samples) counters.set(sampleKey(s.pid, s.starttime), s.cpu_ms);
  return counters;
}

// Later sweeps: a seen key contributes max(0, curr - prev); a new key
// (process born after the window opened, or first sighted here)
// contributes its full cumulative value, since all of it falls inside the
// window.
export function sweepCpuDeltaMs(counters, samples) {
  let deltaMs = 0;
  for (const s of samples) {
    const key = sampleKey(s.pid, s.starttime);
    const prev = counters.get(key);
    counters.set(key, s.cpu_ms);
    deltaMs += prev === undefined ? s.cpu_ms : Math.max(0, s.cpu_ms - prev);
  }
  return deltaMs;
}
