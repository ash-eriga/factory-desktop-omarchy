// Nested navigation shells paint their own opaque surface over the shared
// sidebar tint. Clear only those painters, never their control/panel tokens.
// This stylesheet is appended only inside the existing accepted-Glassy gate.
export const glassyNavigationCss = `
[data-sidebar-visible] [data-factory-port-navigation-surface],
[data-sidebar-visible] [data-analytics-nav-root-v2],
[data-sidebar-visible] [data-wiki-nav-pane-v2],
[data-sidebar-visible] [data-academy-nav-root-v2],
[data-sidebar-visible] [data-software-factory-nav-v2] {
  background-color: transparent !important;
}
`;

export const glassyNavigationChanges = [
  ['identify the settings navigation painter without changing settings behavior',
    'const mUl=J.div`',
    'const mUl=J.div.attrs({"data-factory-port-navigation-surface":!0})`'],
];
