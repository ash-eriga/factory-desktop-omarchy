// Contract tests for the actual auth helper (runtime/auth-helper.mjs).
//
// These exercise the real helper code — chunk loading, the direct HTTP body
// shape, the saved active-organization header, and optional-tier failure
// handling — against a fake vendor chunk and a mock fetch. They are offline;
// no real credentials, network, or keyring is touched. A spawn-mode test
// additionally runs the helper as its own process to cover the sentinel
// protocol.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, cp } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const HELPER = path.join(ROOT, 'runtime', 'auth-helper.mjs');

const LIMITS_BODY = {
  limits: {
    standard: { fiveHour: { usedPercent: 42.5, windowEnd: '2026-10-11T16:00:00Z', secondsRemaining: 3600 } },
    core: null,
  },
  extraUsageBalanceCents: 4500,
  extraUsageAllowed: true,
};
const ME_BODY = { organization: { subscription: { factoryTier: 'teams' } } };

// Builds a fake vendor chunk exporting the vendor functions the helper
// relies on. jwtOrg simulates the organization inside a decoded JWT;
// activeOrg simulates the saved active-organization selection.
async function makeFakeBundle(dir, {
  activeOrg = 'selected-org', jwtOrg = 'original-org', region = 'global',
  userId = null,
  credential = { type: 'workos', token: 'test-token' },
  deployment = { kind: 'factory' },
} = {}) {
  const bundle = path.join(dir, 'bundle');
  const buildDir = path.join(bundle, 'resources', 'app.asar', '.vite', 'build');
  await mkdir(path.join(bundle, 'port'), { recursive: true });
  await mkdir(buildDir, { recursive: true });
  await writeFile(path.join(bundle, 'resources', 'app.asar', 'package.json'),
    JSON.stringify({ type: 'commonjs' }));
  await writeFile(path.join(buildDir, 'fake-chunk.js'), `
    module.exports = {
      getEnv: () => ({}),
      getRuntimeAuthConfig: () => ({ deployment: ${JSON.stringify(deployment)}, airgapEnabled: false }),
      getFreshTokenWithSource: async () => (${JSON.stringify(credential)}),
      getAuthedUser: async () => ({ orgId: ${JSON.stringify(jwtOrg)}, region: ${JSON.stringify(region)}, userId: ${JSON.stringify(userId)} }),
      getActiveOrganizationId: async () => (${JSON.stringify(activeOrg)}),
    };
  `);
  await writeFile(path.join(bundle, 'port', 'versions.json'),
    JSON.stringify({ authModule: '.vite/build/fake-chunk.js' }));
  await mkdir(path.join(bundle, 'resources', 'app.asar.unpacked'), { recursive: true });
  return bundle;
}

function json(response, status, body) {
  return { status, ok: status >= 200 && status < 300, json: async () => JSON.parse(body), text: async () => body };
}

function mockFetch(responses, log = []) {
  return async (url, init) => {
    const entry = { url: String(url), headers: init?.headers ?? {} };
    log.push(entry);
    const match = responses.find(r => String(url).includes(r.match));
    if (!match) throw new Error(`unexpected request: ${url}`);
    if (match.reject) throw match.reject;
    if (match.body !== undefined) return json(null, match.status ?? 200, JSON.stringify(match.body));
    return json(null, match.status ?? 200, match.raw);
  };
}

async function runHelper(dir, options = {}, fetchImpl) {
  const bundle = await makeFakeBundle(dir, options.chunk ?? {});
  // The helper is imported as a URL: a checkout unpacked in a folder
  // whose name contains a '#' would make the rest of the path a URL
  // fragment.
  const { run, SENTINEL } = await import(pathToFileURL(HELPER).href);
  const requests = [];
  const wrapped = async (url, init) => {
    const entry = { url: String(url), headers: init?.headers ?? {} };
    requests.push(entry);
    return fetchImpl ? fetchImpl(url, init) : undefined;
  };
  const payload = await run({
    bundlePath: bundle,
    fetchImpl: fetchImpl ? wrapped : mockFetch(options.responses ?? [
      { match: '/api/billing/limits', body: LIMITS_BODY },
      { match: '/api/app/auth/me', body: ME_BODY },
    ], requests),
  });
  return { payload, requests, SENTINEL, bundle };
}

