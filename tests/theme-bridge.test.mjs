import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createOmarchyThemeProvider, parseColorsToml } =
  require('../runtime/theme-bridge.cjs');

const PALETTE = `mode = "dark"\nbackground = "#101019"\nforeground = "#eeeeee"\naccent = "#89b4fa"\nred = "#f38ba8"\n`;

// The reader used by production is the PROVIDER: it owns the watch, the
// bounded retry and the fallback, and the main process reads the theme
// through it. The tests read the same state through the same public
// interface, so there is exactly one reader.
async function readThemeState(options = {}) {
  const provider = createOmarchyThemeProvider(options);
  try {
    await provider.start();
    return provider.getState();
  } finally {
    provider.stop();
  }
}

async function makeHome() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-theme-bridge-'));
  const current = path.join(home, '.local', 'state', 'omarchy', 'current');
  const theme = path.join(current, 'theme');
  await fs.mkdir(theme, { recursive: true });
  await fs.writeFile(path.join(theme, 'colors.toml'), PALETTE);
  await fs.writeFile(path.join(current, 'theme.generation'), 'theme-1\n');
  return { home, current, theme };
}

// Creates the Omarchy toggles directory (root/omarchy/toggles/hypr) with the
// requested toggle file; mode null creates the directories only.
async function makeToggles(root, mode) {
  const hypr = path.join(root, 'omarchy', 'toggles', 'hypr');
  await fs.mkdir(hypr, { recursive: true });
  if (mode) await fs.writeFile(path.join(hypr, `window-${mode}.lua`), '-- toggle\n');
  return hypr;
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Timed out waiting for the theme bridge event');
}

test('palette parser accepts only the fixed data-only mode and three hex colors', () => {
  assert.deepEqual(parseColorsToml(PALETTE), {
    mode: 'dark', background: '#101019', foreground: '#eeeeee', accent: '#89b4fa',
  });
  assert.deepEqual(parseColorsToml('mode="light"\nbackground="#ABCDEF"\nforeground="#ffffff"\naccent="#123456"\nsemantic = "ignored"\n'), {
    mode: 'light', background: '#abcdef', foreground: '#ffffff', accent: '#123456',
  });
  assert.equal(parseColorsToml(PALETTE + 'mode = "light"\n'), null, 'duplicates fail closed');
  assert.equal(parseColorsToml(PALETTE.replace('accent = "#89b4fa"', 'accent = "#89b4fa80"')), null);
  assert.equal(parseColorsToml(PALETTE.replace('mode = "dark"', 'mode = "system"')), null);
  assert.equal(parseColorsToml(PALETTE.replace('foreground = "#eeeeee"\n', '')), null);
  assert.equal(parseColorsToml('x'.repeat(16 * 1024 + 1)), null);
  assert.equal(parseColorsToml('[palette]\n' + PALETTE), null,
    'values inside TOML tables must not be treated as top-level palette values');
});

test('reader returns a complete snapshot from the fixed Omarchy state path', async t => {
  const fixture = await makeHome();
  t.after(() => fs.rm(fixture.home, { recursive: true, force: true }));
  assert.deepEqual(await readThemeState({ home: fixture.home }), {
    available: true, mode: 'dark', background: '#101019', foreground: '#eeeeee',
    accent: '#89b4fa', revision: 'theme-1', windowMode: 'transparent',
  });
  await fs.rm(path.join(fixture.theme, 'colors.toml'));
  assert.deepEqual(await readThemeState({ home: fixture.home }), {
    available: false, mode: null, background: null, foreground: null,
    accent: null, revision: null, windowMode: null,
  });
});

