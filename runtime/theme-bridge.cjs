'use strict';

// Read-only bridge for Omarchy's active colors.toml and window transparency
// toggles. This intentionally reads a tiny data-only subset, checks toggle
// files by presence and metadata only, and never loads a theme script, parses
// or executes Lua, or invokes Omarchy.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MAX_COLORS_BYTES = 16 * 1024;
const MAX_GENERATION_BYTES = 256;
const GENERATION_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const EMPTY_STATE = Object.freeze({
  available: false,
  mode: null,
  background: null,
  foreground: null,
  accent: null,
  revision: null,
  windowMode: null,
});

function unavailableState() {
  return { ...EMPTY_STATE };
}

function sameState(left, right) {
  return left.available === right.available
    && left.mode === right.mode
    && left.background === right.background
    && left.foreground === right.foreground
    && left.accent === right.accent
    && left.revision === right.revision
    && left.windowMode === right.windowMode;
}

function validateStateHome(stateHome) {
  if (typeof stateHome !== 'string' || stateHome.length === 0
    || !path.isAbsolute(stateHome) || stateHome.includes('\0')) return null;
  return path.resolve(stateHome);
}

// The palette always comes from home. stateHome only redirects the Omarchy
// toggles root; an invalid value fails the window mode closed (null) without
// affecting the palette. Process environment variables are never consulted
// here; the main caller passes XDG_STATE_HOME explicitly.
function resolvePaths(home, stateHome) {
  if (typeof home !== 'string' || !path.isAbsolute(home)) return null;
  const root = path.resolve(home);
  const stateRoot = stateHome === undefined
    ? path.join(root, '.local', 'state')
    : validateStateHome(stateHome);
  const toggles = stateRoot === null ? null
    : path.join(stateRoot, 'omarchy', 'toggles', 'hypr');
  return {
    home: root,
    state: path.join(root, '.local', 'state'),
    omarchy: path.join(root, '.local', 'state', 'omarchy'),
    current: path.join(root, '.local', 'state', 'omarchy', 'current'),
    theme: path.join(root, '.local', 'state', 'omarchy', 'current', 'theme'),
    colors: path.join(root, '.local', 'state', 'omarchy', 'current', 'theme', 'colors.toml'),
    generation: path.join(root, '.local', 'state', 'omarchy', 'current', 'theme.generation'),
    stateRoot,
    toggles,
    toggleChain: stateRoot === null ? null : [
      stateRoot,
      path.join(stateRoot, 'omarchy'),
      path.join(stateRoot, 'omarchy', 'toggles'),
      toggles,
    ],
  };
}

