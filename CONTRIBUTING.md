# Contributing

Thanks for looking at this port. It is an unofficial, personal project:
Factory Desktop, Droid and the Factory mark belong to **The San Francisco
AI Factory, Inc.**, and no contribution here grants access to their
products, endorses this port, or changes their rights.

## Before you start

- Keep the vendor payload out of the repository. No installer, no
  extracted vendor files, no native binaries, no built bundles and no
  packages may be committed or uploaded. The build output directories
  (`build/`, `dist/`, `pkg/`, `src/`) are ignored for that reason.
- Keep personal material out: no account identifiers, no machine or
  device identifiers, no local cache paths, no logs, no screenshots and
  no profile dumps. The test suite must run on a clean machine.
- The personal usage panel is not part of this repository. Changes that
  depend on it do not belong here.

## Running the tests

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm test
```

The suite is offline: no network, no credentials, no account, no GUI
session. Run it before every commit. `npm test` covers both the Node
and the Python suites.

Some tests validate the patch anchors against the real upstream sources.
They read the pristine vendor snapshot that the build produces under
`build/upstream-pristine-0.205.0/`; without it they report an explicit
skip saying that the recipe is unvalidated. If you changed a patch
recipe, run a real build before you ask for a review, so those tests
actually execute.

Useful narrower runs:

```bash
node --test tests/recipe.test.mjs
node --test tests/brand-assets.test.mjs
python3 -m unittest discover -s tests -p 'test_*.py' -v
```

Run the tests in a disposable environment if you like, so nothing lands
in your own state:

```bash
env HOME="$(mktemp -d)" XDG_CACHE_HOME="$(mktemp -d)" XDG_STATE_HOME="$(mktemp -d)" npm test
```

## Style

- JavaScript and shell: two-space indentation, single quotes, semicolons,
  ES modules. Keep the existing comment style: a short line above a
  block that explains *why*, not what.
- Python: four-space indentation, PEP 8 naming, type-free but explicit
  signatures, module docstrings that state the contract.
- Keep functions small and side effects at the edges. A patch recipe
  stays a pure function of its source text.
- Do not add APIs, parameters, exports or configuration that only the
  tests use. If a test needs a seam, restructure the production code so
  the seam is a real one.
- New behaviour comes with a regression test that fails without it.

## Commits and pull requests

- Write commit subjects in the imperative mood, one line, no trailing
  period: `Fix the callback rollback when the file was removed`.
- Describe *what* changed and *why* in the body. Reference the affected
  file and the observable behaviour.
- Add the co-authorship trailer when the change was produced with
  Factory Droid:

  ```
  Co-authored-by: factory-droid[bot] <138933559+factory-droid[bot]@users.noreply.github.com>
  ```

  This attributes the contribution to that account. It grants no access
  and implies no endorsement by Factory.

- A pull request should explain the behaviour before and after, list the
  tests that were run, and state explicitly what was **not** validated
  (for example: no authenticated session, no full Arch package build, no
  GUI session).

## Scope of a change

- Do not update versions, dependencies or the lockfile as a side effect.
  When a change needs a new dependency, say so in the pull request.
- Do not relax a checksum, an anchor or a permission check to make a
  test pass.
- The upstream relay budget, the vendor's rounding formula and the
  vendor's session inventory are re-implemented from the behaviour of the
  pinned release. Changing them is a deliberate decision, not a cleanup.

## Licensing of contributions

Contributions are accepted under the MIT License of this repository (see
[`LICENSE`](LICENSE)). By contributing you confirm that the contribution
is your own work and that it does not include Factory proprietary
material.
