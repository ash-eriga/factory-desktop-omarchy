// Notifications only. Package installation remains exclusively with pacman.
const { readFileSync, lstatSync, mkdirSync, writeFileSync, renameSync, unlinkSync } = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const REPOSITORY = 'https://github.com/ash-eriga/factory-droid-desktop';
const RELEASE_API = 'https://api.github.com/repos/ash-eriga/factory-droid-desktop/releases/latest';
const GUIDE_URL = `${REPOSITORY}#update`;
const DAY = 24 * 60 * 60 * 1000;

function versionParts(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-([1-9]\d*)$/.test(value))
    return null;
  const parts = value.split(/[.-]/).map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}

function compareVersions(left, right) {
  const a = versionParts(left), b = versionParts(right);
  if (!a || !b) throw new Error('Invalid port version');
  for (let index = 0; index < a.length; index++)
    if (a[index] !== b[index]) return Math.sign(a[index] - b[index]);
  return 0;
}

async function checkForUpdate(installedVersion, fetchImpl = globalThis.fetch) {
  if (!versionParts(installedVersion)) throw new Error('Invalid installed port version');
  try {
    // A fixed public endpoint, no account data, credentials or redirects.
    const response = await fetchImpl(RELEASE_API, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Factory-Droid-Desktop-Port' },
      credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(8000),
    });
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel().catch(() => {});
      return { status: 'unavailable' };
    }
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 256 * 1024) throw new Error('Release metadata too large');
        chunks.push(Buffer.from(value));
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    const release = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const latestVersion = typeof release.tag_name === 'string' && release.tag_name.startsWith('v')
      ? release.tag_name.slice(1) : null;
    if (release.draft !== false || release.prerelease !== false || !versionParts(latestVersion)
        || typeof release.published_at !== 'string' || !Number.isFinite(Date.parse(release.published_at)))
      return { status: 'unavailable' };
    return {
      status: compareVersions(latestVersion, installedVersion) > 0 ? 'available' : 'current',
      installedVersion, latestVersion,
      // Never open a URL supplied by release metadata.
      releaseUrl: `${REPOSITORY}/releases/tag/v${latestVersion}`,
    };
  } catch {
    // Private repo, no releases, rate limits and offline are not "up to date".
    return { status: 'unavailable' };
  }
}

function readState(filename) {
  try {
    const info = lstatSync(filename);
    if (!info.isFile() || info.size > 4096) return {};
    const value = JSON.parse(readFileSync(filename, 'utf8'));
    return {
      automatic: value.automatic !== false,
      lastChecked: Number.isSafeInteger(value.lastChecked) ? value.lastChecked : 0,
      notified: typeof value.notified === 'string' && value.notified.length < 160 ? value.notified : '',
    };
  } catch { return {}; }
}

function writeState(filename, state) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    writeFileSync(temporary, JSON.stringify(state), { mode: 0o600, flag: 'wx' });
    renameSync(temporary, filename);
  } catch {
    // A read-only profile must never prevent startup or a manual check.
  } finally {
    try { unlinkSync(temporary); } catch {}
  }
}

