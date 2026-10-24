// Guards the port's desktop computer registration layer against the real,
// checksum-pinned upstream 0.206.0 payload.
//
// The defect this covers: upstream registers the local computer with the
// account exactly once, from the startup sequence, before a fresh profile
// can hold an auth token. When the token is missing, upstream logs
// "[computer] No auth token available, skipping auto-registration" and never
// retries. The local host configuration therefore never gains a
// computerRegistration, computer:getLocalId answers null, and the renderer's
// "This Computer" card in Settings > Droid Computers is never rendered.
//
// These tests are deliberately not fixtures. They load the actual unpatched
// bundle, require every anchor to match it exactly once, apply the recipe,
// and then execute the patched registration driver, the patched sign-in
// callback and the patched local-id IPC handler extracted from the patched
// bytes. The negative controls run the same scenario against the untouched
// upstream bytes, so the suite fails on the unfixed payload and passes on the
// fixed one.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { factoryPortCreateComputerRegistration,
  computerRegistrationMainChanges,
  computerRegistrationRendererChanges,
  computerRegistrationHelperNames,
  diagnoseComputerRegistrationHelpers,
} from '../tools/computer-registration-patches.mjs';
import { patch, diagnose } from '../tools/patches.mjs';
import { SNAPSHOT_DIR, versions } from '../tools/common.mjs';

const flush = async () => { for (let i = 0; i < 200; i++) await Promise.resolve(); };

// The vendor snapshot and the chunk names come from the pins the build
// already uses, so this suite never repeats a desktop version or a bundle
// name of its own.
const upstreamMainPath = path.join(SNAPSHOT_DIR, 'app', versions.lifecycle);
const upstreamRendererPath = path.join(SNAPSHOT_DIR, 'app', versions.renderer);
const present = existsSync(upstreamMainPath) && existsSync(upstreamRendererPath);
const SKIP = 'the pristine vendor snapshot is absent; run the build to produce it';
const sourceOptions = { skip: present ? false : SKIP };
const upstreamMain = present ? readFileSync(upstreamMainPath, 'utf8') : '';
const upstream = present ? readFileSync(upstreamRendererPath, 'utf8') : '';

function sliceBetween(source, from, to) {
  const start = source.indexOf(from);
  assert.notEqual(start, -1, `missing marker: ${from}`);
  const end = source.indexOf(to, start);
  assert.notEqual(end, -1, `missing marker: ${to}`);
  return source.slice(start, end + to.length);
}

// The text before a marker, exclusive: used to lift a self-contained block
// out of the bundle without dragging the marker into it.
function sliceUntil(source, from, to) {
  const start = source.indexOf(from);
  assert.notEqual(start, -1, `missing marker: ${from}`);
  const end = source.indexOf(to, start);
  assert.notEqual(end, -1, `missing marker: ${to}`);
  return source.slice(start, end);
}

// ---------------------------------------------------------------------------
// The registration driver, on its own.
// ---------------------------------------------------------------------------

function driverHarness(overrides = {}) {
  const state = { token: null, computerId: null, registrations: 0, credentials: [],
    warnings: [], infos: [], errors: [] };
  const driver = factoryPortCreateComputerRegistration({
    getToken: async () => { state.credentials.push(state.token); return state.token; },
    getLocalComputerId: async () => state.computerId,
    register: async token => {
      state.registrations++;
      state.registeredWith = token;
      state.computerId = 'computer-1';
    },
    logInfo: (message, details) => state.infos.push([message, details]),
    logWarn: message => state.warnings.push(message),
    logError: (message, error) => state.errors.push([message, error]),
    ...overrides,
  });
  return { state, driver };
}

// The driver reads the real clock. A case that has to move time runs the
// driver in a sandbox with its own clock, so the production API carries no
// clock seam.
function driverWithClock(options, clock) {
  const sandbox = { Date: { now: () => clock.now }, console };
  vm.createContext(sandbox);
  const factory = vm.runInContext(`(${factoryPortCreateComputerRegistration.toString()})`, sandbox);
  return factory(options);
}

test('a profile without credentials never registers and never throws', async () => {
  const h = driverHarness();
  const result = await h.driver.ensure();
  assert.equal(result, null);
  assert.equal(h.state.registrations, 0, 'registration must not run without credentials');
  assert.equal(h.state.warnings.length, 1);
  assert.match(h.state.warnings[0], /No auth token available/);
  assert.equal(h.state.errors.length, 0);
});

test('the missing-credentials deferral is reported once, not on every call', async () => {
  // A caller that polls for the local computer id must not fill the log
  // with the same line.
  const h = driverHarness();
  await h.driver.ensure();
  await h.driver.ensure();
  await h.driver.ensure();
  assert.equal(h.state.warnings.length, 1);
  assert.equal(h.state.registrations, 0);
});

