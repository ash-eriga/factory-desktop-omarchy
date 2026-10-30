import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import vm from 'node:vm';
import { factoryPortCreateApplicationMenu, factoryPortMountApplicationMenu, applicationMenuMainChanges } from '../tools/application-menu-patches.mjs';
import { patch, diagnose } from '../tools/patches.mjs';

function harness() {
  const handlers = new Map(), win = new EventEmitter(), contents = new EventEmitter(), sent = [];
  let clicks = 0, glassy = true, trusted = true, focused = true, sequence = 0;
  const enabled = { label: 'Zoom &In', enabled: true, type: 'normal', accelerator: 'Ctrl+=',
    click: (event, window, webContents) => {
      assert.equal(window, win); assert.equal(webContents, contents); clicks++;
    } };
  const hidden = { label: 'Hidden', visible: false, click: () => assert.fail('hidden command') };
  const disabled = { label: 'Disabled', enabled: false, click: () => assert.fail('disabled command') };
  const parent = { id: 'View', label: '&View', submenu: { items: [enabled, hidden, disabled, { type: 'separator' }] } };
  let menu = { items: [parent] };
  Object.assign(contents, { isDestroyed: () => false, send: (...args) => sent.push(args) });
  Object.assign(win, { webContents: contents, isDestroyed: () => false, isFocused: () => focused });
  const event = { sender: contents };
  const palette = { background: '#101019', foreground: '#eeeeee', mode: 'dark' };
  const api = factoryPortCreateApplicationMenu({ electron: {
    Menu: { getApplicationMenu: () => menu }, BrowserWindow: { fromWebContents: () => win },
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
  }, trusted: () => trusted, isGlassy: () => glassy, getPalette: () => palette, newToken: () => `token-${++sequence}` });
  const invoke = (name, value) => handlers.get(`factory-linux-menu:${name}`)(event, value);
  const show = () => { invoke('ready', true); return api.show(event, { menu: 'View', x: 20, y: 32 }); };
  const opened = () => sent.filter(([name]) => name.endsWith(':open')).at(-1)?.[1];
  const activate = (command = 2, token = opened().token) => invoke('activate', { token, command });
  return { api, event, win, contents, palette, parent, enabled, sent, invoke, show, opened, activate,
    clicks: () => clicks, setGlass: value => { glassy = value; }, setTrust: value => { trusted = value; },
    setFocus: value => { focused = value; }, replaceMenu: () => { menu = { items: [] }; } };
}

test('Glassy menu requires renderer readiness, trusted owner and current follow gate', () => {
  const h = harness();
  assert.equal(h.api.show(h.event), false);
  assert.equal(h.show(), true);
  h.setGlass(false); assert.equal(h.show(), false);
  h.setGlass(true); h.setTrust(false);
  assert.equal(h.invoke('ready', true), false); assert.equal(h.show(), false);
});

test('serialization includes actual labels, roles accelerators and disabled state, never hidden commands or callbacks', () => {
  const h = harness(); h.show();
  const children = h.opened().items[0].children;
  assert.equal(children.length, 3); assert.equal(children[0].label, 'Zoom &In');
  assert.equal(children[0].accelerator, 'Ctrl+='); assert.equal(children[1].enabled, false);
  assert.equal(JSON.stringify(h.opened()).includes('click'), false);
});

test('dispatch uses the original native MenuItem.click exactly once', () => {
  const h = harness(); h.show(); const request = h.opened();
  assert.equal(h.activate(), true); assert.equal(h.clicks(), 1);
  assert.equal(h.activate(2, request.token), false); assert.equal(h.clicks(), 1);
});

