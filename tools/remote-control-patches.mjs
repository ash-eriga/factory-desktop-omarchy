// The daemon answers its first relay lookup from a host identity captured when
// it started. If the Desktop registered this computer after that (first sign-in
// or a re-registration after the account deleted it), the snapshot has no
// registration and the daemon replies "No computer registered" exactly once;
// later starts read host.json again. Retry only that reply, only once.
export async function factoryPortStartRelay(connection, options) {
  try {
    return await connection.startRelay(options);
  } catch (error) {
    if (error?.error?.code !== -32600 ||
      !String(error.error.message ?? '').startsWith('No computer registered')) throw error;
    return await connection.startRelay(options);
  }
}

// The upstream desktop already owns the daemon, registration and relay RPCs.
// Recover that connection, not a second CLI daemon. This function is embedded
// verbatim in the pinned renderer and exercised with a deterministic clock.
export function factoryPortCreateRelayRecovery({
  getEnabled, isAllowed, getComputerId, getConnection, connectLocal,
  onError = () => {}, schedule = setTimeout, cancel = clearTimeout,
}) {
  let disposed = false, running = false, pending = false, timer = null,
    failures = 0, manualCount = 0;
  let inFlight = Promise.resolve();
  const delays = [1000, 2000, 5000, 10000, 30000, 60000];
  const permitted = async () => !disposed && isAllowed() &&
    await getEnabled() === true && !disposed && isAllowed();
  const later = () => {
    if (disposed || timer !== null) return;
    timer = schedule(() => { timer = null; request(); },
      delays[Math.min(failures++, delays.length - 1)]);
  };
  const run = async () => {
    if (disposed || running) return;
    running = true;
    try {
      if (!await permitted()) { failures = 0; return; }
      let connection = getConnection();
      if (!connection?.isFullyConnected()) {
        await connectLocal();
        if (!await permitted()) return;
        connection = getConnection();
      }
      const computerId = await getComputerId();
      if (!connection?.isFullyConnected() || !computerId) {
        later(); return;
      }
      if (!await permitted()) return;
      const status = await connection.getRelayStatus();
      if (!status.connected) {
        if (!await permitted()) return;
        // Match the upstream manual enable flow's 90-second connect budget.
        await factoryPortStartRelay(connection, { timeout: 90000 });
        if (!await permitted()) {
          // A pending start must not undo a user's/admin's later disable.
          if (!disposed) await connection.stopRelay();
          return;
        }
        // The daemon re-reads the id it serves when a relay starts. What
        // the status reports right after our own start is what it serves
        // now: a relay that is still down, or one that came back up still
        // serving another id, is a failure, and the bounded backoff owns
        // the next attempt instead of another immediate restart.
        const settled = await connection.getRelayStatus();
        if (!settled.connected || (settled.computerId && settled.computerId !== computerId)) {
          later(); return;
        }
      } else if (status.computerId && status.computerId !== computerId) {
        // The relay reports the id it serves, and a re-registration can
        // replace that id while the relay stays connected. The daemon only
        // re-reads the id when a relay starts, so serving the replacement
        // takes one stop and start.
        if (!await permitted()) return;
        await connection.stopRelay();
        if (!await permitted()) return;
        await factoryPortStartRelay(connection, { timeout: 90000 });
        if (!await permitted()) {
          if (!disposed) await connection.stopRelay();
          return;
        }
        const settled = await connection.getRelayStatus();
        if (!settled.connected || (settled.computerId && settled.computerId !== computerId)) {
          later(); return;
        }
      }
      failures = 0;
    } catch (error) {
      if (!disposed) { onError(error); later(); }
    } finally {
      running = false;
      // A request or a relay-status notification that arrived while this
      // run held the ids it compared must not be lost: the run may have
      // captured both before the id changed, or read a connected status
      // just before the relay dropped. One more pass re-reads them and
      // decides again. But a failure this run recorded owns the schedule:
      // when its backoff timer is armed, that timer serves the retained
      // recheck, and no drain may cancel or reset it. Only a fresh
      // external request can.
      if (pending && !disposed && !manualCount) {
        pending = false;
        if (timer === null) inFlight = run();
      }
    }
  };
  const request = () => {
    if (disposed) return;
    if (running) { pending = true; return; }
    if (manualCount) return;
    pending = false;
    if (timer !== null) { cancel(timer); timer = null; }
    inFlight = run();
  };
  // Relay-status notifications are the daemon reporting state, including
  // the states this recovery's own stop and start produce (the stop RPC
  // broadcasts a disconnected status, a failed start's cleanup broadcasts
  // it again) and every later disconnect. A notification that arrives
  // while a run is still comparing ids is retained as one pending
  // recheck, coalesced with request()'s pending: the run may have already
  // read the connected status the notification invalidates, so without
  // the retained recheck a disconnect that lands between that read and
  // its reply would leave the relay down. The retention stays bounded:
  // after a successful restart the drain re-runs once, reads a
  // connected status on the current id and stops; after a failure or a
  // still-stale id the armed backoff timer serves the recheck instead.
  // A notification must never cancel or reset an armed failure backoff,
  // and only a recovery that is otherwise idle may act on one directly,
  // so a later disconnect still restarts the relay.
  const notify = () => {
    if (disposed || manualCount || timer !== null) return;
    if (running) { pending = true; return; }
    inFlight = run();
  };
  return {
    request,
    notify,
    manual() {
      manualCount++;
      if (timer !== null) { cancel(timer); timer = null; }
      let released = false;
      return {
        settled: inFlight,
        release() {
          if (released) return;
          released = true; manualCount--; request();
        },
      };
    },
    dispose() {
      disposed = true;
      if (timer !== null) cancel(timer);
      timer = null;
    },
  };
}