test('an authenticated profile registers once and reports the computer id', async () => {
  const h = driverHarness();
  h.state.token = 'token';
  const result = await h.driver.ensure();
  assert.equal(result, 'computer-1');
  assert.equal(h.state.registrations, 1);
  assert.equal(h.state.errors.length, 0);
  assert.equal(h.state.infos.length, 1);
  assert.match(h.state.infos[0][0], /Local computer registered/);
});

test('the credentials the driver read are handed to the registration', async () => {
  // One credential read serves the driver and upstream's own preflight:
  // the driver never reads the credentials a second time to decide what to
  // do, and upstream never reads them again either.
  const h = driverHarness();
  h.state.token = 'token';
  await h.driver.ensure();
  assert.deepEqual(h.state.credentials, ['token']);
  assert.equal(h.state.registeredWith, 'token');
});

test('a stored local id is not treated as a verified registration', async () => {
  // The driver always reaches upstream's registration, so upstream's own
  // verification, host-id repair and re-registration of an existing record
  // still run. The driver never short-circuits on a stored id.
  const h = driverHarness();
  h.state.token = 'token';
  h.state.computerId = 'computer-9';
  await h.driver.ensure();
  assert.equal(h.state.registrations, 1,
    'upstream must still be asked to verify the stored registration');
});

test('concurrent callers share a single registration attempt', async () => {
  const h = driverHarness();
  h.state.token = 'token';
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const slow = factoryPortCreateComputerRegistration({
    getToken: async () => 'token',
    getLocalComputerId: async () => h.state.computerId,
    register: async () => { h.state.registrations++; await gate; h.state.computerId = 'computer-1'; },
  });
  const first = slow.ensure();
  const second = slow.ensure();
  assert.equal(first, second, 'the second caller joins the attempt in flight');
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a, 'computer-1');
  assert.equal(b, 'computer-1');
  assert.equal(h.state.registrations, 1, 'the registration must never run twice at once');
});

test('a failed attempt is contained and the cooldown suppresses an immediate retry', async () => {
  const h = driverHarness();
  h.state.token = 'token';
  const failing = factoryPortCreateComputerRegistration({
    getToken: async () => 'token',
    getLocalComputerId: async () => h.state.computerId,
    register: async () => { h.state.registrations++; throw new Error('backend unavailable'); },
    logError: (message, error) => h.state.errors.push([message, error]),
  });
  const result = await failing.ensure();
  assert.equal(result, null, 'a failing registration must not break the caller');
  assert.equal(h.state.errors.length, 1);
  assert.equal(h.state.errors[0][1].message, 'backend unavailable');
  await failing.ensure();
  assert.equal(h.state.registrations, 1, 'the cooldown suppresses an immediate retry');
  await failing.ensure({ force: true });
  assert.equal(h.state.registrations, 2, 'a forced attempt bypasses the cooldown');
});

test('a forced request during an older attempt is queued and runs after it', async () => {
  // The older attempt may have read the credentials from before the
  // sign-in. The forced attempt waits for it and then reads the committed
  // ones, so the registration still happens.
  let token = null;
  let release;
  const state = { attempts: 0, computerId: null, credentials: [] };
  const driver = factoryPortCreateComputerRegistration({
    getToken: async () => {
      const captured = token;
      state.credentials.push(captured);
      if (state.credentials.length === 1) await new Promise(resolve => { release = resolve; });
      return captured;
    },
    getLocalComputerId: async () => state.computerId,
    register: async () => { state.attempts++; state.computerId = 'computer-1'; },
  });
  const startup = driver.ensure();
  while (!release) await Promise.resolve();
  token = 'signed-in-token';
  const signIn = driver.ensure({ force: true });
  release();
  const [, forced] = await Promise.all([startup, signIn]);
  assert.equal(forced, 'computer-1', 'the forced attempt must reach the registration');
  assert.equal(state.attempts, 1, 'the stale attempt must not register anything');
  assert.deepEqual(state.credentials, [null, 'signed-in-token'],
    'the forced attempt must read the committed credentials');
  assert.equal(await driver.ensure(), 'computer-1');
  assert.equal(state.attempts, 1, 'the cooldown keeps a later caller from registering twice');
});

test('callers that only observe the cooldown do not postpone the retry', async () => {
  const clock = { now: 1000 };
  const state = { attempts: 0, computerId: null };
  const driver = driverWithClock({
    getToken: async () => 'token',
    getLocalComputerId: async () => state.computerId,
    register: async () => {
      if (++state.attempts === 1) throw new Error('backend unavailable');
      state.computerId = 'computer-1';
    },
    logError: () => {},
  }, clock);
  assert.equal(await driver.ensure(), null);
  for (clock.now = 6000; clock.now < 31000; clock.now += 5000) await driver.ensure();
  clock.now = 31000;
  assert.equal(await driver.ensure(), 'computer-1',
    'the original deadline must still allow the retry');
  assert.equal(state.attempts, 2);
});

