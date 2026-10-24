// Runs the Python collector test suite under the Node test runner so
// `npm test` covers both languages in one command.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('python collector tests pass', () => {
  const result = spawnSync('python3', [
    '-m', 'unittest', 'discover', '-s', path.join(ROOT, 'tests'),
    '-p', 'test_*.py', '-v',
  ], { encoding: 'utf8', cwd: ROOT, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
