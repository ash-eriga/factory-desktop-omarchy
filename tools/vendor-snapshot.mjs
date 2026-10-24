// Pristine snapshot of the official payload.
//
// The test suite validates the port's patch anchors against the real,
// checksum-pinned upstream sources. Those sources are proprietary and are
// never committed: the build copies the few official files the suite
// reads out of the freshly extracted application, BEFORE any patch is
// applied, into the ignored build output directory. The suite then
// exercises the real anchors without a private vendor checkout.
//
// The snapshot holds data only. It is never packaged, never uploaded and
// never part of the recipe fingerprint.
import { copyFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { SNAPSHOT_DIR, versions } from './common.mjs';

// The official files the suite reads. Each one is a file the patch recipe
// anchors on, plus the renderer's own stylesheet.
function snapshotFiles() {
  return [
    'package.json',
    '.vite/build/main.js',
    '.vite/build/preload.js',
    versions.lifecycle,
    versions.renderer,
    versions.rendererHtml,
    versions.rendererCss,
  ].sort();
}

// Copies the listed files from the freshly extracted application into the
// snapshot directory. The source tree is the untouched vendor payload:
// the build calls this before the first patch is applied.
export async function writeVendorSnapshot(appDir) {
  // The snapshot is generated, never accumulated: a stale file from an
  // earlier run must not survive next to the current one.
  await rm(SNAPSHOT_DIR, { recursive: true, force: true });
  for (const relative of snapshotFiles()) {
    const target = path.join(SNAPSHOT_DIR, 'app', relative);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(appDir, relative), target);
  }
}
