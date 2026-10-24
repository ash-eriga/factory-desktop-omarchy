// End-to-end tests of the deployable service payload: the plugin's
// bin/factory-usage wrapper must run its OWN collector AND ITS OWN HELPER
// (from the plugin dir, whose path may contain spaces) against an EXPLICIT
// bundle path — never the vendor bundle's own (possibly old) helper.
// Offline; user state is never touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PAYLOAD_RUNNER = path.join(ROOT, 'omarchy', 'factory-usage-service', 'bin', 'factory-usage');

const PAYLOAD_ENV = home => ({
  ...process.env,
  HOME: home,
  XDG_CACHE_HOME: path.join(home, 'cache'),
  XDG_STATE_HOME: path.join(home, 'state'),
  XDG_DATA_HOME: path.join(home, 'data'),
  FACTORY_DESKTOP_BUNDLE: path.join(ROOT, 'dist', 'factory-droid-desktop-0.195.0'),
  FACTORY_DISABLE_KEYRING: '1',
  // Runtime must not write bytecode caches into the verified payload.
  PYTHONDONTWRITEBYTECODE: '1',
});

test('service payload wrapper runs its own collector against the dist bundle', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'factory-payload-'));
  try {
    const result = spawnSync(PAYLOAD_RUNNER, [], {
      encoding: 'utf8',
      timeout: 180000,
      cwd: home,
      env: PAYLOAD_ENV(home),
    });
    assert.equal(result.status, 0, result.stderr);
    // The wrapper prints the finished record as one JSON document (the
    // sentinel protocol is helper→collector only).
    const record = JSON.parse(result.stdout.trim().split('\n').at(-1));
    assert.equal(record.id, 'factory');
    assert.equal(record.schemaVersion, 1);
    // Isolated environment: no credentials, so a static failure category
    // with a meaningful help text.
    assert.equal(record.ready, false);
    assert.equal(record.error, undefined);
    assert.ok(record.usageStatusText.length > 0);
    assert.ok(record.authHelpText.length > 0);
    // No paths from the bundle or home leak into the record.
    const text = JSON.stringify(record);
    assert.ok(!text.includes(home));
    assert.ok(!text.includes('/opt/'));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('plugin-local collector runs ITS OWN helper against an OLD bundle', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'factory-oldbundle-'));
  try {
    // A fake OLD installed bundle: a stub Electron (plain node
    // passthrough) and an OLD helper at port/ that announces itself. The
    // plugin-local collector must execute its OWN helper with --bundle;
    // if it ever ran the vendor bundle's old helper, stdout would contain
    // OLD-HELPER-RAN and the failure category would differ.
    const oldBundle = path.join(home, 'old-bundle');
    const buildDir = path.join(oldBundle, 'resources', 'app.asar', '.vite', 'build');
    await mkdir(path.join(oldBundle, 'port'), { recursive: true });
    await mkdir(buildDir, { recursive: true });
    await writeFile(path.join(oldBundle, 'resources', 'app.asar', 'package.json'),
      JSON.stringify({ type: 'commonjs' }));
    const electronStub = '#!/bin/sh\nexec node "$@"\n';
    await writeFile(path.join(oldBundle, 'factory-desktop'), electronStub);
    await chmod(path.join(oldBundle, 'factory-desktop'), 0o755);
    await writeFile(path.join(oldBundle, 'port', 'versions.json'),
      JSON.stringify({ authModule: '.vite/build/fake-chunk.js' }));
    await writeFile(path.join(oldBundle, 'port', 'auth-helper.mjs'),
      'process.stdout.write("OLD-HELPER-RAN\\n"); process.exit(0);\n');
    await writeFile(path.join(buildDir, 'fake-chunk.js'), `
      module.exports = {
        getEnv: () => ({}),
        getRuntimeAuthConfig: () => ({ deployment: { kind: 'customer-prem' }, airgapEnabled: false }),
      };
    `);

    const result = spawnSync(PAYLOAD_RUNNER, [], {
      encoding: 'utf8',
      timeout: 120000,
      cwd: home,
      env: { ...PAYLOAD_ENV(home), FACTORY_DESKTOP_BUNDLE: oldBundle },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!result.stdout.includes('OLD-HELPER-RAN'),
      'the vendor bundle\'s old helper must never be executed');
    const record = JSON.parse(result.stdout.trim().split('\n').at(-1));
    assert.equal(record.id, 'factory');
    // The LOCAL helper ran against the fake chunk and statically refused
    // the customer-prem deployment; the old helper would have yielded
    // helper-error (unparseable output) instead.
    assert.equal(record.ready, false);
    assert.equal(record.usageStatusText, 'This collector supports Factory-managed accounts only.');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
