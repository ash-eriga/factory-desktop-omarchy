// The plugin README's enablement examples must match the actual
// PluginRegistry contract: `plugins[]` entries are objects with an `id`,
// and the documented plugin id matches the manifest.
//
// The panel that renders the usage record is a separate, user-local
// component and is not part of this repository; this file therefore covers
// the published service tree only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SERVICE = path.join(ROOT, 'omarchy', 'factory-usage-service');

test('plugin README documents object-shaped enablement with the manifest id', async () => {
  const readme = await readFile(path.join(SERVICE, 'README.md'), 'utf8');
  const manifest = JSON.parse(await readFile(path.join(SERVICE, 'manifest.json'), 'utf8'));

  // The documented id matches the manifest.
  assert.ok(readme.includes(manifest.id), 'README must reference the manifest id');

  // The supported user-run enable command is documented.
  assert.ok(readme.includes(`omarchy plugin enable ${manifest.id}`));

  // Any jq example touching .plugins must append objects with id, never
  // bare strings (the registry reads .plugins[j].id).
  const jqMatches = [...readme.matchAll(/jq\s+'([^']+)'/g)];
  assert.ok(jqMatches.length > 0, 'README should show a shell.json alternative');
  for (const [, program] of jqMatches) {
    if (!program.includes('.plugins')) continue;
    assert.ok(!/"\w[\w.-]*"\s*\]/.test(program.replace(/"factory.usage-service"/g, '').replace(/"id"/g, '')),
      'plugins entries must be objects');
    assert.match(program, /\{\s*"id"\s*:\s*"factory\.usage-service"\s*\}/);
  }

  // Disable instructions match the enable mechanics.
  assert.ok(readme.includes(`omarchy plugin disable ${manifest.id}`));
});

test('the plugin tree ships the runner, the collector and the manifest', async () => {
  const { stat } = await import('node:fs/promises');
  const manifest = JSON.parse(await readFile(path.join(SERVICE, 'manifest.json'), 'utf8'));
  assert.equal(manifest.entryPoints.service, 'Service.qml');
  await stat(path.join(SERVICE, 'Service.qml'));
  // The service executes the runner directly, so it must stay executable.
  const runner = path.join(SERVICE, 'bin', 'factory-usage');
  assert.equal((await stat(runner)).mode & 0o111, 0o111, 'the runner must stay executable');
  await stat(path.join(SERVICE, 'runtime', 'collector.py'));
  await stat(path.join(SERVICE, 'runtime', 'auth-helper.mjs'));
  await stat(path.join(SERVICE, 'runtime', 'local_usage.py'));
});