function isRealDirectory(filePath) {
  try {
    const info = fs.lstatSync(filePath);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

function isDirectory(filePath) {
  try { return fs.statSync(filePath).isDirectory(); } catch { return false; }
}

// Omarchy resolves window transparency from toggle files under
// omarchy/toggles/hypr: window-opaque.lua wins, then window-glassy.lua, else
// transparent. Only presence and metadata are inspected; the Lua content is
// never read, parsed, or executed. Symlinks and non-regular entries fail
// closed to null; a missing toggles path is Omarchy's transparent default.
function classifyToggleFile(filePath) {
  let info;
  try { info = fs.lstatSync(filePath); } catch { return 'absent'; }
  if (info.isSymbolicLink() || !info.isFile()) return 'unsafe';
  return 'present';
}

function readWindowMode(paths) {
  if (!paths || !paths.toggleChain) return null;
  for (const dir of paths.toggleChain) {
    let info;
    try { info = fs.lstatSync(dir); } catch { return 'transparent'; }
    if (!info.isDirectory() || info.isSymbolicLink()) return null;
  }
  const opaque = classifyToggleFile(path.join(paths.toggles, 'window-opaque.lua'));
  if (opaque === 'present') return 'opaque';
  if (opaque === 'unsafe') return null;
  const glassy = classifyToggleFile(path.join(paths.toggles, 'window-glassy.lua'));
  if (glassy === 'present') return 'glassy';
  if (glassy === 'unsafe') return null;
  return 'transparent';
}

// Directories watched so toggle changes are detected live even when part of
// the toggles path is missing, replaced, or deleted. The set is bounded by
// the state root path depth plus the fixed toggles chain; it includes the
// nearest existing real-directory ancestor so later creations are noticed.
function toggleWatchCandidates(paths) {
  if (!paths || !paths.stateRoot || !paths.toggleChain) return [];
  const candidates = [path.dirname(paths.stateRoot)];
  let current = paths.stateRoot;
  while (!isRealDirectory(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    candidates.push(parent);
    current = parent;
  }
  candidates.push(current, ...paths.toggleChain);
  return [...new Set(candidates)];
}

function readRegularFile(filePath, maxBytes) {
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  const nonBlock = fs.constants.O_NONBLOCK || 0;
  let descriptor;
  try {
    // Reject FIFOs/devices without allowing open() itself to block the main
    // process while it waits for a reader or writer.
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow | nonBlock);
    const info = fs.fstatSync(descriptor);
    if (!info.isFile() || info.size > maxBytes) return null;
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = fs.readSync(descriptor, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > maxBytes) return null;
    return buffer.subarray(0, length).toString('utf8');
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function parseColorsToml(source) {
  if (typeof source !== 'string' || Buffer.byteLength(source, 'utf8') > MAX_COLORS_BYTES)
    return null;

  const values = Object.create(null);
  const seen = new Set();
  const keyPattern = /^\s*(mode|background|foreground|accent)\s*=/;
  const valuePattern = /^\s*(mode|background|foreground|accent)\s*=\s*"([^"\\\r\n]*)"\s*(?:#.*)?$/;
  let inTable = false;

  for (const line of source.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) {
      inTable = true;
      continue;
    }
    if (inTable) continue;
    const key = line.match(keyPattern)?.[1];
    if (!key) continue;
    if (seen.has(key)) return null;
    seen.add(key);
    const match = line.match(valuePattern);
    if (!match || match[1] !== key) return null;
    values[key] = match[2];
  }

  if (values.mode !== 'light' && values.mode !== 'dark') return null;
  for (const key of ['background', 'foreground', 'accent']) {
    if (typeof values[key] !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(values[key])) return null;
  }

  return {
    mode: values.mode,
    background: values.background.toLowerCase(),
    foreground: values.foreground.toLowerCase(),
    accent: values.accent.toLowerCase(),
  };
}

function readSnapshot(paths) {
  if (!paths || !isDirectory(paths.home)
      || !isDirectory(path.join(paths.home, '.local'))
      || !isDirectory(paths.state)
      || !isDirectory(paths.omarchy)
      || !isRealDirectory(paths.current)) {
    return { state: unavailableState(), transient: false };
  }

  // Omarchy replaces current/theme by rename and updates theme.generation.
  // The marker read on both sides detects a snapshot that spans a switch.
  const before = readRegularFile(paths.generation, MAX_GENERATION_BYTES)?.trim();
  if (!before) return { state: unavailableState(), transient: true };
  if (!GENERATION_PATTERN.test(before)) return { state: unavailableState(), transient: false };
  if (!isRealDirectory(paths.theme)) return { state: unavailableState(), transient: true };

  const colors = readRegularFile(paths.colors, MAX_COLORS_BYTES);
  if (colors === null) return { state: unavailableState(), transient: true };
  const after = readRegularFile(paths.generation, MAX_GENERATION_BYTES)?.trim();
  if (!after || before !== after) return { state: unavailableState(), transient: true };

  const palette = parseColorsToml(colors);
  if (!palette) return { state: unavailableState(), transient: false };
  return {
    state: { available: true, ...palette, revision: before, windowMode: readWindowMode(paths) },
    transient: false,
  };
}

function createOmarchyThemeProvider(options = {}) {
  const home = options.home === undefined ? os.homedir() : options.home;
  const paths = resolvePaths(home, options.stateHome);
  const debounceMs = Number.isInteger(options.debounceMs)
    ? Math.max(0, Math.min(options.debounceMs, 1000)) : 80;
  const retryDelayMs = Number.isInteger(options.retryDelayMs)
    ? Math.max(1, Math.min(options.retryDelayMs, 250)) : 35;
  const maxRetries = Number.isInteger(options.maxRetries)
    ? Math.max(0, Math.min(options.maxRetries, 8)) : 4;

  let state = unavailableState();
  let started = false;
  let startingPromise = null;
  let lifecycle = 0;
  let parentWatcher = null;
  let themeWatcher = null;
  let debounceTimer = null;
  let retryTimer = null;
  let startRetryTimer = null;
  let cancelStartRetry = null;
  let retryCount = 0;
  const listeners = new Set();
  // Watched directory path -> { watcher, dev, ino }. The dev/ino identity lets
  // a stale watcher on an atomically replaced directory be rebound.
  const toggleWatchers = new Map();

  function publish(next) {
    if (sameState(state, next)) return;
    state = next;
    for (const listener of listeners) {
      try { listener({ ...state }); } catch { /* A UI listener cannot break the watcher. */ }
    }
  }

  function closeThemeWatcher() {
    if (!themeWatcher) return;
    themeWatcher.close();
    themeWatcher = null;
  }

  function watchThemeDirectory() {
    if (themeWatcher || !paths || !isRealDirectory(paths.theme)) return;
    try {
      themeWatcher = fs.watch(paths.theme, () => queueRefresh());
      themeWatcher.on('error', closeThemeWatcher);
    } catch {
      closeThemeWatcher();
    }
  }

  function closeToggleWatcher(dir) {
    const entry = toggleWatchers.get(dir);
    if (!entry) return;
    toggleWatchers.delete(dir);
    try { entry.watcher.close(); } catch { /* already closed */ }
  }

  // Rebind the bounded set of toggle watchers: close entries whose directory
  // is gone, unsafe, or a different inode (atomic replacement), then watch
  // every currently real directory in the candidate path. A watched ancestor
  // always covers the later creation of a missing entry.
  function syncToggleWatchers() {
    for (const [dir, entry] of [...toggleWatchers]) {
      let info = null;
      try { info = fs.lstatSync(dir); } catch { /* missing or unreadable */ }
      if (!info || !info.isDirectory() || info.isSymbolicLink()
        || info.dev !== entry.dev || info.ino !== entry.ino) {
        closeToggleWatcher(dir);
      }
    }
    for (const dir of toggleWatchCandidates(paths)) {
      if (toggleWatchers.has(dir)) continue;
      let info;
      try { info = fs.lstatSync(dir); } catch { continue; }
      if (!info.isDirectory() || info.isSymbolicLink()) continue;
      try {
        const watcher = fs.watch(dir, () => queueRefresh(false));
        watcher.on('error', () => {
          closeToggleWatcher(dir);
          queueRefresh(false);
        });
        toggleWatchers.set(dir, { watcher, dev: info.dev, ino: info.ino });
      } catch { /* unwatchable right now; a watched ancestor covers it */ }
    }
  }

  function refreshNow() {
    if (!started) return state;
    watchThemeDirectory();
    syncToggleWatchers();
    const result = readSnapshot(paths);
    if (!result.transient) publish(result.state);
    return result;
  }

  function retryRefresh() {
    retryTimer = null;
    if (!started) return;
    const result = refreshNow();
    if (!result.transient || retryCount >= maxRetries) {
      retryCount = 0;
      if (result.transient) publish(unavailableState());
      return;
    }
    retryCount++;
    retryTimer = setTimeout(retryRefresh, retryDelayMs);
  }

  function queueRefresh(parentChanged = false) {
    if (!started) return;
    if (parentChanged) closeThemeWatcher();
    if (debounceTimer) clearTimeout(debounceTimer);
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    retryCount = 0;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      retryRefresh();
    }, debounceMs);
  }

  function start(onChange) {
    if (typeof onChange === 'function') listeners.add(onChange);
    if (startingPromise) return startingPromise.then(() => ({ ...state }));
    if (started) {
      refreshNow();
      return Promise.resolve({ ...state });
    }

    started = true;
    const startId = ++lifecycle;
    if (paths && isRealDirectory(paths.current)) {
      try {
        parentWatcher = fs.watch(paths.current, () => queueRefresh(true));
        parentWatcher.on('error', () => {
          parentWatcher?.close();
          parentWatcher = null;
        });
      } catch {
        parentWatcher = null;
      }
      watchThemeDirectory();
    }

    // The bounded async retries cover a theme being in its atomic remove/move
    // window at startup without blocking Electron's main event loop.
    let pending;
    pending = (async () => {
      let result = refreshNow();
      let remaining = maxRetries;
      while (started && lifecycle === startId && result.transient && remaining > 0) {
        await new Promise(resolve => {
          cancelStartRetry = resolve;
          startRetryTimer = setTimeout(() => {
            startRetryTimer = null;
            cancelStartRetry = null;
            resolve();
          }, retryDelayMs);
        });
        if (!started || lifecycle !== startId) break;
        result = refreshNow();
        remaining--;
      }
      if (started && lifecycle === startId && result.transient) publish(unavailableState());
      return { ...state };
    })().finally(() => { if (startingPromise === pending) startingPromise = null; });
    startingPromise = pending;
    return startingPromise;
  }

  function getState() {
    if (started) {
      const result = refreshNow();
      if (result.transient) queueRefresh();
    }
    return { ...state };
  }

  function stop() {
    started = false;
    lifecycle++;
    startingPromise = null;
    if (debounceTimer) clearTimeout(debounceTimer);
    if (retryTimer) clearTimeout(retryTimer);
    if (startRetryTimer) clearTimeout(startRetryTimer);
    const finishStartRetry = cancelStartRetry;
    cancelStartRetry = null;
    startRetryTimer = null;
    finishStartRetry?.();
    debounceTimer = null;
    retryTimer = null;
    retryCount = 0;
    parentWatcher?.close();
    parentWatcher = null;
    closeThemeWatcher();
    for (const dir of [...toggleWatchers.keys()]) closeToggleWatcher(dir);
    listeners.clear();
  }

  return Object.freeze({ getState, start, stop });
}

module.exports = {
  parseColorsToml,
  createOmarchyThemeProvider,
  unavailableState,
};
