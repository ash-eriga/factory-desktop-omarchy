// Presentation only: build the popup from Electron's actual application
// menu and invoke its original MenuItem.click, including native roles.
export function factoryPortCreateApplicationMenu({ electron, trusted, isGlassy, getPalette, newToken }) {
  const { Menu, BrowserWindow, ipcMain } = electron;
  const ready = new WeakSet(), active = new WeakMap(), observed = new WeakSet();
  const owner = event => trusted(event) ? BrowserWindow.fromWebContents(event.sender) : null;
  const close = win => {
    if (!active.has(win)) return;
    active.delete(win);
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('factory-linux-menu:close');
  };
  ipcMain.handle('factory-linux-menu:ready', (event, enabled) => {
    const win = owner(event);
    if (!win || typeof enabled !== 'boolean') return false;
    if (enabled) ready.add(win.webContents);
    else { ready.delete(win.webContents); close(win); }
    return true;
  });
  ipcMain.handle('factory-linux-menu:dismiss', (event, token) => {
    const win = owner(event);
    if (win && active.get(win)?.token === token) close(win);
  });
  ipcMain.handle('factory-linux-menu:activate', (event, request) => {
    const win = owner(event), session = win && active.get(win);
    // Match the native API: authorize this window's trusted frame and
    // current popup token, not the advisory native focus flag.
    if (!win || !session || !isGlassy(win) ||
        !request || request.token !== session.token || !Number.isInteger(request.command)) return false;
    const command = session.commands.get(request.command);
    if (!command || Menu.getApplicationMenu() !== session.menu ||
        command.parents.some(item => item.enabled === false || item.visible === false) ||
        command.item.submenu || command.item.enabled === false || command.item.visible === false) return false;
    close(win);
    command.item.click({}, win, win.webContents);
    return true;
  });
  return {
    close,
    sync(win) {
      const session = active.get(win), palette = getPalette();
      if (!isGlassy(win) || session && session.palette !== JSON.stringify([palette.background, palette.foreground, palette.mode])) close(win);
    },
    isOpen(win) { return active.has(win); },
    keyboard(event) {
      const win = owner(event);
      if (win && active.has(win)) { close(win); return true; }
      return this.show(event);
    },
    show(event, payload) {
      const win = owner(event);
      if (!win || !isGlassy(win) || !ready.has(win.webContents)) return false;
      if (payload !== undefined && (!payload || !['File', 'Edit', 'View', 'Window', 'Help'].includes(payload.menu) ||
          !Number.isFinite(payload.x) || !Number.isFinite(payload.y))) return false;
      const menu = Menu.getApplicationMenu();
      if (!menu) return false;
      let commandId = 0;
      const commands = new Map();
      const serialize = (source, parents = []) => source.items.filter(item => item.visible !== false).map(item => {
        const command = ++commandId;
        commands.set(command, { item, parents });
        const children = item.submenu ? serialize(item.submenu, [...parents, item]) : undefined;
        return { command, id: item.id, label: item.label, type: item.type,
          enabled: item.enabled !== false, checked: item.checked === true,
          accelerator: String(item.accelerator || item.getDefaultRoleAccelerator?.() || ''),
          ...(children ? { children } : {}) };
      });
      const items = serialize(menu);
      if (payload && !items.some(item => item.id === payload.menu && item.children)) return false;
      const token = newToken();
      const palette = getPalette();
      active.set(win, { token, menu, commands,
        palette: JSON.stringify([palette.background, palette.foreground, palette.mode]) });
      if (!observed.has(win)) {
        observed.add(win);
        // BrowserWindow.webContents throws once the native window is gone.
        // Keep the already-owned contents for destruction/navigation cleanup.
        const contents = win.webContents;
        win.on('blur', () => close(win));
        win.on('resize', () => close(win));
        win.once('closed', () => { active.delete(win); ready.delete(contents); });
        contents.on('did-start-navigation', (_event, _url, _inPlace, mainFrame) => {
          if (mainFrame) { close(win); ready.delete(contents); }
        });
      }
      win.webContents.send('factory-linux-menu:open', { token, items,
        palette: { background: palette.background, foreground: palette.foreground, mode: palette.mode },
        menu: payload?.menu ?? null, x: payload?.x ?? 8, y: payload?.y ?? 36 });
      return true;
    },
  };
}

export const applicationMenuPreload = `applicationMenu:{
onOpen:listener=>{
 if(typeof listener!=="function")return()=>{};
 const open=(_event,value)=>listener(value),close=()=>listener(null);
 v.ipcRenderer.on("factory-linux-menu:open",open);
 v.ipcRenderer.on("factory-linux-menu:close",close);
 void v.ipcRenderer.invoke("factory-linux-menu:ready",true).catch(()=>{});
 return()=>{v.ipcRenderer.removeListener("factory-linux-menu:open",open);v.ipcRenderer.removeListener("factory-linux-menu:close",close);void v.ipcRenderer.invoke("factory-linux-menu:ready",false).catch(()=>{})};
},
activate:(token,command)=>typeof token==="string"&&Number.isInteger(command)?v.ipcRenderer.invoke("factory-linux-menu:activate",{token,command}).catch(()=>false):Promise.resolve(false),
dismiss:token=>typeof token==="string"?v.ipcRenderer.invoke("factory-linux-menu:dismiss",token).catch(()=>{}):Promise.resolve()
},`;

