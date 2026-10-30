// Real BTf settings layout and real navigation components/styles. Only its
// router/catalog/feature/telemetry adapters are synthetic, in the test clone.
// The other variants reconstruct their pinned outer JSX with real primitives
// and the original CSS asset. No account or authenticated routing is exercised.
import assert from 'node:assert/strict';
import path from 'node:path';
import { saveDisposableScreenshot } from './application-menu-smoke.mjs';

export function navigationFixtureSource(renderer) {
  const start = renderer.indexOf('function BTf('), end = renderer.indexOf('function DTf(', start);
  assert.ok(start > 0 && end > start, 'pinned settings layout is available');
  const settings = renderer.slice(start, end);
  return `
const FactoryNavigationRoute=L.createContext(null);
function FactoryNavigationLink({to,onClick,children,...rest}){
 const route=L.useContext(FactoryNavigationRoute);
 return c.jsx("a",{...rest,href:to,onClick:event=>{event.preventDefault();onClick?.(event);route.navigate({to})},children});
}
const factoryNavigationItems=[
 {id:"general",label:"General",href:Qt.settings.general,sectionLabel:"ACCOUNT"},
 {id:"appearance",label:"Appearance",href:"/__navigation-smoke/appearance"},
 {id:"usage",label:"Usage",href:Qt.settings.usage??"/settings/usage"},
 {id:"support",label:"Support",href:"/__navigation-smoke/support"}
];
const FactorySettingsLayout=(()=>{
 const ake=()=>({items:factoryNavigationItems,sidebarItems:factoryNavigationItems,searchCatalog:[]});
 const $7o=()=>({isSearching:false,results:[]}),uo=()=>false,h0=()=>({}),dd=()=>{};
 const Sg=()=>L.useContext(FactoryNavigationRoute),ao=()=>L.useContext(FactoryNavigationRoute).navigate,bf=FactoryNavigationLink;
 return ${settings};
})();
function mountNavigation(){
 const parent=document.querySelector("[data-factory-port-sidebar-surface]");
 const oldPosition=parent.style.position,old=[...parent.children].map(node=>[node,node.style.visibility]);
 old.forEach(([node])=>{node.style.visibility="hidden"});parent.style.position="relative";
 const host=document.createElement("div");host.id="factory-navigation-fixture";
 host.style.cssText="position:absolute;inset:0";parent.append(host);
 const root=IKo.createRoot(host),savedQuery=store.get(TPt);store.set(TPt,"");
 function Fixture({variant}){
  const[path,navigateTo]=L.useState(Qt.settings.general);
  const navigate=L.useCallback(({to})=>navigateTo(to),[]);
  let content;
  if(variant==="settings")content=c.jsx(FactorySettingsLayout,{autoFocusSearch:false,sessionsReturnPath:"/__navigation-smoke/return"});
  else{
   const nav=c.jsx(EUl,{items:factoryNavigationItems,currentPath:path,linkComponent:FactoryNavigationLink});
   if(variant==="softwareFactory")content=c.jsx(G,{...Pm(),bg:w.bg.surface,"data-software-factory-nav-v2":true,direction:"column",height:"100%",style:{padding:16,boxSizing:"border-box"},children:nav});
   else if(variant==="evaluations")content=c.jsx(G,{...Pm(),direction:"column",height:"100%",padding:16,children:nav});
   else{
    const attrs=variant==="wiki"?{"data-wiki-nav-root-v2":""}:variant==="academy"?{"data-academy-nav-root-v2":""}:{"data-analytics-nav-root-v2":""};
    const inner=variant==="wiki"?c.jsx(Me,{"data-wiki-nav-pane-v2":"",style:{padding:16},children:nav}):nav;
    content=c.jsx(Me,{...attrs,style:{height:"100%",padding:variant==="wiki"?0:16,boxSizing:"border-box"},children:inner});
   }
  }
  return c.jsx(FactoryNavigationRoute.Provider,{value:{pathname:path,navigate},children:c.jsx(Vu,{style:{height:"100%",display:"flex",flexDirection:"column"},children:c.jsx(st,{...Pm(),"data-sidebar-overlay":true,"data-navigation-route":path,backgroundColor:"sidebar-bg",direction:"column",height:"100%",children:content})})});
 }
 return{
  render(variant){root.render(c.jsx(Fixture,{variant},variant))},
  cleanup(){root.unmount();host.remove();parent.style.position=oldPosition;old.forEach(([node,value])=>{node.style.visibility=value});store.set(TPt,savedQuery)}
 };
}
`;
}

