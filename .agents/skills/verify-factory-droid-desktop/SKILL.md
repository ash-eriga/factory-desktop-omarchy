---
name: verify-factory-droid-desktop
description: "Drive and verify the Factory Droid Desktop Omarchy port (Electron desktop app) the way a user does: signed-out window, Droid daemon, Omarchy theme follow, startup performance. Use for /verify-factory-droid-desktop, 'prove the port works', or before/after measurements of the port."
---

# Verify Factory Droid Desktop

Project-local verification for the Omarchy port of Factory Desktop
(Electron 42, x86_64 Linux). Everything here drives the real built bundle
under `dist/factory-droid-desktop-<version>` with disposable, isolated
profiles. No check signs in, no check touches a real user profile, and the
offline suite (`npm test`) is a prerequisite, not a substitute.

Proof scope, stated up front: **signed-out only**. The proven user journey is
launch → usable sign-in screen → real keyboard path → clean shutdown.
Authenticated behavior (sign-in, relay, billing, theme follow) is out of
scope and recorded as pending in the feature map, never approximated.

## Isolation boundary (read before any drive)

Ambient shells can hold live credentials (`FACTORY_API_KEY` and `GH_TOKEN`
were present in the ambient environment on the verification machine on
2026-11-05). Every execution of node or of any vendor binary therefore goes
through `drives/isolated-node.sh`, which runs the child under `env -i` with
an explicit allowlist. Ambient credentials can never cross it. The wrapper
also records ambient secret PRESENCE BOOLEANS (never values) to stderr, so
every run log proves what the ambient shell held. Bare execution of
`factory-desktop`, `droid`, or a smoke script outside this wrapper is a
harness violation, not a shortcut.

Set the tool environment once per shell with the reproducible setup script:

```bash
. .agents/skills/verify-factory-droid-desktop/drives/setup-env.sh
# exports FACTORY_VERIFY_WORK, FACTORY_PLAYWRIGHT_MODULE (the ESM shim),
# FACTORY_OS_RELEASE_STANDIN — all under one WORK dir outside the repo
```

## Host requirements and the Arch gate

- The repo's own suite (`npm test`) runs anywhere; the bundle build does not:
  `tools/build.mjs` refuses any host whose `/etc/os-release` is not Arch-based
  (`hostSupported` in `tools/common.mjs`).
- On an Arch/Omarchy host, build normally: `npm run build`. See
  `docs/architecture.md` for what the build downloads and patches.
- On a non-Arch stand-in host (for example the Ubuntu verification machine),
  do NOT edit the repo to bypass the gate. Build inside an ephemeral
  user+mount namespace that bind-mounts an Arch-like os-release over
  `/etc/os-release` for that one process only:

  ```bash
  WORK="$FACTORY_VERIFY_WORK"   # from setup-env.sh
  unshare --user --map-user="$(id -u)" --map-group="$(id -g)" --keep-caps -m \
    sh -c 'mount --bind "$WORK/arch-os-release" /etc/os-release && npm run build'
  ```

  Build prerequisites (Ubuntu names): `pkg-config libsecret-1-dev` (keytar
  rebuild), `gcc make python3` (node-gyp), `rsvg-convert` (brand assets).
  Label every artifact from a stand-in host as stand-in evidence; stand-in
  numbers are harness-only and each machine compares only against itself.

## Launch

There is no server to keep alive. Build the bundle once, then start each
drive as its own short-lived Electron instance through the harness. Every
drive below creates its own isolated temp HOME, XDG dirs,
`FACTORY_HOME_OVERRIDE`, keyring-off flag (`FACTORY_DISABLE_KEYRING=1`) and a
dead-end proxy (`http://127.0.0.1:9`), so instances never touch a real
profile and never reach the network.

```bash
# Build (once per checkout; ~10 min on 4 CPUs, needs network for the vendor payload)
npm run build
# The finished bundle:
test -f dist/factory-droid-desktop-1.3.0/factory-desktop && echo bundle-ok
```

Playwright is not a repo dependency. `setup-env.sh` installs playwright-core
under `FACTORY_VERIFY_WORK` and exports `FACTORY_PLAYWRIGHT_MODULE` pointing
at the ESM shim `pw-esm.mjs` (a directory or the CJS entry will NOT work:
the smoke scripts do a named `import { _electron }`). The scripts fall back
to `playwright` when the variable is unset.

