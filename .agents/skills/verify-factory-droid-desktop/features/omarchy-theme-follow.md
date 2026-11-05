# Omarchy theme follow

When the user enables **Settings → Appearance → Follow Omarchy theme**, the
app reads the Omarchy palette (`~/.local/state/omarchy/current/theme/colors.toml`
plus `theme.generation`) and applies background/foreground/accent, with the
Glassy tint and navigation transparency governed by the window-mode toggle
markers. The bridge is read-only: it never executes Lua and never writes
outside whitelisted state files.

## Sub-features

- Palette read: mode, background, foreground, accent, revision from the
  fixture `colors.toml`.
- Follow opt-in through the preload's `setOmarchyFollow` channel.
- Glass alpha proven from real `capturePage` bitmaps (not
  `getBackgroundColor()`, which reports opaque black regardless).
- Window mode (glassy/opaque) via marker files only; the compositor is never
  reconfigured and no global Omarchy setting is touched.

## How to get to it (user POV)

Settings → Appearance → Follow Omarchy theme. On the real desktop the
palette changes when the Omarchy theme changes; the app follows.

## Driving it with Playwright (via tests/theme-smoke.mjs)

```bash
. .agents/skills/verify-factory-droid-desktop/drives/setup-env.sh
drives=".agents/skills/verify-factory-droid-desktop/drives"
xvfb-run -a "$drives/isolated-node.sh" "$FACTORY_VERIFY_WORK" \
  node tests/theme-smoke.mjs "$PWD/dist/factory-droid-desktop-1.3.0" "$PWD/build/theme-smoke"
# on a real desktop, drop the xvfb-run prefix
```

The script clones the bundle into a disposable temp dir, instruments the
clone's renderer, mounts the real production components (`gJu`, `Hrf`, the
appearance atoms) from a fixture root, seeds fixture palettes (dark then
light) under the isolated HOME's omarchy state path, and measures applied
alpha and follow behavior.

## Proven end state

Exit code 0 and evidence under `build/theme-smoke/`: screenshots/alpha
bitmaps showing the fixture palette applied (dark `#101019`, light
`#e4f0ff`), with the follow row reading the fixture revisions.

## Gotchas

- **Sign-in is a prerequisite; this feature cannot pass signed-out.** The
  signed-out window stays opaque and light by upstream design, and the dark
  fixture has no effect on it (confirmed independently on the Omarchy
  target: the fixture-palette window "stays light"). A signed-out drive of
  this feature is expected to FAIL on the palette assertion; record that
  failure and the reason. Never weaken the journey to make it pass. To prove
  follow behavior you need an authenticated session, which this skill's
  airgapped harness cannot provide — treat it as a Layer 4 manual check per
  `docs/validation.md`.
- The glassy in-window application menu (`show()` in the menu bridge) opens
  only on a glassy window; on a plain signed-out window the same call is a
  no-op. Do not interpret that as a broken menu.
- The script never touches a real `~/.config/omarchy` or
  `~/.local/state/omarchy`; everything lives in the temp HOME.