test('a login during a running forced attempt gets its own credential read', async () => {
  // The first login's attempt is already running when the second login
  // completes. The second login must not join that running attempt: it
  // would be answered with an account that may already be revoked, and the
  // new account would stay unregistered.
  let token = null;
  let releaseStartup;
  let releaseRegistration;
  const state = { attempts: [], computerIds: new Map(), credentials: [] };
  const driver = factoryPortCreateComputerRegistration({
    getToken: async () => {
      const captured = token;
      state.credentials.push(captured);
      if (state.credentials.length === 1) await new Promise(resolve => { releaseStartup = resolve; });
      return captured;
    },
    getLocalComputerId: async () => state.computerIds.get(token) ?? null,
    register: async credentials => {
      state.attempts.push(credentials);
      if (credentials === 'token-A')
        await new Promise(resolve => { releaseRegistration = resolve; });
      state.computerIds.set(credentials, `computer-${credentials}`);
    },
  });
  const startup = driver.ensure();
  while (!releaseStartup) await Promise.resolve();
  token = 'token-A';
  const loginA = driver.ensure({ force: true });
  releaseStartup();
  await flush();
  assert.deepEqual(state.attempts, ['token-A'], 'the first login is registering');
  token = 'token-B';
  const loginB = driver.ensure({ force: true });
  releaseRegistration();
  await Promise.all([startup, loginA, loginB, driver.settled()]);
  assert.deepEqual(state.attempts, ['token-A', 'token-B'],
    'the second login must not be merged into the running attempt');
  assert.equal(state.computerIds.get('token-B'), 'computer-token-B');
});

test('forced requests that arrive before the queued attempt starts coalesce', async () => {
  // Two sign-ins while the queued attempt is still waiting read the
  // credentials of the last one: the queued attempt has not read anything
  // yet, so there is nothing stale to preserve.
  let token = null;
  let release;
  const state = { attempts: [], credentials: [] };
  const driver = factoryPortCreateComputerRegistration({
    getToken: async () => {
      const captured = token;
      state.credentials.push(captured);
      if (state.credentials.length === 1) await new Promise(resolve => { release = resolve; });
      return captured;
    },
    getLocalComputerId: async () => null,
    register: async credentials => { state.attempts.push(credentials); },
  });
  const startup = driver.ensure();
  token = 'token-A';
  const loginA = driver.ensure({ force: true });
  token = 'token-B';
  const loginB = driver.ensure({ force: true });
  release();
  await Promise.all([startup, loginA, loginB]);
  assert.deepEqual(state.attempts, ['token-B']);
});

// ---------------------------------------------------------------------------
// Upstream's own registration function, executed.
// ---------------------------------------------------------------------------

// Upstream's registration function, lifted from the real bundle and run
// against synthetic dependencies. The bytes decide what a registration
// does; only the network, the local configuration and the vendor runtime
// module are replaced.
function upstreamRegistration(source) {
  const start = source.indexOf('async function Rj(');
  const end = source.indexOf('function gy(){return oA()}', start);
  assert.ok(start >= 0 && end > start, 'upstream registration function not found');
  const state = { id: 'deleted-computer', requests: [], tokenReads: 0, warnings: [] };
  const sandbox = {
    i: {
      getHostedServicesEnabled: () => true,
      getAuthToken: async () => { state.tokenReads++; return 'synthetic-token'; },
      getRuntimeAuthConfig: () => ({}),
      getEnv: () => ({ apiBaseUrl: 'https://synthetic.invalid' }),
      customFetch: async (url, options) => {
        state.requests.push([url, options?.method ?? 'GET']);
        if (options?.method === 'POST') return { json: async () => ({ id: 'new-computer' }) };
        throw { response: { status: 404 } };
      },
      isFetchError: error => !!error?.response,
      HttpStatusCode: { NotFound: 404, Conflict: 409 },
      ComputerSchema: { parse: value => value },
      CreateComputerRequestSchema: { parse: value => value },
      ComputerProviderType: { Byom: 'byom' },
      logWarn: message => state.warnings.push(message),
      logInfo: () => {},
      logException: () => {},
    },
    fl: async () => ({}),
    my: async () => (state.id ? { computerId: state.id } : null),
    X2: async id => { state.id = id; },
    Q2: async () => { state.id = null; },
    Aa: () => ({ getHostIdentity: async () => ({ hostId: 'synthetic-host' }) }),
    Tj: async () => [],
    Ij: () => undefined,
    Ej: name => name,
    Sj: name => name,
    _n: { hostname: () => 'synthetic-name', userInfo: () => ({ username: 'synthetic-user' }) },
    Fi: 5000,
    AbortSignal,
  };
  vm.createContext(sandbox);
  vm.runInContext(`${source.slice(start, end)};globalThis.register=Rj`, sandbox);
  return { state, register: sandbox.register };
}

