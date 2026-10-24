// Recipe fingerprint and executable-policy tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { recipeInputList, recipeFingerprint, recipeMatches,
         isBundleExecutable, expectedExecutables } from '../tools/common.mjs';
import { ROOT } from '../tools/common.mjs';

test('recipe inputs enumerate the shipped runtime and packaging trees deterministically', async () => {
  const inputs = await recipeInputList();
  for (const required of [
    'package.json', 'package-lock.json', 'versions.json', 'PKGBUILD', 'LICENSE',
    'runtime/collector.py', 'runtime/auth-helper.mjs', 'runtime/launch.sh',
    'runtime/factory-usage.sh', 'runtime/factory-callback.sh', 'runtime/factory-callback.py',
    'packaging/factory-callback', 'packaging/factory-usage', 'packaging/factory-droid-desktop',
    'tools/build.mjs', 'tools/patches.mjs', 'tools/common.mjs', 'tools/verify.mjs',
    'tools/brand-assets.mjs', 'tools/vendor-snapshot.mjs',
  ]) {
    assert.ok(inputs.includes(required), `missing recipe input: ${required}`);
  }
  assert.ok(inputs.every(f => !f.includes('__pycache__') && !f.endsWith('.pyc')));
  assert.deepEqual(inputs, [...inputs].sort());
});

test('generated python bytecode is excluded from the recipe', async () => {
  const dir = path.join(tmpdir(), 'factory-recipe-test');
  await rm(dir, { recursive: true, force: true });
  try {
    for (const d of ['tools', 'runtime', 'runtime/__pycache__', 'packaging']) {
      await mkdir(path.join(dir, d), { recursive: true });
    }
    for (const f of ['package.json', 'package-lock.json', 'versions.json', 'PKGBUILD', 'LICENSE']) {
      await writeFile(path.join(dir, f), 'x');
    }
    await writeFile(path.join(dir, 'runtime/collector.py'), 'x');
    await writeFile(path.join(dir, 'runtime/__pycache__/collector.cpython-314.pyc'), 'x');
    await writeFile(path.join(dir, 'packaging/factory-usage'), 'x');
    const inputs = await recipeInputList(dir);
    assert.ok(inputs.includes('runtime/collector.py'));
    assert.ok(!inputs.some(f => f.includes('__pycache__') || f.endsWith('.pyc')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('changing any shipped runtime source changes the recipe identity', async () => {
  const dir = path.join(tmpdir(), 'factory-recipe-test');
  await rm(dir, { recursive: true, force: true });
  try {
    for (const d of ['tools', 'runtime', 'packaging']) {
      await mkdir(path.join(dir, d), { recursive: true });
    }
    for (const f of ['package.json', 'package-lock.json', 'versions.json', 'PKGBUILD', 'LICENSE']) {
      await writeFile(path.join(dir, f), 'x');
    }
    await writeFile(path.join(dir, 'runtime/collector.py'), 'v1');
    await writeFile(path.join(dir, 'runtime/factory-usage.sh'), 'v1');
    await writeFile(path.join(dir, 'runtime/factory-callback.sh'), 'v1');
    await writeFile(path.join(dir, 'runtime/factory-callback.py'), 'v1');
    await writeFile(path.join(dir, 'runtime/auth-helper.mjs'), 'v1');
    await writeFile(path.join(dir, 'runtime/launch.sh'), 'v1');
    await writeFile(path.join(dir, 'packaging/factory-usage'), 'v1');
    const before = await recipeFingerprint(dir);

    for (const target of ['runtime/collector.py', 'runtime/factory-usage.sh',
                          'runtime/factory-callback.sh', 'runtime/factory-callback.py',
                          'runtime/auth-helper.mjs', 'runtime/launch.sh',
                          'packaging/factory-usage']) {
      await writeFile(path.join(dir, target), 'v2');
      const after = await recipeFingerprint(dir);
      assert.notEqual(JSON.stringify(before), JSON.stringify(after),
        `changing ${target} must change the recipe identity`);
      await writeFile(path.join(dir, target), 'v1');
    }
    const restored = await recipeFingerprint(dir);
    assert.equal(JSON.stringify(restored), JSON.stringify(before));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('stale manifests are refused via recipeMatches', async () => {
  const recipe = await recipeFingerprint();
  assert.ok(recipeMatches({ recipe }, recipe));
  assert.ok(!recipeMatches({ recipe: { ...recipe, 'runtime/collector.py': { sha256: '0'.repeat(64), mode: 0o644 } } }, recipe));
  assert.ok(!recipeMatches({}, recipe));
  assert.ok(!recipeMatches(undefined, recipe));
});

test('executable policy covers the Electron crash handler and nothing extra', () => {
  assert.ok(isBundleExecutable('chrome_crashpad_handler'));
  assert.ok(isBundleExecutable('factory-desktop'));
  assert.ok(isBundleExecutable('chrome-sandbox'));
  assert.ok(isBundleExecutable(path.join('resources', 'bin', 'droid')));
  assert.ok(isBundleExecutable(path.join('port', 'launch.sh')));
  assert.ok(!isBundleExecutable(path.join('port', 'collector.py')));
  assert.ok(!isBundleExecutable(path.join('port', 'auth-helper.mjs')));
  assert.ok(!isBundleExecutable('libEGL.so'));
  assert.ok(!isBundleExecutable(path.join('locales', 'en-US.pak')));
  const relative = [
    'chrome_crashpad_handler', 'factory-desktop', 'chrome-sandbox',
    path.join('resources', 'bin', 'droid'), path.join('port', 'launch.sh'),
    path.join('port', 'collector.py'), path.join('resources', 'app.asar'),
  ];
  assert.deepEqual(expectedExecutables(relative), [
    'chrome-sandbox', 'chrome_crashpad_handler', 'factory-desktop',
    path.join('port', 'launch.sh'), path.join('resources', 'bin', 'droid'),
  ].sort());
});
