# Droid daemon over IPC

The bundled Droid CLI (`resources/bin/droid`) starts in IPC daemon mode and
reports the same ready message the vendor lifecycle waits for
(`{"type":"factory.daemon.ready"}`), then shuts down cleanly on SIGTERM.
This is the app's heavy backend; it runs with no display and no window.

## Sub-features

- Daemon reaches ready under an isolated `FACTORY_HOME`.
- Clean SIGTERM shutdown (code 0). A clean exit before ready is a failure.

## How to get to it (user POV)

Not directly reachable by a user; the app's main process spawns the daemon
when a session starts. Verification drives the same binary and the same
ready message directly.

## Driving it with the repo's smoke script

```bash
. .agents/skills/verify-factory-droid-desktop/drives/setup-env.sh
drives=".agents/skills/verify-factory-droid-desktop/drives"
"$drives/isolated-node.sh" "$FACTORY_VERIFY_WORK" \
  node tests/ipc-smoke.mjs "$PWD/dist/factory-droid-desktop-1.3.0"
```

No display needed. The script spawns the daemon with an isolated temp home
(`HOME`, `XDG_*`, `FACTORY_HOME_OVERRIDE`), watches the IPC channel for the
ready type, then SIGTERMs it.

## Gotchas

- **Env propagation:** the script's `nodeSpawn` spreads the ambient
  environment into the daemon child, with no proxy airgap. Drive it only
  through `isolated-node.sh` (env -i allowlist), which caps the inherited
  environment. Reported to the orchestrator on 2026-11-05 for a repo-side
  fix; until then the wrapper is the boundary, not the script.

## Proven end state

`IPC smoke check passed: ready received and daemon shut down cleanly
(code=0)` on stdout, exit code 0.

## Gotchas

- Timeout is 120 seconds by default (second argument). A machine under heavy
  load can need a longer timeout; do not raise it silently in a claim.
- The daemon writes nothing outside its temp home; never point it at a real
  `~/.factory`.
