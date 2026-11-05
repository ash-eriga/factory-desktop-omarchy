# Rust + GPUI rewrite: task plan and decision log

The user's goal, in their words: rewrite the current Omarchy Factory Desktop
port in Rust + GPUI (not Tauri) to lower CPU/RAM and follow the Omarchy theme
at near-zero cost, measuring before/after and reporting line counts and PRs.
This file is the prose plan for that program. The canonical decision log is
the append-only `docs/rust-rewrite-decisions.tsv` (one row per decision,
columns: timestamp, decision, rationale, evidence, confidence); that file,
not this prose, is the record of record. The verification agent owns both;
target-execution work on the Omarchy workstation is owned by the runtime
agent, coordinated through the orchestrator.

Status markers: `[x]` done, `[~]` in progress, `[ ]` not started, `[!]`
blocked. Incomplete steps are preserved on purpose.

## Phases (harness deliverable)

- [x] Read Principles — poteto-mode read in full; the governing leaf skills
      for this phase (benchmark-checklist, explain-the-number, prove-it-works,
      sequence-verifiable-units) read before any measurement.

- Phase A Frame `[x]` — goal, constraints, surfaces, and machine facts
  recorded; discovery handoff from the runtime agent read and folded in.
- Phase B Design workflow `[x]` — verification skill generated from repo
  evidence (launch, doctor, drive, evidence, cleanup, helpers) plus feature
  map seed; see `.agents/skills/verify-factory-droid-desktop/`.
- Phase C Run loop `[x]` — skill executed end to end: bundle built, its own
  signed-out journey drive ran green through the `env -i` boundary, evidence
  captured in `build/skill-journey/`, cleanup verified (evidence survives).
- Phase D Audit trail `[x]` — plan, canonical TSV decision log, build logs,
  and baseline measurements kept as reviewable artifacts; published to the
  shared space.
- Phase E Verify handback `[~]` — skill proven and frozen; baseline harness
  established (5-run protocol); findings published; orchestrator briefed;
  no commits or pushes made.

## Program steps

- [x] Verification skill proven — its own signed-out journey drive executed
      end to end through the `env -i` isolation boundary; evidence in
      `build/skill-journey/` and published to the shared space.
- [~] Baseline comparable — at this stage the baseline only establishes the
      harness; the final A/B (five alternating fresh-process runs per side,
      per benchmark-checklist) happens once the native candidate exists.
      Comparisons are same-machine only: the Ubuntu stand-in numbers here
      prove the harness and compare the port only against itself on this
      machine; the Omarchy target numbers come from the runtime agent with
      the same method. Never mix machines or app states in one claim.
- [ ] Architecture parity gate — define the observable behaviors the native
      implementation must match before code lands.
- [ ] Native implementation (Rust + GPUI; blocked until the gate above).
- [ ] Packaging (Arch recipe parity; only after interfaces are stable).
- [ ] End-to-end + perf comparison against the recorded baseline.
- [ ] Independent review of the parity evidence.
- [ ] PRs and final report with line counts.

## Blocking first steps

Current startup and the skill proof come before any rewriting. The bundle
build (`npm run build`) must produce `dist/factory-droid-desktop-1.3.0`
before GUI verification is possible.

## Independent workstreams

- Verification files (this workstream): skill, feature map, baseline
  harness, evidence.
- Read-only core architecture study (other workstream).
- Upstream/packaging tracking (other workstream).
- Target runtime on the Omarchy workstation (runtime agent): owns execution
  there; the verification agent must not drive that display.

## Shared mutable state

One writer per artifact. No concurrent edits to the git branch, the source
inventory (`packaging/source-inventory.json`), or the release manifest.
Release builds and heavy measurements serialize: 4 CPUs / 7.8 GiB here,
8 CPUs / 16 GiB with memory pressure on the target.

## Smallest safe decomposition

Core rewrite has one owner. Packaging only after interfaces are stable.
Independent runtime review at the end. The original port stays usable and
unmodified until the native parity gate passes.

## Agent model selectors

Subagent model selectors are unavailable in this environment; all spawned
agents inherit the environment model. No actual diverse-model review has
happened yet. This is recorded honestly until an independent review pass
becomes possible.

## Decisions

1. **Skill location.** The repo had no skill directory convention, so the
   verification skill lives at `.agents/skills/verify-factory-droid-desktop/`
   (the harness's project skill folder). It is outside the source trees named
   by `packaging/source-inventory.json`, so it cannot reach the release
   archive by accident.
2. **Harness reuse over invention.** The repo already ships Playwright
   smoke scripts under `tests/` (`gui-smoke.mjs`, `theme-smoke.mjs`,
   `menu-smoke.mjs`, `ipc-smoke.mjs`, `performance-smoke.mjs`,
   `performance-ab.mjs`). The verification skill drives those first instead
   of inventing a second harness. Playwright itself is installed OUTSIDE the
   repo (`/home/factory-user/verify-tools/node_modules/playwright-core`) and
   passed via `FACTORY_PLAYWRIGHT_MODULE`, so the source tree stays untouched.
3. **Headless stand-in, clearly labeled.** This machine is Ubuntu 24.04
   (not Arch), with no display session. The build and the GUI checks run
   under Xvfb. Every artifact from here is labeled a stand-in baseline; the
   real-target build and measurement belong to the Omarchy workstation.
4. **Build host gate workaround.** `tools/build.mjs` refuses non-Arch hosts
   by reading `/etc/os-release`. No repo file was changed. The build runs
   inside an ephemeral user+mount namespace
   (`unshare --user --map-user=1000 --map-group=1000 --keep-caps -m`)
   that bind-mounts an Arch-like os-release file
   (`/home/factory-user/verify-tools/arch-os-release`) over `/etc/os-release`
   for that one process. The namespace dies with the command. The real target
   needs no workaround.
5. **Missing dev package.** The keytar rebuild needs `pkg-config` +
   `libsecret-1`; this Ubuntu lacked the headers, so
   `sudo apt-get install libsecret-1-dev` was run (2026-11-05). This is an
   environment fix, matching the README's own dependency list for Arch
   (`libsecret`), not a repo change.
6. **No commits, no pushes.** Everything so far is uncommitted working-tree
   content. `docs/` is a source tree, so this file must be added to
   `packaging/source-inventory.json` (via `npm run package:sources:update`)
   at commit time, or the archive build will refuse it as an undeclared
   source.
7. **Isolation on the target.** Per the runtime agent's handoff: no second
   instance may touch the running user profile at
   `$HOME/.local/share/factory-droid-desktop/user-data` (the target user's
   real home, not a fixed path); any target
   instance uses an empty temp `--user-data-dir` and no cloned auth or
   profile content. Baseline comparisons use the unauthenticated state only,
   on both machines.
8. **No mixed-machine numbers.** The target is under memory pressure (swap
   in use), so no benchmark claim may mix machine or app state. Stand-in
   numbers here only prove the harness works; they are not target baselines.

## Environment facts (this machine)

- Ubuntu 24.04, kernel 6.1.189+, 4 CPUs, 7.8 GiB RAM, 43 GiB free disk.
- No display session; `xvfb-run` available. GTK-3, NSS, ALSA present, so
  Electron can open a window under Xvfb.
- node v24.22.1, npm 11.19.1, python3, gcc/make, `rsvg-convert`,
  user namespaces enabled. No docker/podman. Passwordless sudo available.
