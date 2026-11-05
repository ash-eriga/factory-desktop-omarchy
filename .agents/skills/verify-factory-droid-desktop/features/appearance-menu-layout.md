# Appearance menu layout

The Appearance settings page renders the port's own controls: the Omarchy
follow row (`factoryPortBuildThemeRow`), the glass CSS controls
(`factoryPortGlassCss`, `factoryPortGlassCssActive`), and the font-smoothing
entry, inside the real appearance components (`tAu`, `z0u`) of the
instrumented bundle.

## Sub-features

- Follow row present and wired to the native `setOmarchyFollow` opt-in.
- Glass controls render and toggle their CSS on the real page.
- The layout survives the real app provider set (atoms, router, auth
  context).

## How to get to it (user POV)

Settings → Appearance. The controls appear below upstream's own appearance
options.

## Driving it with Playwright (via tests/menu-smoke.mjs)

```bash
. .agents/skills/verify-factory-droid-desktop/drives/setup-env.sh
drives=".agents/skills/verify-factory-droid-desktop/drives"
xvfb-run -a "$drives/isolated-node.sh" "$FACTORY_VERIFY_WORK" \
  node tests/menu-smoke.mjs "$PWD/dist/factory-droid-desktop-1.3.0" "$PWD/build/menu-smoke"
# on a real desktop, drop the xvfb-run prefix
```

The script extracts the bundle's renderer ASAR into a temp clone, asserts
every port symbol is present exactly once, captures the real auth context,
mounts the real Appearance page in the app's provider environment, and
screenshots the rendered controls.

## Proven end state

Exit code 0 plus screenshots under `build/menu-smoke-1.3.0/` showing the
Appearance page with the port's controls rendered and functional.

## Gotchas

- The clone is instrumented test scaffolding only; production code is never
  modified on disk. Never run the instrumented clone outside the temp dir.
- Symbol anchors (`tAu`, `z0u`, `gJu`…) are minified upstream names pinned to
  the 1.3.0 payload; a changed vendor release needs the anchors reviewed
  before this smoke is meaningful.