test('helper reads the direct HTTP body, not an invented envelope', async () => {
  await withTemp(async dir => {
    const { payload, requests } = await runHelper(dir);
    assert.equal(payload.ok, true);
    assert.equal(payload.standard.fiveHour.usedPercent, 42.5);
    assert.equal(payload.extraUsageBalanceCents, 4500);
    assert.equal(payload.extraUsageAllowed, true);
    // The request hit the real endpoint paths with the bearer credential.
    assert.ok(requests[0].url.includes('/api/billing/limits'));
    assert.equal(requests[0].headers.Authorization, 'Bearer test-token');
  });
});

test('helper sends the saved active organization, never the JWT organization', async () => {
  await withTemp(async dir => {
    const { payload, requests } = await runHelper(dir, {
      chunk: { activeOrg: 'selected-org', jwtOrg: 'original-org' },
    });
    assert.equal(requests[0].headers['X-Factory-Org-Id'], 'selected-org');
    assert.equal(payload.orgKnown, true);
    // Neither the JWT org nor the selected org may leak into the output.
    assert.ok(!JSON.stringify(payload).includes('selected-org'));
    assert.ok(!JSON.stringify(payload).includes('original-org'));
    assert.ok(!JSON.stringify(payload).includes('test-token'));
  });
});

test('tier comes from /api/app/auth/me with the direct body path', async () => {
  await withTemp(async dir => {
    const { payload, requests } = await runHelper(dir);
    assert.ok(requests.some(r => r.url.includes('/api/app/auth/me')));
    assert.ok(!requests.some(r => r.url.endsWith('/api/auth/me') && !r.url.includes('/app/')));
    assert.equal(payload.tier, 'teams');
  });
});

test('a non-200 tier response keeps limits and balance', async () => {
  await withTemp(async dir => {
    const { payload } = await runHelper(dir, {
      responses: [
        { match: '/api/billing/limits', body: LIMITS_BODY },
        { match: '/api/app/auth/me', status: 500 },
      ],
    });
    assert.equal(payload.ok, true);
    assert.equal(payload.standard.fiveHour.usedPercent, 42.5);
    assert.equal(payload.extraUsageBalanceCents, 4500);
    assert.equal(payload.tier, undefined);
  });
});

test('a malformed tier body keeps limits and balance', async () => {
  await withTemp(async dir => {
    const { payload } = await runHelper(dir, {
      responses: [
        { match: '/api/billing/limits', body: LIMITS_BODY },
        { match: '/api/app/auth/me', raw: 'not json at all' },
      ],
    });
    assert.equal(payload.ok, true);
    assert.equal(payload.extraUsageBalanceCents, 4500);
    assert.equal(payload.tier, undefined);
  });
});

test('a tier network rejection keeps limits and balance', async () => {
  await withTemp(async dir => {
    const { payload } = await runHelper(dir, {
      responses: [
        { match: '/api/billing/limits', body: LIMITS_BODY },
        { match: '/api/app/auth/me', reject: new Error('dns failure') },
      ],
    });
    assert.equal(payload.ok, true);
    assert.equal(payload.standard.fiveHour.usedPercent, 42.5);
    assert.equal(payload.extraUsageBalanceCents, 4500);
    assert.equal(payload.tier, undefined);
  });
});

test('required limits query stays strict: non-200 fails with a category', async () => {
  await withTemp(async dir => {
    const { run, SENTINEL } = await import(pathToFileURL(HELPER).href);
    const bundle = await makeFakeBundle(dir);
    await assert.rejects(() => run({
      bundlePath: bundle,
      fetchImpl: mockFetch([
        { match: '/api/billing/limits', status: 403, body: {} },
        { match: '/api/app/auth/me', body: ME_BODY },
      ]),
    }), error => error.category === 'http-403');
  });
});

