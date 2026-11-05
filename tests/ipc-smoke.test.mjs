// Tests for the IPC smoke check's success guard: a clean exit without the
// factory.daemon.ready message must fail, not pass.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runSmoke, daemonEnvironment } from './ipc-smoke.mjs';

function fakeChild({ messages = [], exitCode = 0, exitSignal = null, exitAfterMs = 0, error }) {
  const child = {
    onMessage(handler) { this._message = handler; },
    onError(handler) { this._error = handler; },
    onExit(handler) { this._exit = handler; },
    kill() { child.killed = true; },
  };
  setTimeout(() => {
    if (error) {
      child._error(error);
      return;
    }
    for (const message of messages) child._message(message);
    child._exit(exitCode, exitSignal);
  }, exitAfterMs);
  return child;
}

async function withTemp(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'factory-smoke-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('ready message followed by clean shutdown passes', async () => {
  await withTemp(async dir => {
    const result = await runSmoke({
      bundle: dir, timeoutMs: 5000, homeFactory: () => dir,
      spawnImpl: () => fakeChild({ messages: [{ type: 'factory.daemon.ready', pid: 1 }] }),
    });
    assert.equal(result.ok, true, result.reason);
  });
});

test('a clean exit without ready is a failure', async () => {
  await withTemp(async dir => {
    const result = await runSmoke({
      bundle: dir, timeoutMs: 5000, homeFactory: () => dir,
      spawnImpl: () => fakeChild({ exitCode: 0 }),
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /exited before ready/);
  });
});

test('non-ready and malformed messages do not satisfy the guard', async () => {
  await withTemp(async dir => {
    const result = await runSmoke({
      bundle: dir, timeoutMs: 5000, homeFactory: () => dir,
      spawnImpl: () => fakeChild({
        messages: ['garbage string', { type: 'factory.daemon.notready' }, null, { noType: true }],
      }),
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /exited before ready/);
  });
});

test('spawn errors and timeouts fail', async () => {
  await withTemp(async dir => {
    const result = await runSmoke({
      bundle: dir, timeoutMs: 5000, homeFactory: () => dir,
      spawnImpl: () => fakeChild({ error: new Error('ENOENT') }),
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /failed to start/);
  });
  await withTemp(async dir => {
    const result = await runSmoke({
      bundle: dir, timeoutMs: 30, homeFactory: () => dir,
      spawnImpl: () => fakeChild({ exitAfterMs: 5000 }),
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /timed out before ready/);
  });
});

test('unexpected exit after ready fails', async () => {
  await withTemp(async dir => {
    const result = await runSmoke({
      bundle: dir, timeoutMs: 5000, homeFactory: () => dir,
      spawnImpl: () => fakeChild({ messages: [{ type: 'factory.daemon.ready' }], exitCode: 1 }),
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /unexpected exit after ready/);
  });
});

test('the daemon child env is allowlisted: ambient credentials never cross', () => {
  const ambient = {
    PATH: '/usr/bin', LANG: 'C.UTF-8', TMPDIR: '/tmp',
    FACTORY_API_KEY: 'fk-synthetic-not-a-real-key',
    GH_TOKEN: 'ghu-synthetic-not-a-real-token',
    AWS_SECRET_ACCESS_KEY: 'synthetic-not-a-secret',
    NODE_OPTIONS: '--require=evil.js',
    ELECTRON_RUN_AS_NODE: '1',
    ELECTRON_NO_ASAR: '1',
    FACTORY_DESKTOP_RENDERER_URL: 'http://127.0.0.1:9',
    FACTORY_E2E_DAEMON_HOOKS: '1',
    FACTORY_DESKTOP_DAEMON_BINARY: '/evil/droid',
  };
  const env = daemonEnvironment('/tmp/fake-home', ambient);
  for (const key of Object.keys(ambient)) {
    if (!['PATH', 'LANG', 'TMPDIR'].includes(key)) {
      assert.equal(env[key], undefined, `${key} must not reach the daemon child`);
    }
  }
  assert.equal(env.HOME, '/tmp/fake-home');
  assert.equal(env.FACTORY_DISABLE_KEYRING, '1');
  assert.match(env.FACTORY_HOME_OVERRIDE, /factory-home$/);
  assert.equal(env.HTTP_PROXY, 'http://127.0.0.1:9');
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:9');
  assert.equal(env.ALL_PROXY, 'http://127.0.0.1:9');
});