test('reader resolves the window mode with opaque precedence over glassy', async t => {
  const fixture = await makeHome();
  t.after(() => fs.rm(fixture.home, { recursive: true, force: true }));
  const hypr = await makeToggles(path.join(fixture.home, '.local', 'state'), 'glassy');
  assert.deepEqual(await readThemeState({ home: fixture.home }), {
    available: true, mode: 'dark', background: '#101019', foreground: '#eeeeee',
    accent: '#89b4fa', revision: 'theme-1', windowMode: 'glassy',
  });
  await fs.writeFile(path.join(hypr, 'window-opaque.lua'), '-- toggle\n');
  assert.equal((await readThemeState({ home: fixture.home })).windowMode, 'opaque');
  await fs.rm(path.join(hypr, 'window-opaque.lua'));
  assert.equal((await readThemeState({ home: fixture.home })).windowMode, 'glassy');
  await fs.rm(path.join(hypr, 'window-glassy.lua'));
  assert.equal((await readThemeState({ home: fixture.home })).windowMode, 'transparent');
});

test('reader fails the window mode closed on unsafe toggle paths but keeps the palette', async t => {
  const fixture = await makeHome();
  t.after(() => fs.rm(fixture.home, { recursive: true, force: true }));
  const hypr = await makeToggles(path.join(fixture.home, '.local', 'state'), null);
  const expectClosed = async () => {
    const state = await readThemeState({ home: fixture.home });
    assert.equal(state.available, true, 'an unknown window mode must not lose the palette');
    assert.equal(state.windowMode, null);
  };

  // Symlinked toggle file.
  const outside = path.join(fixture.home, 'outside.lua');
  await fs.writeFile(outside, '-- toggle\n');
  await fs.symlink(outside, path.join(hypr, 'window-glassy.lua'));
  await expectClosed();
  await fs.rm(path.join(hypr, 'window-glassy.lua'));

  // Non-regular FIFO toggle file: only metadata is inspected, never opened.
  try {
    execFileSync('mkfifo', ['-m', '600', path.join(hypr, 'window-glassy.lua')]);
  } catch (error) {
    if (error.code === 'EPERM') return t.skip('the current test sandbox does not permit mkfifo');
    throw error;
  }
  await expectClosed();
  await fs.rm(path.join(hypr, 'window-glassy.lua'));

  // Symlinked toggles/hypr directory.
  const alt = path.join(path.dirname(hypr), 'hypr-alt');
  await fs.rename(hypr, alt);
  await fs.symlink(alt, hypr, 'dir');
  await expectClosed();
  await fs.rm(hypr);
  await fs.rename(alt, hypr);

  // A safe path with regular files resolves normally again.
  await fs.writeFile(path.join(hypr, 'window-glassy.lua'), '-- toggle\n');
  await fs.writeFile(path.join(hypr, 'window-opaque.lua'), '-- toggle\n');
  assert.equal((await readThemeState({ home: fixture.home })).windowMode, 'opaque');
});

test('reader honors an explicit stateHome for the toggles root only', async t => {
  const fixture = await makeHome();
  t.after(() => fs.rm(fixture.home, { recursive: true, force: true }));
  const stateHome = path.join(fixture.home, 'custom-state');
  await makeToggles(stateHome, 'opaque');

  // The override does not move the palette or the default toggles path.
  assert.equal((await readThemeState({ home: fixture.home })).windowMode, 'transparent');
  const state = await readThemeState({ home: fixture.home, stateHome });
  assert.equal(state.available, true);
  assert.equal(state.revision, 'theme-1', 'the palette still comes from home');
  assert.equal(state.windowMode, 'opaque');

  // Toggles under the default path stay irrelevant while the override is set.
  await makeToggles(path.join(fixture.home, '.local', 'state'), 'glassy');
  assert.equal((await readThemeState({ home: fixture.home, stateHome })).windowMode, 'opaque');

  // A symlinked stateHome fails closed even though Omarchy would follow it.
  const realState = path.join(fixture.home, 'real-state');
  await makeToggles(realState, 'glassy');
  await fs.symlink(realState, path.join(fixture.home, 'linked-state'), 'dir');
  assert.equal((await readThemeState({
    home: fixture.home, stateHome: path.join(fixture.home, 'linked-state'),
  })).windowMode, null);

  // A non-directory stateHome fails closed.
  const stateFile = path.join(fixture.home, 'state-file');
  await fs.writeFile(stateFile, 'not a directory\n');
  assert.equal((await readThemeState({ home: fixture.home, stateHome: stateFile })).windowMode, null);

  // Invalid stateHome values fail closed without losing the palette.
  for (const invalid of ['relative/state', '', '/contains\0nul', null, 42]) {
    const failed = await readThemeState({ home: fixture.home, stateHome: invalid });
    assert.equal(failed.available, true, `stateHome ${String(invalid)} must not affect the palette`);
    assert.equal(failed.windowMode, null, `stateHome ${String(invalid)} must fail closed`);
  }
});