// Observe only the local connection. Relay status notifications handle a
// later disconnect without steady-state polling or touching remote sessions.
// Connection events are fresh opportunities and go to recover; the relay
// status is the daemon reporting state — including what this recovery's own
// stop and start produced — and goes to notify, which never cancels or
// bypasses an armed failure backoff.
export function factoryPortObserveRelay(manager, machineId, events, recover, notify = recover) {
  let connection = null;
  const changed = status => { if (!status?.connected) notify(); };
  const clear = () => {
    if (!connection) return;
    connection.off(events.connected, recover);
    connection.off(events.disconnected, recover);
    connection.off(events.relay, changed);
    connection = null;
  };
  const added = id => {
    if (id !== machineId) return;
    clear();
    connection = manager.getDaemonConnection(machineId);
    connection.on(events.connected, recover);
    connection.on(events.disconnected, recover);
    connection.on(events.relay, changed);
    recover();
  };
  const removed = id => { if (id === machineId) { clear(); recover(); } };
  manager.on(events.added, added);
  manager.on(events.removed, removed);
  if (manager.hasMachine(machineId)) added(machineId);
  return () => {
    clear();
    manager.off(events.added, added);
    manager.off(events.removed, removed);
  };
}

const originalAutoStart = 'const Ce=async()=>{if(!window.electronAPI?.getRemoteAccessEnabled||!await window.electronAPI.getRemoteAccessEnabled()||!E.current)return;const Se=ce.getDaemonConnection(no);for(let ge=0;ge<CMd;ge++){if(!await window.electronAPI?.getLocalComputerId?.()){await new Promise(xe=>{const re=setTimeout(()=>{clearTimeout(re),xe()},bMd)});continue}try{(await Se.getRelayStatus()).connected||await Se.startRelay()}catch(xe){ot("Failed to auto-start local relay connection",{cause:xe})}return}}';

