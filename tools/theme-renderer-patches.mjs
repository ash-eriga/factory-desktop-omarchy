// Small, checksum-pinned renderer/preload/HTML adaptations for the optional
// Omarchy theme bridge, targeting upstream Factory Desktop 1.5.0
// (renderer index-CwKhkNcg.js). The upstream appearance store remains
// authoritative; following Omarchy is a separate, opt-in derived override.
//
// The appearance contrast slider stops at 100 upstream, where every fill token
// has already taken the whole fill curve. The port raises the ceiling to 150 so
// a user who wants more separation can ask for it, without changing anything at
// or below 100. Text tokens stop at their contrast-100 value: their curve adds
// a fixed 20 points per 50 contrast, so running it to 150 would make secondary
// text identical to primary and the disabled label stop reading as disabled.
// Fills extend linearly instead (2.5% -> 5.5% for the dark surface token).
// The ceiling alone cannot lift a panel that sits on the glass tint, though:
// every token is mixed from the palette background, while the pixels behind the
// panel come from the wallpaper. On a bright wallpaper the inner border token
// reaches only 1.06:1 against the pane at 150, so raising the number leaves the
// composer edge where it was. The strong token starts at twice the amount on
// the same curve, so it reaches 2.85:1 there. Inside the glass gate the
// composer panel therefore blends its outline from the inner token towards the
// strong one as the contrast passes 100. A contrast of 100 or less emits no
// rule at all, so the composer renders exactly as upstream did; only the range
// above 100 sharpens the outline, and nothing ever paints a fill.
//
// The derived overlay pins its contrast at factoryPortFollowContrast because
// Omarchy palettes such as vantablack sit on pure black, where the Factory
// default contrast of 50 mixes surfaces and borders at a few percent of the
// foreground and renders them near-invisible. Following Omarchy therefore
// starts above the default rather than at it.
// This file owns the complete follow-row placement inside the theme editor
// (z0u), immediately before the preset row, including the React memo-cache
// slot accounting for tAu and z0u. It also owns the glassy-window renderer
// half: windowMode normalization, the automatic native follow opt-in synced
// from the ThemeSync (Hrf) lifecycle through preload setOmarchyFollow, and
// a single-layer glass tint CSS emitted only when the followed snapshot is
// a valid glassy palette and the trusted main process accepted the follow
// opt-in. Each region paints once: .65 in the content frame and .35 in
// the sidebar/title bar, matching Omarchy's Glassy Bar. The page background
// tokens (--core-v2-bg-page/--surface-1) become transparent so the app's
// many stacked full-window shells (html, body, #root, $e, tt, page surfaces)
// never composite several translucent layers, while popovers, dialogs,
// controls and code keep their opaque bg-overlay/surface-raised tokens.
// Structural painters are cleared directly: the outer backdrop can inherit
// an opaque legacy page token, and the frame's border-box gradient otherwise
// fills the whole pane when its padding-box layer becomes transparent. One
// value is strengthened rather than cleared: above a contrast of 100 the glass
// gate blends the composer panel's outline towards the strong border token, so
// its edge stays visible over a wallpaper the palette background knows nothing
// about. Below that the panel is untouched, and no panel ever receives a fill.
// The secondary buttons inside the composer (the voice-dictation square) get a
// transparent fill and a translucent hover: their default fill is a solid mix
// of the palette background, which over the glass reads as a black box next to
// the transparent chips around it.
// The vendor stylesheet seeds --text-inverted from --core-v2-bg-page inside
// its v2 scopes (mission control, session detail, command palette). Glass
// legitimately makes that page token transparent, but as a text color the
// transparent value blanks inverted text over inverted surfaces (the active
// mission-mode chip, notification badges over accent fills). The glass scope
// therefore carries an opaque --factory-port-page-color with the followed
// background, and cssChanges retargets the vendor's seed to fall back to the
// page token when glass is off.

