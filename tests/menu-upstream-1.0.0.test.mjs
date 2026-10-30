import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  diagnoseMenuRenderer,
  menuRendererChanges,
  patchMenuRenderer,
  unpatchMenuRenderer,
} from '../tools/menu-renderer-patches.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const versions = JSON.parse(readFileSync(path.join(projectRoot, 'versions.json'), 'utf8'));
const upstreamRendererPath = path.join(
  projectRoot,
  'build/upstream-pristine-1.0.0/app',
  versions.renderer,
);

test('menu anchors apply to the raw 1.0.0 renderer and reverse exactly', {
  skip: !existsSync(upstreamRendererPath)
    ? 'the pristine vendor snapshot is absent; run the build to produce it'
    : false,
}, () => {
  const upstream = readFileSync(upstreamRendererPath, 'utf8');

  // The menu controls are independent of the theme layer: their anchors must
  // hold on the raw upstream snapshot, not only after the theme patch.
  assert.deepEqual(diagnoseMenuRenderer(upstream), []);
  const patched = patchMenuRenderer(upstream);
  assert.deepEqual(diagnoseMenuRenderer(patched), menuRendererChanges.map(([name]) => ({ name, count: 0 })));
  assert.equal(unpatchMenuRenderer(patched), upstream);

  // Semantic basis for the off-Mac gate used by every transform.
  assert.equal(upstream.split('Ph=/macintosh|mac os x/i.test(').length - 1, 1,
    'the renderer isMac user-agent gate is present exactly once');

  // Upstream pre-state that the transforms are built against.
  assert.equal(upstream.split('searchId:"appearance-font-smoothing"').length - 1, 1);
  assert.equal(upstream.split('hotkey:"⌘ Enter"').length - 1, 1);
  assert.equal(upstream.split('"Finder":"File Explorer"').length - 1, 2);
  assert.equal(upstream.split('label:Ph?"Finder":"File Explorer"').length - 1, 1);
  assert.equal(upstream.split('children:Ph?"Finder":"File Explorer"').length - 1, 1);

  // Post-state: nothing Windows-specific remains off macOS.
  assert.equal(patched.split('"Finder":"File Explorer"').length - 1, 0);
  assert.match(patched, /hotkey:Ph\?"⌘ Enter":"Ctrl\+Enter"/);
  assert.match(patched, /We=Ph\?c\.jsx\(ad,\{control:Oe,description:\$e,searchId:"appearance-font-smoothing",title:Ve\}\):null/);
});