export async function runNavigationSmoke({ app, page, output, mode, expectedAlpha = 89 }) {
  const baseline = process.env.FACTORY_NAVIGATION_BASELINE === '1';
  const result = { baseline, expectedAlpha, variants: {} };
  const host = page.locator('#factory-navigation-fixture');
  await page.evaluate(() => { window.__factoryNavigationFixture = window.__factoryThemeSmoke.mountNavigation(); });
  async function alphaAt(points) {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    return app.evaluate(async ({ BrowserWindow }, points) => {
      const image = await BrowserWindow.getAllWindows()[0].webContents.capturePage();
      const { width } = image.getSize(), data = image.toBitmap();
      return points.map(([x, y]) => data[(Math.floor(y) * width + Math.floor(x)) * 4 + 3]);
    }, points);
  }
  async function controlAlpha(locator) {
    const box = await locator.boundingBox(); assert.ok(box);
    return (await alphaAt([[box.x + 12, box.y + 3]]))[0];
  }
  try {
    for (const variant of ['settings', 'analytics', 'analytics2', 'wiki', 'academy', 'softwareFactory', 'evaluations']) {
      await page.evaluate(variant => window.__factoryNavigationFixture.render(variant), variant);
      const selected = host.getByRole('link', { name: 'General', exact: true });
      await selected.waitFor({ state: 'visible' });
      await page.mouse.move(400, 100);
      const box = await host.boundingBox();
      const blank = await alphaAt([[box.x + 12, box.y + box.height - 100],
        [box.x + 100, box.y + box.height - 100], [box.x + 186, box.y + 330]]);
      if (!baseline) assert.ok(blank.every(value => Math.abs(value - expectedAlpha) <= 3),
        `${variant}: navigation painters must not cover or multiply the shared sidebar tint: ${blank}`);
      const selectedAlpha = await controlAlpha(selected);
      assert.equal(selectedAlpha, 255, 'active navigation keeps a solid highlight');
      const entry = { blank, selectedAlpha };
      if (variant === 'settings') {
        const search = host.getByRole('searchbox', { name: 'Search settings', exact: true });
        entry.searchAlpha = await controlAlpha(search);
        assert.equal(entry.searchAlpha, 255, 'search input stays solid');
        await search.fill('theme');
        assert.equal(await search.inputValue(), 'theme');
        await host.getByRole('link', { name: 'Appearance', exact: true }).click();
        await page.waitForFunction(() => document.querySelector('#factory-navigation-fixture [data-navigation-route]').getAttribute('data-navigation-route').includes('appearance'));
        assert.equal(await search.inputValue(), '', 'real settings click clears the search atom');
        await host.getByRole('button', { name: 'Back to App', exact: true }).click();
        await page.waitForFunction(() => document.querySelector('#factory-navigation-fixture [data-navigation-route]').getAttribute('data-navigation-route') === '/__navigation-smoke/return');
        entry.typingNavigationAndBack = true;
      }
      await page.mouse.move(400, 100);
      await saveDisposableScreenshot(app, page, path.join(output, `navigation-${mode}-${variant}.png`));
      result.variants[variant] = entry;
    }
    return result;
  } finally {
    await page.evaluate(() => { window.__factoryNavigationFixture.cleanup(); delete window.__factoryNavigationFixture; });
  }
}
