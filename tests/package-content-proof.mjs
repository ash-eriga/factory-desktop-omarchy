// Compare the actual local package payload with its bundle manifest and source.
// Usage: node tests/package-content-proof.mjs /absolute/package.pkg.tar.zst
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ROOT, versions, hash, fingerprint, recipeFingerprint, recipeMatches } from '../tools/common.mjs';
import { PRODUCT_SLUG, pkgInfoRelationshipLines } from '../tools/app-identity.mjs';

const archive = path.resolve(process.argv[2] || '');
assert.ok(process.argv[2], 'provide the package to verify');
const listing = execFileSync('bsdtar', ['-tf', archive], { encoding: 'utf8' }).trim().split('\n');
for (const entry of listing) {
  assert.ok(entry && !entry.startsWith('/') && !entry.includes('\\')
    && !entry.split('/').includes('..'), `unsafe archive member: ${entry}`);
}
const work = await mkdtemp(path.join(tmpdir(), 'fpp-'));
try {
  execFileSync('bsdtar', ['-xpf', archive, '--no-same-owner', '-C', work]);
  const bundle = path.join(work, `opt/${PRODUCT_SLUG}`);
  const manifest = JSON.parse(await readFile(path.join(bundle, 'manifest.json'), 'utf8'));
  assert.equal(manifest.desktop, versions.desktop);
  assert.equal(manifest.electron, versions.electron);
  assert.equal(manifest.droid, versions.droid);
  assert.ok(recipeMatches(manifest, await recipeFingerprint()), 'package must match the current recipe');
  assert.deepEqual(await fingerprint(bundle), manifest.files, 'every archived bundle hash and mode must match');
  const recipe = await readFile(path.join(ROOT, 'PKGBUILD'), 'utf8');
  const release = recipe.match(/^pkgrel=([0-9]+)$/m)?.[1];
  assert.ok(release);
  const info = await readFile(path.join(work, '.PKGINFO'), 'utf8');
  assert.match(info, new RegExp(`^pkgname = ${PRODUCT_SLUG}$`, 'm'));
  assert.ok(info.split('\n').includes(`pkgver = ${versions.desktop}-${release}`));
  // The rename must leave a single owner of the paths the previous package
  // owned: the old name conflicts, is replaced and stays provided, and no
  // second package claims it. The keys are the ones makepkg really writes:
  // PKGBUILD's plural `conflicts` array is serialized as `conflict`.
  for (const line of pkgInfoRelationshipLines()) {
    assert.ok(info.split('\n').includes(line), `.PKGINFO must declare ${line}`);
  }

  const entrypoints = [
    ['usr/bin/factory-droid-desktop', 'packaging/factory-droid-desktop', 0o755],
    ['usr/bin/factory-usage', 'packaging/factory-usage', 0o755],
    ['usr/bin/factory-callback', 'packaging/factory-callback', 0o755],
    ['usr/share/applications/factory-droid-desktop.desktop', 'packaging/factory-droid-desktop.desktop', 0o644],
    ['usr/share/licenses/factory-droid-desktop/LICENSE', 'LICENSE', 0o644],
    ['usr/share/licenses/factory-droid-desktop/NOTICE', 'packaging/NOTICE', 0o644],
    // The icons are generated during the build from the checksum-pinned
    // official payload; no copy of the mark is committed.
    ['usr/share/icons/hicolor/scalable/apps/factory-droid-desktop.svg', 'build/brand/factory.svg', 0o644],
    ['usr/share/icons/hicolor/256x256/apps/factory-droid-desktop.png', 'build/brand/factory.png', 0o644],
  ];
  assert.ok(!listing.some(entry =>
    entry.startsWith('usr/share/doc/factory-droid-desktop/omarchy/')),
    'the archive must not contain the removed service plugin');
  for (const [target, source, mode] of entrypoints) {
    const filename = path.join(work, target);
    assert.equal(await hash(filename), await hash(path.join(ROOT, source)), `archived source: ${target}`);
    assert.equal((await lstat(filename)).mode & 0o7777, mode, `archived mode: ${target}`);
  }
  execFileSync('desktop-file-validate', [path.join(work, 'usr/share/applications/factory-droid-desktop.desktop')]);
  console.log(JSON.stringify({
    archive, sha256: await hash(archive), version: `${versions.desktop}-${release}`,
    bundleFilesVerified: Object.keys(manifest.files).length,
    entrypointsAndDocumentationVerified: entrypoints.length,
    recipeMatches: true, allArchivedHashesAndModesMatch: true,
  }));
} finally {
  await rm(work, { recursive: true, force: true });
}