import { applicationMenuPreload, factoryPortMountApplicationMenu } from './application-menu-patches.mjs';
import { factoryPortUpdateSidebarMask, sidebarFadeChanges } from './sidebar-fade-patches.mjs';
import { glassyNavigationCss, glassyNavigationChanges } from './glassy-navigation-patches.mjs';

const basePreloadChanges = [
  ['narrow Omarchy theme bridge',
    'onCloseRequested:A=>{const e=()=>A();return M.ipcRenderer.on("app:closeRequested",e),()=>M.ipcRenderer.removeListener("app:closeRequested",e)}},getBugReportLogs:',
    `onCloseRequested:A=>{const e=()=>A();return M.ipcRenderer.on("app:closeRequested",e),()=>M.ipcRenderer.removeListener("app:closeRequested",e)}},theme:(()=>{const e=n=>{const o={available:!1,mode:null,background:null,foreground:null,accent:null,revision:null,windowMode:null};if(!n||typeof n!=="object"||n.available!==!0||n.mode!=="light"&&n.mode!=="dark")return o;const s=r=>typeof r==="string"&&/^#[0-9a-f]{6}$/i.test(r)?r.toLowerCase():null,a=s(n.background),l=s(n.foreground),d=s(n.accent),w=n.windowMode==="opaque"||n.windowMode==="transparent"||n.windowMode==="glassy"?n.windowMode:null;return a&&l&&d?{available:!0,mode:n.mode,background:a,foreground:l,accent:d,revision:typeof n.revision==="string"?n.revision:null,windowMode:w}:o};return{getOmarchy:()=>M.ipcRenderer.invoke("factory-linux-theme:get").then(e,()=>e(null)),onOmarchyChanged:n=>{if(typeof n!=="function")return()=>{};const o=(s,r)=>n(e(r));return M.ipcRenderer.on("factory-linux-theme:changed",o),()=>M.ipcRenderer.removeListener("factory-linux-theme:changed",o)},setOmarchyFollow:n=>typeof n!=="boolean"?Promise.resolve(!1):M.ipcRenderer.invoke("factory-linux-theme:follow",n).then(r=>r===!0,()=>!1)}})(),getBugReportLogs:`],
];

export const preloadChanges = basePreloadChanges.map(([name, before, after]) => [
  name, before, after.replace('},theme:(()=>', `},${applicationMenuPreload}theme:(()=>`),
]);

const htmlCrlf = value => value.replace(/\n/g, '\r\n');

export const htmlChanges = [
  ['read optional cached theme before first paint',
    htmlCrlf(`          var stored = localStorage.getItem(STORAGE_KEY);
          var theme =
            stored === 'light' || stored === 'dark'
              ? stored
              : window.matchMedia('(prefers-color-scheme: dark)').matches
                ? 'dark'
                : 'light';`),
    htmlCrlf(`          var stored = localStorage.getItem(STORAGE_KEY);
          var portTheme = null;
          try {
            if (
              localStorage.getItem('factory-port-theme-source') === 'omarchy' &&
              window.electronAPI &&
              window.electronAPI.theme &&
              typeof window.electronAPI.theme.getOmarchy === 'function'
            ) {
              var cachedPortTheme = JSON.parse(
                localStorage.getItem('factory-port-theme-cache') || 'null'
              );
              var validPortColor = function (value) {
                return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
              };
              if (
                cachedPortTheme &&
                cachedPortTheme.available === true &&
                (cachedPortTheme.mode === 'light' || cachedPortTheme.mode === 'dark') &&
                validPortColor(cachedPortTheme.background) &&
                validPortColor(cachedPortTheme.foreground) &&
                validPortColor(cachedPortTheme.accent)
              ) {
                portTheme = cachedPortTheme;
              }
            }
          } catch (e) {
            portTheme = null;
          }
          var theme =
            portTheme
              ? portTheme.mode
              : stored === 'light' || stored === 'dark'
              ? stored
              : window.matchMedia('(prefers-color-scheme: dark)').matches
                ? 'dark'
                : 'light';`)],
  ['use cached Omarchy background without overwriting Factory cache',
    htmlCrlf(`          var appearanceBackground;
          var storedBackgrounds = localStorage.getItem(
            APPEARANCE_BACKGROUNDS_KEY
          );
          if (storedBackgrounds) {
            var candidate = JSON.parse(storedBackgrounds)[theme];
            if (/^#[0-9a-f]{6}$/i.test(candidate)) {
              appearanceBackground = candidate;
            }
          }`),
    htmlCrlf(`          var appearanceBackground = portTheme ? portTheme.background : undefined;
          var storedBackgrounds = localStorage.getItem(
            APPEARANCE_BACKGROUNDS_KEY
          );
          if (!appearanceBackground && storedBackgrounds) {
            var candidate = JSON.parse(storedBackgrounds)[theme];
            if (/^#[0-9a-f]{6}$/i.test(candidate)) {
              appearanceBackground = candidate;
            }
          }`)],
];