export const remoteControlRendererChanges = [
  ['recheck relay eligibility when organization policy resolves',
    'E.current=x;const _=L.useRef(null)',
    'E.current=x;L.useEffect(()=>{factoryPortLocalRelayRecovery?.request()},[x]);const _=L.useRef(null)'],
  ['local relay recovery helpers',
    'function IMd({children:t}){',
    `${factoryPortStartRelay.toString()}\n${factoryPortCreateRelayRecovery.toString()}\n${factoryPortObserveRelay.toString()}\nlet factoryPortLocalRelayRecovery=null;\nfunction IMd({children:t}){`],
  ['recover the existing local relay instead of giving up after startup',
    originalAutoStart,
    'const factoryPortRecovery=factoryPortCreateRelayRecovery({getEnabled:()=>window.electronAPI?.getRemoteAccessEnabled?.(),isAllowed:()=>E.current===!0&&!ce.isDestroyed(),getComputerId:()=>window.electronAPI?.getLocalComputerId?.(),getConnection:()=>ce.hasMachine(no)?ce.getDaemonConnection(no):null,connectLocal:()=>pe(),onError:error=>ot("Failed to recover local relay connection",{cause:error})});factoryPortLocalRelayRecovery=factoryPortRecovery;const Ce=()=>factoryPortRecovery.request()'],
  ['resume recovery after network and foreground events',
    'const be=()=>{document.hidden||ue.handleForeground()};document.addEventListener("visibilitychange",be);const fe=()=>{ue.handleForeground()};',
    'const be=()=>{document.hidden||(ue.handleForeground(),Ce())};document.addEventListener("visibilitychange",be);const fe=()=>{ue.handleForeground(),Ce()};'],
  ['restart the relay when a re-registration replaces the local computer id',
    've=window.electronAPI?.daemon?.onAvailable?.(()=>{',
    'factoryPortComputerIdUnsubscribe=window.electronAPI?.onLocalComputerIdChanged?.(()=>{Ce()}),ve=window.electronAPI?.daemon?.onAvailable?.(()=>{'],
  ['observe local relay notifications and dispose pending retries',
    'return pe(),()=>{document.removeEventListener("visibilitychange",be),window.removeEventListener("online",fe),Ae(),ve?.(),oe(),se();',
    'const factoryPortRelayUnsubscribe=factoryPortObserveRelay(ce,no,{added:_i.MachineAdded,removed:_i.MachineRemoved,connected:hu.Connected,disconnected:hu.Disconnected,relay:_i.RelayStatusChanged},Ce,factoryPortRecovery.notify);return pe(),()=>{factoryPortRecovery.dispose();factoryPortRelayUnsubscribe();if(factoryPortLocalRelayRecovery===factoryPortRecovery)factoryPortLocalRelayRecovery=null;document.removeEventListener("visibilitychange",be),window.removeEventListener("online",fe),Ae(),ve?.(),oe(),se();'],
  ['dispose the local computer id subscription with the other listeners',
    'Ae(),ve?.(),oe(),se();',
    'Ae(),ve?.(),oe(),se(),factoryPortComputerIdUnsubscribe?.();'],
  ['pause automatic retries and finish an in-flight start before manual enable',
    'const h=mmi(t),p=n();r(!0);try{const g=',
    'const h=mmi(t),p=n();r(!0);const factoryPortManualRelay=factoryPortLocalRelayRecovery?.manual();try{await factoryPortManualRelay?.settled;const factoryPortRegisteredComputer=await window.electronAPI?.getLocalComputerId?.({register:!0});if(!factoryPortRegisteredComputer)throw new wn("Computer registration did not complete. Try again.");const g='],
  ['retry the stale daemon registration snapshot during manual enable',
    'try{try{await p.startRelay({timeout:vyu})}catch(A){',
    'try{try{await factoryPortStartRelay(p,{timeout:vyu})}catch(A){'],
  ['pause automatic retries during manual disable without delaying preference save',
    'const f=mmi(t),h=n();r(!0);try{try{await f.setEnabled(!1)}',
    'const f=mmi(t),h=n();r(!0);const factoryPortManualRelay=factoryPortLocalRelayRecovery?.manual();try{try{await f.setEnabled(!1)}'],
  ['resume recovery after manual enable settles',
    'finally{r(!1)}},disableRemoteAccess:async()=>{',
    'finally{r(!1);factoryPortManualRelay?.release()}},disableRemoteAccess:async()=>{'],
  ['recheck preference after manual disable settles',
    'finally{r(!1)}}}}const iRe=cs(void 0),vae=cs({});',
    'finally{r(!1);factoryPortManualRelay?.release()}}}}const iRe=cs(void 0),vae=cs({});'],
];

export const remoteControlHelperNames = [
  'factoryPortStartRelay', 'factoryPortCreateRelayRecovery', 'factoryPortObserveRelay',
  'factoryPortLocalRelayRecovery', 'factoryPortRecovery', 'factoryPortRelayUnsubscribe',
  'factoryPortManualRelay', 'factoryPortComputerIdUnsubscribe',
];
