// Compare the actual local package payload with its bundle manifest and source.
// Usage: node tests/package-content-proof.mjs /absolute/package.pkg.tar.zst
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ROOT, versions, files, hash, fingerprint, recipeFingerprint, recipeMatches } from '../tools/common.mjs';

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
  const bundle = path.join(work, 'opt/factory-desktop-arch');
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
  assert.match(info, /^pkgname = factory-desktop-arch$/m);
  assert.ok(info.split('\n').includes(`pkgver = ${versions.desktop}-${release}`));

  const entrypoints = [
    ['usr/bin/factory-desktop-arch', 'packaging/factory-desktop-arch', 0o755],
    ['usr/bin/factory-usage', 'packaging/factory-usage', 0o755],
    ['usr/bin/factory-callback', 'packaging/factory-callback', 0o755],
    ['usr/share/applications/factory-desktop-arch.desktop', 'packaging/factory-desktop-arch.desktop', 0o644],
    ['usr/share/licenses/factory-desktop-arch/LICENSE', 'LICENSE', 0o644],
    ['usr/share/licenses/factory-desktop-arch/NOTICE', 'packaging/NOTICE', 0o644],
    // The icons are generated during the build from the checksum-pinned
    // official payload; no copy of the mark is committed.
    ['usr/share/icons/hicolor/scalable/apps/factory-desktop-arch.svg', 'build/brand/factory.svg', 0o644],
    ['usr/share/icons/hicolor/256x256/apps/factory-desktop-arch.png', 'build/brand/factory.png', 0o644],
  ];
  const plugin = path.join(ROOT, 'omarchy/factory-usage-service');
  const pluginFiles = await files(plugin);
  for (const file of pluginFiles) {
    const relative = path.relative(plugin, file);
    // The service executes bin/factory-usage directly and the plugin README
    // copies this tree with `cp -r`, which keeps the mode: the runner must
    // be executable in the package. Every other file stays 0644.
    const mode = relative === path.join('bin', 'factory-usage') ? 0o755 : 0o644;
    entrypoints.push([
      `usr/share/doc/factory-desktop-arch/omarchy/factory-usage-service/${relative}`,
      path.relative(ROOT, file), mode,
    ]);
  }
  // The plugin tree in the package also carries the generated marks.
  entrypoints.push([
    'usr/share/doc/factory-desktop-arch/omarchy/factory-usage-service/assets/factory.svg',
    'build/brand/factory-mark.svg', 0o644,
  ]);
  entrypoints.push([
    'usr/share/doc/factory-desktop-arch/omarchy/factory-usage-service/assets/factory-light.svg',
    'build/brand/factory-mark-light.svg', 0o644,
  ]);
  // Nothing else may hide in the packaged plugin tree.
  const packagedPlugin = path.join(work, 'usr/share/doc/factory-desktop-arch/omarchy/factory-usage-service');
  const packagedPluginFiles = (await files(packagedPlugin))
    .map(file => path.relative(packagedPlugin, file)).sort();
  const expectedPluginFiles = [...pluginFiles.map(file => path.relative(plugin, file)),
    path.join('assets', 'factory.svg'), path.join('assets', 'factory-light.svg')].sort();
  assert.deepEqual(packagedPluginFiles, expectedPluginFiles,
    'the packaged plugin tree must hold exactly the published sources and the generated marks');
  for (const [target, source, mode] of entrypoints) {
    const filename = path.join(work, target);
    assert.equal(await hash(filename), await hash(path.join(ROOT, source)), `archived source: ${target}`);
    assert.equal((await lstat(filename)).mode & 0o7777, mode, `archived mode: ${target}`);
  }
  execFileSync('desktop-file-validate', [path.join(work, 'usr/share/applications/factory-desktop-arch.desktop')]);
  console.log(JSON.stringify({
    archive, sha256: await hash(archive), version: `${versions.desktop}-${release}`,
    bundleFilesVerified: Object.keys(manifest.files).length,
    entrypointsAndDocumentationVerified: entrypoints.length,
    recipeMatches: true, allArchivedHashesAndModesMatch: true,
  }));
} finally {
  await rm(work, { recursive: true, force: true });
}
