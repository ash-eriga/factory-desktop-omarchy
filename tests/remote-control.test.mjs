import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { existsSync, readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { factoryPortCreateRelayRecovery, factoryPortObserveRelay, factoryPortStartRelay,
  remoteControlRendererChanges } from '../tools/remote-control-patches.mjs';
import { patch, diagnose } from '../tools/patches.mjs';

const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
// Same shape as the renderer's JsonRpcRequestError for the bundled daemon's reply.
const daemonError = (code, message) =>
  Object.assign(new Error(`RPC Error: ${message}`), { error: { code, message } });
const staleSnapshot = () =>
  daemonError(-32600, 'No computer registered. Run `droid computer register` first.');
function harness() {
  const timers = new Map();
  const state = { enabled: true, allowed: true, id: 'test-computer',
    local: true, relay: false, relayId: void 0, starts: 0, stops: 0, connects: 0,
    errors: 0, events: [] };
  let sequence = 0;
  const connection = {
    isFullyConnected: () => state.local,
    getRelayStatus: async () => state.relay
      ? { connected: true, computerId: state.relayId } : { connected: false },
    startRelay: async options => {
      assert.deepEqual(options, { timeout: 90000 });
      state.starts++; state.relay = true; state.relayId = state.id;
      state.events.push(['start', state.id]);
    },
    stopRelay: async () => { state.stops++; state.relay = false; state.relayId = void 0; },
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

test('recovery retries the daemon startup snapshot once instead of backing off', async () => {
  const h = harness();
  h.connection.startRelay = async () => {
    if (++h.state.starts === 1) throw staleSnapshot();
    h.state.relay = true;
  };
  h.recovery.request(); await flush();
  assert.equal(h.state.starts, 2); assert.equal(h.state.relay, true);
  assert.equal(h.state.errors, 0); assert.equal(h.timers.size, 0);
});

test('relay start retries only the stale registration reply, and only once', async () => {
  for (const error of [daemonError(-32600, 'Invalid relay start request'),
    daemonError(-32603, 'No relay URL available for this computer.'), new Error('offline')]) {
    let calls = 0;
    await assert.rejects(factoryPortStartRelay({ startRelay: async () => { calls++; throw error; } }, {}),
      candidate => candidate === error);
    assert.equal(calls, 1);
  }
  let calls = 0;
  await assert.rejects(factoryPortStartRelay({ startRelay: async () => { calls++; throw staleSnapshot(); } }, {}),
    /No computer registered/);
  assert.equal(calls, 2, 'a computer that is really unregistered still reports the error');
  const options = { timeout: 90000 }, seen = [];
  assert.equal(await factoryPortStartRelay({ startRelay: async value => { seen.push(value); return 'ok'; } }, options), 'ok');
  assert.deepEqual(seen, [options]);
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

test('re-registrations restart the relay once, on the id the daemon re-reads', async () => {
  const h = harness();
  h.state.relay = true; h.state.relayId = 'old-computer'; h.state.id = 'new-computer';
  h.recovery.request(); await flush();
  assert.equal(h.state.stops, 1);
  assert.equal(h.state.starts, 1);
  assert.deepEqual(h.state.events, [['start', 'new-computer']],
    'the relay restarts for the id that is already current when the recovery runs');
  assert.equal(h.state.relayId, 'new-computer');
  assert.equal(h.timers.size, 0);
  h.recovery.request(); await flush();
  assert.equal(h.state.stops, 1, 'a served id is not restarted again');
  assert.equal(h.state.starts, 1);
});

test('an id change never stops or starts the relay while disabled or disallowed', async () => {
  for (const flag of ['enabled', 'allowed']) {
    const h = harness();
    h.state.relay = true; h.state.relayId = 'old-computer';
    h.state.id = 'new-computer'; h.state[flag] = false;
    h.recovery.request(); await flush();
    assert.equal(h.state.starts, 0);
    assert.equal(h.state.stops, 0, 'the manual disable owns the stop');
    assert.equal(h.state.relayId, 'old-computer');
    assert.equal(h.timers.size, 0);
  }
});

test('the same id leaves a connected relay untouched', async () => {
  const h = harness();
  h.state.relay = true; h.state.relayId = 'test-computer';
  h.recovery.request(); await flush();
  assert.equal(h.state.starts, 0); assert.equal(h.state.stops, 0);
  assert.equal(h.timers.size, 0);
});

test('a relay that serves no id is left untouched by an id announcement', async () => {
  // An announcement can arrive with no previous id at all (a first
  // registration, or a repair after the backend deleted the record). The
  // relay's status then reports no served id, and the comparison is a
  // no-op: there is nothing to restart it for.
  const h = harness();
  h.state.relay = true; // connected, but status has no computerId
  h.state.id = 'test-computer';
  h.recovery.request(); await flush();
  assert.equal(h.state.starts, 0);
  assert.equal(h.state.stops, 0);
  assert.equal(h.timers.size, 0);
});

test('an id change during the status read is retained, not lost', async () => {
  // The race the round-1 review found: the recovery captures the local id
  // before awaiting the relay status, and a re-registration replaces the
  // id during that await. The notification fires while the run is still
  // comparing the ids it captured, so it has to survive the run and be
  // re-checked once the run settles.
  const h = harness();
  h.state.relay = true; h.state.relayId = 'old-computer'; h.state.id = 'old-computer';
  let first = true, release;
  h.connection.getRelayStatus = async () => {
    if (first) {
      first = false;
      h.state.id = 'new-computer';
      h.recovery.request(); // the broadcast reaches the renderer mid-read
      await new Promise(resolve => { release = resolve; });
    }
    return h.state.relay ? { connected: true, computerId: h.state.relayId }
      : { connected: false };
  };
  h.recovery.request(); await flush();
  assert.equal(h.state.stops, 0, 'the first run is still mid-read');
  release(); await flush();
  assert.equal(h.state.stops, 1);
  assert.equal(h.state.starts, 1);
  assert.deepEqual(h.state.events, [['start', 'new-computer']]);
  assert.equal(h.state.relayId, 'new-computer');
  assert.equal(h.timers.size, 0, 'no polling loop after the restart');
  h.recovery.request(); await flush();
  assert.equal(h.state.stops, 1, 'a served id is not restarted again');
  assert.equal(h.state.starts, 1);
});

test('an id change during an in-flight start is re-checked once, not lost', async () => {
  const h = harness();
  let release;
  h.connection.startRelay = () => new Promise(resolve => {
    h.state.starts++;
    // The daemon captures the id it serves when the relay starts.
    h.state.relay = true; h.state.relayId = h.state.id;
    h.state.events.push(['start', h.state.id]);
    release = resolve;
  });
  h.recovery.request(); await flush();
  assert.equal(h.state.starts, 1);
  // The registration replaces the id while the start is in flight; the
  // daemon has already captured the old one. Two notifications coalesce.
  h.state.id = 'new-computer';
  h.recovery.request(); await flush();
  h.recovery.request(); await flush();
  assert.equal(h.state.starts, 1, 'no second start next to the in-flight one');
  release(); await flush();
  assert.equal(h.state.stops, 1);
  assert.equal(h.state.starts, 2, 'one re-check, not one per notification');
  assert.deepEqual(h.state.events,
    [['start', 'test-computer'], ['start', 'new-computer']]);
  assert.equal(h.state.relayId, 'new-computer');
  assert.equal(h.timers.size, 0);
});

test('a pending id change waits for a manual operation, then runs once', async () => {
  const h = harness();
  h.state.relay = true; h.state.relayId = 'old-computer'; h.state.id = 'old-computer';
  let first = true, release;
  h.connection.getRelayStatus = async () => {
    if (first) { first = false; await new Promise(resolve => { release = resolve; }); }
    return h.state.relay ? { connected: true, computerId: h.state.relayId }
      : { connected: false };
  };
  h.recovery.request(); await flush();
  const manual = h.recovery.manual();
  h.state.id = 'new-computer';
  h.recovery.request(); await flush();
  release(); await flush();
  assert.equal(h.state.stops, 0, 'the manual operation owns the pause');
  assert.equal(h.state.starts, 0);
  manual.release(); await flush();
  assert.equal(h.state.stops, 1);
  assert.equal(h.state.starts, 1);
  assert.equal(h.state.relayId, 'new-computer');
  assert.equal(h.timers.size, 0);
});

test('disposal discards a pending id change', async () => {
  const h = harness();
  h.state.relay = true; h.state.relayId = 'old-computer'; h.state.id = 'old-computer';
  let first = true, release;
  h.connection.getRelayStatus = async () => {
    if (first) { first = false; await new Promise(resolve => { release = resolve; }); }
    return h.state.relay ? { connected: true, computerId: h.state.relayId }
      : { connected: false };
  };
  h.recovery.request(); await flush();
  h.state.id = 'new-computer';
  h.recovery.request(); await flush();
  h.recovery.dispose();
  release(); await flush();
  assert.equal(h.state.stops, 0);
  assert.equal(h.state.starts, 0);
  assert.equal(h.timers.size, 0);
  h.recovery.request(); await flush();
  assert.equal(h.state.starts, 0, 'a disposed recovery never restarts');
});

test('an id change during a manual enable does not restart next to it', async () => {
  const h = harness();
  h.state.relay = true; h.state.relayId = 'old-computer';
  const manual = h.recovery.manual();
  h.state.id = 'new-computer';
  h.recovery.request(); await flush();
  assert.equal(h.state.starts, 0, 'the automatic recovery stays paused');
  assert.equal(h.state.stops, 0);
  // The manual enable itself registers the new id before it starts the relay.
  await h.connection.startRelay({ timeout: 90000 });
  manual.release(); await flush();
  assert.equal(h.state.starts, 1, 'the manual start is not followed by a restart');
  assert.equal(h.state.stops, 0);
});

test('an id change during a manual disable never starts the relay', async () => {
  const h = harness();
  h.state.relay = true; h.state.relayId = 'old-computer';
  const manual = h.recovery.manual();
  h.state.id = 'new-computer'; h.state.enabled = false;
  h.recovery.request(); await flush();
  manual.release(); await flush();
  assert.equal(h.state.starts, 0);
  assert.equal(h.state.stops, 0, 'the disable path owns the stop');
  assert.equal(h.timers.size, 0);
});

test('disposal cancels a pending restart and ignores later id changes', async () => {
  const h = harness();
  h.state.relay = true; h.state.relayId = 'old-computer'; h.state.id = 'new-computer';
  let finish;
  h.connection.startRelay = () => new Promise(resolve => {
    h.state.starts++; finish = () => { h.state.relay = true; h.state.relayId = h.state.id; resolve(); };
  });
  h.recovery.request(); await flush();
  assert.equal(h.state.stops, 1, 'the obsolete relay is released first');
  h.recovery.dispose(); finish(); await flush();
  assert.equal(h.state.starts, 1);
  assert.equal(h.state.stops, 1, 'disposal settles without further relay RPCs');
  assert.equal(h.timers.size, 0);
  h.state.id = 'another-computer'; h.state.relayId = 'new-computer';
  h.recovery.request(); await flush();
  assert.equal(h.state.starts, 1, 'a disposed recovery never restarts again');
});

test('a pending id change does not cancel the failure backoff that will serve it', async () => {
  // The round-3 rule: a drain may never cancel or reset a failure backoff.
  // The id change is still not lost — the armed timer serves the retained
  // request when it fires.
  const h = harness();
  let release;
  h.connection.startRelay = () => new Promise((resolve, reject) => {
    h.state.starts++;
    if (h.state.starts === 1) {
      release = () => reject(new Error('simulated relay start failure'));
    } else {
      h.state.relay = true; h.state.relayId = h.state.id; resolve();
    }
  });
  h.recovery.request(); await flush();
  assert.equal(h.state.starts, 1);
  // The registration replaces the id while the failing start is in flight.
  h.state.id = 'new-computer';
  h.recovery.request(); await flush();
  release(); await flush();
  assert.equal(h.state.starts, 1, 'the armed backoff serves the retained request');
  assert.equal(h.timers.size, 1);
  assert.equal(await h.tick(), 1000);
  assert.equal(h.state.starts, 2, 'the timer fired the retained re-check');
  assert.equal(h.state.relayId, 'new-computer');
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

test('the observer routes relay status to notify and connection events to recover', () => {
  const manager = new EventEmitter(), connection = new EventEmitter();
  let requests = 0, notifications = 0;
  manager.hasMachine = () => true; manager.getDaemonConnection = () => connection;
  const events = { added: 'add', removed: 'remove', connected: 'up', disconnected: 'down', relay: 'relay' };
  const dispose = factoryPortObserveRelay(manager, 'local', events,
    () => requests++, () => notifications++);
  assert.equal(requests, 1); // wiring on an existing machine recovers once
  assert.equal(notifications, 0);
  connection.emit('relay', { connected: true });
  assert.equal(notifications, 0); // a connected status is not a trigger
  connection.emit('relay', { connected: false });
  assert.equal(notifications, 1);
  assert.equal(requests, 1, 'a relay status never reads as an external request');
  connection.emit('down'); assert.equal(requests, 2);
  connection.emit('up'); assert.equal(requests, 3);
  assert.equal(notifications, 1);
  dispose();
});

// A fake connection that reproduces the pinned daemon's relay-status
// broadcasts (found read-only in /opt/factory-droid-desktop/resources/bin/droid,
// the pinned 0.249.0 CLI): the stop RPC the Desktop calls runs
// stopRelay({broadcast:true}), which broadcasts a disconnected status once
// the relay is down; a start broadcasts the connected status through the
// relay connection's onStatusChange; a failed start's cleanup broadcasts the
// disconnected status again (a duplicate of the stop's) before the RPC error
// reaches the renderer. The renderer's daemon connection re-emits those as
// "relayStatusChanged" events carrying the daemon's params, so the fake
// emits them the same way, and the observer is wired exactly as the patched
// renderer wires it.
function daemonHarness({ id = 'new-computer', servedId = 'other-computer',
  relay = true, failStarts = 0 } = {}) {
  const timers = new Map(); let sequence = 0;
  const state = { enabled: true, allowed: true, id, servedId, relay,
    starts: 0, stops: 0, errors: 0, guarded: false, scheduled: 0, cancelled: 0 };
  const manager = new EventEmitter();
  const connection = new EventEmitter();
  let recovery;
  const guard = () => {
    if (state.stops + state.starts < 24) return false;
    // Round 2 turned these notifications into a tight synchronous loop;
    // the guard disposes the recovery so a regression fails the
    // assertions below instead of hanging the test on the microtask queue.
    state.guarded = true; recovery?.dispose(); return true;
  };
  connection.isFullyConnected = () => true;
  connection.getRelayStatus = async () => state.relay
    ? { connected: true, computerId: state.servedId } : { connected: false };
  connection.stopRelay = async () => {
    if (guard()) return;
    state.stops++; state.relay = false;
    connection.emit('relayStatusChanged', { connected: false });
  };
  connection.startRelay = async options => {
    if (guard()) return;
    assert.deepEqual(options, { timeout: 90000 });
    state.starts++;
    if (state.starts <= failStarts) {
      connection.emit('relayStatusChanged', { connected: false });
      throw new Error('simulated relay start failure');
    }
    state.relay = true;
    connection.emit('relayStatusChanged', { connected: true, computerId: state.servedId });
  };
  recovery = factoryPortCreateRelayRecovery({
    getEnabled: async () => state.enabled, isAllowed: () => state.allowed,
    getComputerId: async () => state.id, getConnection: () => connection,
    connectLocal: async () => {}, onError: () => { state.errors++; },
    schedule: (callback, delay) => { state.scheduled++; const id = ++sequence; timers.set(id, { callback, delay }); return id; },
    cancel: id => { state.cancelled++; timers.delete(id); },
  });
  manager.hasMachine = () => true;
  manager.getDaemonConnection = () => connection;
  const stopObserving = factoryPortObserveRelay(manager, 'local', {
    added: 'machine-added', removed: 'machine-removed',
    connected: 'connected', disconnected: 'disconnected', relay: 'relayStatusChanged',
  }, () => recovery.request(), () => recovery.notify());
  return { state, connection, manager, timers, recovery, stopObserving,
    // Deep enough that the round-2 notification loop reaches the guard
    // instead of spilling into the assertions or the next test.
    async settle() { for (let i = 0; i < 600; i++) await Promise.resolve(); },
    async tick() {
      assert.equal(timers.size, 1);
      const [id, entry] = timers.entries().next().value;
      timers.delete(id); entry.callback(); await flush(); return entry.delay;
    } };
}

test('a persistently stale served id backs off instead of restarting in a loop', async () => {
  // The daemon re-reads the id when a relay starts, but the registration on
  // disk can still name another computer. Every restart then leaves the
  // relay serving that id, and each stop broadcasts a disconnected relay
  // status. The recovery must treat the failed restart as a failure that
  // follows the bounded backoff, never as an immediate new request.
  const h = daemonHarness();
  await h.settle();
  assert.equal(h.state.stops, 1);
  assert.equal(h.state.starts, 1);
  assert.equal(h.timers.size, 1, 'a restart that fixed nothing is a failure');
  assert.equal(h.state.guarded, false);
  assert.equal(await h.tick(), 1000);
  assert.equal(h.state.stops, 2); assert.equal(h.state.starts, 2);
  await h.settle();
  assert.equal(h.state.stops, 2, 'no restart happens without its backoff timer');
  const delays = [];
  for (let i = 0; i < 6; i++) delays.push(await h.tick());
  assert.deepEqual(delays, [2000, 5000, 10000, 30000, 60000, 60000]);
  assert.equal(h.state.stops, 8); assert.equal(h.state.starts, 8);
  assert.equal(h.state.guarded, false);
});

test('start failures keep their backoff through the daemon duplicate notifications', async () => {
  // A failed start's cleanup broadcasts the disconnected status again, a
  // duplicate of the stop's own broadcast. Those notifications must not
  // cancel the failure backoff or start another run: the timers stay armed
  // and fire, and the starts follow the schedule.
  const h = daemonHarness({ id: 'test-computer', servedId: 'test-computer',
    relay: false, failStarts: Infinity });
  await h.settle();
  assert.equal(h.state.starts, 1);
  assert.equal(h.state.errors, 1);
  assert.equal(h.timers.size, 1, 'the duplicate disconnected notification keeps the backoff');
  assert.equal(h.state.guarded, false);
  const delays = [];
  for (let i = 0; i < 6; i++) delays.push(await h.tick());
  assert.deepEqual(delays, [1000, 2000, 5000, 10000, 30000, 60000]);
  assert.equal(h.state.starts, 7);
  assert.equal(h.state.errors, 7);
  assert.equal(h.timers.size, 1);
  assert.equal(h.state.guarded, false);
});

test('a later relay disconnect notification still restarts the relay once', async () => {
  // The observer's reason to exist: the daemon reports a later relay
  // disconnect while the recovery is idle, and one run restarts it.
  const h = daemonHarness({ id: 'test-computer', servedId: 'test-computer' });
  await h.settle();
  assert.equal(h.state.starts, 0, 'connected on the current id: nothing to do');
  assert.equal(h.timers.size, 0);
  h.state.relay = false; // the daemon-side relay connection drops later
  h.connection.emit('relayStatusChanged', { connected: false });
  await h.settle();
  assert.equal(h.state.starts, 1);
  assert.equal(h.state.stops, 0);
  assert.equal(h.state.relay, true);
  assert.equal(h.timers.size, 0);
  assert.equal(h.state.guarded, false);
});

test('a disconnect during the initial status read is retained, not lost', async () => {
  // Round-4 race (a): the run's first status read already captured
  // connected:true when the relay drops. The daemon's disconnect
  // broadcast reaches notify() while the run is still comparing ids, so
  // it must be retained as one pending recheck: the run accepts the
  // stale reply and does nothing, and the drain re-reads the status and
  // restarts the relay.
  const h = daemonHarness({ id: 'test-computer', servedId: 'test-computer' });
  const read = h.connection.getRelayStatus.bind(h.connection);
  let stale = true;
  h.connection.getRelayStatus = async () => {
    const status = await read();
    if (stale) {
      stale = false;
      h.state.relay = false; // the relay drops after the read captured it
      h.connection.emit('relayStatusChanged', { connected: false });
    }
    return status;
  };
  await h.settle();
  assert.equal(h.state.starts, 1, 'the stale connected reply does not end recovery');
  assert.equal(h.state.stops, 0);
  assert.equal(h.state.relay, true);
  assert.equal(h.timers.size, 0);
  assert.equal(h.state.scheduled, 0, 'a recovered disconnect needs no backoff');
  assert.equal(h.state.guarded, false);
});

test('a disconnect during the post-start verification read is retained, not lost', async () => {
  // Round-4 race (b): the relay was down, the run started it, and the
  // verification read already captured connected:true when the relay
  // drops again. The disconnect broadcast reaches notify() while the
  // run is still verifying, so it must be retained: the run accepts the
  // stale verification and reports success, and the drain re-reads the
  // status and starts the relay once more.
  const h = daemonHarness({ id: 'test-computer', servedId: 'test-computer', relay: false });
  const read = h.connection.getRelayStatus.bind(h.connection);
  let reads = 0;
  h.connection.getRelayStatus = async () => {
    const status = await read();
    if (++reads === 2) { // the post-start verification read
      h.state.relay = false; // the relay drops after the read captured it
      h.connection.emit('relayStatusChanged', { connected: false });
    }
    return status;
  };
  await h.settle();
  assert.equal(h.state.starts, 2, 'the stale verification costs one more start, not silence');
  assert.equal(h.state.stops, 0);
  assert.equal(h.state.relay, true);
  assert.equal(h.timers.size, 0);
  assert.equal(h.state.scheduled, 0, 'a recovered disconnect needs no backoff');
  assert.equal(h.state.guarded, false);
});

test('a successful restart costs one extra status read, never another restart', async () => {
  // Round-4 bound: the disconnected status the recovery's own stop
  // broadcasts lands while the restart run is still in flight, and the
  // retained recheck must be bounded — with a successful restart the
  // drain re-reads the status once, sees the current id and stops:
  // never another stop or start, never an armed or cancelled backoff.
  const h = daemonHarness({ id: 'new-computer', servedId: 'old-computer' });
  // The daemon re-reads the id it serves when a relay starts.
  const start = h.connection.startRelay.bind(h.connection);
  h.connection.startRelay = async options => { h.state.servedId = h.state.id; await start(options); };
  let reads = 0;
  const read = h.connection.getRelayStatus.bind(h.connection);
  h.connection.getRelayStatus = async () => { reads++; return await read(); };
  await h.settle();
  assert.equal(h.state.stops, 1);
  assert.equal(h.state.starts, 1);
  assert.equal(reads, 3, 'the restart run plus exactly one retained recheck');
  assert.equal(h.state.scheduled, 0, 'no backoff was ever armed');
  assert.equal(h.state.cancelled, 0, 'no timer was ever cancelled');
  assert.equal(h.state.guarded, false);
  await h.settle();
  assert.equal(reads, 3, 'the recheck settles the chain: no further reads');
  assert.equal(h.state.stops, 1, 'no extra stop');
  assert.equal(h.state.starts, 1, 'no extra start');
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

test('negative control: real upstream auto-start keeps the relay on the deleted computer id', sourceOptions, async () => {
  const source = remoteControlRendererChanges.find(([name]) => name.startsWith('recover the existing'))[1];
  assert.ok(upstream.includes(source));
  // The account deleted this computer and the registration replaced its id;
  // the relay is still connected for the deleted one. Upstream never looks
  // at the id the relay serves, so it does nothing and the new computer is
  // unreachable although Remote Control is on.
  const calls = [];
  const run = vm.runInNewContext(`${source};Se`, {
    window: { electronAPI: {
      getRemoteAccessEnabled: async () => true,
      getLocalComputerId: async () => 'new-computer',
    } },
    x: { current: true }, Ki: 'local', de: { getDaemonConnection: () => ({
      getRelayStatus: async () => ({ connected: true, computerId: 'old-computer' }),
      startRelay: async () => { calls.push('start'); },
      stopRelay: async () => { calls.push('stop'); },
    }) }, YXc: 10, KXc: 1000, et: () => {},
  });
  await run();
  assert.deepEqual(calls, [], 'upstream neither stops nor starts the connected relay');
});

test('the patched renderer wires id change notifications to the recovery', sourceOptions, async () => {
  const patched = patch(upstream, remoteControlRendererChanges);
  const start = patched.indexOf('factoryPortComputerIdUnsubscribe=window.electronAPI?.onLocalComputerIdChanged');
  const end = patched.indexOf('ve()});', start);
  assert.ok(start >= 0 && end > start, 'the local computer id subscription moved');
  // A real recovery with the id the relay serves still wired to the old
  // computer: firing the notification the main process broadcasts must
  // restart the relay on the new id exactly once.
  const h = harness();
  h.state.relay = true; h.state.relayId = 'old-computer'; h.state.id = 'new-computer';
  let handler = null, unsubscribed = false;
  const context = {
    window: { electronAPI: {
      onLocalComputerIdChanged: listener => {
        assert.equal(typeof listener, 'function');
        handler = listener;
        return () => { unsubscribed = true; };
      },
      daemon: { onAvailable: () => () => {} },
    } },
    Se: () => h.recovery.request(),
    de: { hasMachine: () => true, getDaemonConnection: () => ({ isFullyConnected: () => true }) },
    Ki: 'local', vr: () => {}, ve: () => {},
  };
  vm.createContext(context);
  vm.runInNewContext(`${patched.slice(start, end + 've()});'.length)}`
    + ';globalThis.__unsubscribe=factoryPortComputerIdUnsubscribe', context);
  handler();
  await flush();
  assert.equal(h.state.stops, 1);
  assert.equal(h.state.starts, 1);
  assert.deepEqual(h.state.events, [['start', 'new-computer']]);
  assert.equal(h.state.relayId, 'new-computer');
  assert.equal(h.timers.size, 0, 'no polling loop after the restart');
  context.__unsubscribe();
  assert.equal(unsubscribed, true, 'the component unmount releases the subscription');
});

// Execute the real manual-enable hook, not a parallel implementation of its
// preference/relay transaction. Only its services and React hooks are fixtures.
function manualHook(source, register, staleStarts = 0) {
  const start = source.indexOf('function Kjo(){');
  const end = source.indexOf('function AEu(t){', start);
  assert.ok(start >= 0 && end > start);
  const events = [];
  const state = { enabled: false, connected: false, changing: false };
  const connection = {
    startRelay: async () => {
      events.push('start');
      if (staleStarts-- > 0) throw staleSnapshot();
      state.connected = true;
    },
    stopRelay: async () => { events.push('stop'); state.connected = false; },
    getRelayStatus: async () => ({ connected: state.connected }),
  };
  const store = { subscribe: () => () => {}, getSnapshot: () => ({}), patch: () => {} };
  const hook = vm.runInNewContext(`${source.slice(start, end)};Kjo()`, {
    ce: () => ({ t: key => key }),
    ws: () => ({ getDaemonConnection: () => connection }),
    Ki: 'local', Ho: () => true, mEu: () => store,
    L: {
      useState: initial => [typeof initial === 'function' ? initial() : initial,
        value => { state.changing = value; }],
      useSyncExternalStore: () => ({}),
    },
    fai: () => ({
      getEnabled: async () => state.enabled,
      setEnabled: async value => { events.push(`preference:${value}`); state.enabled = value; },
    }),
    window: { electronAPI: { getLocalComputerId: async options => {
      events.push('register');
      assert.equal(options.register, true);
      return register();
    } } },
    factoryPortLocalRelayRecovery: { manual: () => ({
      settled: Promise.resolve(), release: () => events.push('release'),
    }) },
    pEu: 90000, pPt: value => value, et: () => {}, factoryPortStartRelay,
    ln: Error, R3: class extends Error {},
    WH: class extends Error {
      constructor({ step, cause }) { super('relay failed', { cause }); this.step = step; }
    },
    Iae: { SavePreference: 'preference', Relay: 'relay' },
  });
  return { hook, state, events };
}

test('manual enable waits for registration before changing preferences or starting relay', sourceOptions, async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const h = manualHook(patch(upstream, remoteControlRendererChanges), () => gate);
  const pending = h.hook.enableRemoteAccess();
  await flush();
  assert.deepEqual(h.events, ['register']);
  assert.equal(h.state.enabled, false);
  assert.equal(h.state.connected, false);
  release('recreated-computer');
  await pending;
  assert.deepEqual(h.events, ['register', 'preference:true', 'start', 'release']);
  assert.equal(h.state.connected, true);
  assert.equal(h.state.changing, false);
});

test('failed registration leaves Remote Control off and releases the manual operation', sourceOptions, async () => {
  const h = manualHook(patch(upstream, remoteControlRendererChanges), async () => null);
  await assert.rejects(h.hook.enableRemoteAccess(), /registration did not complete/);
  assert.deepEqual(h.events, ['register', 'release']);
  assert.equal(h.state.enabled, false);
  assert.equal(h.state.connected, false);
  assert.equal(h.state.changing, false);
});

test('negative control: upstream starts relay without verifying the local registration', sourceOptions, async () => {
  const h = manualHook(upstream, async () => null);
  await h.hook.enableRemoteAccess();
  assert.deepEqual(h.events, ['preference:true', 'start']);
  assert.equal(h.state.connected, true, 'the old hook never consulted registration');
});

test('manual enable connects when the daemon still holds its startup snapshot', sourceOptions, async () => {
  const h = manualHook(patch(upstream, remoteControlRendererChanges), async () => 'recreated-computer', 1);
  await h.hook.enableRemoteAccess();
  assert.deepEqual(h.events, ['register', 'preference:true', 'start', 'start', 'release']);
  assert.equal(h.state.connected, true);
});

test('negative control: upstream manual enable surfaces the stale snapshot as an error', sourceOptions, async () => {
  const h = manualHook(upstream, async () => null, 1);
  await assert.rejects(h.hook.enableRemoteAccess(),
    error => /No computer registered/.test(error.cause?.message ?? ''));
  assert.deepEqual(h.events, ['preference:true', 'start', 'preference:false', 'stop'],
    'the single start fails and upstream rolls the preference back');
  assert.equal(h.state.connected, false);
});