test('reader rejects symlinked active theme directories', async t => {
  const fixture = await makeHome();
  t.after(() => fs.rm(fixture.home, { recursive: true, force: true }));
  const replacement = path.join(fixture.current, 'replacement-theme');
  await fs.rename(fixture.theme, replacement);
  await fs.symlink(replacement, fixture.theme, 'dir');
  assert.equal((await readThemeState({ home: fixture.home })).available, false);
});

test('reader rejects FIFO inputs without blocking the Electron main process', async t => {
  if (process.platform !== 'linux') return t.skip('FIFO O_NONBLOCK behavior is Linux-specific');
  const subprocessProbe = spawnSync(process.execPath, ['-e', 'process.exit(0)'], {
    encoding: 'utf8', timeout: 1000,
  });
  if (subprocessProbe.error?.code === 'EPERM')
    return t.skip('the current test sandbox does not permit subprocesses');
  assert.equal(subprocessProbe.status, 0, subprocessProbe.stderr);

  const fixture = await makeHome();
  t.after(() => fs.rm(fixture.home, { recursive: true, force: true }));

  const modulePath = require.resolve('../runtime/theme-bridge.cjs');
  // The probe reads the theme through the public provider, exactly as the
  // main process does, and stops it so the process can exit.
  const probe = `const bridge=require(${JSON.stringify(modulePath)});` +
    `(async()=>{const provider=bridge.createOmarchyThemeProvider({home:${JSON.stringify(fixture.home)}});` +
    `await provider.start();console.log(JSON.stringify(provider.getState()));provider.stop();})()`;
  const assertPromptFailure = () => {
    const result = spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8', timeout: 1000 });
    assert.equal(result.error, undefined, 'reading a FIFO must return before the timeout');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).available, false);
  };

  const generation = path.join(fixture.current, 'theme.generation');
  await fs.rm(generation);
  try {
    execFileSync('mkfifo', ['-m', '600', generation]);
  } catch (error) {
    if (error.code === 'EPERM') return t.skip('the current test sandbox does not permit mkfifo');
    throw error;
  }
  assertPromptFailure();

  await fs.rm(generation);
  await fs.writeFile(generation, 'theme-fifo-test\n');
  const colors = path.join(fixture.theme, 'colors.toml');
  await fs.rm(colors);
  execFileSync('mkfifo', ['-m', '600', colors]);
  assertPromptFailure();
});

test('provider follows toggle creation and removal without a theme.generation change', async t => {
  const fixture = await makeHome();
  t.after(() => fs.rm(fixture.home, { recursive: true, force: true }));
  const provider = createOmarchyThemeProvider({
    home: fixture.home, debounceMs: 10, retryDelayMs: 10,
  });
  t.after(() => provider.stop());
  const changes = [];
  const initial = await provider.start(state => changes.push(state));
  assert.equal(initial.available, true);
  assert.equal(initial.windowMode, 'transparent');
  assert.equal(initial.revision, 'theme-1');

  const hypr = await makeToggles(path.join(fixture.home, '.local', 'state'), 'glassy');
  await waitFor(() => changes.some(state => state.windowMode === 'glassy'));
  assert.deepEqual(provider.getState(), {
    available: true, mode: 'dark', background: '#101019', foreground: '#eeeeee',
    accent: '#89b4fa', revision: 'theme-1', windowMode: 'glassy',
  });
  assert.equal(changes.some(state => !state.available), false);
  assert.equal(changes.some(state => state.revision !== 'theme-1'), false,
    'toggle changes must not require a theme.generation bump');

  await fs.rm(path.join(hypr, 'window-glassy.lua'));
  await waitFor(() => changes.some(state => state.windowMode === 'transparent'));
  assert.equal(changes.some(state => !state.available), false);
});

