// Test-mount the real session-list wrapper (0.206 alias k8c), which renders
// the Radix viewport and the session-list edge overlays, in the existing
// isolated theme smoke. Only the rows/header/footer are synthetic, with no
// user data.
import assert from 'node:assert/strict';
import path from 'node:path';
import { saveDisposableScreenshot } from './application-menu-smoke.mjs';

export function sidebarFadeFixtureSource() {
  return `
function mountSidebarFade(){
 const parent=document.querySelector("[data-factory-port-sidebar-surface]");
 const oldPosition=parent.style.position,old=[...parent.children].map(node=>[node,node.style.visibility]);
 old.forEach(([node])=>{node.style.visibility="hidden"});parent.style.position="relative";
 const texture=document.createElement("div");texture.id="factory-sidebar-fade-texture";
 texture.style.cssText="display:none;position:absolute;inset:0;pointer-events:none;background:repeating-linear-gradient(135deg,#140f28 0px,#140f28 12px,#8040c0 13px,#2f1a50 25px,#211534 45px)";
 parent.append(texture);
 const host=document.createElement("div");host.style.cssText="position:absolute;inset:0";
 host.id="factory-sidebar-fade-fixture";parent.append(host);
 function SidebarFixture(){
  const viewport=L.useRef(null);
  return c.jsxs(df,{style:{display:"flex",flexDirection:"column",height:"100%",maxHeight:600,background:"transparent"},children:[
   c.jsx("div",{style:{height:32,flexShrink:0,padding:"6px 12px",boxSizing:"border-box"},children:"Projects"}),
   c.jsx("div",{style:{flex:1,minHeight:0,position:"relative"},children:c.jsx(k8c,{viewportRef:viewport,children:c.jsx("div",{children:Array.from({length:48},(_,index)=>c.jsx("button",{"data-fade-row":index,style:{height:32,display:"block",width:"100%",background:"transparent",border:0,padding:0,textAlign:"left"},onClick:event=>{event.currentTarget.dataset.clicked="true"},children:"Session "+String(index+1).padStart(2,"0")},index))})})}),
   c.jsx("div",{style:{height:48,flexShrink:0,padding:12,boxSizing:"border-box"},children:"Test account"})
  ]});
 }
 const root=IKo.createRoot(host);root.render(c.jsx(SidebarFixture,{}));
 return()=>{root.unmount();host.remove();texture.remove();parent.style.position=oldPosition;old.forEach(([node,value])=>{node.style.visibility=value})};
}
`;
}