test('upstream repairs a record the backend deleted', sourceOptions, async () => {
  const h = upstreamRegistration(upstreamMain);
  await h.register();
  assert.equal(h.state.id, 'new-computer');
  assert.equal(h.state.requests.length, 2);
});

test('the driver keeps upstream verification of an existing registration', sourceOptions, async () => {
  const h = upstreamRegistration(upstreamMain);
  const driver = factoryPortCreateComputerRegistration({
    getToken: async () => 'synthetic-token',
    getLocalComputerId: async () => h.state.id,
    register: token => h.register(token),
  });
  await driver.ensure();
  assert.equal(h.state.id, 'new-computer',
    'the deleted record must be repaired, not kept');
  assert.equal(h.state.requests.length, 2);
});

test('the patched registration behaves like the pristine one', sourceOptions, async () => {
  const patchedMain = patch(upstreamMain, computerRegistrationMainChanges);
  const pristine = upstreamRegistration(upstreamMain);
  await pristine.register();
  const patched = upstreamRegistration(patchedMain);
  await patched.register();
  assert.equal(patched.state.id, pristine.state.id);
  assert.deepEqual(patched.state.requests, pristine.state.requests);
  assert.deepEqual(patched.state.warnings, pristine.state.warnings);
});

test('the patched registration reuses the credentials the driver read', sourceOptions, async () => {
  const patchedMain = patch(upstreamMain, computerRegistrationMainChanges);
  const patched = upstreamRegistration(patchedMain);
  await patched.register('driver-token');
  assert.equal(patched.state.tokenReads, 0,
    'the registration must not read the credentials a second time');
  const pristine = upstreamRegistration(upstreamMain);
  await pristine.register();
  assert.equal(pristine.state.tokenReads, 1,
    'upstream reads the credentials itself when it is given none');
});

// ---------------------------------------------------------------------------
// The patched main process, with upstream's own registration and the
// organization-scoped storage next to it.
// ---------------------------------------------------------------------------

// Upstream's registration function, the local-id reader and the
// organization-scoped storage around them, taken from the patched bundle
// and run against synthetic services. The bytes are the real ones: only
// the vendor runtime, the configuration storage and the network are
// replaced.
function patchedRegistration(source, options = {}) {
  const state = {
    token: options.token === undefined ? null : options.token,
    context: options.context === undefined ? null : options.context,
    hosted: options.hosted ?? true,
    authReads: 0,
    requests: [],
    configs: new Map(),
    warnings: [],
    infos: [],
    errors: [],
    host: 'host-A',
  };
  const key = context => (context ? `${context.userId}/${context.organizationId}` : null);
  const i = {
    getHostedServicesEnabled: () => state.hosted,
    getAuthToken: async () => {
      state.authReads++;
      return options.tokenRead ? options.tokenRead(state) : state.token;
    },
    getRuntimeAuthConfig: () => ({}),
    getAuthedUser: async () => state.context,
    getEnv: () => ({ apiBaseUrl: 'https://synthetic.invalid' }),
    customFetch: async (url, opts = {}, config) => {
      const headers = await config.getHeaders();
      const method = opts.method ?? 'GET';
      state.requests.push({ url, method, authorization: headers.Authorization });
      if (options.request) {
        const response = await options.request({ url, method, state, headers });
        if (response) return response;
      }
      if (method === 'GET' && url !== '/api/v0/computers')
        return { json: async () => ({ id: 'new-computer', hostId: state.host }) };
      if (url === '/api/v0/computers' && method === 'GET')
        return { json: async () => ({ computers: [] }) };
      if (method === 'POST')
        return { json: async () => ({ id: 'new-computer', hostId: state.host }) };
      return { json: async () => ({}) };
    },
    isFetchError: error => !!error?.response,
    HttpStatusCode: { NotFound: 404, Conflict: 409 },
    ComputerSchema: { parse: value => value },
    ComputerListResponseSchema: { parse: value => value },
    CreateComputerRequestSchema: { parse: value => value },
    ComputerProviderType: { Byom: 'byom' },
    COMPUTER_CONFIG_FILENAME: 'computers.json',
    logWarn: message => state.warnings.push(message),
    logInfo: message => state.infos.push(message),
    logException: (error, message) => state.errors.push([message, error]),
  };
  const hostStore = {
    getHostIdentity: async () => ({ hostId: state.host }),
    getComputerConfig: async context => state.configs.get(key(context)) ?? null,
    removeComputerRegistration: async context => { state.configs.delete(key(context)); },
    saveComputerRegistration: async ({ computerId, authContext }) => {
      state.configs.set(key(authContext), { computerId });
    },
  };
  const sandbox = {
    i,
    fl: async () => {
      const context = await i.getAuthedUser(i.getRuntimeAuthConfig());
      return context?.organizationId ? context : null;
    },
    Aa: () => hostStore,
    vj: provider => provider === 'byom',
    Ej: name => name,
    Sj: name => name,
    _n: { hostname: () => 'synthetic-name', userInfo: () => ({ username: 'synthetic-user' }) },
    _j: 'synthetic-name',
    W3: () => '/synthetic',
    Fi: 5000,
    AbortSignal,
    X: { join: (...parts) => parts.join('/') },
    h3: () => '/synthetic',
    console,
  };
  vm.createContext(sandbox);
  const start = source.indexOf('async function my(){');
  const end = source.indexOf('function gy(){return oA()}', start);
  assert.ok(start >= 0 && end > start, 'upstream registration region not found');
  vm.runInContext(`${source.slice(start, end)};globalThis.register=Rj;globalThis.local=xj;`
    + 'globalThis.driver=typeof factoryPortComputerRegistration==="undefined"?null:'
    + 'factoryPortComputerRegistration;', sandbox);
  // The local-id handler, taken from the patched main.
  const handlerStart = 'x.ipcMain.handle("computer:getLocalId",';
  const from = source.indexOf(handlerStart);
  const to = source.indexOf(',x.ipcMain.handle("computer:getLocalHostId"', from);
  assert.ok(from >= 0 && to > from, 'the local computer id handler moved');
  const handler = vm.runInContext(`(${source.slice(from + handlerStart.length, to - 1)})`, sandbox);
  return { state, register: sandbox.register, local: sandbox.local, handler, driver: sandbox.driver };
}

