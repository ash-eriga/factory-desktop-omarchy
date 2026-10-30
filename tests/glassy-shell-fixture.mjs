// Test-only reconstruction of the structural painters observed in the real
// authenticated shell. st/$e/Pm and the frame/backdrop CSS are upstream code.
// The unthemed backdrop deliberately inherits a locally opaque page token,
// matching the real profile's legacy outer scope, not the inner Om() scope.
export function glassyShellFixtureSource(prefix) {
  return `
function NativeContent({children,style}){
  return c.jsx(st,{
    id:"${prefix}-backdrop","data-window-backdrop-v2":!0,
    style:{height:"100%",...style,"--core-v2-bg-page":"#060b1e"},
    children:c.jsxs(st,{style:{display:"flex",height:"100%"},children:[
    c.jsx(st,{"data-sidebar-visible":!0,style:{width:200,flexShrink:0,height:"100%"},children:
      c.jsx(mZn,{paneProps:{...Pm(),...fbo},children:c.jsxs(L.Fragment,{children:[
        c.jsx("span",{"data-sidebar-nav":!0,id:"${prefix}-sidebar-label",children:"Projects"}),
        c.jsx("button",{"data-sf-workstream-row":!0,"data-active":!0,id:"${prefix}-sidebar-selected",children:"Selected session"})
      ]})})
    }),
    c.jsxs($e,{
      ...Om(),id:"${prefix}-native-content","data-windows-content-surface":!0,
      bg:"sidebar-bg",direction:"column",height:"100%",style:{flex:1,minWidth:0},
      children:[
      c.jsx(st,{...Om(),"data-windows-title-bar-v2":!0,style:{height:32,flexShrink:0},children:
        c.jsx(mLl,{$isWindowTitleBar:!0,$titleBarBackground:fbo.background,height:32,
          children:c.jsx("span",{id:"${prefix}-titlebar-label",children:"File"})})
      }),
      c.jsx(st,{
        id:"${prefix}-frame","data-windows-content-frame":!0,
        borderTopLeftRadius:4,flex:1,minHeight:0,pl:2,pt:0,position:"relative",
        children
      })]
    })]})
  })
}
`;
}