test('required limits query stays strict: malformed body is schema drift', async () => {
  await withTemp(async dir => {
    const { run } = await import(pathToFileURL(HELPER).href);
    const bundle = await makeFakeBundle(dir);
    await assert.rejects(() => run({
      bundlePath: bundle,
      fetchImpl: mockFetch([{ match: '/api/billing/limits', raw: '<html>gateway</html>' }]),
    }), error => error.category === 'schema-error');
  });
});

test('required limits query stays strict: network rejection is a network error', async () => {
  await withTemp(async dir => {
    const { run } = await import(pathToFileURL(HELPER).href);
    const bundle = await makeFakeBundle(dir);
    await assert.rejects(() => run({
      bundlePath: bundle,
      fetchImpl: mockFetch([{ match: '/api/billing/limits', reject: new Error('offline') }]),
    }), error => error.category === 'network');
  });
});

test('unauthenticated and unsupported deployments are static categories', async () => {
  await withTemp(async dir => {
    const { run } = await import(pathToFileURL(HELPER).href);
    const bundle = await makeFakeBundle(dir, { credential: null });
    await assert.rejects(() => run({ bundlePath: bundle, fetchImpl: async () => { throw new Error('no requests'); } }),
      error => error.category === 'unauthenticated');
  });
  await withTemp(async dir => {
    const { run } = await import(pathToFileURL(HELPER).href);
    const bundle = await makeFakeBundle(dir, { deployment: { kind: 'customer-prem' } });
    await assert.rejects(() => run({ bundlePath: bundle, fetchImpl: async () => { throw new Error('no requests'); } }),
      error => error.category === 'unsupported-deployment');
  });
});

test('helper as a spawned process emits the sentinel protocol (no network)', async () => {
  await withTemp(async dir => {
    const bundle = await makeFakeBundle(dir, { credential: null });
    await mkdir(path.join(bundle, 'port'), { recursive: true });
    await writeFile(path.join(bundle, 'port', 'auth-helper.mjs'), await readFile(HELPER));
    // Spawn via explicit --bundle from a DIFFERENT working directory: the
    // helper must read the vendor chunk from the bundle argument, not from
    // its own location.
    const helperCopy = path.join(dir, 'deployed-elsewhere', 'auth-helper.mjs');
    await mkdir(path.dirname(helperCopy), { recursive: true });
    await writeFile(helperCopy, await readFile(HELPER));
    const result = spawnSync(process.execPath, [helperCopy, '--bundle', bundle], {
      encoding: 'utf8', timeout: 60000, cwd: dir,
    });
    assert.equal(result.status, 0, result.stderr);
    const [marker, payloadLine] = result.stdout.trim().split('\n');
    assert.equal(marker, 'FACTORY-USAGE-JSON-1');
    const payload = JSON.parse(payloadLine);
    assert.deepEqual(payload, { ok: false, error: 'unauthenticated' });
  });
});

