// Called inside the existing disposable actual-renderer theme smoke. Tests
// production preload/main/renderer routing and Electron's real MenuItem roles.
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';

export async function saveDisposableScreenshot(app, page, filename) {
  const handle = await app.browserWindow(page);
  const png = await handle.evaluate(async win => (await win.webContents.capturePage()).toPNG().toString('base64'));
  await writeFile(filename, Buffer.from(png, 'base64'));
}

export async function closeDisposableApp(app) {
  let timer, forcedExit = false;
  const child = app.process();
  const exited = child.exitCode !== null ? Promise.resolve() :
    new Promise(resolve => child.once('exit', resolve));
  try {
    await Promise.race([app.close(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Disposable Electron close timed out')), 30000);
    })]);
  } catch (error) {
    forcedExit = true;
    if (child.exitCode === null) {
      void app.evaluate(({ app }) => app.exit(0)).catch(() => {});
      clearTimeout(timer);
      await Promise.race([exited, new Promise((_, reject) => {
        timer = setTimeout(() => { child.kill('SIGKILL'); reject(error); }, 15000);
      })]);
    }
  } finally { clearTimeout(timer); }
  await exited;
  return { forcedDisposableExit: forcedExit, exitCode: child.exitCode };
}

export async function focusDisposableWindow(app, page) {
  const handle = await app.browserWindow(page);
  await handle.evaluate(win => { win.setTitle('factory-remote-menu-disposable'); win.show(); win.focus(); });
  if (process.env.WAYLAND_DISPLAY && process.env.HYPRLAND_INSTANCE_SIGNATURE) {
    const pid = app.process().pid;
    const own = JSON.parse(execFileSync('hyprctl', ['clients', '-j'], { encoding: 'utf8' }))
      .filter(client => client.pid === pid && client.title === 'factory-remote-menu-disposable');
    assert.equal(own.length, 1, 'only the disposable app window can be focused');
    assert.match(own[0].address, /^0x[0-9a-f]+$/i);
    for (const command of [
      `hl.dsp.focus({window="address:${own[0].address}"})`,
      `hl.dsp.window.alter_zorder({mode="top",window="address:${own[0].address}"})`,
    ]) execFileSync('hyprctl', ['dispatch', command], { encoding: 'utf8', timeout: 5000 });
  }
  await page.bringToFront();
}