test('stale, forged, disabled and changed-menu commands are rejected', () => {
  for (const mutate of [
    h => h.setGlass(false), h => h.setTrust(false),
    h => { h.enabled.enabled = false; }, h => { h.parent.enabled = false; },
    h => { h.parent.visible = false; }, h => h.replaceMenu(),
  ]) {
    const h = harness(); h.show(); mutate(h);
    assert.equal(h.activate(), false); assert.equal(h.clicks(), 0);
  }
  const h = harness(); h.show();
  assert.equal(h.activate(2, 'forged-token'), false);
  assert.equal(h.activate(3), false); assert.equal(h.activate(999), false);
  assert.equal(h.activate(1), false, 'a submenu is not a leaf command');
});

test('advisory Wayland focus does not block the trusted owning window command', () => {
  const h = harness(); h.show(); h.setFocus(false);
  assert.equal(h.activate(), true); assert.equal(h.clicks(), 1);
});

test('popup tokens belong to their own window and latest snapshot', () => {
  const h = harness(); h.show(); const token = h.opened().token; h.show();
  assert.equal(h.activate(2, token), false);
  h.invoke('dismiss', token); assert.equal(h.api.isOpen(h.win), true);
  h.invoke('dismiss', h.opened().token); assert.equal(h.api.isOpen(h.win), false);
});

test('blur, resize, navigation, palette changes and Follow off dismiss active popups', () => {
  for (const event of ['blur', 'resize']) {
    const h = harness(); h.show(); h.win.emit(event);
    assert.equal(h.api.isOpen(h.win), false);
  }
  const h = harness(); h.show(); h.contents.emit('did-start-navigation', {}, '', false, true);
  assert.equal(h.api.isOpen(h.win), false);
  assert.equal(h.api.show(h.event), false, 'navigation revokes renderer readiness');
  h.show(); h.palette.background = '#ffffff'; h.api.sync(h.win);
  assert.equal(h.api.isOpen(h.win), false);
  h.show(); h.setGlass(false); h.api.sync(h.win); assert.equal(h.api.isOpen(h.win), false);
});

test('Alt/F10 keyboard entry toggles the same popup instead of opening another one', () => {
  const h = harness(); h.invoke('ready', true);
  assert.equal(h.api.keyboard(h.event), true);
  assert.equal(h.api.isOpen(h.win), true);
  assert.equal(h.api.keyboard(h.event), true);
  assert.equal(h.api.isOpen(h.win), false);
});

test('closed cleanup never reads native properties of the destroyed window', () => {
  const h = harness(); h.show();
  Object.defineProperty(h.win, 'webContents', {
    get() { throw new TypeError('Object has been destroyed'); },
  });
  assert.doesNotThrow(() => h.win.emit('closed'));
  assert.equal(h.api.isOpen(h.win), false);
});

const versions = JSON.parse(readFileSync(new URL('../versions.json', import.meta.url), 'utf8'));
const lifecycleFile = new URL(`../build/upstream-pristine-${versions.desktop}/app/${versions.lifecycle}`, import.meta.url);
test('application menu patch matches the actual pinned lifecycle exactly once', {
  skip: existsSync(lifecycleFile) ? false : 'the pristine vendor snapshot is absent; run the build to produce it',
}, () => {
  const source = readFileSync(lifecycleFile, 'utf8');
  assert.deepEqual(diagnose(source, applicationMenuMainChanges), []);
  assert.doesNotThrow(() => new vm.Script(patch(source, applicationMenuMainChanges)));
});

// --------------------------------------------------- generated renderer menu

