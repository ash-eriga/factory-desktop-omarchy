import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod, cp, readFile, rm, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const runtime = path.join(ROOT, 'runtime');

const modeOf = async (target) => (await stat(target)).mode & 0o777;

function launchWithMask(launcher, mask, env) {
  return spawnSync('/bin/sh', ['-c', `umask ${mask}; exec "$1" --flag`, 'sh', launcher], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

async function makeBundle(dir) {
  const bundle = path.join(dir, 'bundle');
  await mkdir(path.join(bundle, 'port'), { recursive: true });
  await cp(path.join(runtime, 'launch.sh'), path.join(bundle, 'port', 'launch.sh'));
  await chmod(path.join(bundle, 'port', 'launch.sh'), 0o755);
  const stub = '#!/bin/sh\numask > "$STUB_LOG/umask.txt"\n'
    + ': > "$PROJECT_DIR/created-file.txt"\nmkdir "$PROJECT_DIR/created-dir"\n';
  await writeFile(path.join(bundle, 'factory-desktop'), stub);
  await chmod(path.join(bundle, 'factory-desktop'), 0o755);
  return path.join(bundle, 'port', 'launch.sh');
}

test('launch.sh survives bundle paths containing spaces', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'factory-launch-'));
  const bundle = path.join(dir, 'Factory Port 0.195.0');
  try {
    await mkdir(path.join(bundle, 'port'), { recursive: true });
    await cp(path.join(runtime, 'launch.sh'), path.join(bundle, 'port', 'launch.sh'));
    // Stub electron entry: echo argv back one per line.
    const stub = '#!/bin/sh\nfor arg in "$@"; do printf \'%s\\n\' "$arg"; done\n';
    await writeFile(path.join(bundle, 'factory-desktop'), stub);
    await chmod(path.join(bundle, 'factory-desktop'), 0o755);
    await chmod(path.join(bundle, 'port', 'launch.sh'), 0o755);

    const result = spawnSync(path.join(bundle, 'port', 'launch.sh'), ['--flag', 'a b'], {
      encoding: 'utf8',
      env: { ...process.env, HOME: dir, XDG_DATA_HOME: path.join(dir, 'data') },
    });
    assert.equal(result.status, 0, result.stderr);
    const lines = result.stdout.trim().split('\n');
    assert.ok(lines[0].includes('--user-data-dir'), lines[0]);
    assert.deepEqual(lines.slice(1), ['--flag', 'a b']);
    assert.ok(lines[0].startsWith(`--user-data-dir=${path.join(dir, 'data')}/factory-droid-desktop/user-data`));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('factory-usage.sh passes arguments through a spaced bundle path', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'factory-usage-'));
  const bundle = path.join(dir, 'spaced bundle dir');
  try {
    await mkdir(path.join(bundle, 'port'), { recursive: true });
    await cp(path.join(runtime, 'factory-usage.sh'), path.join(bundle, 'port', 'factory-usage.sh'));
    await chmod(path.join(bundle, 'port', 'factory-usage.sh'), 0o755);
    // Stub collector: dump argv as JSON lines.
    await writeFile(path.join(bundle, 'port', 'collector.py'),
      'import json,sys\nprint(json.dumps(sys.argv))\n');
    await chmod(path.join(bundle, 'port', 'collector.py'), 0o644);

    const result = spawnSync(path.join(bundle, 'port', 'factory-usage.sh'),
      ['--force', 'x y'], {
        encoding: 'utf8',
        env: { ...process.env, HOME: dir },
      });
    assert.equal(result.status, 0, result.stderr);
    const argv = JSON.parse(result.stdout.trim().split('\n').at(-1));
    assert.equal(argv.at(-1), 'x y');
    assert.ok(argv.includes('--force'));
    assert.ok(argv.some(a => a === '--bundle' || a.endsWith('--bundle') || a === '--bundle'));
    // The bundle argument must be the real (unescaped) spaced path.
    assert.ok(argv.includes(bundle), JSON.stringify(argv));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

for (const [mask, fileMode, dirMode] of [
  ['0022', 0o644, 0o755],
  ['0027', 0o640, 0o750],
]) {
  test(`launch.sh gives the app the caller umask ${mask} and keeps profile dirs private`, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'factory-umask-'));
    try {
      const project = path.join(dir, 'project');
      const log = path.join(dir, 'log');
      await mkdir(project);
      await mkdir(log);
      const launcher = await makeBundle(dir);

      const result = launchWithMask(launcher, mask, {
        HOME: dir,
        XDG_DATA_HOME: path.join(dir, 'data'),
        PROJECT_DIR: project,
        STUB_LOG: log,
      });
      assert.equal(result.status, 0, result.stderr);

      const childUmask = (await readFile(path.join(log, 'umask.txt'), 'utf8')).trim();
      assert.equal(childUmask, mask, 'the app inherits the caller mask');
      assert.equal(await modeOf(path.join(project, 'created-file.txt')), fileMode,
        'project files are not narrowed by the launcher');
      assert.equal(await modeOf(path.join(project, 'created-dir')), dirMode,
        'project directories are not narrowed by the launcher');

      const data = path.join(dir, 'data', 'factory-droid-desktop');
      assert.equal(await modeOf(path.join(data, 'factory-home')), 0o700, 'profile home is private');
      assert.equal(await modeOf(path.join(data, 'user-data')), 0o700, 'profile user-data is private');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test('launch.sh leaves an existing profile directory untouched', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'factory-profile-'));
  try {
    const data = path.join(dir, 'data', 'factory-droid-desktop');
    const home = path.join(data, 'factory-home');
    const project = path.join(dir, 'project');
    const log = path.join(dir, 'log');
    await mkdir(home, { recursive: true });
    await mkdir(project);
    await mkdir(log);
    await chmod(home, 0o755);
    await writeFile(path.join(home, 'profile.json'), '{"kept":true}\n');
    const launcher = await makeBundle(dir);

    const result = launchWithMask(launcher, '0022', {
      HOME: dir,
      XDG_DATA_HOME: path.join(dir, 'data'),
      PROJECT_DIR: project,
      STUB_LOG: log,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(path.join(home, 'profile.json'), 'utf8'), '{"kept":true}\n');
    assert.equal(await modeOf(home), 0o755, 'an existing profile keeps its mode');
    assert.equal(await modeOf(path.join(data, 'user-data')), 0o700, 'a new profile dir is private');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('all shell scripts parse cleanly', async () => {
  for (const name of ['launch.sh', 'factory-usage.sh', 'factory-callback.sh']) {
    const result = spawnSync('/bin/sh', ['-n', path.join(runtime, name)], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${name}: ${result.stderr}`);
  }
});
