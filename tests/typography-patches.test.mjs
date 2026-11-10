// Guards the composer model-chip baseline layer against the real,
// checksum-pinned upstream 1.7.1 renderer: the anchor must match the pristine
// bytes exactly once, and the patch may not reflow any other Typography call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { diagnose, patch } from '../tools/patches.mjs';
import { typographyRendererChanges } from '../tools/typography-patches.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RENDERER_DIR = path.join(ROOT, 'build', 'upstream-pristine-1.7.1', 'app',
  '.vite', 'renderer', 'main_window');
const SKIP = `renderer snapshot ${RENDERER_DIR} not present; typography recipe unvalidated`;

const present = await access(path.join(RENDERER_DIR, 'index.html')).then(() => true, () => false);

let renderer = null;
if (present) {
  const html = await readFile(path.join(RENDERER_DIR, 'index.html'), 'utf8');
  const entries = [...html.matchAll(/src="\.\/assets\/(index-[^"]+\.js)"/g)].map(m => m[1]);
  assert.equal(entries.length, 1, 'expected exactly one renderer entry script');
  renderer = await readFile(path.join(RENDERER_DIR, 'assets', entries[0]), 'utf8');
}

test('the composer model-chip anchor matches the pristine 1.7.1 renderer exactly once',
  { skip: present ? false : SKIP }, () => {
    assert.deepEqual(diagnose(renderer, typographyRendererChanges), []);
  });

test('only the model chip receives the 15px row line-height', { skip: present ? false : SKIP }, () => {
  const body2Calls = before => before.split('variant:"body-2"').length - 1;
  assert.equal(body2Calls(renderer), body2Calls(patch(renderer, typographyRendererChanges)),
    'every Typography call must stay byte-identical');
  const patched = patch(renderer, typographyRendererChanges);
  assert.equal(patched.split('c.jsx(HZr,{style:{lineHeight:"15px"},children:o})').length - 1, 1,
    'exactly one chip renders with the row line-height');
  // The chip span, its content path and the trigger around it stay upstream's.
  assert.ok(patched.includes('):c.jsx(HZr,{style:{lineHeight:"15px"},children:o}),e[23]=S'),
    'chip memo slots must remain untouched');
  assert.equal(patched.split('c.jsx(HZr,{children:').length - 1, 0,
    'no unstyled chip span remains');
});
