import { PRODUCT_NAME, DESKTOP_ENTRY } from './app-identity.mjs';

// Exact anchors from the inspected, checksum-pinned Desktop 0.206.0 bundle.
// Enable the vendor's integrated header, menu, theme and zoom capabilities
// while keeping the actual Linux platform identity and daemon transport.
//
// This module also owns the port's visible identity anchors: the main
// process name, the renderer window title and the initial page title all
// carry the port's own name (tools/app-identity.mjs).
//
// 0.206.0 upstream now supports the non-darwin (Linux included) platform
// natively for: the integrated renderer header (`showApplicationMenu` is
// exposed on every non-darwin platform in preload), the inline application
// menu IPC (`window:showApplicationMenu` is darwin-gated, not win32-only),
// hiding the separate menu bar after menu rebuilds, and re-aligning the
// title-bar overlay on zoom. Those four 0.201.0-era patches are therefore
// retired; the Linux restrictions below only cover what upstream still does
// not restrict itself (proprietary updater inside pacman, protocol
// registration, keyboard menu access, window icon).
export const linuxMenuKeyboardHandler = `
if(process.platform==="linux"){
  const linuxOpenApplicationMenu=()=>{
    if(typeof factoryLinuxApplicationMenu!=="undefined"&&factoryLinuxApplicationMenu?.keyboard({sender:a.webContents,senderFrame:a.webContents.mainFrame}))return;
    x.Menu.getApplicationMenu()?.popup({window:a});
  };
  let linuxAltMenuPending=false;
  a.on("blur",()=>{linuxAltMenuPending=false});
  a.webContents.on("before-input-event",(event,input)=>{
    if(input.key==="Alt"){
      if(input.type==="keyDown"&&!input.isAutoRepeat){
        if(typeof factoryLinuxApplicationMenu!=="undefined"&&factoryLinuxApplicationMenu?.isOpen(a)){
          factoryLinuxApplicationMenu.close(a);linuxAltMenuPending=false;event.preventDefault();return;
        }
        linuxAltMenuPending=!input.control&&!input.meta&&!input.shift;
      }else if(input.type==="keyUp"){
        const openMenu=linuxAltMenuPending&&!input.control&&!input.meta&&!input.shift;
        linuxAltMenuPending=false;
        if(openMenu){event.preventDefault();linuxOpenApplicationMenu()}
      }
      return;
    }
    if(input.type!=="keyDown")return;
    linuxAltMenuPending=false;
    if(input.key==="F10"&&!input.isAutoRepeat&&!input.control&&!input.meta&&!input.shift&&!input.alt){
      event.preventDefault();linuxOpenApplicationMenu();
    }
  });
}
`;

export const changes = [
  // The package's desktop entry advertises factory-desktop:// through XDG.
  // Skip upstream's default-handler takeover; existing user choices stay
  // intact. Only fix the XDG desktop entry name for Linux badges here.
  ['callback opt-in', 'function jne(){try{const e=i.getDesktopProtocol();',
    `function jne(){if(process.platform==="linux"){x.app.setDesktopName("${DESKTOP_ENTRY}");return;}try{const e=i.getDesktopProtocol();`],
  // The visible name of the port. The official manifest names the
  // application "Factory"; the port ships as its own product, so the name
  // is set before the first window exists and before the protocol helper
  // runs. The window title, the taskbar entry and the application menu
  // read the name from here.
  ['application name', 'i.startupTracker.beginPhase("ipc_and_protocol_setup"),jne()',
    `i.startupTracker.beginPhase("ipc_and_protocol_setup"),x.app.setName("${PRODUCT_NAME}"),jne()`],
  // The pacman boundary: an Arch-managed install must never enforce the
  // vendor's minimum-version quit prompt, run its in-app updater entry
  // points, or offer "Check for Updates" in the menu. Upstream 0.206.0
  // already refuses to *start* the auto-updater for externally managed
  // Linux installs (fs()/dl() detect the vendor's own packages); these
  // guards keep the manual and prompted paths equally closed.
  ['minimum version prompt', 'async function wj(){if(i.getRuntimeAuthConfig()',
    'async function wj(){if(process.platform==="linux")return!0;if(i.getRuntimeAuthConfig()'],
  ['manual updater', 'async function vc({onAborted:e}={}){',
    'async function vc({onAborted:e}={}){if(process.platform==="linux"){e?.();return;}'],
  ['update checks', 'async function hj(){de("check-now-requested"),',
    'async function hj(){if(process.platform==="linux")return;de("check-now-requested"),'],
  ['update menu', 'r=!t||i.areDesktopUpdatesDisabledByCachedOrgSettings()?[]:',
    'r=process.platform==="linux"||!t||i.areDesktopUpdatesDisabledByCachedOrgSettings()?[]:'],
  // Upstream still ships no keyboard affordance for the hidden Linux menu
  // bar (no before-input-event handler exists in 0.206.0), so keep the port's
  // Alt/F10 access through the integrated menu.
  ['keyboard application menu', 'if(t){a.setMenuBarVisibility(!1);const C=()=>',
    `if(t){a.setMenuBarVisibility(!1);${linuxMenuKeyboardHandler}const C=()=>`],
  // Native alpha surfaces need the transparency flag at BrowserWindow
  // creation; it cannot be enabled later. Proven on the port's Electron
  // 42.11.15 with native Wayland (build/glassy-native-proof/report.json):
  // transparent:true plus the untouched titleBarStyle:"hidden" and the
  // vendor's already-transparent titleBarOverlay ({color:"#00000000"} via
  // a3()) keep the native controls and resizing while the compositor can
  // blend the framebuffer. The vendor still paints backgroundColor:ww()
  // opaque by default, so nothing changes visually until the Omarchy
  // follow machinery (theme-main-patches.mjs) deliberately applies
  // #00000000 for a valid glassy windowMode.
  ['Linux window icon', 'titleBarStyle:"hidden",titleBarOverlay:t?',
    'icon:process.platform==="linux"?Q.join(process.resourcesPath,"factory-desktop.png"):void 0,transparent:process.platform==="linux"||void 0,titleBarStyle:"hidden",titleBarOverlay:t?'],
];

