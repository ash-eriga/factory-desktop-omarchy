// Desktop computer registration: the local PC must appear as "This Computer"
// in Settings > Droid Computers.
//
// Upstream 0.206.0 owns the registration. Its main process holds the whole
// flow in one function, the desktop auto-registration, and that function has
// exactly one call site: the startup sequence, before a fresh profile can
// hold an auth token. When the token is missing, upstream logs
//
//   [computer] No auth token available, skipping auto-registration
//
// and stops there. Neither sign-in path reaches the registration
// afterwards: the browser sign-in stores the credentials and tells the
// renderer that the account is ready, and the customer-owned sign-in commits
// its credentials through its own session object, but neither leads back to
// the registration. The local host configuration therefore never gains a
// computerRegistration, so computer:getLocalId answers null.
//
// The failure is specific to the first sign-in. A profile that was already
// signed in when the app started has a token at startup, the registration
// runs, and the local computer id is there. A profile that signs in after
// startup has no token at startup, and never gets a second attempt.
//
// This layer re-runs upstream's own registration once authentication is
// available. It does not reimplement it and it does not widen it: the driver
// calls upstream's registration function, which keeps upstream's account,
// organization, payload and backend checks. In particular the driver never
// decides what a registration means and never skips upstream's verification
// of an existing registration: a stored computer id is a local record, not a
// verified one, and upstream's function is what verifies it, repairs a
// missing host id and re-registers a record the backend deleted.
//
// The port never touches the remote-access preference, the local relay or
// the organization policy. Registration is not remote access: the relay
// still needs the user's own toggle and the organization's own decision.
//
// The one change to upstream's own function is its signature: it now
// accepts the credentials the driver already read, so upstream's preflight
// reuses that read instead of reading the credentials a second time. Every
// branch of upstream's function, including the hosted-services gate and the
// missing-credentials decision, is unchanged, and calling it without an
// argument keeps its original behavior exactly.

// The registration driver. It is written as a standalone function so it can
// be exercised on its own: every side effect arrives through an injected
// dependency, and the function body is embedded verbatim in the main
// process.
export function factoryPortCreateComputerRegistration({
  getToken,
  getLocalComputerId,
  register,
  logInfo = () => {},
  logWarn = () => {},
  logError = () => {},
}) {
  // The cooldown is the driver's own policy, not a knob: it bounds how
  // often upstream's registration may be attempted. It is a fixed value
  // because no caller varies it.
  const cooldownMs = 30000;
  let inflight = null;
  let queuedForced = null;
  let nextAttemptAt = 0;
  let missingCredentialsReported = false;

  const run = async () => {
    let token;
    try {
      token = await getToken();
    } catch (error) {
      logError('[computer] The auth token could not be read', error);
      return null;
    }
    if (!token) {
      // No credentials yet. The registration is deferred, not failed: the
      // sign-in path asks for it again, and nothing is written. The deferral
      // is reported once per missing-credentials state, so a caller that
      // polls cannot fill the log with the same line.
      if (!missingCredentialsReported) {
        missingCredentialsReported = true;
        logWarn('[computer] No auth token available; the desktop computer '
          + 'registration is deferred until sign-in');
      }
      return null;
    }
    missingCredentialsReported = false;
    try {
      // Upstream's own registration function is the authority. The
      // credentials the driver already read are handed to it, so upstream's
      // own preflight reuses that read instead of repeating it, and
      // upstream still decides whether a registration happens, what it
      // contains and which existing record it adopts, verifies or repairs.
      await register(token);
      const computerId = await getLocalComputerId();
      if (computerId) logInfo('[computer] Local computer registered', { computerId });
      else logWarn('[computer] The desktop computer registration finished '
        + 'without a local computer id');
      return computerId;
    } catch (error) {
      logError('[computer] The desktop computer registration attempt failed', error);
      return null;
    } finally {
      // Only an actual attempt moves the deadline. A caller that merely
      // observes the cooldown must never postpone the retry.
      nextAttemptAt = Date.now() + cooldownMs;
    }
  };

  const ensure = ({ force = false } = {}) => {
    if (inflight) {
      if (!force) return inflight;
      // A forced request that arrives while an older attempt is still
      // running must not be lost: that attempt may have read the
      // credentials from before the sign-in. The attempt queued behind it
      // reads the committed ones, and every waiter observes its result.
      if (!queuedForced) {
        const queued = inflight.then(() => {
          // The marker is released when the queued attempt starts, not
          // when it ends. A forced request that arrives while that attempt
          // is already running has to schedule its own attempt, with the
          // credentials its own sign-in committed: joining a running
          // attempt would answer it with an account that may already be
          // revoked, and would leave the new account unregistered.
          if (queuedForced === queued) queuedForced = null;
          return run();
        });
        queuedForced = queued;
        inflight = queued;
        queued.then(() => {
          if (queuedForced === queued) queuedForced = null;
          if (inflight === queued) inflight = null;
        });
      }
      return queuedForced;
    }
    if (!force && Date.now() < nextAttemptAt) {
      // Inside the cooldown the attempt is skipped, and the deadline stays
      // where it is. The current local id is still reported.
      return Promise.resolve(getLocalComputerId()).catch(() => null);
    }
    const started = run();
    inflight = started;
    started.then(() => { if (inflight === started) inflight = null; });
    return started;
  };

  // Wait until no attempt is running and none is queued behind one. A
  // caller that needs the settled state uses this after asking for an
  // attempt, so that a sign-in that lands mid-attempt is not missed.
  const settled = async () => {
    for (;;) {
      const current = inflight;
      if (!current) return;
      await current;
      if (inflight === current) return;
      // A forced attempt took the flight over; wait for it as well.
    }
  };

  return { ensure, settled };
}