// The renderer menu is generated as source and injected into the patched
// bundle, so the helper itself is the artifact under test. Only the
// browser objects it touches are replaced here: the menu that is built
// is the real one, with the real items, roles, focus and cleanup.
function fakeDom() {
  const makeElement = tag => {
    const listeners = new Map();
    let ownText = '';
    const element = {
      tagName: String(tag).toUpperCase(),
      children: [],
      parent: null,
      dataset: {},
      attributes: {},
      style: { setProperty(name, value) { element.style[name] = value; } },
      get textContent() {
        return ownText + element.children.map(child => child.textContent).join('');
      },
      set textContent(value) { ownText = String(value); },
      tabIndex: 0,
      disabled: false,
      type: '',
      isConnected: false,
      append(...nodes) {
        for (const node of nodes) {
          node.parent = element;
          node.isConnected = element.isConnected;
          element.children.push(node);
        }
      },
      remove() {
        if (!element.parent) return;
        element.parent.children = element.parent.children.filter(child => child !== element);
        element.parent = null;
        element.isConnected = false;
      },
      setAttribute(name, value) { element.attributes[name] = String(value); },
      getAttribute(name) { return element.attributes[name] ?? null; },
      addEventListener(type, handler) {
        const list = listeners.get(type) || [];
        list.push(handler);
        listeners.set(type, list);
      },
      dispatch(type, event = {}) {
        for (const handler of listeners.get(type) || []) {
          handler({ preventDefault() {}, stopPropagation() {}, ...event });
        }
      },
      focus() { document.activeElement = element; },
      getBoundingClientRect() {
        return { left: 0, top: 0, right: 120, bottom: 20, width: 120, height: 20 };
      },
      contains(node) {
        if (node === element) return true;
        return element.children.some(child => child.contains(node));
      },
      querySelectorAll(selector) {
        const found = [];
        const walk = node => {
          for (const child of node.children) {
            if (selector.startsWith('button') && child.tagName === 'BUTTON' && !child.disabled) {
              found.push(child);
            }
            walk(child);
          }
        };
        walk(element);
        return found;
      },
    };
    return element;
  };
  const head = makeElement('head');
  const body = makeElement('body');
  const documentListeners = new Map();
  const document = {
    head,
    body,
    activeElement: null,
    createElement: makeElement,
    addEventListener(type, handler) {
      const list = documentListeners.get(type) || [];
      list.push(handler);
      documentListeners.set(type, list);
    },
    removeEventListener(type, handler) {
      const list = documentListeners.get(type) || [];
      documentListeners.set(type, list.filter(entry => entry !== handler));
    },
    dispatch(type, event = {}) {
      for (const handler of documentListeners.get(type) || []) {
        handler({ preventDefault() {}, stopPropagation() {}, ...event });
      }
    },
  };
  const windowListeners = new Map();
  const window = {
    addEventListener(type, handler) {
      const list = windowListeners.get(type) || [];
      list.push(handler);
      windowListeners.set(type, list);
    },
    removeEventListener(type, handler) {
      const list = windowListeners.get(type) || [];
      windowListeners.set(type, list.filter(entry => entry !== handler));
    },
    dispatch(type, event = {}) {
      for (const handler of windowListeners.get(type) || []) handler(event);
    },
  };
  return { document, window };
}

function mountRendererMenu() {
  const { document, window } = fakeDom();
  const context = vm.createContext({ document, window, innerWidth: 1280, innerHeight: 800 });
  vm.runInContext(
    `var factoryPortMountApplicationMenu = ${factoryPortMountApplicationMenu.toString()};`, context);
  const activated = [];
  const dismissed = [];
  let deliver = null;
  const api = {
    onOpen(handler) { deliver = handler; return () => { deliver = null; }; },
    activate(token, command) { activated.push({ token, command }); return Promise.resolve(true); },
    dismiss(token) { dismissed.push(token); },
  };
  const stop = context.factoryPortMountApplicationMenu(api);
  return { document, window, stop, activated, dismissed, open: session => deliver(session) };
}

const rendererSession = () => ({
  token: 'token-1',
  menu: '',
  x: 20,
  y: 32,
  palette: { background: '#101019', foreground: '#eeeeee', mode: 'dark' },
  items: [
    { id: 'View', label: '&View', type: 'normal', enabled: true, command: 1,
      children: [{ id: 'zoom', label: 'Zoom &In', type: 'normal', enabled: true, command: 2,
        accelerator: 'CommandOrControl+Equal' }] },
    { id: 'sep', type: 'separator' },
    { id: 'off', label: 'Disabled', type: 'normal', enabled: false, command: 3, accelerator: 'Ctrl+D' },
    { id: 'toggle', label: 'Toggle', type: 'checkbox', checked: true, enabled: true, command: 4,
      accelerator: 'Ctrl+T' },
  ],
});