function createUpdateNotifier({ electron, version, allowed = () => true,
  canAutoCheck = () => true, rebuildMenu = () => {}, fetchImpl = globalThis.fetch,
  now = Date.now, schedule = setTimeout, cancel = clearTimeout }) {
  if (!versionParts(version)) throw new Error('Invalid port version');
  const { app, BrowserWindow, dialog, shell } = electron;
  const filename = path.join(app.getPath('userData'), 'port-updates.json');
  const state = { automatic: true, lastChecked: 0, notified: '', ...readState(filename) };
  let stopped = false, timer = null, inFlight = null, manualRequested = false, lastResult = null;
  const permitted = () => { try { return !stopped && allowed() === true; } catch { return false; } };
  const autoPermitted = () => {
    try { return permitted() && canAutoCheck() === true; } catch { return false; }
  };
  const autoEnabled = () => state.automatic && autoPermitted();
  const focused = () => {
    const win = BrowserWindow.getFocusedWindow();
    return win && !win.isDestroyed() ? win : null;
  };
  const notificationKey = result => `${version}:${result.latestVersion}`;
  const persist = () => writeState(filename, state);
  const present = async (result, manual) => {
    if (!permitted() || !manual && (!autoEnabled() || !focused())) return;
    const available = result.status === 'available';
    if (!manual && (!available || state.notified === notificationKey(result))) return;
    const pt = app.getLocale().toLowerCase().startsWith('pt');
    const options = {
      type: 'info', title: 'Factory Droid Desktop',
      message: available
        ? (pt ? `Nova versão do port disponível: ${result.latestVersion}` : `Port update available: ${result.latestVersion}`)
        : result.status === 'current'
          ? (pt ? 'Nenhuma versão mais nova do port publicada.' : 'No newer published port release.')
          : (pt ? 'Não foi possível verificar atualizações do port.' : 'Could not check for port updates.'),
      detail: available
        ? (pt ? `Instalada: ${version}. Nada será instalado automaticamente. Feche o app, faça backup do perfil e siga o guia de atualização.`
          : `Installed: ${version}. Nothing is installed automatically. Quit the app, back up your profile and follow the update guide.`)
        : (pt ? `Instalada: ${version}. A consulta usa releases públicas deste port, não versões oficiais da Factory. Repositório privado, ausência de releases ou falha de rede podem impedir a consulta.`
          : `Installed: ${version}. Checks use this port's public releases, not official Factory versions. A private repository, no releases or a network failure can prevent checking.`),
      buttons: available
        ? (pt ? ['Como atualizar', 'Notas da versão', 'Depois'] : ['How to update', 'Release notes', 'Later'])
        : (pt ? ['OK', 'Como atualizar'] : ['OK', 'How to update']),
      defaultId: available ? 2 : 0, cancelId: available ? 2 : 0, noLink: true,
    };
    const win = focused();
    const answer = await (win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options));
    if (!permitted()) return;
    if (available) { state.notified = notificationKey(result); persist(); }
    const url = available
      ? answer.response === 0 ? GUIDE_URL : answer.response === 1 ? result.releaseUrl : null
      : answer.response === 1 ? GUIDE_URL : null;
    if (url) await shell.openExternal(url);
  };
  const check = ({ manual = true } = {}) => {
    if (!permitted() || !manual && !autoEnabled()) return Promise.resolve();
    manualRequested ||= manual;
    if (inFlight) return inFlight;
    inFlight = (async () => {
      state.lastChecked = now(); persist();
      lastResult = await checkForUpdate(version, fetchImpl);
      if (manualRequested || autoEnabled()) await present(lastResult, manualRequested);
      return lastResult;
    })().catch(() => {}).finally(() => { inFlight = null; manualRequested = false; });
    return inFlight;
  };
  const automatic = () => {
    if (!autoEnabled() || !focused() || inFlight) return;
    if (lastResult?.status === 'available' && state.notified !== notificationKey(lastResult)) {
      // Reuse a completed check if the window lost focus during the request.
      inFlight = present(lastResult, false).catch(() => {}).finally(() => { inFlight = null; });
      return;
    }
    const elapsed = now() - state.lastChecked;
    if (elapsed >= DAY || elapsed < 0) void check({ manual: false });
  };
  const onFocus = () => {
    if (timer || !autoEnabled()) return;
    timer = schedule(() => { timer = null; automatic(); }, 15000);
    timer?.unref?.();
  };
  const stop = () => {
    stopped = true;
    if (timer) cancel(timer);
    timer = null;
    app.removeListener('browser-window-focus', onFocus);
    app.removeListener('will-quit', stop);
  };
  app.on('browser-window-focus', onFocus);
  app.on('will-quit', stop);
  onFocus();
  return {
    check, stop,
    menuItems() {
      if (!permitted()) return [];
      const pt = app.getLocale().toLowerCase().startsWith('pt');
      return [
        { label: pt ? 'Verificar atualizações do port…' : 'Check for port updates…', click: () => check() },
        { label: pt ? 'Verificar atualizações do port automaticamente' : 'Check for port updates automatically',
          type: 'checkbox', checked: autoEnabled(), enabled: autoPermitted(),
          click: item => { state.automatic = item.checked === true; persist(); rebuildMenu(); onFocus(); } },
        { type: 'separator' },
      ];
    },
  };
}

module.exports = { versionParts, compareVersions, checkForUpdate, createUpdateNotifier,
  RELEASE_API, GUIDE_URL };