// Uses textContent, not HTML from the menu DTO. No new window, preload
// privilege, account data or saved appearance setting is needed.
export function factoryPortMountApplicationMenu(api) {
  if (!api?.onOpen) return () => {};
  const existing = factoryPortMountApplicationMenu.current;
  const release = instance => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--instance.users === 0) {
        instance.dispose();
        factoryPortMountApplicationMenu.current = null;
      }
    };
  };
  if (existing) { existing.users++; return release(existing); }
  let root = null, session = null, previousFocus = null, levels = [], topIndex = -1;
  const style = document.createElement('style');
  style.textContent = `
[data-factory-port-application-menu]{position:fixed;z-index:2147483646;min-width:230px;max-width:calc(100vw - 16px);max-height:calc(100vh - 16px);overflow:auto;padding:6px;border:1px solid var(--border-1,#666);border-radius:12px;background:var(--core-v2-bg-surface-raised,#242424);color:var(--core-v2-text-primary,#fff);box-shadow:0 8px 28px #0005;backdrop-filter:blur(20px);font:13px/1.4 var(--font-family-ui,system-ui);user-select:none;-webkit-app-region:no-drag}
[data-factory-port-application-menu] button{display:flex;align-items:center;gap:12px;box-sizing:border-box;width:100%;border:0;border-radius:6px;padding:7px 10px;background:transparent;color:inherit;font:inherit;text-align:left;white-space:nowrap}
[data-factory-port-application-menu] button:focus{outline:0;background:var(--factory-port-menu-hover,#555)}
[data-factory-port-application-menu] button:disabled{color:var(--factory-port-menu-disabled,#999)}
[data-factory-port-application-menu] [data-menu-check]{width:14px;flex:none}
[data-factory-port-application-menu] [data-menu-label]{flex:1}
[data-factory-port-application-menu] kbd{font:inherit;color:inherit}
[data-factory-port-application-menu] hr{border:0;border-top:1px solid var(--border-1,#666);margin:5px -6px}
`;
  document.head.append(style);
  const close = (notify = true, restore = true) => {
    const token = session?.token;
    root?.remove(); root = null; session = null; levels = [];
    if (restore && previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    previousFocus = null;
    if (notify && token) void api.dismiss(token);
  };
  const focusable = panel => [...panel.querySelectorAll('button:not(:disabled)')];
  const place = (panel, x, y, parent) => {
    const bounds = panel.getBoundingClientRect();
    if (x + bounds.width > innerWidth - 8 && parent) x = parent.left - bounds.width + 2;
    panel.style.left = `${Math.max(8, Math.min(x, innerWidth - bounds.width - 8))}px`;
    panel.style.top = `${Math.max(8, Math.min(y, innerHeight - bounds.height - 8))}px`;
  };
  const trim = depth => {
    while (levels.length > depth) {
      const old = levels.pop(); old.parentButton?.setAttribute('aria-expanded', 'false'); old.panel.remove();
    }
  };
  const render = (items, x, y, depth = 0, parentButton = null, focus = true) => {
    trim(depth);
    const panel = document.createElement('div');
    const palette = session.palette;
    if (palette && /^#[\da-f]{6}$/i.test(palette.background) && /^#[\da-f]{6}$/i.test(palette.foreground)) {
      const rgb = [1, 3, 5].map(offset => Number.parseInt(palette.background.slice(offset, offset + 2), 16));
      const foreground = [1, 3, 5].map(offset => Number.parseInt(palette.foreground.slice(offset, offset + 2), 16));
      const mix = fraction => `rgb(${rgb.map((value, index) => Math.round(value * (1 - fraction) + foreground[index] * fraction)).join(',')})`;
      panel.style.backgroundColor = `rgba(${rgb.join(',')},.35)`;
      panel.style.color = palette.foreground;
      panel.style.setProperty('--factory-port-menu-hover', mix(.12));
      panel.style.setProperty('--factory-port-menu-disabled', mix(.65));
      panel.style.textShadow = `0 1px 2px ${palette.mode === 'light' ? '#fffc' : '#000c'}`;
    }
    panel.dataset.factoryPortApplicationMenu = ''; panel.setAttribute('role', 'menu');
    panel.setAttribute('aria-label', depth ? parentButton.textContent : session.menu || 'Application');
    panel.tabIndex = -1;
    root.append(panel);
    const level = { panel, parentButton };
    levels.push(level);
    for (const item of items) {
      if (item.type === 'separator') { const hr = document.createElement('hr'); hr.setAttribute('role', 'separator'); panel.append(hr); continue; }
      const button = document.createElement('button');
      button.type = 'button'; button.tabIndex = -1; button.disabled = !item.enabled;
      button.setAttribute('role', item.type === 'checkbox' ? 'menuitemcheckbox' : item.type === 'radio' ? 'menuitemradio' : 'menuitem');
      if (['checkbox', 'radio'].includes(item.type)) button.setAttribute('aria-checked', String(item.checked));
      const check = document.createElement('span'); check.dataset.menuCheck = '';
      check.textContent = item.checked ? item.type === 'radio' ? '●' : '✓' : '';
      const label = document.createElement('span'); label.dataset.menuLabel = '';
      label.textContent = String(item.label || '').replace(/&&|&/g, value => value === '&&' ? '&' : '');
      const key = document.createElement('kbd');
      key.textContent = item.children ? '›' : item.accelerator.replace(/CommandOrControl|CmdOrCtrl|Control/g, 'Ctrl');
      button.append(check, label, key);
      if (item.children) button.setAttribute('aria-haspopup', 'menu');
      const openChild = (keyboard = false) => {
        if (!item.children || button.disabled) return;
        const rect = button.getBoundingClientRect();
        button.setAttribute('aria-expanded', 'true');
        render(item.children, rect.right + 4, rect.top - 6, depth + 1, button, keyboard);
      };
      button.addEventListener('pointerenter', () => {
        button.focus({ preventScroll: true });
        if (item.children) openChild(false); else trim(depth + 1);
      });
      button.addEventListener('click', () => {
        if (item.children) { openChild(true); return; }
        const token = session.token;
        close(false);
        void api.activate(token, item.command);
      });
      button.addEventListener('keydown', event => {
        if (event.key === 'ArrowRight' && item.children) {
          event.preventDefault(); event.stopPropagation(); openChild(true);
        }
      });
      panel.append(button);
    }
    place(panel, x, y, parentButton?.getBoundingClientRect());
    if (focus) (focusable(panel)[0] || panel).focus({ preventScroll: true });
  };
  const showTop = direction => {
    const tops = session.items.filter(item => item.children && item.enabled);
    if (!tops.length) return;
    topIndex = (topIndex + direction + tops.length) % tops.length;
    const item = tops[topIndex]; session.menu = item.id;
    render(item.children, session.x, session.y);
  };
  const keydown = event => {
    if (!root) return;
    const level = levels.at(-1), buttons = focusable(level.panel);
    const index = buttons.indexOf(document.activeElement);
    if (event.key === 'Escape' && levels.length > 1) {
      event.preventDefault(); event.stopPropagation();
      const parent = level.parentButton; trim(levels.length - 1); parent.focus(); return;
    }
    if (['Escape', 'Tab', 'Alt', 'F10'].includes(event.key)) {
      event.preventDefault(); event.stopPropagation(); close(); return;
    }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 :
        (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus({ preventScroll: true }); return;
    }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault(); event.stopPropagation();
      if (event.key === 'ArrowLeft' && levels.length > 1) {
        const parent = level.parentButton; trim(levels.length - 1); parent.focus();
      } else if (session.menu && levels.length === 1) showTop(event.key === 'ArrowRight' ? 1 : -1);
      return;
    }
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && event.key !== ' ') {
      const candidates = [...buttons.slice(index + 1), ...buttons.slice(0, index + 1)];
      const found = candidates.find(button => button.querySelector('[data-menu-label]').textContent.toLocaleLowerCase().startsWith(event.key.toLocaleLowerCase()));
      if (found) { event.preventDefault(); found.focus(); }
    }
  };
  const outside = event => { if (root && !root.contains(event.target)) close(true, false); };
  const lost = () => close();
  document.addEventListener('keydown', keydown);
  document.addEventListener('pointerdown', outside, true);
  window.addEventListener('blur', lost);
  window.addEventListener('resize', lost);
  const unsubscribe = api.onOpen(value => {
    close(false);
    if (!value) return;
    session = value; previousFocus = document.activeElement;
    root = document.createElement('div'); document.body.append(root);
    topIndex = value.items.filter(item => item.children && item.enabled).findIndex(item => item.id === value.menu);
    const items = value.menu ? value.items.find(item => item.id === value.menu)?.children : value.items;
    if (items) render(items, value.x, value.y); else close();
  });
  const instance = { users: 1, dispose: () => {
    close(); unsubscribe(); style.remove();
    document.removeEventListener('keydown', keydown);
    document.removeEventListener('pointerdown', outside, true);
    window.removeEventListener('blur', lost);
    window.removeEventListener('resize', lost);
  } };
  factoryPortMountApplicationMenu.current = instance;
  return release(instance);
}

export const applicationMenuMainChanges = [
  ['share the presentation bridge with the menu and window factories',
    'function kde(){E.ipcMain.handle("window:showApplicationMenu"',
    'var factoryLinuxApplicationMenu;function kde(){E.ipcMain.handle("window:showApplicationMenu"'],
  ['route a followed Glassy menu through the existing application commands',
    'if(!n||n.isDestroyed())return;const o=n.webContents.getZoomFactor();if(t!==void 0){const l=Tde.safeParse(t);',
    'if(!n||n.isDestroyed())return;if(process.platform==="linux"&&factoryLinuxApplicationMenu?.show(e,t))return;const o=n.webContents.getZoomFactor();if(t!==void 0){const l=Tde.safeParse(t);'],
];