export async function runSidebarFadeSmoke({ app, page, output, mode }) {
  const masked = process.env.FACTORY_SIDEBAR_FADE_BASELINE !== '1';
  await page.evaluate(() => { window.__factorySidebarFadeCleanup = window.__factoryThemeSmoke.mountSidebarFade(); });
  const viewport = page.locator('#factory-sidebar-fade-fixture [data-radix-scroll-area-viewport]');
  const result = { masked, states: {} };
  const edge = (direction, color = false) => page.getByTestId(`session-list-${direction}-fade${color ? '-color' : ''}`);
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  async function captureLines() {
    await settle();
    const rect = await viewport.boundingBox();
    return app.evaluate(async ({ BrowserWindow }, rect) => {
      const image = await BrowserWindow.getAllWindows()[0].webContents.capturePage();
      const { width } = image.getSize(), data = image.toBitmap();
      const x = Math.floor(rect.x + rect.width - 30);
      const rgba = y => {
        const i = (Math.floor(y) * width + x) * 4;
        return [data[i + 2], data[i + 1], data[i], data[i + 3]];
      };
      return {
        top: Array.from({ length: 60 }, (_, n) => rgba(rect.y + n)),
        bottom: Array.from({ length: 60 }, (_, n) => rgba(rect.y + rect.height - 1 - n)),
      };
    }, rect);
  }
  async function state(name, top, bottom) {
    // Background probes must not accidentally sample a hovered row after
    // wheel/click tests move the pointer or scroll content beneath it.
    await page.mouse.move(400, 100);
    await page.waitForFunction(({ top, bottom }) => {
      const opacity = direction => getComputedStyle(document.querySelector(`[data-testid="session-list-${direction}-fade-color"]`)).opacity;
      return opacity('top') === String(top) && opacity('bottom') === String(bottom);
    }, { top, bottom });
    const styles = {};
    for (const direction of ['top', 'bottom']) {
      styles[direction] = await edge(direction, true).evaluate(element => {
        const s = getComputedStyle(element);
        return { height: s.height, background: s.backgroundImage, opacity: s.opacity, pointerEvents: s.pointerEvents, display: s.display };
      });
      assert.equal(styles[direction].pointerEvents, 'none');
      if (masked) assert.equal(styles[direction].display, 'none');
    }
    const mask = await viewport.evaluate(element => {
      const s = getComputedStyle(element), cap = Math.min(40, element.clientHeight / 4);
      return {
        image: s.maskImage,
        actual: ['top', 'bottom'].map(edge => parseFloat(s.getPropertyValue(`--factory-port-sidebar-${edge}-fade`))),
        expected: [element.scrollTop, element.scrollHeight - element.clientHeight - element.scrollTop].map(depth => Math.min(cap, Math.max(0, depth))),
      };
    });
    if (masked) {
      assert.notEqual(mask.image, 'none');
      assert.deepEqual(mask.actual, mask.expected);
    }
    const lines = await captureLines();
    const pixels = Object.fromEntries(Object.entries(lines).map(([edge, values]) => [edge, values.map(rgba => rgba[3])]));
    if (masked) for (const values of Object.values(pixels)) {
      assert.ok(values.every(value => Math.abs(value - 89) <= 2),
        `an empty scroll edge must not repaint the glass background: alpha ${Math.min(...values)}..${Math.max(...values)}`);
    }
    result.states[name] = { styles, mask, pixels };
    await saveDisposableScreenshot(app, page, path.join(output, `sidebar-fade-${mode}-${name}.png`));
  }
  async function continuity() {
    await page.mouse.move(400, 100);
    await page.locator('#factory-sidebar-fade-texture').evaluate(element => { element.style.display = 'block'; });
    const painted = await captureLines();
    const overlays = page.locator('#factory-sidebar-fade-fixture [data-testid^="session-list-"]');
    const original = await overlays.evaluateAll(elements => elements.map(element => {
      const before = element.getAttribute('style');
      element.style.setProperty('display', 'none', 'important');
      return before;
    }));
    const reference = await captureLines();
    await overlays.evaluateAll((elements, original) => elements.forEach((element, i) => {
      original[i] === null ? element.removeAttribute('style') : element.setAttribute('style', original[i]);
    }), original);
    const backgroundDelta = {};
    for (const edge of ['top', 'bottom']) {
      backgroundDelta[edge] = Math.max(...painted[edge].flatMap((rgba, i) => rgba.map((value, channel) => Math.abs(value - reference[edge][i][channel]))));
      if (masked) assert.ok(backgroundDelta[edge] <= 1, `${edge}: patterned background must not acquire a rectangular blur/color patch`);
    }
    const rect = await viewport.boundingBox();
    for (const [edge, y] of [['top', rect.y + 8], ['bottom', rect.y + rect.height - 8]]) {
      await page.mouse.move(rect.x + 60, y);
      await saveDisposableScreenshot(app, page, path.join(output, `sidebar-fade-${mode}-texture-${edge}.png`));
    }
    await page.mouse.move(400, 100);
    await page.locator('#factory-sidebar-fade-texture').evaluate(element => { element.style.display = 'none'; });
    const rows = page.locator('[data-fade-row]');
    const rowStyles = await rows.evaluateAll(elements => elements.map(element => {
      const before = element.getAttribute('style');
      element.style.backgroundColor = '#fff'; element.style.display = 'flex';
      return before;
    }));
    const probe = await captureLines();
    const profile = {};
    for (const edge of ['top', 'bottom']) {
      const alpha = probe[edge].map(rgba => rgba[3]);
      const jumps = alpha.slice(1).map((value, i) => Math.abs(value - alpha[i]));
      profile[edge] = { alpha, maxStep: Math.max(...jumps) };
      if (masked) {
        assert.ok(Math.abs(alpha[0] - 89) <= 2, 'hover/content must disappear before the hard clip boundary');
        assert.equal(alpha.at(-1), 255, 'content beyond the fade remains fully opaque');
        assert.ok(profile[edge].maxStep <= 8, 'content alpha must change gradually, with no hard fade cutoff');
        assert.ok(Math.abs(alpha[39] - alpha[40]) <= 2, 'the fade must meet the opaque center smoothly');
      }
    }
    await rows.evaluateAll((elements, original) => elements.forEach((element, i) => {
      original[i] === null ? element.removeAttribute('style') : element.setAttribute('style', original[i]);
    }), rowStyles);
    result.continuity = { backgroundDelta, profile };
  }
  try {
    await viewport.waitFor({ state: 'visible' });
    const geometry = await viewport.evaluate(element => ({
      height: element.clientHeight, contentHeight: element.scrollHeight,
      rows: [...element.querySelectorAll('[data-fade-row]')].slice(0, 2).map(row => {
        const rect = row.getBoundingClientRect();
        return { top: rect.top, height: rect.height };
      }),
    }));
    assert.ok(geometry.contentHeight > geometry.height,
      `sidebar fixture must overflow before testing scroll fades: ${JSON.stringify(geometry)}`);
    assert.equal(geometry.rows[1].top - geometry.rows[0].top, 32,
      'sidebar fixture rows must form one column with a 32px scroll stride');
    await state('start', 0, 1);
    await viewport.evaluate(element => { element.scrollTop = 1; });
    await state('near-start', 0, 1);
    await viewport.evaluate(element => { element.scrollTop = (element.scrollHeight - element.clientHeight) / 2; });
    await state('middle', 1, 1);
    await continuity();
    const scrolled = await viewport.evaluate(element => element.scrollTop);
    await viewport.hover();
    await page.mouse.wheel(0, 60);
    await page.waitForFunction(before => document.querySelector('#factory-sidebar-fade-fixture [data-radix-scroll-area-viewport]').scrollTop > before, scrolled);
    const visibleRow = Math.ceil(await viewport.evaluate(element => element.scrollTop) / 32);
    await page.locator(`[data-fade-row="${visibleRow}"]`).click();
    assert.equal(await page.locator(`[data-fade-row="${visibleRow}"]`).getAttribute('data-clicked'), 'true');
    await page.locator(`[data-fade-row="${visibleRow}"]`).evaluate(element => element.blur());
    await viewport.evaluate(element => { element.scrollTop = element.scrollHeight - element.clientHeight - 1; });
    await state('near-end', 1, 0);
    await viewport.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await state('end', 1, 0);
    await page.locator('[data-fade-row]').evaluateAll(rows => rows.slice(1).forEach(row => row.remove()));
    await state('no-overflow', 0, 0);
    result.wheelAndClickThrough = true;
    return result;
  } finally {
    await page.evaluate(() => { window.__factorySidebarFadeCleanup(); delete window.__factorySidebarFadeCleanup; });
  }
}
