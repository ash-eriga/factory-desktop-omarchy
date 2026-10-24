// The upstream desktop already owns the daemon, registration and relay RPCs.
// Recover that connection, not a second CLI daemon. This function is embedded
// verbatim in the pinned renderer and exercised with a deterministic clock.
export function factoryPortCreateRelayRecovery({
  getEnabled, isAllowed, getComputerId, getConnection, connectLocal,
  onError = () => {}, schedule = setTimeout, cancel = clearTimeout,
}) {
  let disposed = false, running = false, timer = null, failures = 0, manualCount = 0;
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
      if (!connection?.isFullyConnected() || !await getComputerId()) {
        later(); return;
      }
      if (!await permitted()) return;
      if (!(await connection.getRelayStatus()).connected) {
        if (!await permitted()) return;
        // Match the upstream manual enable flow's 90-second connect budget.
        await connection.startRelay({ timeout: 90000 });
        if (!await permitted()) {
          // A pending start must not undo a user's/admin's later disable.
          if (!disposed) await connection.stopRelay();
          return;
        }
        if (!(await connection.getRelayStatus()).connected) { later(); return; }
      }
      failures = 0;
    } catch (error) {
      if (!disposed) { onError(error); later(); }
    } finally { running = false; }
  };
  const request = () => {
    if (disposed || running || manualCount) return;
    if (timer !== null) { cancel(timer); timer = null; }
    inFlight = run();
  };
  return {
    request,
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
export function factoryPortObserveRelay(manager, machineId, events, recover) {
  let connection = null;
  const changed = status => { if (!status?.connected) recover(); };
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

const originalAutoStart = 'const Ce=async()=>{if(!window.electronAPI?.getRemoteAccessEnabled||!await window.electronAPI.getRemoteAccessEnabled()||!E.current)return;const we=le.getDaemonConnection(eo);for(let be=0;be<XWc;be++){if(!await window.electronAPI?.getLocalComputerId?.()){await new Promise(xe=>{const fe=setTimeout(()=>{clearTimeout(fe),xe()},JWc)});continue}try{(await we.getRelayStatus()).connected||await we.startRelay()}catch(xe){et("Failed to auto-start local relay connection",{cause:xe})}return}}';

export const remoteControlRendererChanges = [
  ['recheck relay eligibility when organization policy resolves',
    'E.current=x;const _=P.useRef(null)',
    'E.current=x;P.useEffect(()=>{factoryPortLocalRelayRecovery?.request()},[x]);const _=P.useRef(null)'],
  ['local relay recovery helpers',
    'function tVc({children:t}){',
    `${factoryPortCreateRelayRecovery.toString()}\n${factoryPortObserveRelay.toString()}\nlet factoryPortLocalRelayRecovery=null;\nfunction tVc({children:t}){`],
  ['recover the existing local relay instead of giving up after startup',
    originalAutoStart,
    'const factoryPortRecovery=factoryPortCreateRelayRecovery({getEnabled:()=>window.electronAPI?.getRemoteAccessEnabled?.(),isAllowed:()=>E.current===!0&&!le.isDestroyed(),getComputerId:()=>window.electronAPI?.getLocalComputerId?.(),getConnection:()=>le.hasMachine(eo)?le.getDaemonConnection(eo):null,connectLocal:()=>ye(),onError:error=>et("Failed to recover local relay connection",{cause:error})});factoryPortLocalRelayRecovery=factoryPortRecovery;const Ce=()=>factoryPortRecovery.request()'],
  ['resume recovery after network and foreground events',
    'const Se=()=>{document.hidden||ae.handleForeground()};document.addEventListener("visibilitychange",Se);const he=()=>{ae.handleForeground()};',
    'const Se=()=>{document.hidden||(ae.handleForeground(),Ce())};document.addEventListener("visibilitychange",Se);const he=()=>{ae.handleForeground(),Ce()};'],
  ['observe local relay notifications and dispose pending retries',
    'return ye(),()=>{document.removeEventListener("visibilitychange",Se),window.removeEventListener("online",he),ue(),Ae?.(),oe(),de();',
    'const factoryPortRelayUnsubscribe=factoryPortObserveRelay(le,eo,{added:bi.MachineAdded,removed:bi.MachineRemoved,connected:cd.Connected,disconnected:cd.Disconnected,relay:bi.RelayStatusChanged},Ce);return ye(),()=>{factoryPortRecovery.dispose();factoryPortRelayUnsubscribe();if(factoryPortLocalRelayRecovery===factoryPortRecovery)factoryPortLocalRelayRecovery=null;document.removeEventListener("visibilitychange",Se),window.removeEventListener("online",he),ue(),Ae?.(),oe(),de();'],
  ['pause automatic retries and finish an in-flight start before manual enable',
    'const h=soi(t),p=n();r(!0);try{const g=',
    'const h=soi(t),p=n();r(!0);const factoryPortManualRelay=factoryPortLocalRelayRecovery?.manual();try{await factoryPortManualRelay?.settled;const g='],
  ['pause automatic retries during manual disable without delaying preference save',
    'const f=soi(t),h=n();r(!0);try{try{await f.setEnabled(!1)}',
    'const f=soi(t),h=n();r(!0);const factoryPortManualRelay=factoryPortLocalRelayRecovery?.manual();try{try{await f.setEnabled(!1)}'],
  ['resume recovery after manual enable settles',
    'finally{r(!1)}},disableRemoteAccess:async()=>{',
    'finally{r(!1);factoryPortManualRelay?.release()}},disableRemoteAccess:async()=>{'],
  ['recheck preference after manual disable settles',
    'finally{r(!1)}}}}function kvu(t){',
    'finally{r(!1);factoryPortManualRelay?.release()}}}}function kvu(t){'],
];

export const remoteControlHelperNames = [
  'factoryPortCreateRelayRecovery', 'factoryPortObserveRelay',
  'factoryPortLocalRelayRecovery', 'factoryPortRecovery', 'factoryPortRelayUnsubscribe',
  'factoryPortManualRelay',
];