test('account session inventory counts proven self-owned rows only', async () => {
  await withTemp(async dir => {
    const { payload, requests } = await runHelper(dir, {
      chunk: { jwtOrg: 'original-org', activeOrg: 'selected-org', userId: 'user_me' },
    }, mockFetch([
      { match: '/api/billing/limits', body: LIMITS_BODY },
      { match: '/api/app/auth/me', body: ME_BODY },
      { match: '/api/sessions/v2', body: {
        sessions: [
          { id: 'session-1', owner: 'user_me', factoryCredits: 1.5, title: 'Secret title' },
          { id: 'session-2', owner: { id: 'user_me' }, factoryCredits: 2.5 },
          { id: 'session-3', owner: 'user_other', factoryCredits: 99 },
          // Unknown owner: never credited into the sample.
          { id: 'session-4', factoryCredits: 'not-a-number' },
          { id: 'session-5', factoryCredits: 50 },
          { id: 'session-6', owner: { id: 'user_me' }, factoryCredits: 1 },
          null,
        ],
        pagination: { nextBefore: 'cursor-data', hasMore: true },
      } },
    ]));
    assert.equal(payload.ok, true);
    const inventory = payload.accountRecentSessions;
    assert.equal(inventory.sessionCount, 3);
    assert.equal(inventory.creditsSampleTotal, 5);
    // Unknown-owner rows are counted, never credited.
    assert.equal(inventory.unknownOwnerRows, 2);
    assert.equal(inventory.hasMore, true);
    assert.equal(inventory.complete, false);
    assert.match(inventory.scope, /recent sample/);
    assert.equal(inventory.ownerFiltered, undefined);
    // No session ids, pagination cursors, or titles may be emitted.
    const text = JSON.stringify(payload);
    assert.ok(!text.includes('session-1'));
    assert.ok(!text.includes('cursor-data'));
    assert.ok(!text.includes('Secret title'));
    assert.ok(!text.includes('user_me'));
    assert.ok(!text.includes('creditsTotal'));
    // The inventory request hit the documented endpoint.
    assert.ok(requests.some(r => r.url.includes('/api/sessions/v2?limit=20&lite=true')));
  });
});

test('account inventory without a resolvable user id never sums credits', async () => {
  await withTemp(async dir => {
    const { payload } = await runHelper(dir, {
      chunk: { userId: null },
    }, mockFetch([
      { match: '/api/billing/limits', body: LIMITS_BODY },
      { match: '/api/app/auth/me', body: ME_BODY },
      { match: '/api/sessions/v2', body: {
        sessions: [
          { id: 'session-1', owner: 'user_other', factoryCredits: 99 },
          { id: 'session-2', factoryCredits: 50 },
        ],
        pagination: { hasMore: false },
      } },
    ]));
    assert.equal(payload.ok, true);
    const inventory = payload.accountRecentSessions;
    assert.equal(inventory.sessionCount, 0);
    assert.equal(inventory.creditsSampleTotal, 0);
    assert.equal(inventory.unknownOwnerRows, 2);
    assert.equal(inventory.complete, false);
  });
});

test('account session inventory is optional: failure keeps limits and balance', async () => {
  await withTemp(async dir => {
    const { payload } = await runHelper(dir, {
      chunk: { userId: 'user_me' },
    }, mockFetch([
      { match: '/api/billing/limits', body: LIMITS_BODY },
      { match: '/api/app/auth/me', body: ME_BODY },
      { match: '/api/sessions/v2', status: 403, body: {} },
    ]));
    assert.equal(payload.ok, true);
    assert.equal(payload.standard.fiveHour.usedPercent, 42.5);
    assert.equal(payload.extraUsageBalanceCents, 4500);
    assert.equal(payload.accountRecentSessions, undefined);
  });
});

async function withTemp(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'factory-helper-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('the helper is imported as a URL, so a checkout path with a # works', async () => {
  // A clone or a ZIP unpacked in a folder whose name contains a '#'
  // breaks a raw filesystem path in a dynamic import: the rest of the
  // path is read as a URL fragment and the module is never found.
  const dir = await mkdtemp(path.join(tmpdir(), 'factory-helper-#-'));
  try {
    const helper = path.join(dir, 'auth-helper.mjs');
    await cp(path.join(ROOT, 'runtime', 'auth-helper.mjs'), helper);
    const module = await import(pathToFileURL(helper).href);
    assert.equal(typeof module.run, 'function');
    // Both suites that drive the helper import it the same way.
    for (const file of ['helper-contract.test.mjs', 'field-continuity.test.mjs']) {
      const source = await readFile(path.join(ROOT, 'tests', file), 'utf8');
      assert.match(source, /import\(pathToFileURL\(HELPER\)\.href\)/, file);
      assert.doesNotMatch(source, /import\(HELPER\)/, file);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
