// Test-only reconstruction of the structural painters observed in the real
// authenticated shell. lt/it/pv and the frame/backdrop CSS are upstream code.
// The unthemed backdrop deliberately inherits a locally opaque page token,
// matching the real profile's legacy outer scope, not the inner pv() scope.
export function glassyShellFixtureSource(prefix) {
  return `
function NativeContent({children,style}){
  return c.jsx(lt,{
    id:"${prefix}-backdrop","data-window-backdrop-v2":!0,
    style:{height:"100%",...style,"--core-v2-bg-page":"#060b1e"},
    children:c.jsxs(lt,{style:{display:"flex",height:"100%"},children:[
    c.jsx(lt,{"data-sidebar-visible":!0,style:{width:200,flexShrink:0,height:"100%"},children:
      c.jsx(KYn,{paneProps:{...pv(),...y1o},children:c.jsxs(c.Fragment,{children:[
        c.jsx("span",{"data-sidebar-nav":!0,id:"${prefix}-sidebar-label",children:"Projects"}),
        c.jsx("button",{"data-sf-workstream-row":!0,"data-active":!0,id:"${prefix}-sidebar-selected",children:"Selected session"})
      ]})})
    }),
    c.jsxs(it,{
      ...pv(),id:"${prefix}-native-content","data-windows-content-surface":!0,
      bg:"sidebar-bg",direction:"column",height:"100%",style:{flex:1,minWidth:0},
      children:[
      c.jsx(lt,{...pv(),"data-windows-title-bar-v2":!0,style:{height:32,flexShrink:0},children:
        c.jsx(bkl,{$isWindowTitleBar:!0,$titleBarBackground:y1o.background,height:32,
          children:c.jsx("span",{id:"${prefix}-titlebar-label",children:"File"})})
      }),
      c.jsx(lt,{
        id:"${prefix}-frame","data-windows-content-frame":!0,
        borderTopLeftRadius:4,flex:1,minHeight:0,pl:2,pt:0,position:"relative",
        children
      })]
    })]})
  })
}
`;
}
