// Small, checksum-pinned renderer/preload/HTML adaptations for the optional
// Omarchy theme bridge, targeting upstream Factory Desktop 0.206.0
// (renderer index-DTd1u_pI.js). The upstream appearance store remains
// authoritative; following Omarchy is a separate, opt-in derived override.
// The derived overlay pins its contrast at factoryPortFollowContrast because
// Omarchy palettes such as vantablack sit on pure black, where the Factory
// default contrast of 50 mixes surfaces and borders at a few percent of the
// foreground and renders them near-invisible.
// This file owns the complete follow-row placement inside the theme editor
// (iCu), immediately before the preset row, including the React memo-cache
// slot accounting for pCu and iCu. It also owns the glassy-window renderer
// half: windowMode normalization, the automatic native follow opt-in synced
// from the ThemeSync (pAf) lifecycle through preload setOmarchyFollow, and
// a single-layer glass tint CSS emitted only when the followed snapshot is
// a valid glassy palette and the trusted main process accepted the follow
// opt-in. Each region paints once: .65 in the content frame and .35 in
// the sidebar/title bar, matching Omarchy's Glassy Bar. The page background
// tokens (--core-v2-bg-page/--surface-1) become transparent so the app's
// many stacked full-window shells (html, body, #root, Ue, tt, page surfaces)
// never composite several translucent layers, while popovers, dialogs,
// controls and code keep their opaque bg-overlay/surface-raised tokens.
// Structural painters are cleared directly: the outer backdrop can inherit
// an opaque legacy page token, and the frame's border-box gradient otherwise
// fills the whole pane when its padding-box layer becomes transparent.

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
function factoryPortNormalizeTheme(t){if(!t||typeof t!=="object"||t.available!==!0||t.mode!=="light"&&t.mode!=="dark")return factoryPortThemeEmpty;const e=n=>typeof n==="string"&&/^#[0-9a-f]{6}$/i.test(n)?n.toLowerCase():null,n=e(t.background),i=e(t.foreground),o=e(t.accent),r=t.windowMode==="opaque"||t.windowMode==="transparent"||t.windowMode==="glassy"?t.windowMode:null;return n&&i&&o?{available:!0,mode:t.mode,background:n,foreground:i,accent:o,revision:typeof t.revision==="string"?t.revision:null,windowMode:r}:factoryPortThemeEmpty}
function factoryPortOverlayAppearance(t,e,n){if(!e.available)return t;const i=e.mode,o=n[i];return{...t,[i]:{...(t[i]??o),preset:o.preset,accent:o.accent,accentColor:e.accent,background:e.background,foreground:e.foreground,contrast:factoryPortFollowContrast}}}
function factoryPortReadFollow(){try{return localStorage.getItem(factoryPortThemeKey)==="omarchy"}catch{return!1}}
function factoryPortReadCachedTheme(){try{if(!factoryPortReadFollow()||typeof window==="undefined"||!window.electronAPI?.theme?.getOmarchy)return factoryPortThemeEmpty;return factoryPortNormalizeTheme(JSON.parse(localStorage.getItem(factoryPortThemeCacheKey)||"null"))}catch{return factoryPortThemeEmpty}}
function factoryPortPersistTheme(t){try{t.available?localStorage.setItem(factoryPortThemeCacheKey,JSON.stringify(t)):localStorage.removeItem(factoryPortThemeCacheKey)}catch{}}
function factoryPortThemeUiCopy(e){let n="";try{n=localStorage.getItem("factory-app-startup-locale")||navigator.language||""}catch{}const i=/^pt(?:-|$)/i.test(n);return{title:i?"Seguir o tema do Omarchy":"Follow Omarchy theme",description:e.available?i?"Usa temporariamente as cores do Omarchy; sua aparência salva no Factory continua preservada.":"Temporarily use Omarchy colors; your saved Factory appearance stays intact.":i?"As cores do tema Omarchy não estão disponíveis; a aparência do Factory continua ativa.":"Omarchy theme colors are unavailable; your Factory appearance remains active."}}
function factoryPortBuildThemeRow(t,e,n){const i=factoryPortThemeUiCopy(e),o=c.jsx(ia,{"aria-label":i.title,checked:t,disabled:!t&&!e.available,onCheckedChange:r=>n(r===!0)});return c.jsx(Kc,{control:o,description:i.description,searchId:"appearance-follow-omarchy",title:i.title})}
let factoryPortNativeFollowTicket=0;
function factoryPortSyncNativeFollow(store,forced){const desired=forced===void 0?store.get(factoryPortThemeFollow)===!0:forced===!0,api=typeof window==="object"&&window!==null&&window.electronAPI?.theme?.setOmarchyFollow;if(typeof api!=="function"){store.set(factoryPortNativeFollowAccepted,!1);return}const requested=desired===!0,ticket=++factoryPortNativeFollowTicket;if(!requested)store.set(factoryPortNativeFollowAccepted,!1);Promise.resolve(api(desired)).then(r=>{ticket===factoryPortNativeFollowTicket&&store.set(factoryPortNativeFollowAccepted,requested&&r===!0)},()=>{ticket===factoryPortNativeFollowTicket&&store.set(factoryPortNativeFollowAccepted,!1)})}
function factoryPortGlassCss(t){
if(!t||typeof t!=="object"||t.available!==!0||t.windowMode!=="glassy"||typeof t.background!=="string"||!/^#[0-9a-f]{6}$/i.test(t.background)||typeof t.foreground!=="string"||!/^#[0-9a-f]{6}$/i.test(t.foreground))return"";
const e=Number.parseInt(t.background.slice(1,3),16),n=Number.parseInt(t.background.slice(3,5),16),i=Number.parseInt(t.background.slice(5,7),16),o=e+", "+n+", "+i,s=t.mode==="light"?"rgba(255,255,255,.8)":"rgba(0,0,0,.8)";
return":root:root, [data-core-ui-v2-theme='light'][data-core-ui-v2-theme], :root:not([data-theme='dark']), [data-core-ui-v2-theme='dark'][data-core-ui-v2-theme], [data-core-v2-portals='dark'][data-core-v2-portals], :root[data-theme='dark']{--core-v2-bg-page:transparent;--surface-1:transparent}\\nhtml{background-color:transparent!important}\\nbody, #root{background-color:transparent!important}\\n[data-windows-content-surface], [data-window-backdrop-v2]{background-color:transparent!important}\\n[data-windows-content-frame='true']{background:rgba("+o+", .65)!important;border-color:var(--border-1)!important}\\n[data-sidebar-visible], [data-windows-title-bar-v2]{background-color:rgba("+o+", .35)!important}\\n[data-sidebar-visible] [data-factory-port-sidebar-surface], [data-sidebar-visible] [data-sidebar-overlay], [data-sidebar-visible] [data-factory-port-titlebar-surface], [data-windows-title-bar-v2] [data-factory-port-titlebar-surface]{background-color:transparent!important}\\n[data-factory-port-sidebar-surface][data-factory-port-sidebar-surface], [data-windows-title-bar-v2][data-windows-title-bar-v2]{--core-v2-text-primary:"+t.foreground+"!important;--core-v2-text-secondary:color-mix(in srgb,"+t.foreground+" 85%,"+t.background+")!important;--core-v2-text-tertiary:color-mix(in srgb,"+t.foreground+" 75%,"+t.background+")!important;--sidebar-text:var(--core-v2-text-secondary)!important;--sidebar-text-hover:var(--core-v2-text-primary)!important;color:var(--core-v2-text-primary);text-shadow:0 1px 2px "+s+"}"
}
`;

export const rendererHelpers = `${baseRendererHelpers}\nconst factoryPortNavigationGlassCss=${JSON.stringify(glassyNavigationCss)};\n${factoryPortMountApplicationMenu.toString()}\n${factoryPortUpdateSidebarMask.toString()}\n`;

export const rendererChanges = [
  ['persisted opt-in and live Omarchy snapshot store',
    'XWe=fs(wMc());XWe.onMount=',
    `XWe=fs(wMc());${rendererHelpers}const factoryPortThemeFollow=jne(factoryPortThemeKey,factoryPortReadFollow(),{getItem:()=>factoryPortReadFollow(),setItem:(t,e)=>{try{localStorage.setItem(t,e?"omarchy":"factory")}catch{}},removeItem:t=>{try{localStorage.removeItem(t)}catch{}}}),factoryPortThemeSnapshot=fs(factoryPortReadCachedTheme());factoryPortThemeSnapshot.onMount=t=>{let e=!1,n=0,i=()=>{};if(typeof window==="undefined"||!window.electronAPI?.theme)return()=>{};const o=window.electronAPI.theme,a=r=>{if(!e){const l=factoryPortNormalizeTheme(r);factoryPortPersistTheme(l),t(l)}},s=r=>{n++,a(r)},l=n;try{typeof o.onOmarchyChanged==="function"&&(i=o.onOmarchyChanged(s))}catch{}try{Promise.resolve().then(()=>typeof o.getOmarchy==="function"?o.getOmarchy():null).then(r=>{n===l&&a(r)},()=>{n===l&&a(null)})}catch{a(null)}return()=>{e=!0;try{i?.()}catch{}}};const factoryPortThemeActive=fs(t=>t(factoryPortThemeFollow)&&t(factoryPortThemeSnapshot).available),factoryPortThemeSource=fs(t=>t(factoryPortThemeActive)?t(factoryPortThemeSnapshot).mode:t(JWe)),factoryPortNativeFollowAccepted=fs(!1),factoryPortGlassActive=fs(t=>t(factoryPortThemeFollow)===!0&&t(factoryPortThemeSnapshot).available===!0&&t(factoryPortThemeSnapshot).windowMode==="glassy"&&t(factoryPortNativeFollowAccepted)===!0);XWe.onMount=`],
  ['derive resolved theme from opt-in source',
    'const $H=fs(t=>{const e=t(JWe);return e===Qy.System?t(XWe):e===Qy.Light?"light":e===Qy.Dark?"dark":t(XWe)});',
    'const $H=fs(t=>{const e=t(factoryPortThemeSource);return e===Qy.System?t(XWe):e===Qy.Light?"light":e===Qy.Dark?"dark":t(XWe)});'],
  ['derive palette tokens without changing stored Factory settings',
    'const Ske=F5e(q9c,mx,{mergeWithDefaults:L8r}),wke=fs(!1),kmu=fs(t=>{const e=t($H)==="dark"?Ur.Dark:Ur.Light;return eue({mode:e,settings:t(Ske)[e]})}),Xsi=fs(t=>t(wke)?e7r({settings:t(Ske)}):""),',
    'const Ske=F5e(q9c,mx,{mergeWithDefaults:L8r}),wke=fs(!1),factoryPortEffectiveAppearance=fs(t=>factoryPortOverlayAppearance(t(Ske),t(factoryPortThemeActive)?t(factoryPortThemeSnapshot):factoryPortThemeEmpty,mx)),kmu=fs(t=>{const e=t($H)==="dark"?Ur.Dark:Ur.Light;return eue({mode:e,settings:t(Ske)[e]})}),Xsi=fs(t=>{if(!t(wke))return"";const e=e7r({settings:t(factoryPortEffectiveAppearance)});return t(factoryPortGlassActive)?e+factoryPortGlassCss(t(factoryPortThemeSnapshot))+factoryPortNavigationGlassCss:e}),'],
  ['use temporary source background while following',
    'Zsi=fs(t=>t(wke)?z5t(t(kmu)):void 0),',
    'Zsi=fs(t=>{if(!t(wke))return;return t(factoryPortThemeActive)?t(factoryPortThemeSnapshot).background:z5t(t(kmu))}),'],
  ['sync Electron native theme using effective preference',
    'themePreference:i.get(JWe)',
    'themePreference:i.get(factoryPortThemeSource)'],
  ['observe effective theme source changes and sync native follow opt-in',
    'const r=i.sub($H,s),a=i.sub(JWe,s),l=i.sub(Zsi,s);return()=>{r(),a(),l()}',
    'const r=i.sub($H,s),a=i.sub(factoryPortThemeSource,s),l=i.sub(Zsi,s),g=()=>factoryPortSyncNativeFollow(i);g();const f=i.sub(factoryPortThemeFollow,g),factoryPortMenuStop=factoryPortMountApplicationMenu(window.electronAPI?.applicationMenu);return()=>{factoryPortMenuStop();r(),a(),l(),f(),factoryPortSyncNativeFollow(i,!1)}'],
  ['Appearance screen reads follow state and grows its memo cache',
    'function pCu(){const t=z.c(232),{t:e}=ce("settings"),[n,i]=cs(Ske),{theme:o,themePreference:s,setThemePreference:r}=bD(),',
    'function pCu(){const t=z.c(235),{t:e}=ce("settings"),[n,i]=cs(Ske),[factoryPortFollow,setFactoryPortFollow]=cs(factoryPortThemeFollow),[factoryPortState]=cs(factoryPortThemeSnapshot),{theme:o,themePreference:s,setThemePreference:r}=bD(),'],
  ['pass follow state into the theme editor',
    'let R;t[29]!==a||t[30]!==l||t[31]!==m||t[32]!==k?(R=c.jsx(iCu,{mode:a,onChange:k,onChoose:m,theme:l},a),t[29]=a,t[30]=l,t[31]=m,t[32]=k,t[33]=R):R=t[33];',
    'let R;t[29]!==a||t[30]!==l||t[31]!==m||t[32]!==k||t[232]!==factoryPortFollow||t[233]!==factoryPortState||t[234]!==setFactoryPortFollow?(R=c.jsx(iCu,{mode:a,onChange:k,onChoose:m,theme:l,factoryPortFollow,factoryPortState,setFactoryPortFollow},a),t[29]=a,t[30]=l,t[31]=m,t[32]=k,t[232]=factoryPortFollow,t[233]=factoryPortState,t[234]=setFactoryPortFollow,t[33]=R):R=t[33];'],
  ['theme editor accepts follow state and grows its memo cache',
    'function iCu(t){const e=z.c(206),{mode:n,onChange:i,onChoose:o,theme:s}=t,{t:r}=ce("settings"),',
    'function iCu(t){const e=z.c(211),{mode:n,onChange:i,onChoose:o,theme:s,factoryPortFollow,factoryPortState,setFactoryPortFollow}=t,{t:r}=ce("settings"),'],
  ['memoize the follow row from its three controlled props',
    'const{palette:b}=v;let C;if(e[11]!==n||e[12]!==s.preset){',
    'const{palette:b}=v;let factoryPortThemeRow;e[206]!==factoryPortFollow||e[207]!==factoryPortState||e[208]!==setFactoryPortFollow?(factoryPortThemeRow=factoryPortBuildThemeRow(factoryPortFollow,factoryPortState,setFactoryPortFollow),e[206]=factoryPortFollow,e[207]=factoryPortState,e[208]=setFactoryPortFollow,e[209]=factoryPortThemeRow):factoryPortThemeRow=e[209];let C;if(e[11]!==n||e[12]!==s.preset){'],
  ['place the follow row immediately before the preset row',
    'let ct;e[183]!==ee||e[184]!==Se||e[185]!==be||e[186]!==_e||e[187]!==Fe||e[188]!==Xe?(ct=c.jsxs($g,{children:[ee,te,Se,ve,be,we,_e,Ee,Fe,He,Xe]}),e[183]=ee,e[184]=Se,e[185]=be,e[186]=_e,e[187]=Fe,e[188]=Xe,e[189]=ct):ct=e[189];',
    'let ct;e[183]!==ee||e[184]!==Se||e[185]!==be||e[186]!==_e||e[187]!==Fe||e[188]!==Xe||e[210]!==factoryPortThemeRow?(ct=c.jsxs($g,{children:[factoryPortThemeRow,ee,te,Se,ve,be,we,_e,Ee,Fe,He,Xe]}),e[183]=ee,e[184]=Se,e[185]=be,e[186]=_e,e[187]=Fe,e[188]=Xe,e[210]=factoryPortThemeRow,e[189]=ct):ct=e[189];'],
  ['mark the real sidebar pane without changing its layout or interactions',
    'c.jsx(b7c,{$background:a,$borderRight:l,"data-testid":i',
    'c.jsx(b7c,{$background:a,$borderRight:l,"data-factory-port-sidebar-surface":!0,"data-testid":i'],
  ['mark the real title-bar painter without changing its native drag regions',
    'const j5l=J(Ue)`',
    'const j5l=J(Ue).attrs({"data-factory-port-titlebar-surface":!0})`'],
  ...sidebarFadeChanges,
  ...glassyNavigationChanges,
];

export const rendererHelperNames = [
  'factoryPortNormalizeTheme',
  'factoryPortFollowContrast',
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
