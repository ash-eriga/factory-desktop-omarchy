// Factory usage auth helper.
//
// Runs the bundled Electron binary in Node mode (ELECTRON_RUN_AS_NODE=1) to
// load the vendor app's own compiled auth module from the app archive. The
// helper resolves saved credentials and refreshes tokens exactly the way the
// desktop app does, then calls the billing endpoints the renderer uses.
//
// Security contract:
// - Credential material (tokens, refresh tokens, encryption keys) never
//   leaves this process. Only the whitelisted metric fields below are
//   printed, as one JSON object after a sentinel line on stdout.
// - Requests go only to trusted HTTPS Factory API origins. Customer
//   on-premise and air-gapped deployments are refused, not guessed.
// - Errors are reported as static categories. Response bodies and error
//   messages are never echoed, because they could carry secrets.
//
// The vendor SDK's `dp.fromResponse()` stores the raw parsed HTTP JSON body
// in its `.data` (that is why the renderer reads `response.data.limits`).
// This helper reads the direct HTTP body: no extra envelope is added or
// assumed.

import { createRequire } from 'node:module';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const SENTINEL = 'FACTORY-USAGE-JSON-1';
const TRUSTED_API_HOSTS = new Set(['api.factory.ai', 'api.eu.factory.ai']);
const REQUEST_TIMEOUT_MS = 20000;
// The renderer pins the authenticated query to /api/app/auth/me.
const AUTH_ME_PATH = '/api/app/auth/me';

// The compiled chunks require('electron') at module scope. Under
// ELECTRON_RUN_AS_NODE there is no app; serve a minimal non-app shim so the
// import succeeds without starting an app or touching a display. The shim
// only no-ops the lifecycle calls the chunk makes at import time (protocol
// scheme registration, app model id); no window, updater, or protocol
// handler is ever created.
const electronShim = {
  app: {
    isPackaged: true, isReady: () => true, whenReady: () => Promise.resolve(),
    getPath: name => (name === 'home' ? os.homedir() : os.tmpdir()),
    getAppPath: () => os.tmpdir(),
    getVersion: () => '0.0.0-helper',
    on: () => {}, quit: () => {}, exit: () => {},
    setAppUserModelId: () => {},
  },
  ipcMain: { on: () => {} },
  protocol: { registerSchemesAsPrivileged: () => {} },
  BrowserWindow: class {},
  autoUpdater: { on: () => {} },
  powerMonitor: { on: () => {} },
  dialog: {},
};
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electronShim;
  return realLoad.call(this, request, parent, isMain);
};

function httpsTrustedUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !TRUSTED_API_HOSTS.has(url.hostname)) return null;
    return url;
  } catch {
    return null;
  }
}