export async function runApplicationMenuSmoke({ app, page, output, mode }) {
  await page.evaluate(() => {
    window.__factoryMenuSmokeDomTrace = [];
    if (window.__factoryMenuSmokeDomTraceInstalled) return;
    window.__factoryMenuSmokeDomTraceInstalled = true;
    for (const name of ['resize', 'blur']) window.addEventListener(name, () => window.__factoryMenuSmokeDomTrace.push(name));
    document.addEventListener('keydown', event => {
      if (['F10', 'Alt'].includes(event.key)) window.__factoryMenuSmokeDomTrace.push(event.key);
    }, true);
  });
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0], wc = win.webContents;
    globalThis.__factoryMenuSmokeTrace = [];
    if (globalThis.__factoryMenuSmokeTraceInstalled) return;
    globalThis.__factoryMenuSmokeTraceInstalled = true;
    const record = value => globalThis.__factoryMenuSmokeTrace.push(value);
    const send = wc.send;
    wc.send = function(channel, ...args) {
      if (channel.startsWith('factory-linux-menu:')) record(channel);
      return send.call(this, channel, ...args);
    };
    for (const name of ['blur', 'resize']) win.on(name, () => record(name));
    wc.on('before-input-event', (_event, input) => {
      if (['F10', 'Alt'].includes(input.key))
        record({ key: input.key, type: input.type, control: input.control, alt: input.alt, shift: input.shift });
    });
  });
  const journal = [];
  const step = async name => {
    journal.push({ name, native: await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      return { focus: win.isFocused(), zoom: win.webContents.getZoomFactor(), trace: globalThis.__factoryMenuSmokeTrace };
    }), renderer: await page.evaluate(() => ({ ratio: devicePixelRatio,
      activation: window.__factoryMenuSmokeActivation ?? null, trace: window.__factoryMenuSmokeDomTrace })) });
    await writeFile(path.join(output, `application-menu-${mode}-steps.json`), JSON.stringify(journal, null, 2));
  };
  assert.equal(await page.evaluate(() => typeof window.electronAPI?.applicationMenu?.onOpen), 'function');
  await focusDisposableWindow(app, page);
  const selector = '[data-factory-port-application-menu]';
  const open = async menu => {
    await page.evaluate(menu => window.electronAPI.window.showApplicationMenu({ menu, x: 230, y: 40 }), menu);
    await page.locator(selector).first().waitFor({ state: 'visible' });
    assert.equal(await page.locator(selector).count(), 1, 'multiple ThemeSync mounts share one menu listener');
  };
  const close = async () => {
    await page.keyboard.press('Escape');
    await page.locator(selector).waitFor({ state: 'detached' });
  };
  // Zoom changes DPR before the next renderer resize event. Let that event
  // finish before opening a new popup, which correctly dismisses on resize.
  const settleViewport = () => page.evaluate(() => new Promise(resolve =>
    requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await open('View');
  await step('opened-view');
  const visual = await page.locator(selector).evaluate(panel => {
    const style = getComputedStyle(panel);
    const text = panel.querySelectorAll('[data-menu-label]')[1];
    const rect = panel.getBoundingClientRect(), glyphs = text.getBoundingClientRect();
    const focus = getComputedStyle(panel.querySelector('button:focus'));
    return { background: style.backgroundColor, foreground: style.color,
      focusBackground: focus.backgroundColor, focusForeground: focus.color,
      opacity: style.opacity, blur: style.backdropFilter, labels: panel.textContent,
      backgroundPoint: [Math.floor(rect.x + rect.width / 2), Math.floor(rect.y + 3)],
      glyphRect: { x: Math.floor(glyphs.x), y: Math.floor(glyphs.y), width: Math.ceil(glyphs.width), height: Math.ceil(glyphs.height) } };
  });
  assert.match(visual.background, /0\.35\)$/);
  assert.equal(visual.opacity, '1');
  const luminance = rgb => rgb.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => {
    value /= 255;
    return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
  }).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
  const a = luminance(visual.focusBackground), b = luminance(visual.focusForeground);
  const focusContrast = (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
  assert.ok(focusContrast >= 4.5, `focused menu text remains readable: ${focusContrast}`);
  assert.match(visual.blur, /blur/);
  assert.equal(visual.labels.includes('Developer Tools'), false, 'hidden native items stay hidden');
  await saveDisposableScreenshot(app, page, path.join(output, `application-menu-${mode}.png`));
  const pixels = await app.evaluate(async ({ BrowserWindow }, { point, rect }) => {
    const win = BrowserWindow.getAllWindows()[0], image = await win.webContents.capturePage();
    const size = image.getSize(), bitmap = image.toBitmap();
    const alpha = (x, y) => bitmap[(y * size.width + x) * 4 + 3];
    let glyphMax = 0;
    for (let y = rect.y; y < rect.y + rect.height; y++)
      for (let x = rect.x; x < rect.x + rect.width; x++) glyphMax = Math.max(glyphMax, alpha(x, y));
    return { backgroundAlpha: alpha(...point), glyphMax };
  }, { point: visual.backgroundPoint, rect: visual.glyphRect });
  assert.ok(pixels.backgroundAlpha < 245, `popup framebuffer remains translucent: ${pixels.backgroundAlpha}`);
  assert.ok(pixels.glyphMax >= 250, `menu glyphs are not faded: ${pixels.glyphMax}`);

  // Real vendor zoom command through our DTO and original MenuItem.click.
  const ratio = await page.evaluate(() => devicePixelRatio);
  await page.evaluate(() => { window.__factoryMenuSmokeActivation = null; });
  await page.getByRole('menuitem', { name: /^Zoom In/ }).click();
  await page.waitForFunction(() => window.__factoryMenuSmokeActivation !== null);
  await step('clicked-zoom-in');
  assert.equal(await page.evaluate(() => window.__factoryMenuSmokeActivation.accepted), true);
  await page.waitForFunction(before => devicePixelRatio > before, ratio);
  await settleViewport();
  assert.ok(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomFactor()) > 1);
  await open('View');
  await page.getByRole('menuitem', { name: /^Actual Size/ }).click();
  await step('clicked-reset');
  await page.waitForFunction(before => Math.abs(devicePixelRatio - before) < .001, ratio);
  await settleViewport();

  // Native role dispatch must operate on the previously focused editor.
  await page.evaluate(() => {
    const input = document.createElement('input'); input.id = 'menu-smoke-selection';
    input.value = 'disposable selection test'; input.style.cssText = 'position:fixed;bottom:12px;left:240px;z-index:2147483500';
    document.body.append(input); input.focus(); input.setSelectionRange(3, 3);
  });
  await open('Edit');
  await page.getByRole('menuitem', { name: /^Select All/ }).click();
  await step('clicked-select-all');
  await page.waitForFunction(() => {
    const input = document.getElementById('menu-smoke-selection');
    return input.selectionStart === 0 && input.selectionEnd === input.value.length;
  });
  await page.evaluate(() => document.getElementById('menu-smoke-selection').remove());

  // Send native Electron input, not renderer-only CDP key events. Scope
  // every key to this disposable webContents, never the user's active app.
  const nativeKey = async (keyCode, modifiers = []) => {
    const handle = await app.browserWindow(page);
    await handle.evaluate((win, { keyCode, modifiers }) => {
      for (const type of ['keyDown', 'keyUp'])
        win.webContents.sendInputEvent({ type, keyCode, modifiers });
    }, { keyCode, modifiers });
  };
  await nativeKey('=', ['control']);
  await step('accelerator-zoom-in');
  await page.waitForFunction(before => devicePixelRatio > before, ratio, { timeout: 5000 });
  await settleViewport();
  await nativeKey('0', ['control']);
  await page.waitForFunction(before => Math.abs(devicePixelRatio - before) < .001, ratio);
  await settleViewport();

  await nativeKey('F10');
  try { await page.locator(selector).waitFor({ state: 'visible', timeout: 5000 }); }
  catch (error) { await step('failed-f10'); throw error; }
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator(selector).count(), 2, 'keyboard opens a native-template submenu');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator(selector).count(), 1, 'Escape returns to the parent');
  await close();
  await nativeKey('Alt');
  await page.locator(selector).waitFor({ state: 'visible' });
  await nativeKey('Alt');
  await page.locator(selector).waitFor({ state: 'detached' });
  await open('View');
  await page.keyboard.press('ArrowRight');
  assert.match(await page.locator(selector).textContent(), /Minimize/, 'top-level keyboard navigation reaches Window');
  await close();
  return { background: visual.background, foreground: visual.foreground, ...pixels,
    blur: visual.blur, focusContrast, nativeZoomAndSelectAll: true, nativeAccelerators: true,
    keyboardSubmenusAndAltF10: true, sharedListener: true };
}

export async function assertNativeMenuFallback({ app, page }) {
  await app.evaluate(({ Menu }) => {
    const submenu = Menu.getApplicationMenu().getMenuItemById('View').submenu;
    globalThis.__factoryMenuSmokeNativePopup = { submenu, original: submenu.popup, calls: 0 };
    submenu.popup = () => { globalThis.__factoryMenuSmokeNativePopup.calls++; };
  });
  try {
    await page.evaluate(() => window.electronAPI.window.showApplicationMenu({ menu: 'View', x: 230, y: 40 }));
    assert.equal(await app.evaluate(() => globalThis.__factoryMenuSmokeNativePopup.calls), 1);
    assert.equal(await page.locator('[data-factory-port-application-menu]').count(), 0);
  } finally {
    await app.evaluate(() => {
      const record = globalThis.__factoryMenuSmokeNativePopup;
      record.submenu.popup = record.original; delete globalThis.__factoryMenuSmokeNativePopup;
    });
  }
}