test('provider detects toggles appearing under a stateHome whose ancestors are missing', async t => {
  const fixture = await makeHome();
  t.after(() => fs.rm(fixture.home, { recursive: true, force: true }));
  const stateHome = path.join(fixture.home, 'nested', 'deeper', 'state');
  const provider = createOmarchyThemeProvider({
    home: fixture.home, stateHome, debounceMs: 10, retryDelayMs: 10,
  });
  t.after(() => provider.stop());
  const changes = [];
  const initial = await provider.start(state => changes.push(state));
  assert.equal(initial.available, true);
  assert.equal(initial.windowMode, 'transparent');

  const hypr = await makeToggles(stateHome, 'glassy');
  await waitFor(() => changes.some(state => state.windowMode === 'glassy'));
  assert.equal(changes.some(state => !state.available), false);
});

test('provider follows atomic replacement of the toggles/hypr directory', async t => {
  const fixture = await makeHome();
  t.after(() => fs.rm(fixture.home, { recursive: true, force: true }));
  const hypr = await makeToggles(path.join(fixture.home, '.local', 'state'), 'glassy');
  const provider = createOmarchyThemeProvider({
    home: fixture.home, debounceMs: 10, retryDelayMs: 10,
  });
  t.after(() => provider.stop());
  const changes = [];
  await provider.start(state => changes.push(state));
  await waitFor(() => changes.some(state => state.windowMode === 'glassy'));

  const staged = path.join(path.dirname(hypr), 'hypr-staged');
  await fs.mkdir(staged);
  await fs.writeFile(path.join(staged, 'window-opaque.lua'), '-- toggle\n');
  await fs.rename(hypr, path.join(path.dirname(hypr), 'hypr-old'));
  await fs.rename(staged, hypr);
  await waitFor(() => changes.some(state => state.windowMode === 'opaque'));
  assert.equal(provider.getState().windowMode, 'opaque');
  assert.equal(changes.some(state => !state.available), false);
});

test('provider stop closes toggle watchers, restarts cleanly, and keeps live detection', async t => {
  const fixture = await makeHome();
  t.after(() => fs.rm(fixture.home, { recursive: true, force: true }));
  const stateRoot = path.join(fixture.home, '.local', 'state');
  const hypr = await makeToggles(stateRoot, 'glassy');
  const provider = createOmarchyThemeProvider({
    home: fixture.home, debounceMs: 10, retryDelayMs: 10,
  });
  t.after(() => provider.stop());
  const changes = [];
  await provider.start(state => changes.push(state));
  await waitFor(() => changes.some(state => state.windowMode === 'glassy'));

  provider.stop();
  const countAfterStop = changes.length;
  await fs.writeFile(path.join(hypr, 'window-opaque.lua'), '-- toggle\n');
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(changes.length, countAfterStop, 'a stopped provider must not publish toggle events');

  const resumed = await provider.start(state => changes.push(state));
  assert.equal(resumed.available, true);
  assert.equal(resumed.windowMode, 'opaque');

  await fs.rm(path.join(hypr, 'window-opaque.lua'), { force: true });
  await fs.rm(path.join(hypr, 'window-glassy.lua'), { force: true });
  await waitFor(() => changes.some(state => state.windowMode === 'transparent'));
  provider.stop();
});

