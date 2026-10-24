import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { changes, diagnose, patch, preloadChanges, linuxMenuKeyboardHandler } from '../tools/patches.mjs';

test('every patch applies exactly once to a representative source', () => {
  // A source containing each anchor exactly once (replacements embed the
  // anchor text, so anchors only, never replacements, go into the source).
  const source = changes.map(([, before]) => before).join('\n') + '\n';
  const patched = patch(source);
  for (const [name, before, after] of changes) {
    assert.ok(patched.includes(after), name);
    // Each anchor is consumed: the patched text has it only where earlier
    // replacements legitimately embed it.
    const original = source.split(before).length - 1;
    assert.equal(original, 1, name);
  }
});

test('patch refuses zero matches', () => {
  assert.throws(() => patch('function unrelated(){try{const e=zz();'));
});

test('patch refuses two matches rather than relaxing the guard', () => {
  const anchor = changes[0][1];
  assert.throws(() => patch(`${anchor}\n${anchor}`));
});

test('diagnose reports every mismatching anchor at once', () => {
  const report = diagnose('no anchors here');
  assert.equal(report.length, changes.length);
  for (const item of report) {
    assert.ok(item.name);
    assert.equal(item.count, 0);
  }
  assert.deepEqual(diagnose(changes.map(([, before]) => before).join('\n')), []);
});

test('patched main guards keep the pacman boundary closed on Linux', () => {
  const names = new Map(changes.map(([name]) => [name, name]));
  for (const required of ['callback opt-in', 'application name', 'minimum version prompt',
    'manual updater', 'update checks', 'update menu', 'keyboard application menu',
    'Linux window icon']) {
    assert.ok(names.has(required), `missing patch: ${required}`);
  }
  // The updater entry points must bail out before touching vendor state, and
  // the callback helper must only fix the desktop entry name on Linux.
  const source = changes.map(([, before]) => before).join('\n');
  const patched = patch(source);
  assert.match(patched, /async function uD\(\)\{if\(process\.platform==="linux"\)return!0;/);
  assert.match(patched, /async function T4\(\{onAborted:e\}=\{\}\)\{if\(process\.platform==="linux"\)\{e\?\.\(\);return;\}/);
  assert.match(patched, /async function iD\(\)\{if\(process\.platform==="linux"\)return;/);
  assert.match(patched, /function xte\(\)\{if\(process\.platform==="linux"\)\{T\.app\.setDesktopName\("factory-droid-desktop\.desktop"\);return;\}/);
  // The visible name of the port is set before the first window exists.
  assert.match(patched, /i\.startupTracker\.beginPhase\("ipc_and_protocol_setup"\),T\.app\.setName\("Factory Droid Desktop"\),xte\(\)/);
  assert.match(patched, /r=process\.platform==="linux"\|\|!t\|\|i\.areDesktopUpdatesDisabledByCachedOrgSettings\(\)\?\[\]:/);
  // Nothing may widen the guards to other platforms.
  for (const [, , after] of changes) {
    for (const platform of ['"darwin"', '"win32"']) {
      const guard = new RegExp(`process\\.platform===${platform}.*return`);
      for (const line of after.split(';')) {
        assert.equal(line.match(guard), null, `guard leaked to ${platform}: ${line}`);
      }
    }
  }
});

test('Linux main windows are created transparent-capable with native controls intact', () => {
  const source = changes.map(([, before]) => before).join('\n') + '\n';
  const patched = patch(source);
  const [, before, after] = changes.find(([name]) => name === 'Linux window icon');
  assert.equal(before, 'titleBarStyle:"hidden",titleBarOverlay:t?');
  // The transparency flag is Linux-only and applied at BrowserWindow creation
  // (proven on native Wayland in build/glassy-native-proof/report.json); the
  // vendor keeps its hidden title bar and transparent overlay untouched.
  assert.match(after, /transparent:process\.platform==="linux"\|\|void 0,titleBarStyle:"hidden",titleBarOverlay:t\?/);
  assert.ok(patched.includes(after));
  for (const platform of ['"darwin"', '"win32"']) {
    assert.equal(after.includes(`transparent:process.platform===${platform}`), false,
      `transparency must not leak to ${platform}`);
  }
});

test('preload needs no patch: the native non-darwin menu API stays untouched', () => {
  // 0.205.0 upstream exposes showApplicationMenu on every non-darwin platform,
  // so the recipe must not rewrite preload.js at all.
  assert.deepEqual(preloadChanges, []);
  const source = 'window:{showApplicationMenu:process.platform==="darwin"?void 0:A=>1}';
  assert.equal(patch(source, preloadChanges), source);
  assert.deepEqual(diagnose(source, preloadChanges), []);
});

test('hidden Linux menu stays accessible without stealing Alt shortcuts', () => {
  const handlers = new Map();
  let popups = 0;
  const window = { on: (name, cb) => handlers.set(name, cb),
    webContents: { on: (name, cb) => handlers.set(name, cb) } };
  vm.runInNewContext(linuxMenuKeyboardHandler, {
    process: { platform: 'linux' }, a: window,
    T: { Menu: { getApplicationMenu: () => ({ popup: ({window: target}) => {
      assert.equal(target, window); popups++;
    } }) } },
  });
  const send = (key, type = 'keyDown', extra = {}) => {
    let prevented = false;
    handlers.get('before-input-event')({ preventDefault: () => { prevented = true; } },
      { key, type, ...extra });
    return prevented;
  };
  assert.equal(send('Alt'), false);
  assert.equal(send('Alt', 'keyUp'), true);
  assert.equal(popups, 1);
  send('Alt'); send('ArrowLeft', 'keyDown', { alt: true }); send('Alt', 'keyUp');
  assert.equal(popups, 1, 'Alt+Left must remain a navigation shortcut');
  send('Alt'); handlers.get('blur')(); send('Alt', 'keyUp');
  assert.equal(popups, 1, 'Alt+Tab/blur must not open a menu on return');
  assert.equal(send('F10'), true);
  assert.equal(send('F10', 'keyDown', { shift: true }), false);
  assert.equal(send('F10', 'keyDown', { isAutoRepeat: true }), false);
  assert.equal(popups, 2);
});
