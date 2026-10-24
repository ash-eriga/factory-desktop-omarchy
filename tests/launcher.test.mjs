import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod, cp, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const runtime = path.join(ROOT, 'runtime');

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
    assert.ok(lines[0].startsWith(`--user-data-dir=${path.join(dir, 'data')}/factory-desktop-arch/user-data`));
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

test('all shell scripts parse cleanly', async () => {
  for (const name of ['launch.sh', 'factory-usage.sh', 'factory-callback.sh']) {
    const result = spawnSync('/bin/sh', ['-n', path.join(runtime, name)], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${name}: ${result.stderr}`);
  }
});
