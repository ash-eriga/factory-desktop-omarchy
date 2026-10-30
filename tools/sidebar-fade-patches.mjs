// Fade the scroll content itself, not a painted/blurred rectangle over glass.
// Reuse yQe's existing scroll/resize/mutation observer; other scroll areas
// keep their upstream rendering and behavior.
export function factoryPortUpdateSidebarMask(viewport, offset, range) {
  if (!viewport.closest('[data-factory-port-sidebar-scroll]')) return;
  const cap = Math.min(40, viewport.clientHeight / 4);
  viewport.style.setProperty('--factory-port-sidebar-top-fade',
    `${Math.min(cap, Math.max(0, offset))}px`);
  viewport.style.setProperty('--factory-port-sidebar-bottom-fade',
    `${Math.min(cap, Math.max(0, range - offset))}px`);
}

export const sidebarMaskCss = `
  @supports (mask-image: linear-gradient(#000, #000)) {
    & [data-radix-scroll-area-viewport] {
      --factory-port-sidebar-top-fade: 0px;
      --factory-port-sidebar-bottom-fade: 0px;
      mask-image: linear-gradient(to bottom,
        transparent 0px,
        rgba(0,0,0,.104) calc(var(--factory-port-sidebar-top-fade) * .2),
        rgba(0,0,0,.352) calc(var(--factory-port-sidebar-top-fade) * .4),
        rgba(0,0,0,.648) calc(var(--factory-port-sidebar-top-fade) * .6),
        rgba(0,0,0,.896) calc(var(--factory-port-sidebar-top-fade) * .8),
        #000 var(--factory-port-sidebar-top-fade),
        #000 calc(100% - var(--factory-port-sidebar-bottom-fade)),
        rgba(0,0,0,.896) calc(100% - var(--factory-port-sidebar-bottom-fade) * .8),
        rgba(0,0,0,.648) calc(100% - var(--factory-port-sidebar-bottom-fade) * .6),
        rgba(0,0,0,.352) calc(100% - var(--factory-port-sidebar-bottom-fade) * .4),
        rgba(0,0,0,.104) calc(100% - var(--factory-port-sidebar-bottom-fade) * .2),
        transparent 100%);
      scroll-padding-block: 40px;
    }
    & [data-testid="session-list-top-fade"],
    & [data-testid="session-list-top-fade-color"],
    & [data-testid="session-list-bottom-fade"],
    & [data-testid="session-list-bottom-fade-color"] {
      display: none;
    }
  }
`;

export const sidebarFadeChanges = [
  // The marker belongs to the session-list scroll root, the styled root the
  // session wrapper renders. 1.0.0 has a second root with the same styled
  // base (`s8i`) shared with unrelated panels, so the marker must sit on
  // `EZc`, the root `RZc` renders for the session list.
  ['mask only the session-list viewport instead of painting rectangular edge overlays',
    'EZc=X(krt)`',
    `EZc=X(krt).attrs({"data-factory-port-sidebar-scroll":!0})\`${sidebarMaskCss}`],
  ['reuse upstream edge observers for continuous sidebar mask depths',
    'k={end:_<T-GLn,start:_>GLn};p(R=>',
    'k={end:_<T-GLn,start:_>GLn};if(!v)factoryPortUpdateSidebarMask(y,_,T);p(R=>'],
];
