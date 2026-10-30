// Main-process integration for the read-only Omarchy palette bridge. Keep the
// IPC surface narrow: the renderer can request a sanitized snapshot, listen
// for snapshots, and opt its own window into native transparency when the
// Omarchy provider reports a valid glassy windowMode; it cannot choose a
// path, ask the main process to read files, or make itself glassy without
// the provider's glassy marker.
//
// Verified 1.0.0 initLifecycle-C9wwcpdA.js module aliases used below (from
// the bundle's import header and definitions; build.mjs refuses to build on
// any other payload):
//   E  = require("electron")            J  = require("path")
//   vT = require("url")                 s  = require("./index-DO2zeVx0.js")
//   zn = registered main-window Set (zn.add in the window factory)
//   Bo() = live non-destroyed windows   To() = webContents not destroyed/crashed
//   IS() = vendor baseline background (Sa || surface-1 by theme)
//   Xle(color, win?) = vendor native background applier (also caches Sa)
//
// Vendor background paths audited in the 1.0.0 bundle: window creation
// paints backgroundColor:IS() (opaque), the window:setBackgroundColor IPC
// handler calls Xle() (targeted or broadcast), and the window factory
// re-applies Sa on resize (`a.on("resize",()=>{Sa&&a.setBackgroundColor(Sa)})`).
// window:setThemeSource never touches the background. The resize path is
// handled without patching it: each followed window gets its own resize
// listener at follow time, registered after the vendor's, which re-applies
// native transparency right after the vendor's opaque repaint.
import { factoryPortCreateApplicationMenu } from './application-menu-patches.mjs';

const integration = `if(process.platform==="linux"){
const factoryLinuxOmarchyBridge=require(J.resolve(process.resourcesPath,"..","port","theme-bridge.cjs"));
const factoryLinuxOmarchyProviderOptions={home:E.app.getPath("home")};
if(typeof process.env?.XDG_STATE_HOME==="string"&&J.isAbsolute(process.env.XDG_STATE_HOME))factoryLinuxOmarchyProviderOptions.stateHome=process.env.XDG_STATE_HOME;
const factoryLinuxOmarchyProvider=factoryLinuxOmarchyBridge.createOmarchyThemeProvider(factoryLinuxOmarchyProviderOptions);
let factoryLinuxOmarchyRunning=false,factoryLinuxOmarchyStartPromise=null,factoryLinuxOmarchyRunId=0;
const factoryLinuxOmarchyFollow=new WeakMap,factoryLinuxOmarchyBase=new WeakMap,factoryLinuxOmarchyGlass=new WeakMap,factoryLinuxOmarchyResize=new WeakMap;
const factoryLinuxOmarchyTrusted=event=>{
  const sender=event==null?void 0:event.sender;
  const frame=event==null?void 0:event.senderFrame;
  const owner=sender?E.BrowserWindow.fromWebContents(sender):null;
  if(!owner||owner.isDestroyed()||!zn.has(owner)||!To(sender)||frame!==sender.mainFrame)return!1;
  const url=frame.url;
  if(typeof url!=="string")return!1;
  try{
    const candidate=new URL(url);
    if(candidate.protocol==="file:")
      return vT.fileURLToPath(candidate)===J.resolve(__dirname,"..","renderer","main_window","index.html");
    if(typeof s.DESKTOP_RENDERER_ORIGIN==="string"){
      const expected=new URL(s.DESKTOP_RENDERER_ORIGIN);
      return candidate.protocol===expected.protocol&&candidate.host===expected.host&&candidate.pathname==="/index.html";
    }
  }catch{}
  return!1;
};
const factoryLinuxOmarchyGlassy=state=>state!=null&&state.available===!0&&state.windowMode==="glassy";
const factoryLinuxOmarchyApply=(win,state)=>{
  if(!win||typeof win.isDestroyed!=="function"||win.isDestroyed())return;
  const glassy=factoryLinuxOmarchyFollow.get(win)===!0&&factoryLinuxOmarchyGlassy(state===void 0?factoryLinuxOmarchyProvider.getState():state);
  if(glassy){
    factoryLinuxOmarchyGlass.set(win,!0);
    try{win.setBackgroundColor("#00000000")}catch{}
  }else if(factoryLinuxOmarchyGlass.get(win)){
    factoryLinuxOmarchyGlass.set(win,!1);
    try{win.setBackgroundColor(factoryLinuxOmarchyBase.get(win)||IS())}catch{}
  }
  factoryLinuxApplicationMenu?.sync(win);
};
var factoryLinuxOmarchyTrack=null;
factoryLinuxOmarchyTrack=(color,win)=>{
  if(typeof color!=="string"||!/^#[0-9a-fA-F]{6}$/.test(color))return;
  if(win&&!win.isDestroyed()){factoryLinuxOmarchyBase.set(win,color);factoryLinuxOmarchyApply(win);return}
  for(const target of Bo()){
    if(!target||target.isDestroyed())continue;
    factoryLinuxOmarchyBase.set(target,color);factoryLinuxOmarchyApply(target)
  }
};
const factoryLinuxOmarchyPublish=state=>{
  for(const win of Bo()){
    if(!win||win.isDestroyed())continue;
    if(factoryLinuxOmarchyFollow.get(win)===!0)factoryLinuxOmarchyApply(win,state);
    if(!To(win.webContents)||win.webContents.isLoading())continue;
    const event={sender:win.webContents,senderFrame:win.webContents.mainFrame};
    if(factoryLinuxOmarchyTrusted(event))win.webContents.send("factory-linux-theme:changed",state);
  }
};
const factoryLinuxOmarchyStart=()=>{
  if(factoryLinuxOmarchyRunning)return Promise.resolve();
  if(factoryLinuxOmarchyStartPromise)return factoryLinuxOmarchyStartPromise;
  const runId=factoryLinuxOmarchyRunId;
  let pending;
  pending=factoryLinuxOmarchyProvider.start(factoryLinuxOmarchyPublish).then(()=>{
    if(factoryLinuxOmarchyRunId===runId)factoryLinuxOmarchyRunning=true;
  }).finally(()=>{
    if(factoryLinuxOmarchyStartPromise===pending)factoryLinuxOmarchyStartPromise=null;
  });
  factoryLinuxOmarchyStartPromise=pending;
  return pending;
};
const factoryLinuxOmarchyStop=()=>{
  factoryLinuxOmarchyRunId++;
  factoryLinuxOmarchyRunning=false;
  factoryLinuxOmarchyStartPromise=null;
  factoryLinuxOmarchyProvider.stop();
};
E.ipcMain.handle("factory-linux-theme:get",async event=>{
  if(!factoryLinuxOmarchyTrusted(event))return factoryLinuxOmarchyBridge.unavailableState();
  await factoryLinuxOmarchyStart();
  return factoryLinuxOmarchyProvider.getState();
});
E.ipcMain.handle("factory-linux-theme:follow",async(event,enabled)=>{
  if(typeof enabled!=="boolean"||!factoryLinuxOmarchyTrusted(event))return!1;
  const win=E.BrowserWindow.fromWebContents(event.sender);
  if(!win||typeof win.isDestroyed!=="function"||win.isDestroyed())return!1;
  factoryLinuxOmarchyFollow.set(win,enabled);
  if(enabled===!0){
    if(!factoryLinuxOmarchyResize.has(win)){
      const listener=()=>factoryLinuxOmarchyApply(win);
      win.on("resize",listener);
      win.once("closed",()=>{factoryLinuxOmarchyResize.delete(win)});
      factoryLinuxOmarchyResize.set(win,listener);
    }
    await factoryLinuxOmarchyStart().catch(()=>{});
  }
  factoryLinuxOmarchyApply(win);
  return!0;
});
E.app.on("browser-window-created",()=>{void factoryLinuxOmarchyStart()});
E.app.on("window-all-closed",factoryLinuxOmarchyStop);
E.app.on("before-quit",factoryLinuxOmarchyStop);
E.app.on("will-quit",factoryLinuxOmarchyStop);
factoryLinuxApplicationMenu=(${factoryPortCreateApplicationMenu.toString()})({
electron:E,trusted:factoryLinuxOmarchyTrusted,
isGlassy:win=>factoryLinuxOmarchyFollow.get(win)===!0&&factoryLinuxOmarchyGlassy(factoryLinuxOmarchyProvider.getState()),
getPalette:()=>factoryLinuxOmarchyProvider.getState(),
newToken:()=>require("node:crypto").randomUUID()
});
void factoryLinuxOmarchyStart();}`;