// The instance embedded in the main process. Every dependency is upstream's
// own: the credentials come from the vendor runtime module, the local
// computer id from upstream's reader, and the registration from upstream's
// own function. The driver is the only place that decides whether an
// attempt may run at all; upstream's registration function remains the
// authority for what the attempt does.
const registrationInstance = `const factoryPortComputerRegistration=factoryPortCreateComputerRegistration({
getToken:()=>i.getAuthToken(i.getRuntimeAuthConfig()),
getLocalComputerId:()=>xj(),
register:token=>Rj(token),
logInfo:(message,details)=>i.logInfo(message,details),
logWarn:(message,details)=>i.logWarn(message,details),
logError:(message,error)=>i.logException(error,message)
});`;

export const computerRegistrationMainChanges = [
  // The driver lives next to upstream's own registration function, at module
  // scope, so the startup path, the sign-in paths and the IPC handler all
  // reach the same instance.
  ['desktop computer registration driver',
    'async function xj(){if(!i.getHostedServicesEnabled())return null;',
    `${factoryPortCreateComputerRegistration.toString()}\n${registrationInstance}async function xj(){if(!i.getHostedServicesEnabled())return null;`],
  // Upstream's registration function now accepts the credentials the driver
  // already read. Upstream keeps the hosted-services gate and the
  // missing-credentials decision; only the repeated credential read is
  // gone, so one read serves both the driver and the registration.
  ['reuse the credentials the registration driver already read',
    'async function Rj(){if(i.getHostedServicesEnabled())try{const e=await i.getAuthToken(i.getRuntimeAuthConfig());',
    'async function Rj(factoryPortAuthToken){if(i.getHostedServicesEnabled())try{const e=factoryPortAuthToken===void 0?await i.getAuthToken(i.getRuntimeAuthConfig()):factoryPortAuthToken;'],
  // Upstream's startup attempt, now routed through the driver: same call,
  // same upstream function, one shared instance. The driver never skips it
  // because a local id exists, so upstream's verification of an existing
  // registration, its repair of a missing host id and its recovery of a
  // record the backend deleted all still run.
  ['run the startup registration through the driver',
    'Rj(),i.startupTracker.beginPhase("daemon_start")',
    'factoryPortComputerRegistration.ensure(),i.startupTracker.beginPhase("daemon_start")'],
  // The missing link: the browser sign-in stores the credentials and then
  // tells the renderer that the account is ready. This is the first-login
  // path, and it is where the registration has to run: the attempt is not
  // awaited, so the sign-in flow is never delayed by the backend round
  // trip, and the forced attempt bypasses the cooldown.
  ['run the registration again once the browser sign-in completes',
    'p(i.DesktopSignInProgress.Connecting),await Bp(),cn(u).webContents.send("auth:success",{user:m.user})',
    'p(i.DesktopSignInProgress.Connecting),await Bp(),factoryPortComputerRegistration.ensure({force:!0}),cn(u).webContents.send("auth:success",{user:m.user})'],
  // The same for the customer-owned deployment sign-in, which commits its
  // credentials through its own session object.
  ['run the registration again once the customer sign-in completes',
    'await O(),await Bp();const{user:A}=await P3();if(!A)throw new i.MetaError("Could not load the signed-in user.");Dr("auth:success",{user:A})',
    'await O(),await Bp();factoryPortComputerRegistration.ensure({force:!0});const{user:A}=await P3();if(!A)throw new i.MetaError("Could not load the signed-in user.");Dr("auth:success",{user:A})'],
  // The local computer id is what the renderer needs. A registered computer
  // is answered straight from the local configuration, exactly as upstream
  // does, so the steady state costs no extra work. Only an unregistered
  // computer waits: the driver is asked for an attempt and then for the
  // settled state, so a sign-in that lands while an attempt is running is
  // not missed, and the renderer reads the registered id instead of the
  // empty one.
  ['settle the local computer id before reporting it',
    'x.ipcMain.handle("computer:getLocalId",async()=>xj())',
    'x.ipcMain.handle("computer:getLocalId",async()=>{const computerId=await xj();if(computerId)return computerId;await factoryPortComputerRegistration.ensure();await factoryPortComputerRegistration.settled();return xj()})'],
];