On a headless host, wrap GUI drives in Xvfb (the scripts forward `DISPLAY`):
prefix with `xvfb-run -a`. Ready signal: the script prints one JSON report
line to stdout and exits 0.

## Doctor

Read-only checks that answer "is this instance worth driving?". No instance
is started, nothing is killed, and process checks never kill by name or by
generic pattern match (a `pgrep factory-desktop` hit could be the user's own
running instance — leave it alone).

```bash
test -f dist/factory-droid-desktop-1.3.0/factory-desktop && echo bundle-ok
# Version probe, ISOLATED (the CLI is the vendor binary; it never runs bare):
drives=".agents/skills/verify-factory-droid-desktop/drives"
"$drives/isolated-node.sh" "$FACTORY_VERIFY_WORK" \
  dist/factory-droid-desktop-1.3.0/resources/bin/droid --version   # expect: 1.3.0
node --test tests/recipe.test.mjs            # recipe identity (offline)
node --test benchmarks/*.test.mjs            # benchmark unit gates: CPU-percent factor, PSS availability (offline, no repo deps)
```

Leftover-process check is recorded-run based: every harness drive tears down
its own instance in a `finally` block and its JSON report records success.
If a drive fails, note the PID Playwright reports in its error log and,
only if that exact PID is still alive afterward and is provably the one the
harness spawned, kill that recorded PID — never a name-matched or guessed
PID. Evidence under `build/` survives cleanup by design.

## Drive

The exact reproducible invocation of this skill is one command:

```bash
.agents/skills/verify-factory-droid-desktop/drives/verify.sh \
  [bundleDir] [outDir]
```

It runs the tool setup, the read-only doctor, the skill's own signed-out
journey (through the isolation wrapper, in Xvfb when no display exists), and
the safe recorded-PID cleanup. Defaults: the bundle for the pinned version,
evidence to `build/skill-journey/`.

The individual drives behind it (all run from the repo root, through the
isolation wrapper; never part of `npm test`):

```bash
drives=".agents/skills/verify-factory-droid-desktop/drives"
B=dist/factory-droid-desktop-1.3.0

# THE skill's own drive: the signed-out launch journey (proven; see Helpers)
xvfb-run -a "$drives/isolated-node.sh" "$FACTORY_VERIFY_WORK" \
  "$drives/signed-out-journey.mjs" "$B" build/skill-journey

# Signed-out window regression: security prefs, F10 handling, dark/light screenshots
xvfb-run -a "$drives/isolated-node.sh" "$FACTORY_VERIFY_WORK" \
  node tests/gui-smoke.mjs "$PWD/$B" "$PWD/build/gui-smoke"

# Droid daemon over IPC regression: ready message, clean shutdown (no display)
"$drives/isolated-node.sh" "$FACTORY_VERIFY_WORK" \
  node tests/ipc-smoke.mjs "$PWD/$B"
# NOTE: ipc-smoke now allowlists the daemon child environment in the repo
# (daemonEnvironment), so ambient credentials never reach it. The env -i
# wrapper above stays mandatory defense-in-depth for every drive.

# Theme follow regression: fixture palettes, glass alpha via capturePage
# bitmaps, window-mode toggles as markers (instrumented disposable clone).
# This is a REGRESSION TEST on real production components, not a user
# journey; the signed-out window cannot show theme follow at all.
xvfb-run -a "$drives/isolated-node.sh" "$FACTORY_VERIFY_WORK" \
  node tests/theme-smoke.mjs "$PWD/$B" "$PWD/build/theme-smoke"

# Appearance menu layout regression (instrumented disposable clone)
xvfb-run -a "$drives/isolated-node.sh" "$FACTORY_VERIFY_WORK" \
  node tests/menu-smoke.mjs "$PWD/$B" "$PWD/build/menu-smoke"

# Startup/interaction performance regression (airgapped)
xvfb-run -a "$drives/isolated-node.sh" "$FACTORY_VERIFY_WORK" \
  node tests/performance-smoke.mjs "$PWD/$B" --seconds 20
```

Stable handles are the scripts themselves; inside Playwright code, prefer
the same stable handles they use: the `Sign in` body text, `app.evaluate`
over Electron APIs, and `sendInputEvent` keystrokes. Do not drive by pixel
coordinates. Two environment facts to know before driving:

