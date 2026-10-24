// The optional Omarchy plugin tree is shipped as a copyable extra. The
// service executes bin/factory-usage directly (Service.qml) and the plugin
// README copies this tree with `cp -r`, which keeps the file modes: the
// runner must be executable in the package, every other file must stay
// 0644.
//
// The test runs the RECIPE's own normalization function (sourced from the
// PKGBUILD) on a temporary copy of the plugin tree, so it cannot drift
// from what makepkg would produce. No build, no makepkg, no installed
// package, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, rm, stat, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ROOT, files } from '../tools/common.mjs';

const PLUGIN = path.join(ROOT, 'omarchy', 'factory-usage-service');
const RUNNER = path.join('bin', 'factory-usage');

async function packagedCopy() {
  const dir = await mkdtemp(path.join(tmpdir(), 'factory-plugin-modes-'));
  await cp(PLUGIN, path.join(dir, 'factory-usage-service'), { recursive: true });
  // The recipe's own function decides the modes of the shipped tree. It
  // takes the directory that CONTAINS the plugin, exactly as package()
  // passes the documentation directory.
  const result = spawnSync('bash', ['-c',
    `source "$1" >/dev/null 2>&1 || exit 3; normalize_plugin_modes "$2"`,
    'bash', path.join(ROOT, 'PKGBUILD'), dir,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return dir;
}

test('the recipe keeps the plugin runner executable and the data files 0644', async () => {
  const dir = await packagedCopy();
  try {
    const root = path.join(dir, 'factory-usage-service');
    for (const file of await files(root)) {
      const relative = path.relative(root, file);
      const mode = (await stat(file)).mode & 0o777;
      if (relative === RUNNER) {
        assert.equal(mode, 0o755, `the runner must stay executable: ${relative}`);
      } else {
        assert.equal(mode, 0o644, `other plugin files stay 0644: ${relative}`);
      }
    }
    // The directories are traversable. The published tree carries no
    // brand assets: the recipe adds the generated marks to the packaged
    // copy, so the repository tree has no assets directory at all.
    for (const relative of ['runtime', 'bin']) {
      const mode = (await stat(path.join(root, relative))).mode & 0o777;
      assert.equal(mode, 0o755, `directory mode: ${relative}`);
    }
    await assert.rejects(access(path.join(root, 'assets')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the packaged runner can be executed directly', async () => {
  const dir = await packagedCopy();
  try {
    const runner = path.join(dir, 'factory-usage-service', RUNNER);
    // Executed as the service does it: directly, without an interpreter.
    // --help makes argparse print the usage and exit before any collector
    // work, so nothing is fetched and no user state is touched.
    const result = spawnSync(runner, ['--help'], {
      encoding: 'utf8',
      timeout: 60000,
      env: {
        PATH: process.env.PATH,
        HOME: path.join(dir, 'home'),
        XDG_STATE_HOME: path.join(dir, 'state'),
        XDG_CACHE_HOME: path.join(dir, 'cache'),
        XDG_DATA_HOME: path.join(dir, 'data'),
        PYTHONDONTWRITEBYTECODE: '1',
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /--write/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the recipe declares the runner mode explicitly', async () => {
  const { readFile } = await import('node:fs/promises');
  const recipe = await readFile(path.join(ROOT, 'PKGBUILD'), 'utf8');
  // The normalization is a single recipe function, called by package().
  assert.match(recipe, /^normalize_plugin_modes\(\) \{$/m);
  assert.match(recipe, /chmod 755 "\$root\/factory-usage-service\/bin\/factory-usage"/);
  assert.match(recipe, /normalize_plugin_modes "\$pkgdir\/usr\/share\/doc\/\$pkgname\/omarchy"/);
});

test('the recipe adds the generated marks to the packaged plugin tree', async () => {
  const { readFile } = await import('node:fs/promises');
  const recipe = await readFile(path.join(ROOT, 'PKGBUILD'), 'utf8');
  // The marks are generated during the build, never committed, and the
  // normalization runs after they are installed.
  assert.match(recipe, /build\/brand\/factory-mark\.svg/);
  assert.match(recipe, /build\/brand\/factory-mark-light\.svg/);
  assert.match(recipe, /factory-usage-service\/assets\/factory\.svg/);
  assert.match(recipe, /factory-usage-service\/assets\/factory-light\.svg/);
});