const baseRendererHelpers = `
const factoryPortThemeKey="factory-port-theme-source",factoryPortThemeCacheKey="factory-port-theme-cache",factoryPortThemeEmpty={available:!1,mode:null,background:null,foreground:null,accent:null,revision:null,windowMode:null};
const factoryPortFollowContrast=85;
// Following Omarchy raises the derived contrast to a floor, it does not impose
// one. A palette on pure black needs at least 85 for its borders to read, but a
// user who asked for more must keep it: the composer outline only sharpens
// above 100, so overwriting a chosen 150 with 85 would undo that choice.
function factoryPortFollowContrastFloor(n){return typeof n==="number"&&n>=factoryPortFollowContrast?n:factoryPortFollowContrast}
function factoryPortNormalizeTheme(t){if(!t||typeof t!=="object"||t.available!==!0||t.mode!=="light"&&t.mode!=="dark")return factoryPortThemeEmpty;const e=n=>typeof n==="string"&&/^#[0-9a-f]{6}$/i.test(n)?n.toLowerCase():null,n=e(t.background),i=e(t.foreground),o=e(t.accent),r=t.windowMode==="opaque"||t.windowMode==="transparent"||t.windowMode==="glassy"?t.windowMode:null;return n&&i&&o?{available:!0,mode:t.mode,background:n,foreground:i,accent:o,revision:typeof t.revision==="string"?t.revision:null,windowMode:r}:factoryPortThemeEmpty}
function factoryPortOverlayAppearance(t,e,n){if(!e.available)return t;const i=e.mode,o=n[i],s=t[i]??o;return{...t,[i]:{...s,preset:o.preset,accent:o.accent,accentColor:e.accent,background:e.background,foreground:e.foreground,contrast:factoryPortFollowContrastFloor(s.contrast)}}}
function factoryPortReadFollow(){try{return localStorage.getItem(factoryPortThemeKey)==="omarchy"}catch{return!1}}
function factoryPortReadCachedTheme(){try{if(!factoryPortReadFollow()||typeof window==="undefined"||!window.electronAPI?.theme?.getOmarchy)return factoryPortThemeEmpty;return factoryPortNormalizeTheme(JSON.parse(localStorage.getItem(factoryPortThemeCacheKey)||"null"))}catch{return factoryPortThemeEmpty}}
function factoryPortPersistTheme(t){try{t.available?localStorage.setItem(factoryPortThemeCacheKey,JSON.stringify(t)):localStorage.removeItem(factoryPortThemeCacheKey)}catch{}}
function factoryPortThemeUiCopy(e){let n="";try{n=localStorage.getItem("factory-app-startup-locale")||navigator.language||""}catch{}const i=/^pt(?:-|$)/i.test(n);return{title:i?"Seguir o tema do Omarchy":"Follow Omarchy theme",description:e.available?i?"Usa temporariamente as cores do Omarchy; sua aparência salva no Factory continua preservada.":"Temporarily use Omarchy colors; your saved Factory appearance stays intact.":i?"As cores do tema Omarchy não estão disponíveis; a aparência do Factory continua ativa.":"Omarchy theme colors are unavailable; your Factory appearance remains active."}}
function factoryPortBuildThemeRow(t,e,n){const i=factoryPortThemeUiCopy(e),o=c.jsx(Ia,{"aria-label":i.title,checked:t,disabled:!t&&!e.available,onCheckedChange:r=>n(r===!0)});return c.jsx(ad,{control:o,description:i.description,searchId:"appearance-follow-omarchy",title:i.title})}
let factoryPortNativeFollowTicket=0;
function factoryPortSyncNativeFollow(store,forced){const desired=forced===void 0?store.get(factoryPortThemeFollow)===!0:forced===!0,api=typeof window==="object"&&window!==null&&window.electronAPI?.theme?.setOmarchyFollow;if(typeof api!=="function"){store.set(factoryPortNativeFollowAccepted,!1);return}const requested=desired===!0,ticket=++factoryPortNativeFollowTicket;if(!requested)store.set(factoryPortNativeFollowAccepted,!1);Promise.resolve(api(desired)).then(r=>{ticket===factoryPortNativeFollowTicket&&store.set(factoryPortNativeFollowAccepted,requested&&r===!0)},()=>{ticket===factoryPortNativeFollowTicket&&store.set(factoryPortNativeFollowAccepted,!1)})}
function factoryPortComposerContrast(t,e){if(!t||typeof t!=="object")return null;const n=e==null?t[t.mode]:t[e],i=n==null?void 0:n.contrast;return typeof i==="number"&&Number.isFinite(i)?i:null}
function factoryPortComposerBorderCss(e){const n=typeof e==="number"&&Number.isFinite(e)&&e>100?Math.min(1,(e-100)/50):0;return n<=0?"":"\\n[data-factory-port-composer-surface][data-factory-port-composer-surface]{border-color:color-mix(in oklab, var(--core-v2-border-strong) "+Math.round(n*100)+"%, var(--core-v2-border-inner))!important}"}
function factoryPortGlassCss(t,r){
if(!t||typeof t!=="object"||t.available!==!0||t.windowMode!=="glassy"||typeof t.background!=="string"||!/^#[0-9a-f]{6}$/i.test(t.background)||typeof t.foreground!=="string"||!/^#[0-9a-f]{6}$/i.test(t.foreground))return"";
const e=Number.parseInt(t.background.slice(1,3),16),n=Number.parseInt(t.background.slice(3,5),16),i=Number.parseInt(t.background.slice(5,7),16),o=e+", "+n+", "+i,s=t.mode==="light"?"rgba(255,255,255,.8)":"rgba(0,0,0,.8)";
return":root:root, [data-core-ui-v2-theme='light'][data-core-ui-v2-theme], :root:not([data-theme='dark']), [data-core-ui-v2-theme='dark'][data-core-ui-v2-theme], [data-core-v2-portals='dark'][data-core-v2-portals], :root[data-theme='dark']{--core-v2-bg-page:transparent;--surface-1:transparent;--factory-port-page-color:"+t.background+"}\\nhtml{background-color:transparent!important}\\nbody, #root{background-color:transparent!important}\\n[data-windows-content-surface], [data-window-backdrop-v2]{background-color:transparent!important}\\n[data-windows-content-frame='true']{background:rgba("+o+", .65)!important;border-color:var(--border-1)!important}\\n[data-sidebar-visible], [data-windows-title-bar-v2]{background-color:rgba("+o+", .35)!important}\\n[data-sidebar-visible] [data-factory-port-sidebar-surface], [data-sidebar-visible] [data-sidebar-overlay], [data-sidebar-visible] [data-factory-port-titlebar-surface], [data-windows-title-bar-v2] [data-factory-port-titlebar-surface]{background-color:transparent!important}\\n[data-factory-port-sidebar-surface][data-factory-port-sidebar-surface], [data-windows-title-bar-v2][data-windows-title-bar-v2]{--core-v2-text-primary:"+t.foreground+"!important;--core-v2-text-secondary:color-mix(in srgb,"+t.foreground+" 85%,"+t.background+")!important;--core-v2-text-tertiary:color-mix(in srgb,"+t.foreground+" 75%,"+t.background+")!important;--sidebar-text:var(--core-v2-text-secondary)!important;--sidebar-text-hover:var(--core-v2-text-primary)!important;color:var(--core-v2-text-primary);text-shadow:0 1px 2px "+s+"}\\n[data-factory-port-composer-surface] button{--core-v2-button-secondary-bg-default:transparent;--core-v2-button-secondary-bg-hover:color-mix(in srgb,var(--core-v2-text-primary) 12%,transparent)}"+factoryPortComposerBorderCss(r)
}
`;