- the glassy in-window application menu opens only on a glassy window, so a
  plain signed-out window has no clickable in-renderer menu; the F10 popup
  path (asserted through real input events) is the menu surface there;
- Omarchy theme follow cannot be proven signed-out: the palette fixture has
  no effect on the signed-out window (it stays light and opaque; confirmed
  on the Omarchy target as well). See `features/omarchy-theme-follow.md`.

On the Omarchy workstation, never drive the running user instance; any
second instance there needs orchestrator approval and an empty temp
`--user-data-dir`.

## Evidence

Each drive writes to its own output dir (second argument) and survives the
run: `journey.json` + three screenshots (the skill's own journey),
`report.json` with versions, window/menu facts, security prefs and renderer
errors (gui-smoke), and the performance script's JSON summaries. Proof
standards:

- The proven user path is the signed-out launch journey. The instrumented
  theme/menu smokes are regression tests of production components in
  disposable clones — label them as regressions, never as user journeys.
  Authenticated theme follow stays pending until a signed-in run exists.
- Read the report's `rendererErrors` and the exit code, not just the final
  screenshot; a window that opens with a pageerror is a failure.
- For performance numbers, follow `benchmarks/measure-runtime.mjs`
  (per-process-tree RSS/CPU sampling) and the benchmark checklist: name the
  limiter, run counts, and spread with every number. Never mix machines or
  app states in one claim, and never compare an Ubuntu stand-in number with
  an Omarchy target number; each machine compares only against itself.
- Measurement honesty: PSS is read per process from `/proc/<pid>/smaps_rollup`
  and reported as available, partial, or unavailable with the kernel's own
  reason (EACCES when a process has cleared its dumpable flag) — never a
  fake 0. A whole-tree PSS total is only a number when every idle sweep
  read the whole tree; the shakedown on the stand-in host collected it
  (Playwright-spawned Electron answers the rollup). The helper always
  reports the summed tree RSS with its shared-pages double-counting caveat
  alongside.

## Cleanup

The drives tear down their own temp profiles in `finally` blocks. For a run
that left its instance behind, use `drives/cleanup-run.sh <runOutputDir>`:
it reads the run's own `journey.json` `mainPid`, then kills that PID only
after re-verifying from `/proc` that it is alive, owned by this user, the
same `factory-desktop` binary, and running from a temp `factory-*` profile.
It never kills by name, never scans for candidates, and refuses to touch
anything that fails a check. Evidence dirs under `build/` are gitignored and
survive cleanup by design. If a drive fails, fix and rerun; a cleanup that
eats the proof fails the skill.

## Helpers

Shipped by this skill (all executable, all invoked as shown above):

- `drives/setup-env.sh` — reproducible tool setup outside the repo
  (os-release stand-in, ESM shim, playwright-core); prints the exports.
- `drives/isolated-node.sh` — the `env -i` isolation boundary every
  execution goes through; logs ambient secret presence booleans.
- `drives/verify.sh` — the exact skill invocation: setup, doctor, journey,
  cleanup, in one command.
- `drives/cleanup-run.sh` — safe recorded-PID-only cleanup for a run output
  dir (verifies ownership, binary, and temp profile from `/proc` before
  acting).
- `drives/signed-out-journey.mjs` — the skill's own drive, executed end to
  end as the skill's proof; evidence in `build/skill-journey/`.

Repo helpers the skill drives: `tests/gui-smoke.mjs`, `tests/ipc-smoke.mjs`,
`tests/theme-smoke.mjs`, `tests/menu-smoke.mjs`,
`tests/performance-smoke.mjs` (all shown in Drive). The baseline measurement
helper is `benchmarks/measure-runtime.mjs`:

```bash
xvfb-run -a "$drives/isolated-node.sh" "$FACTORY_VERIFY_WORK" \
  node benchmarks/measure-runtime.mjs dist/factory-droid-desktop-1.3.0 \
  build/baseline-standin --runs 5 --idle-seconds 30
```

It launches the bundle per run in a fresh temp profile, samples the whole
process tree from `/proc` at 1 Hz, records ambient secret presence booleans,
and writes `samples.csv` plus `summary.json` (per-run and aggregate
median/range for startup, idle CPU over the measured first-to-last-sweep
span, RSS; PSS with status and failure counts, null total when the tree
was not fully readable). It measures; it never changes the bundle.