test('a second login during a running forced attempt still registers the new account', sourceOptions, async () => {
  // The real patched registration, the real organization-scoped storage and
  // the real local-id handler. The first account's registration is refused
  // by the backend while the second account signs in: the second account
  // must still be registered, and the handler must report its id.
  const patchedMain = patch(upstreamMain, computerRegistrationMainChanges);
  let releaseStartup;
  let releaseBackend;
  const h = patchedRegistration(patchedMain, {
    token: null,
    tokenRead: async state => {
      const token = state.token;
      if (state.authReads === 1) await new Promise(resolve => { releaseStartup = resolve; });
      return token;
    },
    request: async ({ method, headers }) => {
      if (method === 'POST' && headers.Authorization === 'Bearer token-A') {
        await new Promise(resolve => { releaseBackend = resolve; });
        throw { response: { status: 401 } };
      }
    },
  });
  const startup = h.driver.ensure();
  h.state.token = 'token-A';
  h.state.context = { userId: 'user-A', organizationId: 'org-A' };
  const loginA = h.driver.ensure({ force: true });
  releaseStartup();
  await flush();
  assert.equal(h.state.requests.at(-1)?.method, 'POST',
    'the first account must be registering');
  h.state.token = 'token-B';
  h.state.context = { userId: 'user-B', organizationId: 'org-B' };
  const loginB = h.driver.ensure({ force: true });
  const localRead = h.handler();
  releaseBackend();
  await Promise.all([startup, loginA, loginB]);
  assert.equal(await localRead, 'new-computer',
    'the second account must be registered even though the first one failed');
  assert.ok(h.state.requests.some(request => request.authorization === 'Bearer token-B'),
    'the second account must reach the backend with its own credentials');
  assert.equal(h.state.configs.get('user-B/org-B')?.computerId, 'new-computer');
});



test('every registration anchor matches the real unpatched 0.206.0 source once', sourceOptions, () => {
  assert.deepEqual(diagnose(upstreamMain, computerRegistrationMainChanges), [],
    'main-process registration anchors drifted');
  assert.deepEqual(diagnose(upstream, computerRegistrationRendererChanges), [],
    'renderer registration anchor drifted');
  assert.deepEqual(diagnoseComputerRegistrationHelpers(upstreamMain), []);
  assert.deepEqual(diagnoseComputerRegistrationHelpers(upstream), []);
});

test('the patched main process and renderer stay valid JavaScript', sourceOptions, () => {
  const patchedMain = patch(upstreamMain, computerRegistrationMainChanges);
  const patchedRenderer = patch(upstream, computerRegistrationRendererChanges);
  for (const [label, source] of [['main', patchedMain], ['renderer', patchedRenderer]]) {
    const syntax = spawnSync(process.execPath, ['--check', '--input-type=module'],
      { input: source, encoding: 'utf8' });
    assert.equal(syntax.status, 0, `${label}: ${syntax.stderr?.split('\n')[0]}`);
  }
});

test('the registration patch reverses exactly', sourceOptions, () => {
  let patchedMain = patch(upstreamMain, computerRegistrationMainChanges);
  for (const [, before, after] of [...computerRegistrationMainChanges].reverse()) {
    assert.equal(patchedMain.split(after).length - 1, 1);
    patchedMain = patchedMain.replace(after, before);
  }
  assert.equal(patchedMain, upstreamMain);
  let patchedRenderer = patch(upstream, computerRegistrationRendererChanges);
  for (const [, before, after] of [...computerRegistrationRendererChanges].reverse()) {
    assert.equal(patchedRenderer.split(after).length - 1, 1);
    patchedRenderer = patchedRenderer.replace(after, before);
  }
  assert.equal(patchedRenderer, upstream);
});