export const rendererHelpers = `${baseRendererHelpers}\nconst factoryPortNavigationGlassCss=${JSON.stringify(glassyNavigationCss)};\n${factoryPortMountApplicationMenu.toString()}\n${factoryPortUpdateSidebarMask.toString()}\n`;

export const cssChanges = [
  ['keep inverted text readable while the glass page token is transparent',
    '--text-inverted: var(--core-v2-bg-page)',
    '--text-inverted: var(--factory-port-page-color, var(--core-v2-bg-page))'],
];

export const rendererChanges = [
  ['persisted opt-in and live Omarchy snapshot store',
    'pnt=Di(msd());pnt.onMount=',
    `pnt=Di(msd());${rendererHelpers}const factoryPortThemeFollow=bce(factoryPortThemeKey,factoryPortReadFollow(),{getItem:()=>factoryPortReadFollow(),setItem:(t,e)=>{try{localStorage.setItem(t,e?"omarchy":"factory")}catch{}},removeItem:t=>{try{localStorage.removeItem(t)}catch{}}}),factoryPortThemeSnapshot=Di(factoryPortReadCachedTheme());factoryPortThemeSnapshot.onMount=t=>{let e=!1,n=0,i=()=>{};if(typeof window==="undefined"||!window.electronAPI?.theme)return()=>{};const o=window.electronAPI.theme,a=r=>{if(!e){const l=factoryPortNormalizeTheme(r);factoryPortPersistTheme(l),t(l)}},s=r=>{n++,a(r)},l=n;try{typeof o.onOmarchyChanged==="function"&&(i=o.onOmarchyChanged(s))}catch{}try{Promise.resolve().then(()=>typeof o.getOmarchy==="function"?o.getOmarchy():null).then(r=>{n===l&&a(r)},()=>{n===l&&a(null)})}catch{a(null)}return()=>{e=!0;try{i?.()}catch{}}};const factoryPortThemeActive=Di(t=>t(factoryPortThemeFollow)&&t(factoryPortThemeSnapshot).available),factoryPortThemeSource=Di(t=>t(factoryPortThemeActive)?t(factoryPortThemeSnapshot).mode:t(Dke)),factoryPortNativeFollowAccepted=Di(!1),factoryPortGlassActive=Di(t=>t(factoryPortThemeFollow)===!0&&t(factoryPortThemeSnapshot).available===!0&&t(factoryPortThemeSnapshot).windowMode==="glassy"&&t(factoryPortNativeFollowAccepted)===!0);pnt.onMount=`],
  ['derive resolved theme from opt-in source',
    'const YH=Di(t=>{const e=t(Dke),n=t(wQt);return n||(e===lb.System?t(pnt):e===lb.Light?"light":e===lb.Dark?"dark":t(pnt))});',
    'const YH=Di(t=>{const e=t(factoryPortThemeSource),n=t(wQt);return n||(e===lb.System?t(pnt):e===lb.Light?"light":e===lb.Dark?"dark":t(pnt))});'],
  ['derive palette tokens without changing stored Factory settings',
    'z9e=Di(!1),kCu=Di(t=>{const e=t(YH)==="dark"?Ir.Dark:Ir.Light;return pAe({mode:e,settings:t(H9e)[e]})}),U1i=Di(t=>t(z9e)?C7a({settings:t(H9e)}):""),',
    'z9e=Di(!1),factoryPortEffectiveAppearance=Di(t=>factoryPortOverlayAppearance(t(H9e),t(factoryPortThemeActive)?t(factoryPortThemeSnapshot):factoryPortThemeEmpty,A6)),kCu=Di(t=>{const e=t(YH)==="dark"?Ir.Dark:Ir.Light;return pAe({mode:e,settings:t(H9e)[e]})}),U1i=Di(t=>{if(!t(z9e))return"";const e=C7a({settings:t(factoryPortEffectiveAppearance)});return t(factoryPortGlassActive)?e+factoryPortGlassCss(t(factoryPortThemeSnapshot),factoryPortComposerContrast(t(factoryPortEffectiveAppearance),t(factoryPortThemeSnapshot).mode))+factoryPortNavigationGlassCss:e}),'],
  // Upstream validates, clamps and displays the slider value against one
  // shared bounds object, so raising its max is what lets a stored 150 survive
  // the appearance store, the slider and a theme JSON import.
  ['raise the appearance contrast ceiling to 150',
    'TXe={min:0,max:100}',
    'TXe={min:0,max:150}'],
  // The fill curve is linear in contrast and safe to extend. The text curve is
  // a fixed offset per 50 contrast, so it saturates: past 100 secondary text
  // reaches primary and the disabled label stops reading as disabled. Clamping
  // only the contrast fed to the text branch keeps every text token at its
  // contrast-100 value while fills keep growing.
  ['stop the text contrast curve at the upstream ceiling',
    'function W$n({contrast:t,mix:e,mode:n}){const i=e[n],o=t/50;',
    'function W$n({contrast:t,mix:e,mode:n}){const i=e[n],g=e.kind==="text"&&t>100?100:t,o=g/50;'],
  ['use temporary source background while following',
    '$1i=Di(t=>t(z9e)?MLt(t(kCu)):void 0),',
    '$1i=Di(t=>{if(!t(z9e))return;return t(factoryPortThemeActive)?t(factoryPortThemeSnapshot).background:MLt(t(kCu))}),'],
  ['sync Electron native theme using effective preference',
    'themePreference:i.get(Dke)',
    'themePreference:i.get(factoryPortThemeSource)'],
  ['observe effective theme source changes and sync native follow opt-in',
    'const r=i.sub(YH,s),a=i.sub(Dke,s),l=i.sub($1i,s),d=i.sub(wQt,s);return()=>{r(),a(),l(),d()}',
    'const r=i.sub(YH,s),a=i.sub(Dke,s),l=i.sub($1i,s),d=i.sub(wQt,s),g=()=>factoryPortSyncNativeFollow(i);g();const f=i.sub(factoryPortThemeFollow,g),factoryPortMenuStop=factoryPortMountApplicationMenu(window.electronAPI?.applicationMenu);return()=>{factoryPortMenuStop();r(),a(),l(),d(),f(),factoryPortSyncNativeFollow(i,!1)}'],
  ['Appearance screen reads follow state and grows its memo cache',
    'function t$u(){const t=z.c(232),{t:e}=fe("settings"),[n,i]=Gs(H9e),{theme:o,themePreference:s,setThemePreference:r}=M8(),',
    'function t$u(){const t=z.c(235),{t:e}=fe("settings"),[n,i]=Gs(H9e),[factoryPortFollow,setFactoryPortFollow]=Gs(factoryPortThemeFollow),[factoryPortState]=Gs(factoryPortThemeSnapshot),{theme:o,themePreference:s,setThemePreference:r}=M8(),'],
  ['pass follow state into the theme editor',
    'let R;t[29]!==a||t[30]!==l||t[31]!==m||t[32]!==k?(R=c.jsx(zUu,{mode:a,onChange:k,onChoose:m,theme:l},a),t[29]=a,t[30]=l,t[31]=m,t[32]=k,t[33]=R):R=t[33];',
    'let R;t[29]!==a||t[30]!==l||t[31]!==m||t[32]!==k||t[232]!==factoryPortFollow||t[233]!==factoryPortState||t[234]!==setFactoryPortFollow?(R=c.jsx(zUu,{mode:a,onChange:k,onChoose:m,theme:l,factoryPortFollow,factoryPortState,setFactoryPortFollow},a),t[29]=a,t[30]=l,t[31]=m,t[32]=k,t[232]=factoryPortFollow,t[233]=factoryPortState,t[234]=setFactoryPortFollow,t[33]=R):R=t[33];'],
  ['theme editor accepts follow state and grows its memo cache',
    'function zUu(t){const e=z.c(206),{mode:n,onChange:i,onChoose:o,theme:s}=t,{t:r}=fe("settings"),',
    'function zUu(t){const e=z.c(211),{mode:n,onChange:i,onChoose:o,theme:s,factoryPortFollow,factoryPortState,setFactoryPortFollow}=t,{t:r}=fe("settings"),'],
  ['memoize the follow row from its three controlled props',
    'const{palette:b}=y;let C;if(e[11]!==n||e[12]!==s.preset){',
    'const{palette:b}=y;let factoryPortThemeRow;e[206]!==factoryPortFollow||e[207]!==factoryPortState||e[208]!==setFactoryPortFollow?(factoryPortThemeRow=factoryPortBuildThemeRow(factoryPortFollow,factoryPortState,setFactoryPortFollow),e[206]=factoryPortFollow,e[207]=factoryPortState,e[208]=setFactoryPortFollow,e[209]=factoryPortThemeRow):factoryPortThemeRow=e[209];let C;if(e[11]!==n||e[12]!==s.preset){'],
  ['place the follow row immediately before the preset row',
    'let Ze;e[183]!==Z||e[184]!==de||e[185]!==ge||e[186]!==_e||e[187]!==je||e[188]!==Ye?(Ze=c.jsxs(x1,{children:[Z,te,de,ve,ge,xe,_e,Ee,je,Qe,Ye]}),e[183]=Z,e[184]=de,e[185]=ge,e[186]=_e,e[187]=je,e[188]=Ye,e[189]=Ze):Ze=e[189];',
    'let Ze;e[183]!==Z||e[184]!==de||e[185]!==ge||e[186]!==_e||e[187]!==je||e[188]!==Ye||e[210]!==factoryPortThemeRow?(Ze=c.jsxs(x1,{children:[factoryPortThemeRow,Z,te,de,ve,ge,xe,_e,Ee,je,Qe,Ye]}),e[183]=Z,e[184]=de,e[185]=ge,e[186]=_e,e[187]=je,e[188]=Ye,e[210]=factoryPortThemeRow,e[189]=Ze):Ze=e[189];'],
  ['mark the real sidebar pane without changing its layout or interactions',
    'c.jsx(qnd,{$background:a,$borderRight:l,"data-testid":i',
    'c.jsx(qnd,{$background:a,$borderRight:l,"data-factory-port-sidebar-surface":!0,"data-testid":i'],
  ['mark the real title-bar painter without changing its native drag regions',
    'c.jsx(At,{...ne,"data-windows-title-bar-v2":!0,flexShrink:0,children:',
    'c.jsx(At,{...ne,"data-factory-port-titlebar-surface":!0,"data-windows-title-bar-v2":!0,flexShrink:0,children:'],
  // The composer panel paints no fill of its own and marks its edge with the
  // border token only. Over a glassy frame the panel shows the .65 tint over
  // the desktop wallpaper, and every border token is mixed from the palette
  // background, which is not what is actually behind it: on a bright wallpaper
  // the inner token lands within one RGB step of the pane and the box
  // dissolves. The marker lets the glass layer blend that one edge towards the
  // strong token above a contrast of 100, while the panel keeps upstream's
  // transparent background and its border at or below 100.
  //
  // Two components draw that panel. a4 is the stacked panel the new-session
  // composer and its banners use (border: 1px solid var(--border-1), no fill);
  // kBa is the card the session composer uses. Both carry the same marker, so
  // the one rule strengthens whichever of them is on screen.
  ['mark the stacked composer panels the new-session view draws',
    'const a4=X(st)`\n  align-items: center;\n  border: 1px solid var(--border-1);',
    'const a4=X(st).attrs({"data-factory-port-composer-surface":!0})`\n  align-items: center;\n  border: 1px solid var(--border-1);'],
  ['mark the composer card the session view draws',
    'const kBa=X.div`',
    'const kBa=X.div.attrs({"data-factory-port-composer-surface":!0})`'],
  ...sidebarFadeChanges,
  ...glassyNavigationChanges,
];

