# Launch: signed-out window

The app opens a usable window with no account: the first thing any user sees
after install. This is also the harness's gate — if this fails, nothing else
in the map can run.

## Sub-features

- Window opens, renders the sign-in prompt, no renderer errors.
- Security posture: Chromium sandbox on, context isolation on, node
  integration off, no `--no-sandbox` switch.
- The injected menu-bar hiding: the menu bar is not visible, and pressing
  F10 triggers exactly one menu popup (exercised through real
  `before-input-event` keyboard handling).
- Light and dark theme source switches both render.

## How to get to it (user POV)

Open **Factory Droid Desktop** from the app launcher, or run
`factory-droid-desktop`. A signed-out install lands directly on the sign-in
screen.

## Driving it with Playwright (via tests/gui-smoke.mjs)

```bash
. .agents/skills/verify-factory-droid-desktop/drives/setup-env.sh
drives=".agents/skills/verify-factory-droid-desktop/drives"
xvfb-run -a "$drives/isolated-node.sh" "$FACTORY_VERIFY_WORK" \
  node tests/gui-smoke.mjs "$PWD/dist/factory-droid-desktop-1.3.0" "$PWD/build/gui-smoke"
# on a real desktop, drop the xvfb-run prefix
```

The script launches the real `factory-desktop` executable with an isolated
temp profile and a dead-end proxy, waits for the `Sign in` body text, asserts
the security posture and the F10 behavior, toggles
`nativeTheme.themeSource`, and closes the app.

This skill also ships its own drive of this journey, including the evidence
write-up:

```bash
xvfb-run -a "$drives/isolated-node.sh" "$FACTORY_VERIFY_WORK" \
  "$drives/signed-out-journey.mjs" dist/factory-droid-desktop-1.3.0 build/skill-journey
```

It checks the sign-in screen, the three real entry buttons (Sign up, Log in,
Sign in to Factory Private), the F10 popup firing exactly once through real
input events, and writes `journey.json` plus three screenshots.

## Proven end state

Exit code 0 plus `build/gui-smoke/report.json` containing
`version: "1.3.0"`, `sandbox: true`, `contextIsolation: true`,
`nodeIntegration: false`, `menuBarVisible: false`, `rendererErrors: []`, and
`window.png` / `window-dark.png` / `window-light.png` showing the sign-in
screen.

## Gotchas

- `FACTORY_PLAYWRIGHT_MODULE` must be a module whose ESM import exposes
  `_electron` as a named export. Playwright's CJS entry does not, so use the
  ESM shim described in the parent `SKILL.md`.
- Without a display the launch still needs Xvfb on headless hosts; the
  script forwards `DISPLAY`.
- A window that opens but logs a `pageerror` is a failure; read
  `rendererErrors`, not just the screenshot.