// Strict fetch for required endpoints: any failure becomes a static error
// category and terminates the helper. Response bodies are never echoed.
async function fetchJsonStrict(fetchImpl, url, headers) {
  let response;
  try {
    response = await fetchImpl(url, {
      headers, redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    fail('network');
  }
  if (response.status !== 200) fail(`http-${response.status}`);
  try {
    return await response.json();
  } catch {
    fail('schema-error');
  }
}

// Optional fetch for the tier label: a non-200, malformed body, or network
// rejection only means no label. It must never discard previously collected
// limits or balance.
async function fetchJsonOptional(fetchImpl, url, headers) {
  try {
    const response = await fetchImpl(url, {
      headers, redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status !== 200) return null;
    return await response.json();
  } catch {
    return null;
  }
}

// The limit buckets the renderer consumes. Anything unexpected is schema
// drift, not something to guess around.
function readBucket(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) fail('schema-error');
  const out = {};
  if (value.usedPercent !== undefined) {
    if (typeof value.usedPercent !== 'number' || !Number.isFinite(value.usedPercent)) fail('schema-error');
    out.usedPercent = Math.min(100, Math.max(0, value.usedPercent));
  }
  if (value.windowEnd !== undefined) {
    if (value.windowEnd !== null && typeof value.windowEnd !== 'string') fail('schema-error');
    out.windowEnd = value.windowEnd;
  }
  if (value.secondsRemaining !== undefined) {
    if (value.secondsRemaining !== null && typeof value.secondsRemaining !== 'number') fail('schema-error');
    out.secondsRemaining = value.secondsRemaining;
  }
  return out;
}

function readPool(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) fail('schema-error');
  return {
    fiveHour: readBucket(value.fiveHour),
    weekly: readBucket(value.weekly),
    monthly: readBucket(value.monthly),
  };
}

// Static failure categories become this error internally; the entry point
// turns them into the sentinel-delimited output. Nothing else is ever
// echoed, so a category is all a caller learns.
class HelperFailure extends Error {
  constructor(category) {
    super(category);
    this.category = category;
  }
}

function fail(category) {
  throw new HelperFailure(category);
}

function emit(payload) {
  process.stdout.write(`${SENTINEL}\n${JSON.stringify(payload)}\n`);
  // Telemetry timers and AbortControllers inside the SDK must not keep this
  // process alive after the result is out.
  process.exit(0);
}

export async function run({ bundlePath, fetchImpl = fetch } = {}) {
  const helperPath = fileURLToPath(import.meta.url);
  const bundle = bundlePath ?? path.dirname(path.dirname(helperPath));
  const port = JSON.parse(await readFile(path.join(bundle, 'port', 'versions.json'), 'utf8'));
  const chunk = path.join(bundle, 'resources', 'app.asar', path.posix.dirname(port.authModule), path.posix.basename(port.authModule));

  const requireChunk = createRequire(chunk);
  const mod = requireChunk(chunk);

  mod.getEnv?.();
  const config = mod.getRuntimeAuthConfig();
  if (config.airgapEnabled === true || config.deployment?.kind === 'customer-prem') {
    fail('unsupported-deployment');
  }

  const credential = await mod.getFreshTokenWithSource(config);
  if (!credential || typeof credential.token !== 'string' || !credential.token) fail('unauthenticated');

  // The org header must carry the saved active organization selection, not
  // the JWT's issuing organization: the two are independent and can differ.
  // Residency resolution (authedUser.region, resolved by the SDK's whoami
  // flow for the same selection) picks the EU API host when applicable.
  const activeOrgId = await mod.getActiveOrganizationId?.(config) ?? null;
  const user = await mod.getAuthedUser?.(config) ?? null;
  const region = user?.region === 'eu' ? 'eu' : 'global';
  const baseUrl = httpsTrustedUrl(region === 'eu' ? 'https://api.eu.factory.ai' : 'https://api.factory.ai');
  if (!baseUrl) fail('helper-error');

  const headers = { Accept: 'application/json', Authorization: `Bearer ${credential.token}` };
  if (typeof activeOrgId === 'string' && activeOrgId) headers['X-Factory-Org-Id'] = activeOrgId;

  // GET /api/billing/limits returns the metric object directly:
  // {limits:{standard:{...},core:{...}},extraUsageBalanceCents,extraUsageAllowed}.
  const limitsBody = await fetchJsonStrict(fetchImpl, new URL('/api/billing/limits', baseUrl), headers);
  if (typeof limitsBody !== 'object' || limitsBody === null) fail('schema-error');
  const limits = limitsBody.limits;
  if (typeof limits !== 'object' || limits === null) fail('schema-error');
  const metrics = {
    ok: true,
    credentialSource: String(credential.type ?? 'unknown'),
    orgKnown: Boolean(activeOrgId),
    region,
    standard: readPool(limits.standard),
    core: readPool(limits.core),
    extraUsageBalanceCents: limitsBody.extraUsageBalanceCents,
    extraUsageAllowed: limitsBody.extraUsageAllowed,
  };
  if (typeof metrics.extraUsageBalanceCents !== 'number' || !Number.isFinite(metrics.extraUsageBalanceCents)) {
    metrics.extraUsageBalanceCents = null;
  }
  if (typeof metrics.extraUsageAllowed !== 'boolean') metrics.extraUsageAllowed = null;

  // Optional plan tier from the authenticated organization subscription
  // (direct body path organization.subscription.factoryTier). A failure here
  // only means no label; the collected limits and balance stand.
  let tier;
  try {
    const me = await fetchJsonOptional(fetchImpl, new URL(AUTH_ME_PATH, baseUrl), headers);
    const value = me?.organization?.subscription?.factoryTier;
    if (typeof value === 'string' && /^[a-z_]{1,32}$/.test(value)) tier = value;
  } catch {
    // Tier stays optional; keep the metrics collected so far.
  }

  // Optional account session inventory: the lite sessions list is the one
  // account-wide endpoint that works for personal plans. Only PROVEN
  // self-owned rows (the authenticated user id resolved on both sides) are
  // counted; rows without a resolvable owner are counted separately and
  // never credited. Root/child credit semantics are not proven, so the sum
  // is a RECENT SAMPLE of reported per-session values, never a total
  // account spend. Complete stays false. No session ids, titles, or owner
  // identifiers are emitted.
  let accountRecentSessions;
  try {
    const list = await fetchJsonOptional(fetchImpl,
      new URL('/api/sessions/v2?limit=20&lite=true', baseUrl), headers);
    const rows = Array.isArray(list?.sessions) ? list.sessions : [];
    const userId = typeof user?.userId === 'string' ? user.userId : null;
    let sessionCount = 0;
    let creditsSampleTotal = 0;
    let unknownOwnerRows = 0;
    if (userId) {
      for (const row of rows) {
        if (typeof row !== 'object' || row === null) continue;
        const ownerId = typeof row.owner === 'string' ? row.owner
          : (typeof row.owner?.id === 'string' ? row.owner.id : null);
        if (!ownerId) {
          unknownOwnerRows += 1;
          continue;
        }
        if (ownerId !== userId) continue; // not proven self-owned
        if (typeof row.factoryCredits === 'number' && Number.isFinite(row.factoryCredits)) {
          creditsSampleTotal += row.factoryCredits;
          sessionCount += 1;
        }
      }
    } else {
      unknownOwnerRows = rows.filter(r => typeof r === 'object' && r !== null).length;
    }
    if (sessionCount > 0 || unknownOwnerRows > 0) {
      accountRecentSessions = {
        requestedLimit: 20,
        sessionCount,
        creditsSampleTotal,
        unknownOwnerRows,
        hasMore: list?.pagination?.hasMore === true,
        complete: false,
        scope: 'recent sample of the account session inventory; not a total account ledger',
      };
    }
  } catch {
    // Inventory stays optional; the metrics collected so far stand.
  }

  if (typeof tier === 'string') metrics.tier = tier;
  if (accountRecentSessions) metrics.accountRecentSessions = accountRecentSessions;
  return metrics;
}

function isMain() {
  try {
    return Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === process.argv[1];
  } catch {
    return false;
  }
}

// CLI: [--bundle <path>]. The bundle is the VENDOR bundle (its Electron
// binary runs this helper and its app archive carries the auth chunk).
// Packaged use derives the bundle from this file's own location
// (<bundle>/port/auth-helper.mjs); standalone deployments pass --bundle
// explicitly so the vendor bundle never needs a local helper copy.
function bundleFromArgv(argv) {
  const flagIndex = argv.indexOf('--bundle');
  if (flagIndex !== -1 && argv[flagIndex + 1]) return path.resolve(argv[flagIndex + 1]);
  const value = argv.find(a => a.startsWith('--bundle='));
  if (value) return path.resolve(value.slice('--bundle='.length));
  return path.dirname(path.dirname(fileURLToPath(import.meta.url)));
}

async function main() {
  process.on('uncaughtException', () => emit({ ok: false, error: 'helper-error' }));
  process.on('unhandledRejection', () => emit({ ok: false, error: 'helper-error' }));
  try {
    emit(await run({ bundlePath: bundleFromArgv(process.argv.slice(2)) }));
  } catch (error) {
    const category = error instanceof HelperFailure ? error.category : 'helper-error';
    emit({ ok: false, error: category });
  }
}

if (isMain()) main();