test('provider follows atomic theme replacement and stop closes its watchers', async t => {
  const fixture = await makeHome();
  t.after(() => fs.rm(fixture.home, { recursive: true, force: true }));

  const provider = createOmarchyThemeProvider({ home: fixture.home, debounceMs: 15, retryDelayMs: 10 });
  const changes = [];
  const initial = await provider.start(state => changes.push(state));
  assert.equal(initial.revision, 'theme-1');

  const nextTheme = path.join(fixture.current, 'staged-theme');
  await fs.mkdir(nextTheme);
  await fs.writeFile(path.join(nextTheme, 'colors.toml'), PALETTE.replace('#101019', '#202020'));
  await fs.rename(fixture.theme, path.join(fixture.current, 'previous-theme'));
  await fs.rename(nextTheme, fixture.theme);
  await fs.writeFile(path.join(fixture.current, 'theme.generation'), 'theme-2\n');

  await waitFor(() => changes.some(state => state.available && state.revision === 'theme-2'));
  assert.deepEqual(provider.getState(), {
    available: true, mode: 'dark', background: '#202020', foreground: '#eeeeee',
    accent: '#89b4fa', revision: 'theme-2', windowMode: 'transparent',
  });

  provider.stop();
  const countAfterStop = changes.length;
  await fs.writeFile(path.join(fixture.current, 'theme.generation'), 'theme-3\n');
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(changes.length, countAfterStop, 'closed provider must not publish later filesystem events');
});

test('provider preserves the last valid palette during an atomic gap, then falls back if missing persists', async t => {
  const fixture = await makeHome();
  t.after(() => fs.rm(fixture.home, { recursive: true, force: true }));

  const provider = createOmarchyThemeProvider({ home: fixture.home, debounceMs: 10, retryDelayMs: 15,
    maxRetries: 4 });
  const changes = [];
  await provider.start(state => changes.push(state));

  const oldTheme = path.join(fixture.current, 'previous-theme');
  await fs.rename(fixture.theme, oldTheme);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(provider.getState().revision, 'theme-1', 'a transient missing directory keeps the previous snapshot');
  assert.equal(changes.some(state => !state.available), false,
    'no unavailable state should flash while bounded retry is in progress');

  const nextTheme = path.join(fixture.current, 'staged-theme');
  await fs.mkdir(nextTheme);
  await fs.writeFile(path.join(nextTheme, 'colors.toml'), PALETTE.replace('#101019', '#202020'));
  await fs.rename(nextTheme, fixture.theme);
  await fs.writeFile(path.join(fixture.current, 'theme.generation'), 'theme-2\n');
  await waitFor(() => changes.some(state => state.available && state.revision === 'theme-2'));
  assert.equal(changes.some(state => !state.available), false,
    'the valid replacement should publish without an intermediate fallback');

  await fs.rm(path.join(fixture.theme, 'colors.toml'));
  await waitFor(() => changes.some(state => !state.available));
  assert.equal(provider.getState().available, false,
    'an unavailable source falls back after the bounded transient window');
  provider.stop();
});

test('provider falls back after an invalid replacement and can restart cleanly', async t => {
  const fixture = await makeHome();
  t.after(() => fs.rm(fixture.home, { recursive: true, force: true }));

  const provider = createOmarchyThemeProvider({ home: fixture.home, debounceMs: 10, retryDelayMs: 10 });
  const changes = [];
  await provider.start(state => changes.push(state));
  await fs.writeFile(path.join(fixture.theme, 'colors.toml'), PALETTE.replace('#89b4fa', 'red'));
  await fs.writeFile(path.join(fixture.current, 'theme.generation'), 'theme-invalid\n');
  await waitFor(() => changes.some(state => state.available === false));
  assert.deepEqual(provider.getState(), {
    available: false, mode: null, background: null, foreground: null, accent: null,
    revision: null, windowMode: null,
  });

  provider.stop();
  await fs.writeFile(path.join(fixture.theme, 'colors.toml'), PALETTE);
  await fs.writeFile(path.join(fixture.current, 'theme.generation'), 'theme-4\n');
  assert.equal((await provider.start()).revision, 'theme-4');
  provider.stop();
});
