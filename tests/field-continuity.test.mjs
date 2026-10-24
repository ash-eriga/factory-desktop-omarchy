// Field-continuity test: the account session inventory must survive the
// actual helper → collector → record handoff intact (including real zero
// vs missing values), and the published record must carry exactly the
// field names its consumer reads.
//
// The panel that renders the record is a separate, user-local component
// and is not part of this repository. What IS public is the contract: the
// helper's metrics, the collector's inventory and the record fields. Those
// are asserted here against the real modules, plus the documentation that
// describes them.
//
// Offline: mock fetch, isolated temp dirs, no user state.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const HELPER = path.join(ROOT, 'runtime', 'auth-helper.mjs');
const SERVICE_README = path.join(ROOT, 'omarchy', 'factory-usage-service', 'README.md');

// The inventory fields the record consumer reads. The names are the
// contract: they travel from the helper through the collector into the
// published record unchanged.
const INVENTORY_FIELDS = ['sessionCount', 'creditsSampleTotal', 'unknownOwnerRows',
  'hasMore', 'complete'];

const LIMITS_BODY = {
  limits: { standard: { fiveHour: { usedPercent: 10 } }, core: null },
  extraUsageBalanceCents: 2500,
  extraUsageAllowed: true,
};
const ME_BODY = { organization: { subscription: { factoryTier: 'max' } } };

const SESSIONS_BODY = {
  sessions: [
    { id: 's1', owner: 'user_me', factoryCredits: 3.5 },
    { id: 's2', owner: { id: 'user_me' }, factoryCredits: 4.5 },
    { id: 's3', owner: 'user_other', factoryCredits: 99 },
    { id: 's4', factoryCredits: 12 },
  ],
  pagination: { nextBefore: 'cursor', hasMore: true },
};

async function makeBundle(dir) {
  const bundle = path.join(dir, 'bundle');
  const buildDir = path.join(bundle, 'resources', 'app.asar', '.vite', 'build');
  await mkdir(path.join(bundle, 'port'), { recursive: true });
  await mkdir(buildDir, { recursive: true });
  await writeFile(path.join(bundle, 'resources', 'app.asar', 'package.json'),
    JSON.stringify({ type: 'commonjs' }));
  await writeFile(path.join(buildDir, 'fake-chunk.js'), `
    module.exports = {
      getEnv: () => ({}),
      getRuntimeAuthConfig: () => ({ deployment: { kind: 'factory' }, airgapEnabled: false }),
      getFreshTokenWithSource: async () => ({ type: 'workos', token: 'tok' }),
      getAuthedUser: async () => ({ userId: 'user_me', orgId: 'org_x', region: 'global' }),
      getActiveOrganizationId: async () => 'org_sel',
    };
  `);
  await writeFile(path.join(bundle, 'port', 'versions.json'),
    JSON.stringify({ authModule: '.vite/build/fake-chunk.js' }));
  return bundle;
}

function mockFetch(responses) {
  return async url => {
    const match = responses.find(r => String(url).includes(r.match));
    if (!match) throw new Error('unexpected request: ' + url);
    return { status: 200, ok: true, json: async () => match.body };
  };
}

async function helperMetrics(overrides = []) {
  const dir = await mkdtemp(path.join(tmpdir(), 'factory-cont-'));
  try {
    const bundle = await makeBundle(dir);
    // The helper is imported as a URL: a checkout unpacked in a folder
    // whose name contains a '#' would make the rest of the path a URL
    // fragment.
    const { run } = await import(pathToFileURL(HELPER).href);
    return await run({
      bundlePath: bundle,
      fetchImpl: mockFetch([
        // Overrides first: the mock resolves requests in list order.
        ...overrides,
        { match: '/api/billing/limits', body: LIMITS_BODY },
        { match: '/api/app/auth/me', body: ME_BODY },
        { match: '/api/sessions/v2', body: SESSIONS_BODY },
      ]),
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// The real collector: the inventory it derives and the record it writes.
async function collectorContract(metrics) {
  const result = spawnSync('python3', ['-c', `
import json, importlib.util, sys
spec = importlib.util.spec_from_file_location('c', 'runtime/collector.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
metrics = json.loads(sys.argv[1])
inventory = m.extract_account_recent_sessions(metrics)
record = m.build_record(metrics)
print(json.dumps({'inventory': inventory, 'record': record}))
  `, JSON.stringify(metrics)], {
    encoding: 'utf8', cwd: ROOT,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim());
}

test('inventory creditsSampleTotal survives helper → collector → record', async () => {
  const metrics = await helperMetrics();
  assert.equal(metrics.accountRecentSessions.sessionCount, 2);
  assert.equal(metrics.accountRecentSessions.creditsSampleTotal, 8);
  const { inventory, record } = await collectorContract(metrics);
  // The reviewer's failing case: the sample amount must survive, not be
  // dropped so the consumer shows 0 FSC.
  assert.equal(inventory.creditsSampleTotal, 8);
  assert.equal(inventory.unknownOwnerRows, 1);
  assert.equal(inventory.complete, false);
  assert.equal(inventory.hasMore, true);
  assert.equal(inventory.sessionCount, 2);

  // The published record carries the same inventory under the documented
  // name, with the documented field names and nothing else.
  assert.deepEqual(Object.keys(record.accountRecentSessions).sort(),
    [...INVENTORY_FIELDS, 'requestedLimit', 'scope'].sort());
  assert.equal(record.accountRecentSessions.creditsSampleTotal, 8);
  assert.equal(record.accountRecentSessions.sessionCount, 2);
  assert.equal(record.accountRecentSessions.unknownOwnerRows, 1);
  assert.equal(record.accountRecentSessions.complete, false);
  assert.equal(record.accountRecentSessions.hasMore, true);
});

test('a real zero sample stays zero through the contract', async () => {
  const metrics = await helperMetrics([
    { match: '/api/billing/limits', body: LIMITS_BODY },
    { match: '/api/app/auth/me', body: ME_BODY },
    { match: '/api/sessions/v2', body: {
      sessions: [
        { id: 's1', factoryCredits: 7 },        // unknown owner: not credited
        { id: 's2', owner: 'user_x', factoryCredits: 7 },
      ],
      pagination: { hasMore: false },
    } },
  ]);
  const { inventory, record } = await collectorContract(metrics);
  assert.equal(inventory.sessionCount, 0);
  assert.equal(inventory.creditsSampleTotal, 0);
  assert.equal(inventory.unknownOwnerRows, 1);
  assert.equal(record.accountRecentSessions.creditsSampleTotal, 0);
  assert.equal(record.accountRecentSessions.sessionCount, 0);
});

test('a missing sample value stays missing through the contract', async () => {
  const metrics = await helperMetrics();
  const reduced = { ...metrics, accountRecentSessions: { sessionCount: 4, hasMore: true } };
  const { inventory, record } = await collectorContract(reduced);
  assert.equal(inventory.sessionCount, 4);
  assert.equal(inventory.creditsSampleTotal, undefined);
  assert.equal(record.accountRecentSessions.creditsSampleTotal, undefined);
  assert.equal(record.accountRecentSessions.creditsSampleTotal || 0, 0); // the consumer's `|| 0` fallback
});

test('the published service documentation describes the inventory contract', async () => {
  const readme = await readFile(SERVICE_README, 'utf8');
  assert.match(readme, /accountRecentSessions|Account inventory/);
  assert.match(readme, /creditsSampleTotal|session credits/);
  // The record is explicitly marked incomplete: no account-global history
  // is invented.
  assert.match(readme, /incomplete|complete: false/i);
});