export const themeMainHelperNames = [
  'factoryLinuxOmarchyBridge',
  'factoryLinuxOmarchyProviderOptions',
  'factoryLinuxOmarchyProvider',
  'factoryLinuxOmarchyRunning',
  'factoryLinuxOmarchyStartPromise',
  'factoryLinuxOmarchyRunId',
  'factoryLinuxOmarchyFollow',
  'factoryLinuxOmarchyBase',
  'factoryLinuxOmarchyGlass',
  'factoryLinuxOmarchyResize',
  'factoryLinuxOmarchyTrusted',
  'factoryLinuxOmarchyGlassy',
  'factoryLinuxOmarchyApply',
  'factoryLinuxOmarchyTrack',
  'factoryLinuxOmarchyPublish',
  'factoryLinuxOmarchyStart',
  'factoryLinuxOmarchyStop',
  'factoryLinuxApplicationMenu',
];

export const themeMainChanges = [
  // The vendor window:setBackgroundColor handler keeps running unchanged
  // first (real kne behavior and the ua baseline stay intact); only then
  // does the Linux-only hook record the window's last known vendor RGB and
  // re-apply native transparency if that window opted in and the provider
  // currently reports a valid glassy windowMode. The hook identifier is a
  // hoisted var so the earlier-registered vendor handler closure can see it
  // while staying inert on non-Linux platforms.
  ['Omarchy read-only theme IPC bridge',
    'E.ipcMain.handle("window:setBackgroundColor",async(O,{color:x})=>{if(!/^#[0-9a-fA-F]{6}$/.test(x))return;const M=E.BrowserWindow.fromWebContents(O.sender);Xle(x,M??void 0)}),E.ipcMain.handle("window:setThemeSource"',
    'E.ipcMain.handle("window:setBackgroundColor",async(O,{color:x})=>{if(!/^#[0-9a-fA-F]{6}$/.test(x))return;const M=E.BrowserWindow.fromWebContents(O.sender),W=M??void 0;Xle(x,W);process.platform==="linux"&&factoryLinuxOmarchyTrack&&factoryLinuxOmarchyTrack(x,W)});' + integration + 'E.ipcMain.handle("window:setThemeSource"'],
];

export function diagnoseThemeMainHelpers(source) {
  return themeMainHelperNames.filter(name => source.includes(name));
}