test('the generated renderer menu builds the real items, roles and separators', () => {
  const menu = mountRendererMenu();
  menu.open(rendererSession());
  const panels = menu.document.body.children.flatMap(root =>
    root.children.filter(child => child.getAttribute('role') === 'menu'));
  assert.equal(panels.length, 1, 'the menu is inserted into the document');
  const panel = panels[0];
  assert.equal(panel.getAttribute('aria-label'), 'Application');
  assert.equal(panel.dataset.factoryPortApplicationMenu, '');
  const buttons = panel.children.filter(child => child.tagName === 'BUTTON');
  const separator = panel.children.filter(child => child.tagName === 'HR');
  assert.equal(separator.length, 1);
  assert.equal(separator[0].getAttribute('role'), 'separator');
  assert.equal(buttons.length, 3, 'the separator is not a command');
  assert.equal(buttons[0].getAttribute('role'), 'menuitem');
  assert.equal(buttons[0].getAttribute('aria-haspopup'), 'menu');
  assert.equal(buttons[1].disabled, true, 'a disabled command stays disabled');
  assert.equal(buttons[2].getAttribute('role'), 'menuitemcheckbox');
  assert.equal(buttons[2].getAttribute('aria-checked'), 'true');
  assert.equal(buttons[0].children[1].textContent, 'View',
    'the ampersand of the label is unescaped');
  assert.equal(buttons[0].children[2].textContent, '›');
  menu.stop();
});

test('the generated renderer menu opens a submenu, closes it and activates a command', () => {
  const menu = mountRendererMenu();
  menu.open(rendererSession());
  const panels = () => menu.document.body.children
    .flatMap(root => root.children.filter(child => child.getAttribute('role') === 'menu'));
  const top = panels()[0];
  const parent = top.children.find(child => child.tagName === 'BUTTON');
  parent.dispatch('pointerenter', {});
  assert.equal(panels().length, 2, 'the submenu is built');
  assert.equal(parent.getAttribute('aria-expanded'), 'true');
  const child = panels()[1].children.find(button => button.tagName === 'BUTTON');
  assert.match(panels()[1].getAttribute('aria-label'), /^View/,
    'the submenu is named after the command that opened it');
  assert.equal(child.children[1].textContent, 'Zoom In',
    'the ampersand of the label is the mnemonic, not a character of the text');
  child.dispatch('click', {});
  assert.deepEqual(menu.activated, [{ token: 'token-1', command: 2 }],
    'the command is activated with the token of the session');
  assert.equal(panels().length, 0, 'the menu closes itself after a command');
  menu.stop();
});

test('the generated renderer menu moves the focus with the keyboard and cleans up', () => {
  const menu = mountRendererMenu();
  menu.open(rendererSession());
  const panels = () => menu.document.body.children
    .flatMap(root => root.children.filter(child => child.getAttribute('role') === 'menu'));
  const top = panels()[0];
  const buttons = top.children.filter(child => child.tagName === 'BUTTON');
  assert.equal(menu.document.activeElement, buttons[0], 'the first command is focused');
  menu.document.dispatch('keydown', { key: 'ArrowDown' });
  assert.equal(menu.document.activeElement, buttons[2],
    'the focus walks the commands that can be taken');
  menu.document.dispatch('keydown', { key: 'Escape' });
  assert.equal(panels().length, 0, 'Escape closes the menu');
  assert.deepEqual(menu.dismissed, ['token-1'], 'the main process is told to dismiss');
  menu.stop();
  assert.equal(menu.document.body.children.length, 0, 'the cleanup removes what it added');
});
