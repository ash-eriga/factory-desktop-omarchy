# Startup performance profile

How long the signed-out window takes to become usable, what the network
tries during startup (it must be nothing but airgapped origins in this
harness), and where the process tree spends resources while idle. This is
the harness that produces the port's "before" numbers for the Rust + GPUI
comparison.

## Sub-features

- Startup timing: launch to rendered window, phase-tagged.
- Idle resource use: process-tree RSS/PSS and CPU time delta over a fixed
  idle interval.
- Network accounting: requests grouped by phase/origin/status; the smoke is
  airgapped, so unexpected origins are failures.

## How to get to it (user POV)

Launch the app from cold and wait. Nothing is clicked; signed-out idle state.

## Driving it

Startup and network, via the repo's script (needs the ESM shim from the
parent `SKILL.md`):

```bash
export FACTORY_PLAYWRIGHT_MODULE=/home/factory-user/verify-tools/pw-esm.mjs
node tests/performance-smoke.mjs "$PWD/dist/factory-droid-desktop-1.3.0" --seconds 20
# headless host: prefix with `xvfb-run -a`
```

Whole-tree RSS/CPU baseline, via the measurement helper (implements the
measurement contract: 5 fresh-process runs, median + range, summed tree RSS
with its double-counting caveat, PSS per process with status and the
kernel's own reason when a rollup is refused (total null, never a fake 0),
CPU as % of one core over the measured ≥30 s idle-window span, daemon
counted, raw samples and hashes saved, ambient secret presence booleans
recorded):

```bash
drives=".agents/skills/verify-factory-droid-desktop/drives"
xvfb-run -a "$drives/isolated-node.sh" "$FACTORY_VERIFY_WORK" \
  node benchmarks/measure-runtime.mjs dist/factory-droid-desktop-1.3.0 \
  build/baseline-standin --runs 5 --idle-seconds 30
# on a real desktop, run without xvfb-run; the helper uses the ambient DISPLAY
```

## Proven end state

Exit code 0; `build/baseline-standin/summary.json` with per-run medians and
ranges and `samples.csv` with raw per-second samples; the run record names
the bundle hash, the git commit, and the exact command.

## Gotchas

- Headless Xvfb numbers are stand-in evidence. Target-machine claims (Omarchy
  workstation, real compositor, GTX 1060 render path) must come from the
  runtime agent running this same helper there, never mixed with stand-in
  numbers.
- The target machine is under memory pressure; an idle-interval measurement
  taken while something else compiles measures the machine, not the app.
- Startup is reported separately from idle; never average them.
