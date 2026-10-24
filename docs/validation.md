# Validation

What the port's checks prove, what they do not, and how to run each
layer. The layers are deliberately separated: the automated suite must
stay runnable without the vendor payload, without an account and without
a GUI session.

## Layer 1 — the offline suite (`npm test`)

Runs on Node and Python, with no network, no credentials, no real
account, no installed package and no GUI session.

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm test
```

`npm test` runs `node --test tests/*.test.mjs`; the Python suite is
driven from `tests/python.test.mjs`, so one command covers both
languages. The suite is also what `makepkg` runs in its `check()` phase.

What it covers:

- the patch recipes and their exact anchors, including the negative
  controls (a duplicated or missing anchor must fail),
- the launcher: isolated home, environment scrubbing, quoting of paths
  that contain spaces,
- the auth helper and the collector, including the field continuity of
  the account inventory, the real-zero and missing-value cases, and the
  credential handling rules,
- the local accounting: per-model growth, session dedup, day buckets and
  credit fractions — all of it device-local; this repository does not
  merge the records of two devices,
- the callback registration and its rollback, including third-party
  changes and files removed by another action,
- the theme bridge: trusted frames only, validated payloads, no writes
  outside the whitelisted state files,
- the menus, the relay recovery and the billing polling gate,
- the recipe fingerprint, the executable policy and the package modes,
- the generated brand assets and the packaging path that uses them.

Synthetic fixtures are used on purpose: the vendor logo is never
embedded in a test, and the brand extraction is exercised against
synthetic geometry in an isolated fixture.

## Layer 2 — the payload-dependent tests

Some tests are deliberately not fixtures: they load the real, checksum-
pinned upstream sources, require every anchor to match exactly once,
apply the recipe, and then execute the patched billing hook and theme
bridge extracted from the patched bytes.

They read the pristine vendor snapshot that the build produces in
`build/upstream-pristine-0.205.0/` (see
[architecture](architecture.md#7-generated-outputs)). The snapshot is
copied out of the freshly extracted application before any patch is
applied, and it stays in the ignored build directory: it is proprietary
vendor data and is never committed, packaged or uploaded.

When the snapshot is absent, these tests report an explicit skip whose
message states that the recipe is unvalidated against the pinned
release. After a real build, the suite exercises them without skips.

## Layer 3 — the Arch build and package

Not covered by the automated suite, and not covered by the CI:

```bash
makepkg -f
```

This downloads the vendor installer and the pinned Electron runtime,
rebuilds `keytar` against the pinned Linux Electron, runs the suite,
installs the payload, and produces the package. `makepkg` needs network
access, the distribution's `nodejs`/`npm`, `base-devel`, `libsecret`
headers, `librsvg` and working user namespaces.

The package is then checked with `tests/package-content-proof.mjs`,
which compares the archive against the bundle manifest and against the
recipe: every archived file's hash and mode, the license files, the
generated icons, the plugin tree, and the recipe identity.

`makepkg -si` additionally installs the package and the missing
dependencies with `pacman`. `makepkg` itself must not run as root.

## Layer 4 — manual and real-session checks

These require a real account, a real window manager and a real
compositor, and are therefore outside the automated scope:

- the visual result of the theme follow and of the Glassy tint,
- the authenticated relay connection and its recovery,
- the authenticated billing and limits display,
- the panel that renders the usage record — a separate, user-local
  component that is not part of this repository.

The optional Playwright scripts under `tests/` (`gui-smoke.mjs`,
`theme-smoke.mjs`, `menu-smoke.mjs`, `performance-*.mjs`,
`glassy-*.mjs`) drive a built bundle. They need a Playwright module
(`FACTORY_PLAYWRIGHT_MODULE`) and a short writable temporary path, and
they are never part of `npm test`.

## CI

`.github/workflows/ci.yml` runs Layer 1 on a synthetic Linux, with
`contents: read` permissions, a job timeout, no credentials, no
`pull_request_target` and no uploaded artifacts. It does **not** build
the vendor payload, does not run `makepkg`, and does not publish
anything: it checks the sources and the fixtures only. A CI run is
therefore not evidence that a full Arch build succeeds; that remains a
local step (Layer 3).

## Known limits

- The vendor payload's publisher signature is not verified. The pinned
  SHA-256 is the only trust anchor, and the bundle manifest records
  `"publisherSignature": "not verified"`.
- The CI runs on a synthetic Linux distribution, not on Arch. The recipe
  checks the distribution itself, and only an Arch host can run it.
- The optional plugin tree under `omarchy/` is shipped as documentation
  and is not part of the recipe fingerprint; a change to it does not
  invalidate an existing bundle.
- The upstream relay budget, the vendor's rounding formula and the
  vendor's own session inventory are re-implemented from the observed
  behaviour of the pinned release. A newer vendor release can change
  them; `npm run upstream:check` reports the latest published version
  only, and the anchors then have to be reviewed by hand.