export const computerRegistrationRendererChanges = [
  // The settings page resolves the local computer id once per mount and
  // needs the account's computer list to match it. When the id only appears
  // after the registration, the list fetched before that point is stale, so
  // the list is read again. The read is sequenced: the first one may be the
  // request the page already had in flight, which was sent before the
  // registration, and a second read after it settles is a fresh one.
  // Upstream's query hook only cancels a pending request when it already
  // holds data, so a single read could otherwise return the empty list.
  // The upstream effect runs on mount only, so this is one extra read per
  // mount and never a refetch loop. A failed refresh is reported and never
  // clears the local computer id. The ref is declared, not assigned: the
  // renderer bundle is an ES module, where an undeclared assignment throws.
  ['refresh the computer list when the local computer id appears',
    '[b,C]=L.useState(null),[S,I]=L.useState(!s);Xt(()=>{if(!s)return;async function K(){try{const Z=await window.electronAPI?.getLocalComputerId?.();C(Z??null)}catch(Z){et("Failed to fetch local computer ID (v2)",{cause:Z}),C(null)}finally{I(!0)}}K()});',
    '[b,C]=L.useState(null),[S,I]=L.useState(!s);const factoryPortLocalComputerIdRef=L.useRef(null);Xt(()=>{if(!s)return;async function K(){try{const Z=await window.electronAPI?.getLocalComputerId?.();C(Z??null);if(Z&&Z!==factoryPortLocalComputerIdRef.current){factoryPortLocalComputerIdRef.current=Z;try{const result=await u();const computers=result?.data?.data?.computers??result?.data?.computers??result?.computers??[];if(!computers.some(computer=>computer.id===Z))await u()}catch(error){et("Failed to refresh the computer list",{cause:error})}}}catch(Z){et("Failed to fetch local computer ID (v2)",{cause:Z}),C(null)}finally{I(!0)}}K()});'],
];

export const computerRegistrationHelperNames = [
  'factoryPortCreateComputerRegistration',
  'factoryPortComputerRegistration',
  'factoryPortLocalComputerIdRef',
];

export function diagnoseComputerRegistrationHelpers(source) {
  return computerRegistrationHelperNames.filter(name => source.includes(name));
}
