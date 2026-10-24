import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { existsSync, readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { factoryPortCreateRelayRecovery, factoryPortObserveRelay,
  remoteControlRendererChanges } from '../tools/remote-control-patches.mjs';
import { patch, diagnose } from '../tools/patches.mjs';

const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
function harness() {
  const timers = new Map();
  const state = { enabled: true, allowed: true, id: 'test-computer',
    local: true, relay: false, starts: 0, stops: 0, connects: 0, errors: 0 };
  let sequence = 0;
  const connection = {
    isFullyConnected: () => state.local,
    getRelayStatus: async () => ({ connected: state.relay }),
    startRelay: async options => {
      assert.deepEqual(options, { timeout: 90000 });
      state.starts++; state.relay = true;
    },
    stopRelay: async () => { state.stops++; state.relay = false; },
  };
  const recovery = factoryPortCreateRelayRecovery({
    getEnabled: async () => state.enabled, isAllowed: () => state.allowed,
    getComputerId: async () => state.id, getConnection: () => connection,
    connectLocal: async () => { state.connects++; state.local = true; },
    onError: () => { state.errors++; },
    schedule: (callback, delay) => { const id = ++sequence; timers.set(id, { callback, delay }); return id; },
    cancel: id => timers.delete(id),
  });
  return { state, connection, recovery, timers, async tick() {
    assert.equal(timers.size, 1);
    const [id, entry] = timers.entries().next().value;
    timers.delete(id); entry.callback(); await flush(); return entry.delay;
  } };
}

test('recovers registration delayed beyond the upstream ten-second limit', async () => {
  const h = harness(); h.state.id = null; h.recovery.request(); await flush();
  const delays = [];
  for (let i = 0; i < 12; i++) delays.push(await h.tick());
  assert.equal(h.state.starts, 0);
  assert.equal(Math.max(...delays), 60000, 'backoff is capped, not a tight loop');
  h.state.id = 'test-computer'; await h.tick();
  assert.equal(h.state.starts, 1);
  assert.equal(h.state.relay, true);
  assert.equal(h.timers.size, 0, 'no steady-state polling');
});

test('retries a transient relay error, then verifies actual connected status', async () => {
  const h = harness();
  h.connection.startRelay = async () => {
    if (++h.state.starts === 1) throw new Error('simulated offline relay');
    h.state.relay = true;
  };
  h.recovery.request(); await flush();
  assert.equal(h.state.starts, 1); assert.equal(h.state.errors, 1);
  await h.tick();
  assert.equal(h.state.starts, 2); assert.equal(h.state.relay, true);
  assert.equal(h.timers.size, 0);
});

test('a successful RPC with disconnected status is not accepted as recovery', async () => {
  const h = harness(); h.connection.startRelay = async () => { h.state.starts++; };
  h.recovery.request(); await flush();
  assert.equal(h.state.relay, false); assert.equal(h.timers.size, 1);
  h.state.relay = true; await h.tick();
  assert.equal(h.state.starts, 1); assert.equal(h.timers.size, 0);
});

test('disabled preference, admin policy and disposed provider never start a relay', async () => {
  for (const flag of ['enabled', 'allowed']) {
    const h = harness(); h.state[flag] = false; h.recovery.request(); await flush();
    assert.equal(h.state.starts, 0); assert.equal(h.state.connects, 0);
    assert.equal(h.timers.size, 0);
  }
  const h = harness(); h.state.id = null; h.recovery.request(); await flush();
  h.recovery.dispose(); h.recovery.request(); await flush();
  assert.equal(h.timers.size, 0); assert.equal(h.state.starts, 0);
});

test('rechecks disable after an awaited operation and cancels a pending start', async () => {
  const h = harness();
  let finish;
  h.connection.startRelay = () => new Promise(resolve => { finish = resolve; h.state.starts++; });
  h.recovery.request(); await flush();
  assert.equal(h.state.starts, 1);
  h.state.enabled = false; finish(); await flush();
  assert.equal(h.state.stops, 1); assert.equal(h.timers.size, 0);
  const other = harness();
  other.connection.getRelayStatus = async () => { other.state.allowed = false; return { connected: false }; };
  other.recovery.request(); await flush();
  assert.equal(other.state.starts, 0);
});

test('coalesces events, reconnects only the owned local connection and cancels timers', async () => {
  const h = harness(); h.state.local = false;
  let finish;
  h.connection.startRelay = () => new Promise(resolve => {
    h.state.starts++; finish = () => { h.state.relay = true; resolve(); };
  });
  h.recovery.request(); h.recovery.request(); await flush();
  h.recovery.request(); await flush();
  assert.equal(h.state.connects, 1); assert.equal(h.state.starts, 1);
  finish(); await flush();
  h.recovery.request(); await flush();
  assert.equal(h.state.starts, 1, 'already connected does not start twice');
});

test('manual operations pause queued retries and resume once, after settling', async () => {
  const h = harness(); h.state.id = null; h.recovery.request(); await flush();
  assert.equal(h.timers.size, 1);
  const manual = h.recovery.manual();
  assert.equal(h.timers.size, 0);
  h.state.id = 'test-computer'; h.recovery.request(); await flush();
  assert.equal(h.state.starts, 0);
  manual.release(); manual.release(); await flush();
  assert.equal(h.state.starts, 1);
});

test('manual enable can await an existing automatic start without concurrent RPCs', async () => {
  const h = harness(); let finish, settled = false;
  h.connection.startRelay = () => new Promise(resolve => {
    h.state.starts++; finish = () => { h.state.relay = true; resolve(); };
  });
  h.recovery.request(); await flush();
  const manual = h.recovery.manual();
  void manual.settled.then(() => { settled = true; });
  h.recovery.request(); await flush();
  assert.equal(settled, false); assert.equal(h.state.starts, 1);
  finish(); await flush(); assert.equal(settled, true);
  manual.release(); await flush(); assert.equal(h.state.starts, 1);
});

test('manual disable saves immediately and wins over an already pending start', async () => {
  const h = harness(); let finish;
  h.connection.startRelay = () => new Promise(resolve => {
    h.state.starts++; finish = () => { h.state.relay = true; resolve(); };
  });
  h.recovery.request(); await flush();
  const manual = h.recovery.manual();
  h.state.enabled = false; await h.connection.stopRelay(); manual.release();
  finish(); await flush();
  assert.equal(h.state.relay, false); assert.equal(h.state.stops, 2);
  assert.equal(h.timers.size, 0);
});

test('relay observer handles replacement and removes every local subscription', () => {
  const manager = new EventEmitter(), first = new EventEmitter(), second = new EventEmitter();
  let connection = first, calls = 0;
  manager.hasMachine = () => true; manager.getDaemonConnection = () => connection;
  const events = { added: 'add', removed: 'remove', connected: 'up', disconnected: 'down', relay: 'relay' };
  const dispose = factoryPortObserveRelay(manager, 'local', events, () => calls++);
  assert.equal(calls, 1); first.emit('relay', { connected: true }); assert.equal(calls, 1);
  first.emit('relay', { connected: false }); assert.equal(calls, 2);
  manager.emit('add', 'remote'); assert.equal(calls, 2);
  connection = second; manager.emit('add', 'local'); assert.equal(first.eventNames().length, 0);
  second.emit('down'); assert.equal(calls, 4);
  dispose(); assert.equal(second.eventNames().length, 0); assert.equal(manager.eventNames().length, 0);
});

const upstreamFile = new URL(
  '../build/upstream-pristine-0.206.0/app/.vite/renderer/main_window/assets/index-DTd1u_pI.js', import.meta.url);
const sourceOptions = { skip: existsSync(upstreamFile) ? false : 'the pristine vendor snapshot is absent; run the build to produce it' };
const upstream = existsSync(upstreamFile) ? readFileSync(upstreamFile, 'utf8') : '';
test('all recovery anchors match the actual vendor renderer and reverse exactly', sourceOptions, () => {
  assert.deepEqual(diagnose(upstream, remoteControlRendererChanges), []);
  let patched = patch(upstream, remoteControlRendererChanges);
  const syntax = spawnSync(process.execPath, ['--check', '--input-type=module'], { input: patched, encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr?.split('\n')[0]);
  for (const [, before, after] of [...remoteControlRendererChanges].reverse()) {
    assert.equal(patched.split(after).length - 1, 1);
    patched = patched.replace(after, before);
  }
  assert.equal(patched, upstream);
});

test('negative control: real upstream auto-start abandons a first relay error', sourceOptions, async () => {
  const source = remoteControlRendererChanges.find(([name]) => name.startsWith('recover the existing'))[1];
  assert.ok(upstream.includes(source));
  let starts = 0;
  const run = vm.runInNewContext(`${source};Se`, {
    window: { electronAPI: { getRemoteAccessEnabled: async () => true, getLocalComputerId: async () => 'test' } },
    x: { current: true }, Ki: 'local', de: { getDaemonConnection: () => ({
      getRelayStatus: async () => ({ connected: false }),
      startRelay: async () => { starts++; throw new Error('simulated transient error'); },
    }) }, YXc: 10, KXc: 1000, et: () => {},
  });
  await run(); assert.equal(starts, 1, 'vendor returns instead of retrying after failure');
});