export const rendererHelperNames = [
  'factoryPortNormalizeTheme',
  'factoryPortFollowContrast',
  'factoryPortFollowContrastFloor',
  'factoryPortThemeFollow',
  'factoryPortThemeSnapshot',
  'factoryPortBuildThemeRow',
  'factoryPortThemeActive',
  'factoryPortThemeSource',
  'factoryPortEffectiveAppearance',
  'factoryPortNativeFollowTicket',
  'factoryPortSyncNativeFollow',
  'factoryPortNativeFollowAccepted',
  'factoryPortGlassActive',
  'factoryPortGlassCss',
  'factoryPortComposerContrast',
  'factoryPortComposerBorderCss',
  'factoryPortMountApplicationMenu',
  'factoryPortMenuStop',
  'factoryPortUpdateSidebarMask',
  'factoryPortNavigationGlassCss',
];

// The port injects its own theme bridge into the preload API surface, so an
// upstream theme member there would be shadowed. The API is exposed as one
// object literal, so only a theme member inside that literal is a
// collision: a schema field that happens to be named "theme" elsewhere in
// the preload is not an API surface. The port's own bridge member names are
// checked in the whole file, because those must never exist upstream.
export function diagnoseThemePreloadCollisions(source) {
  const collisions = [];
  for (const name of ['getOmarchy', 'onOmarchyChanged', 'setOmarchyFollow'])
    if (source.includes(name)) collisions.push(`electronAPI.theme.${name}`);
  const exposure = source.indexOf('exposeInMainWorld("electronAPI"');
  const api = exposure === -1 ? source : source.slice(exposure);
  if (api.includes('theme:')) collisions.push('electronAPI.theme bridge');
  return collisions;
}

export function diagnoseThemeHtmlCollisions(source) {
  return ['factory-port-theme-source', 'factory-port-theme-cache']
    .filter(key => source.includes(key));
}

export function diagnoseThemeCssCollisions(source) {
  return ['--factory-port-page-color']
    .filter(key => source.includes(key));
}

export function diagnose(source, transformations) {
  return transformations.map(([name, before]) => {
    const count = source.split(before).length - 1;
    return count === 1 ? null : { name, count };
  }).filter(Boolean);
}

export function diagnoseThemeHelperCollisions(source) {
  return rendererHelperNames.filter(name => source.includes(name));
}

export function patch(source, transformations) {
  let result = source;
  for (const [name, before, after] of transformations) {
    if (result.split(before).length !== 2) throw new Error(`Theme patch precondition failed: ${name}`);
    result = result.replace(before, after);
  }
  return result;
}
