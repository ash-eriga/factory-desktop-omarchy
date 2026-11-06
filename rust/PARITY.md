# Native parity gate

The observable behaviors the Rust + GPUI build must match before it replaces
the Electron port. Each row names the behavior, the evidence that proves it,
and the current state. A row is only `proven` when the native build produced
the evidence itself; a row carried over from the Electron harness is
`reference`, not proof.

Scope is the signed-out surface. Sign-in, relay, billing, and workstreams are
out of scope until the port has an authenticated path.

## Gate rows

| # | Behavior | Evidence | State |
|---|---|---|---|
| 1 | Window opens with no account and renders the sign-in prompt | Headless Xvfb launch: 900x600 window, 1,703 dark text pixels | proven (stand-in) |
| 2 | The three entry points render: Sign up, Log in, Sign in to Factory Private | Screenshot shows three accent-filled buttons; click not yet driven | rendered, click pending |
| 3 | Omarchy palette is read from `colors.toml` and `theme.generation` | `cargo test` theme suite; fixture palette rendered as `#101019` / `#7AA2F7` | proven (stand-in) |
| 4 | A malformed or mid-switch palette never reaches the window | `cargo test` theme suite (repeated key, bad hex, missing marker) | unit-proven |
| 5 | Window mode follows the toggle files only (opaque, glassy, transparent) | `cargo test` theme suite; live toggle on the target | unit-proven, live pending |
| 6 | The Droid daemon reaches ready and shuts down cleanly on SIGTERM | `cargo test` daemon suite; live spawn against a verified CLI | unit-proven, live pending |
| 7 | Startup and idle cost are measured with the same protocol as the baseline | `benchmarks/measure-runtime.mjs` run against the native binary | pending |
| 8 | The app exits through a clean shutdown with no orphaned daemon | Target run: window gone, process gone, no `droid` child | pending |

## What the unit suites cover

`cargo test` in this directory proves the pure and filesystem-bounded parts:

- `tests/theme.rs` — palette parsing, table scoping, duplicate rejection,
  hex validation, generation-marker handling, toggle classification.
- `tests/daemon.rs` — ready-message recognition, other typed messages,
  non-object lines, nested `type` fields.

These run without a display and without the vendor CLI. They are the
regression floor, not the parity proof.

## What still needs the target machine

Rows 2 (click), 5 (live toggle), 6 (live spawn), 7, and 8 need a compositor,
a GPU render path, and a verified Droid CLI. Rows 1 and 3 are proven on a
headless Xvfb stand-in with software Vulkan (lavapipe); that is stand-in
evidence, not an Omarchy target claim.

## Provenance gap

The published artifacts (`9139ca2`, `dbe44dc`) were built from Rust + GPUI
sources that are not present in this repository or in
`ash-eriga/factory-desktop-omarchy-rust`. The binary's own strings show the
module layout (`src/ui.rs`, `src/theme.rs`, `src/daemon.rs`, GPUI 0.2.2), and
this crate follows that layout. Until the original sources are pushed, this
tree is the repository-side foundation, not a continuation of that exact
code.
