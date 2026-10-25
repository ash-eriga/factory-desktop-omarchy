# Contributing

Thanks for looking at this port. It is an unofficial, personal project:
Factory Desktop, Droid and the Factory mark belong to **The San Francisco
AI Factory, Inc.**, and no contribution here grants access to their
products, endorses this port, or changes their rights.

The port itself is named **Factory Droid Desktop** (technical slug
`factory-droid-desktop`). That name belongs to the port's own work and is
not a Factory trademark; the upstream product name, the
`factory-desktop://` scheme and the vendor's mark keep their own names.

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
`build/upstream-pristine-0.206.0/`; without it they report an explicit
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

## The source archive

The recipe builds from the port's own source archive, not from a
checkout: the same archive serves the GitHub clone and the AUR, so both
workflows ship the same bytes. `PKGBUILD` pins the archive's SHA-256 and
`.SRCINFO` is the metadata makepkg writes for that recipe; both are
checked in.

```bash
npm run package:sources            # build the archive, check the pinned digest
npm run package:sources:update     # refresh the inventory, digest and .SRCINFO
```

`package:sources` writes the versioned archive under `build/`,
compares its SHA-256 with the one the recipe pins, and **fails** on a
mismatch. It never rewrites the recipe.

`package:sources:update` is the maintainer's mode. It refreshes the
source inventory from the tracked files of the checkout, rebuilds the
archive, rewrites the single `sha256sums=(...)` line of `PKGBUILD` and
regenerates `.SRCINFO` with `makepkg --printsrcinfo`. It is the only mode
that writes to the recipe.

The update is a transaction. Everything that can fail is done first, and
the inventory, the recipe and the metadata keep their bytes and their
modes until the last step: a failing update (a missing or a broken
makepkg, a source that changed under it, a recipe or a metadata file
that is read-only) restores them exactly as they were, removes the
archive that was still pending and leaves the archive that was published
before untouched. Every file is restored even when one of them cannot
be written, and the archive that was pending is removed in any case: a
rollback that could not finish is reported next to the failure that
caused it. A failed update never leaves a recipe that pins one digest
next to a metadata that pins another.

### The source inventory

What the archive holds is not read from a directory walk and not from a
git index: it is `packaging/source-inventory.json`, a checked-in list of
every source file of the port and the mode it ships with. The inventory
is what makes the archive reproducible in a clone, in a source ZIP, in a
release download and in an AUR checkout alike, because none of them
carries a git index. The default mode needs no git at all; only the
maintainer's mode does.

The default mode refuses to build when the tree and the inventory
disagree:

- a file the inventory names but the tree does not hold is a **missing
  source**;
- a file of a source tree the inventory does not name is an **undeclared
  source**, and a local note or a leftover file can therefore never reach
  a release;
- a path that traverses, that is absolute, that is a link or a special
  file, that carries a payload extension, a credential, a log, a profile
  or the personal panel is **refused**, in the default mode and in the
  maintainer's mode alike;
- every source tree has to be a real directory. A link in place of
  `runtime/`, or in the middle of a source path, would carry the bytes
  of a copy that lives outside the tree, and that is refused as well;
- an artifact of a working tree is never a source. A log, a dump, a core
  file, profiler output and generated bytecode are ignored in a tree, and
  a source may not name one of them: a tracked or a listed artifact is
  refused;
- the bytes of the archive are the bytes of the inventory. The packing
  step ignores `TAR_OPTIONS`, `GZIP`, the shell startup files of the
  environment and the functions an outer shell exported, so the
  environment cannot drop a member of the archive.

Two rules keep that guarantee:

- Add a new source file to the repository and to the inventory before
  the archive is regenerated. An untracked file inside the source trees
  is refused by the maintainer's mode, and a source file that is not in
  the inventory is refused by the default mode.
- After an intentional source change, run `npm run package:sources:update`
  and commit the regenerated inventory, checksum and `.SRCINFO` together
  with the change. The default mode reports a mismatch and stops; it
  never rewrites the recipe on someone's machine.

The archive holds the port's own sources only: no vendor payload, no
generated output, no personal material, and no recipe file, because a
checksum inside the recipe cannot cover the recipe itself. The inventory
names itself, and it carries no digest of its own contents: the archive's
checksum is what covers it.


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