test('the layer never touches remote access, the relay or the daemon', sourceOptions, () => {
  for (const [name, , after] of [...computerRegistrationMainChanges,
    ...computerRegistrationRendererChanges]) {
    assert.doesNotMatch(after, /RemoteAccess|remoteAccess|startRelay|stopRelay|getRelayStatus/,
      `${name} must not reach the remote-access preference or the relay`);
    assert.doesNotMatch(after, /spawn|execFile|droid\b/,
      `${name} must not start a second daemon`);
  }
});

// ---------------------------------------------------------------------------
// Negative control: the untouched upstream payload really does skip the
// registration, and the patched payload really does not.
// ---------------------------------------------------------------------------

test('negative control: upstream registers the computer only at startup', sourceOptions, () => {
  // The registration function exists exactly once, and the startup sequence
  // is its only call site. Neither sign-in path reaches it, so a profile that
  // signs in after startup stays unregistered.
  assert.equal(upstreamMain.split('async function Rj(){').length - 1, 1);
  assert.equal(upstreamMain.split('Rj(),i.startupTracker.beginPhase').length - 1, 1);
  const browserSignIn = sliceBetween(upstreamMain, 'p(i.DesktopSignInProgress.Connecting),',
    'webContents.send("auth:success",{user:m.user})');
  assert.ok(browserSignIn.includes('await Bp(),cn(u).webContents.send('),
    'the browser sign-in completion moved');
  assert.doesNotMatch(browserSignIn, /\bRj\(|ensure\(/,
    'the browser sign-in must not reach the registration');
  const customerSignIn = sliceBetween(upstreamMain, 'await O(),await Bp();',
    'Dr("auth:success",{user:A})');
  assert.ok(customerSignIn.includes('const{user:A}=await P3();'));
  assert.doesNotMatch(customerSignIn, /\bRj\(|ensure\(/,
    'the customer sign-in must not reach the registration');
  // The local computer id is read straight from the local configuration,
  // with nothing in between that could register the computer.
  const handler = sliceBetween(upstreamMain, 'x.ipcMain.handle("computer:getLocalId"',
    'async()=>xj())');
  assert.ok(handler.endsWith('async()=>xj())'));
  assert.doesNotMatch(handler, /ensure\(|await/,
    'upstream reads the local id without registering anything');
});

test('the patched payload registers the computer once the account is signed in', sourceOptions, () => {
  const patchedMain = patch(upstreamMain, computerRegistrationMainChanges);
  for (const [from, to] of [
    ['p(i.DesktopSignInProgress.Connecting),', 'webContents.send("auth:success",{user:m.user})'],
    ['await O(),await Bp();', 'Dr("auth:success",{user:A})'],
  ]) {
    const signIn = sliceBetween(patchedMain, from, to);
    assert.ok(signIn.includes('factoryPortComputerRegistration.ensure({force:!0})'),
      `the sign-in path ${from} must reach the registration`);
    // The sign-in flow itself is not delayed by the backend round trip.
    assert.ok(signIn.indexOf('ensure({force:!0})') < signIn.indexOf('auth:success'));
    assert.doesNotMatch(signIn, /await factoryPortComputerRegistration/,
      'the sign-in flow must not wait for the registration');
  }
});

// ---------------------------------------------------------------------------
// The patched main process, executed.
// ---------------------------------------------------------------------------

function patchedScenario({ upstreamBytes }) {
  const source = upstreamBytes
    ? upstreamMain
    : patch(upstreamMain, computerRegistrationMainChanges);
  const driver = upstreamBytes ? '' : sliceUntil(source,
    'function factoryPortCreateComputerRegistration({',
    'async function xj(){if(!i.getHostedServicesEnabled())return null;');
  // The browser sign-in completion: the credentials are stored just before
  // it, and the renderer is told that the account is ready just after.
  const signIn = sliceBetween(source, 'p(i.DesktopSignInProgress.Connecting),',
    'webContents.send("auth:success",{user:m.user})');
  // The handler is an IPC registration; the callable is its arrow function.
  const handlerPrefix = 'x.ipcMain.handle("computer:getLocalId",';
  const handlerStart = source.indexOf(handlerPrefix);
  assert.notEqual(handlerStart, -1, 'the local computer id handler moved');
  const handlerEnd = source.indexOf(',x.ipcMain.handle("computer:getLocalHostId"', handlerStart);
  assert.notEqual(handlerEnd, -1, 'the local computer id handler moved');
  const handler = source.slice(handlerStart + handlerPrefix.length, handlerEnd - 1);
  return { driver, signIn, handler };
}

async function runScenario({ upstreamBytes }) {
  const { driver, signIn, handler } = patchedScenario({ upstreamBytes });
  // The upstream dependencies live at the top level of the script, exactly
  // as they do in the main process module, so the injected driver closes over
  // the same bindings the real bundle uses.
  const script = `${driver}
const state = { token: null, computerId: null, registrations: 0, registeredWith: null };
const xj = async () => state.computerId;
const Rj = async token => { state.registrations++; state.registeredWith = token; state.computerId = 'computer-1'; };
const i = {
  getHostedServicesEnabled: () => true,
  getRuntimeAuthConfig: () => ({}),
  getAuthToken: async () => state.token,
  logInfo: () => {}, logWarn: () => {}, logException: () => {},
  MetaError: class MetaError extends Error {},
  DesktopSignInProgress: { Connecting: 'connecting', Finishing: 'finishing' },
};
const p = () => {};
const Bp = async () => {};
const cn = () => ({ webContents: { send: () => {} } });
const u = 'callback-url';
const m = { user: { id: 'user-1' } };
globalThis.__run = async () => {
  const before = await (${handler})();
  // The sign-in stores the credentials before it announces the account.
  state.token = 'token';
  ${signIn}
  await new Promise(resolve => setTimeout(resolve, 0));
  const after = await (${handler})();
  return { before, after, registrations: state.registrations,
    registeredWith: state.registeredWith };
};`;
  const sandbox = { setTimeout, console };
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox);
  return sandbox.__run();
}

test('the patched main process registers the computer after signing in', sourceOptions, async () => {
  const result = await runScenario({ upstreamBytes: false });
  assert.equal(result.before, null, 'before signing in there is no local computer id');
  assert.equal(result.registrations, 1, 'signing in must reach the registration');
  assert.equal(result.registeredWith, 'token',
    'the registration must run with the committed credentials');
  assert.equal(result.after, 'computer-1',
    'the local computer id must be readable once the computer is registered');
});

test('negative control: upstream never registers the computer after signing in', sourceOptions, async () => {
  const result = await runScenario({ upstreamBytes: true });
  assert.equal(result.before, null);
  assert.equal(result.registrations, 0,
    'upstream must not register the computer on its own after signing in');
  assert.equal(result.after, null,
    'upstream leaves the local computer id empty, so "This Computer" is never rendered');
});

test('an already registered computer is answered without registering anything', sourceOptions, async () => {
  const { driver, handler } = patchedScenario({ upstreamBytes: false });
  const script = `${driver}
const state = { token: 'token', computerId: 'computer-1', registrations: 0 };
const xj = async () => state.computerId;
const Rj = async token => { state.registrations++; state.computerId = 'computer-2'; };
const i = {
  getHostedServicesEnabled: () => true,
  getRuntimeAuthConfig: () => ({}),
  getAuthToken: async () => state.token,
  logInfo: () => {}, logWarn: () => {}, logException: () => {},
};
globalThis.__run = async () => ({
  computerId: await (${handler})(),
  registrations: state.registrations,
});`;
  const sandbox = { setTimeout, console };
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox);
  const result = await sandbox.__run();
  assert.equal(result.computerId, 'computer-1');
  assert.equal(result.registrations, 0,
    'a registered computer must not be registered again');
});

// ---------------------------------------------------------------------------
// The patched renderer, executed.
// ---------------------------------------------------------------------------

// The settings page effect that resolves the local computer id, taken from
// the real bundle. The patched page declares the ref it compares against;
// the unpatched page has no such declaration.
function settingsEffect(source) {
  const declared = source.indexOf('const factoryPortLocalComputerIdRef=L.useRef(null);');
  const from = declared >= 0 ? declared : source.indexOf('Xt(()=>{if(!s)return;async function K(){');
  const end = source.indexOf('}}K()});', from);
  assert.ok(from >= 0 && end > from, 'the settings effect moved');
  return source.slice(from, end + '}}K()});'.length);
}

// Upstream's own effect helper: it runs an effect once, on mount.
function upstreamEffectHelper(source) {
  const match = /function Xt\(t\)\{L\.useEffect\(t,\[\]\)\}/.exec(source);
  assert.ok(match, 'the upstream effect helper moved');
  return match[0];
}

// A stand-in for the query object behind upstream's computer list, with the
// same read de-duplication: a read while another read is in flight joins it
// when the query holds no data, and a read after it settled reaches the
// network again.
function queryStub() {
  const state = { data: undefined, fetchStatus: 'idle', requests: 0 };
  let current = null;
  const query = {
    state,
    fetch() {
      if (state.fetchStatus !== 'idle' && current) {
        if (state.data === undefined) return current.promise;
        // With data in hand upstream cancels the pending read and starts a
        // new one instead of joining it.
        current.settle(state.data);
      }
      state.fetchStatus = 'fetching';
      state.requests += 1;
      let settle;
      const entry = { settle: value => settle(value) };
      entry.promise = new Promise(resolve => { settle = resolve; }).then(value => {
        if (current === entry) { state.fetchStatus = 'idle'; state.data = value; }
        return value;
      });
      current = entry;
      return entry.promise;
    },
    settle(value) { current.settle(value); },
  };
  return query;
}

function rendererSandbox(query, { fail = false } = {}) {
  const state = { ids: [], loaded: 0, refreshes: 0, errors: [], list: null, ref: null };
  const sandbox = {
    L: {
      // A ref keeps its value across renders of the same page.
      useRef: value => { if (!state.ref) state.ref = { current: value }; return state.ref; },
      useEffect: (fn, deps) => {
        assert.equal(deps.length, 0, 'the upstream effect runs on mount only');
        fn();
      },
    },
    s: true,
    C: value => state.ids.push(value),
    I: value => { state.loaded = value; },
    u: async () => {
      state.refreshes++;
      if (fail) throw new Error('network down');
      const data = await query.fetch(undefined, { cancelRefetch: true });
      state.list = data;
      return { data };
    },
    et: (message, details) => { state.errors.push([message, details]); },
    window: { electronAPI: { getLocalComputerId: async () => 'new-computer' } },
    console,
  };
  return { state, sandbox };
}

function runSettingsEffect(source, query, options) {
  const { state, sandbox } = rendererSandbox(query, options);
  vm.createContext(sandbox);
  const script = `${upstreamEffectHelper(source)}\n(()=>{${settingsEffect(source)}})()`;
  vm.runInContext(script, sandbox);
  return { state, sandbox, script };
}

test('the settings page reads the computer list again after the registration', sourceOptions, async () => {
  const patchedRenderer = patch(upstream, computerRegistrationRendererChanges);
  const query = queryStub();
  // The page's own list read is still in flight when the local computer id
  // appears: it was sent before the computer existed.
  query.fetch();
  const { state } = runSettingsEffect(patchedRenderer, query);
  await flush();
  assert.deepEqual(state.ids, ['new-computer'], 'the local computer id reaches the page');
  assert.equal(query.state.requests, 1,
    'the read the page already had in flight is joined, not restarted');
  // The read the page already had in flight settles with the list from
  // before the registration.
  query.settle({ data: { computers: [] } });
  await flush();
  assert.equal(query.state.requests, 2,
    'a fresh list read is required after the registration');
  // That fresh read reaches the network and returns the registered
  // computer.
  query.settle({ data: { computers: [{ id: 'new-computer' }] } });
  await flush();
  assert.deepEqual(state.list.data.computers.map(computer => computer.id),
    ['new-computer'], 'the page must end up with the registered computer');
});

test('negative control: the unpatched page keeps the pre-registration list', sourceOptions, async () => {
  const query = queryStub();
  query.fetch();
  const { state } = runSettingsEffect(upstream, query);
  await flush();
  query.settle({ data: { computers: [] } });
  await flush();
  assert.equal(state.refreshes, 0, 'the unpatched page never reads the list again');
  assert.equal(query.state.requests, 1);
  assert.equal(state.list, null,
    'the unpatched page never learns about the registered computer');
});

test('the settings page never refreshes the list twice for one local id', sourceOptions, async () => {
  const patchedRenderer = patch(upstream, computerRegistrationRendererChanges);
  const query = queryStub();
  query.fetch();
  const { state, sandbox, script } = runSettingsEffect(patchedRenderer, query);
  await flush();
  query.settle({ data: { computers: [] } });
  await flush();
  query.settle({ data: { computers: [{ id: 'new-computer' }] } });
  await flush();
  assert.equal(state.refreshes, 2, 'one joined read and one fresh read');
  // A later render of the same page must not read the list again: the
  // effect runs on mount only, and the local computer id has not changed.
  vm.runInContext(script, sandbox);
  await flush();
  assert.equal(query.state.requests, 2, 'the page must not refetch forever');
});

test('the settings page keeps the local computer id when the refresh fails', sourceOptions, async () => {
  const patchedRenderer = patch(upstream, computerRegistrationRendererChanges);
  const query = queryStub();
  query.fetch();
  const { state } = runSettingsEffect(patchedRenderer, query, { fail: true });
  await flush();
  assert.deepEqual(state.ids, ['new-computer'], 'a failed refresh must not clear the local id');
  assert.equal(state.errors.length, 1);
  assert.match(state.errors[0][0], /Failed to refresh the computer list/);
});

test('the upstream effect runs on mount only', sourceOptions, () => {
  assert.ok(upstream.includes('function Xt(t){L.useEffect(t,[])}'));
});

test('the helper names are unique to this layer', () => {
  assert.deepEqual(computerRegistrationHelperNames,
    ['factoryPortCreateComputerRegistration', 'factoryPortComputerRegistration',
      'factoryPortLocalComputerIdRef']);
});