// 0.206.0 exposes the integrated header's showApplicationMenu on every
// non-darwin platform (`window:{showApplicationMenu:process.platform==="darwin"?void 0:...}`),
// so no preload patch is needed. The array stays (empty) so build.mjs keeps
// its single diagnostic/patch pipeline; tests/main-upstream-0.206.0.test.mjs
// guards the native branch against upstream regressions.
export const preloadChanges = [];

// Pause only this hook's polling while its renderer window is hidden or
// unfocused. Other query hooks and TanStack's global focus manager stay intact.
export const rendererHelperNames = [
  'factoryLinuxBillingFocusSnapshot',
  'factoryLinuxBillingFocusSubscribe',
  'factoryLinuxBillingUseFocused',
];

export const rendererChanges = [
  ['pause hidden billing limits polling',
    'function Sst(t){const e=z.c(3),n=t===void 0?!0:t,i=Gu(),o=n&&!i;let s;e[0]!==o?(s={endpoint:"/api/billing/limits",method:"GET",queryKey:Gn.billing.tokenLimits,enabled:o,hideErrorToast:!0},e[0]=o,e[1]=s):s=e[1];let r;return e[2]===Symbol.for("react.memo_cache_sentinel")?(r={refetchInterval:2e4,refetchIntervalInBackground:!0,retry:!1},e[2]=r):r=e[2],Ji(s,r)}',
    'function factoryLinuxBillingFocusSnapshot(){return typeof document==="undefined"||document.visibilityState!=="hidden"&&(typeof document.hasFocus!=="function"||document.hasFocus())}function factoryLinuxBillingFocusSubscribe(t){if(typeof window==="undefined"||typeof document==="undefined")return()=>{};return window.addEventListener("focus",t),window.addEventListener("blur",t),document.addEventListener("visibilitychange",t),()=>{window.removeEventListener("focus",t),window.removeEventListener("blur",t),document.removeEventListener("visibilitychange",t)}}function factoryLinuxBillingUseFocused(){return L.useSyncExternalStore(factoryLinuxBillingFocusSubscribe,factoryLinuxBillingFocusSnapshot,factoryLinuxBillingFocusSnapshot)}function Sst(t){const focused=factoryLinuxBillingUseFocused(),e=z.c(3),n=t===void 0?!0:t,i=Gu(),o=n&&!i&&focused;let s;e[0]!==o?(s={endpoint:"/api/billing/limits",method:"GET",queryKey:Gn.billing.tokenLimits,enabled:o,hideErrorToast:!0},e[0]=o,e[1]=s):s=e[1];let r;return e[2]===Symbol.for("react.memo_cache_sentinel")?(r={refetchInterval:2e4,refetchIntervalInBackground:!1,refetchOnWindowFocus:!0,retry:!1},e[2]=r):r=e[2],Ji(s,r)}'],
];

// The window title belongs to the renderer: Electron propagates a page
// title to the native window, so the upstream default title and the
// session title suffix are part of the port's visible name. The session
// title itself is preserved: only the product suffix changes.
//
// This is a layer of its own: the renderer compatibility layer above
// stays scoped to the billing gate, and the identity layers stay
// separable from it.
export const rendererTitleChanges = [
  ['default window title', 'Yqn="Factory"', `Yqn="${PRODUCT_NAME}"`],
  ['session window title suffix', 'r=n?`${n} - Factory`:Yqn;',
    `r=n?\`\${n} - ${PRODUCT_NAME}\`:Yqn;`],
];

export function diagnoseRendererHelperCollisions(source) {
  return rendererHelperNames.filter(name => source.includes(name));
}

// The initial page title: the window carries it before the renderer mounts
// and replaces it with its own title. The renderer title layer above owns
// the title the window shows afterwards.
export const htmlTitleChanges = [
  ['initial window title', '<title>Factory</title>', `<title>${PRODUCT_NAME}</title>`],
];

export function diagnose(source, transformations = changes) {
  return transformations.map(([name, before]) => {
    const count = source.split(before).length - 1;
    return count === 1 ? null : { name, count };
  }).filter(Boolean);
}

export function patch(source, transformations = changes) {
  let result = source;
  for (const [name, before, after] of transformations) {
    if (result.split(before).length !== 2) throw new Error(`Patch precondition failed: ${name}`);
    result = result.replace(before, after);
  }
  return result;
}
