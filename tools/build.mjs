import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, chmod, cp, copyFile, rename, access, unlink, stat, readdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as asar from '@electron/asar';
import { rebuild } from '@electron/rebuild';
import { ROOT, versions, run, hash, files, safePath, validateListing, elf, fingerprint,
         recipeFingerprint, recipeMatches, isBundleExecutable, outputBundle, hostSupported,
         pinnedElectronChecksum, electronDownloadOptions, portVersion } from './common.mjs';
import { patch, diagnose, diagnoseRendererHelperCollisions, preloadChanges, rendererChanges,
         rendererTitleChanges, htmlTitleChanges } from './patches.mjs';
import { themeMainChanges, diagnoseThemeMainHelpers } from './theme-main-patches.mjs';
import {
  diagnose as diagnoseThemeRenderer,
  diagnoseThemeHelperCollisions,
  diagnoseThemeHtmlCollisions,
  diagnoseThemePreloadCollisions,
  htmlChanges as themeHtmlChanges,
  patch as patchThemeRenderer,
  preloadChanges as themePreloadChanges,
  rendererChanges as themeRendererChanges,
} from './theme-renderer-patches.mjs';
import { diagnoseMenuRenderer, patchMenuRenderer } from './menu-renderer-patches.mjs';
import { remoteControlRendererChanges, remoteControlHelperNames } from './remote-control-patches.mjs';
import { applicationMenuMainChanges } from './application-menu-patches.mjs';
import { computerRegistrationMainChanges, computerRegistrationRendererChanges,
  computerRegistrationPreloadChanges, diagnoseComputerRegistrationHelpers } from './computer-registration-patches.mjs';
import { writeVendorSnapshot } from './vendor-snapshot.mjs';
import { writeBrandAssets, ensureBrandAssets, brandSource, BRAND_DIR } from './brand-assets.mjs';
import { applyAppIdentity } from './app-identity.mjs';
import { updateNotificationMainChanges, diagnoseUpdateNotificationHelpers } from './update-notification-patches.mjs';

const require = createRequire(import.meta.url);
const zip = require('7zip-bin').path7za;
const cache = path.join(ROOT, 'build', 'downloads');
const stage = path.join(ROOT, 'build', `assembly-${randomUUID()}`);
const output = await outputBundle();

async function normalizeBundlePermissions(bundle) {
  await chmod(bundle, 0o755);
  // Directories first (every one 0755), then files.
  const stack = [bundle];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await chmod(child, 0o755);
        stack.push(child);
      }
    }
  }
  for (const file of await files(bundle)) {
    await chmod(file, isBundleExecutable(path.relative(bundle, file)) ? 0o755 : 0o644);
  }
}

async function download(url, name, expected) {
  const target = path.join(cache, name);
  if (await access(target).then(() => true, () => false)) {
    if (await hash(target) !== expected) throw new Error(`Cached input changed: ${name}`);
    return target;
  }
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(180000) });
  if (response.status !== 200 || !response.body) throw new Error(`Download failed: ${response.status}`);
  const partial = `${target}.${randomUUID()}.partial`;
  let bytes = 0;
  async function* bounded() {
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > 1024 ** 3) throw new Error('Download exceeds 1 GiB');
      yield chunk;
    }
  }
  await pipeline(Readable.from(bounded()), createWriteStream(partial, { flags: 'wx', mode: 0o600 }));
  if (await hash(partial) !== expected) throw new Error(`SHA-256 mismatch: ${name}`);
  await rename(partial, target);
  return target;
}

async function extract(archive, destination) {
  validateListing(run(zip, ['l', '-slt', archive]));
  await mkdir(destination);
  run(zip, ['x', '-y', `-o${destination}`, archive]);
  await files(destination);
}

// An existing bundle may be reused only when the recipe that produced it is
// identical to the current one; otherwise rebuilding would silently ship a
// stale patch set or lockfile.
async function reusableBundle() {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path.join(output, 'manifest.json'), 'utf8'));
  } catch {
    throw new Error(`${output} exists but has no readable manifest; remove it and rebuild`);
  }
  const recipe = await recipeFingerprint();
  if (!recipeMatches(manifest, recipe)) {
    throw new Error(`${output} was built from a different recipe or lockfile; `
      + 'remove the bundle and rebuild');
  }
  return manifest;
}

// The brand assets are generated, not committed. A reused bundle still
// needs them, so every generated output is verified against the pinned
// geometry and the ones that are missing or altered are restored. The
// recovery lives here, in the build that reuses the bundle, and not in
// the recipe.
async function restoreBrandAssets() {
  const restored = await ensureBrandAssets(await brandSource());
  if (restored.length)
    console.log(`Restored ${restored.join(', ')} in ${path.relative(ROOT, BRAND_DIR)}`);
}

async function main() {
  if (!hostSupported(await readFile('/etc/os-release', 'utf8'), process.arch))
    throw new Error('Build requires an Arch-based x86_64 host');
  if (process.getuid?.() === 0) throw new Error('Never build as root');
  if (await access(output).then(() => true, () => false)) {
    await reusableBundle();
    await restoreBrandAssets();
    console.log(`Reusing existing bundle ${output} (recipe unchanged). Nothing installed or registered.`);
    return;
  }
  run('pkg-config', ['--exists', 'libsecret-1']);
  run('unshare', ['-Ur', 'true']);
  await chmod(zip, 0o755);
  await mkdir(cache, { recursive: true });
  await mkdir(stage, { recursive: true });

  const installer = await download(versions.installerUrl, `Factory-${versions.desktop}.exe`, versions.installerSha256);
  await extract(installer, path.join(stage, 'installer'));
  const packages = (await files(path.join(stage, 'installer'))).filter(f => f.endsWith('.nupkg'));
  if (packages.length !== 1) throw new Error('Expected one installer package');
  await extract(packages[0], path.join(stage, 'windows'));
  const archives = (await files(path.join(stage, 'windows'))).filter(f => path.basename(f) === 'app.asar');
  if (archives.length !== 1) throw new Error('Expected one application archive');
  const archive = archives[0];
  const listing = asar.listPackage(archive).map(p => p.replace(/^\/+/, ''));
  for (const name of listing) {
    safePath(name);
    if (asar.statFile(archive, name).link) throw new Error('ASAR link forbidden');
  }
  const app = path.join(stage, 'app');
  asar.extractAll(archive, app);
  const manifest = JSON.parse(await readFile(path.join(app, 'package.json'), 'utf8'));
  if (manifest.version !== versions.desktop || manifest.devDependencies.electron !== versions.upstreamElectron)
    throw new Error('Unexpected vendor app version or Electron major');

  // Check every patch anchor against the fresh source before touching
  // anything expensive. Refuse to relax guards: each anchor must match
  // exactly once.
  const lifecycle = path.join(app, versions.lifecycle);
  const lifecycleSource = await readFile(lifecycle, 'utf8');
  const preload = path.join(app, '.vite/build/preload.js');
  const preloadSource = await readFile(preload, 'utf8');
  const renderer = path.join(app, versions.renderer);
  const rendererSource = await readFile(renderer, 'utf8');
  const rendererHtml = path.join(app, versions.rendererHtml);
  const rendererHtmlSource = await readFile(rendererHtml, 'utf8');
  // Keep the untouched official sources the test suite validates the
  // anchors against, and generate the brand assets from the untouched
  // renderer. Both happen BEFORE the first patch, so the snapshot is
  // pristine and the icon geometry comes from the official payload.
  await writeVendorSnapshot(app);
  // The port presents itself under its own name. The official manifest
  // names the application "Factory", so that one field is rewritten after
  // the pristine snapshot was taken: the snapshot stays the vendor's own
  // bytes, and only the display name of the shipped application changes.
  await writeFile(path.join(app, 'package.json'),
    applyAppIdentity(await readFile(path.join(app, 'package.json'), 'utf8')));
  const generated = await writeBrandAssets(rendererSource);
  console.log(`Generated ${generated.join(', ')} in ${path.relative(ROOT, BRAND_DIR)}`);
  const failures = [...diagnose(lifecycleSource), ...diagnose(preloadSource, preloadChanges),
    ...diagnose(preloadSource, computerRegistrationPreloadChanges),
    ...diagnose(rendererSource, rendererChanges),
    ...diagnose(rendererSource, rendererTitleChanges)];
  const linuxLifecycle = patch(lifecycleSource);
  const linuxPreload = patch(patch(preloadSource, preloadChanges), computerRegistrationPreloadChanges);
  // The renderer's own title sources and the initial page title carry the
  // port's name: the window shows it from the first frame on.
  const linuxRenderer = patch(patch(rendererSource, rendererChanges), rendererTitleChanges);
  const identityHtml = patch(rendererHtmlSource, htmlTitleChanges);
  const themePatchedRenderer = patchThemeRenderer(linuxRenderer, themeRendererChanges);
  failures.push(...diagnose(linuxLifecycle, themeMainChanges));
  const themedLifecycle = patch(linuxLifecycle, themeMainChanges);
  failures.push(...diagnose(themedLifecycle, applicationMenuMainChanges));
  // The registration layer is applied last, so its anchors are checked
  // against the source it will actually patch.
  const menuLifecycle = patch(themedLifecycle, applicationMenuMainChanges);
  failures.push(...diagnose(menuLifecycle, computerRegistrationMainChanges));
  const registeredLifecycle = patch(menuLifecycle, computerRegistrationMainChanges);
  failures.push(...diagnose(registeredLifecycle, updateNotificationMainChanges));
  failures.push(...diagnoseThemeRenderer(linuxPreload, themePreloadChanges),
    ...diagnoseThemeRenderer(linuxRenderer, themeRendererChanges),
    ...diagnoseMenuRenderer(themePatchedRenderer),
    ...diagnose(rendererHtmlSource, htmlTitleChanges),
    ...diagnoseThemeRenderer(rendererHtmlSource, themeHtmlChanges));
  const menuRenderer = patchMenuRenderer(themePatchedRenderer);
  failures.push(...diagnose(menuRenderer, remoteControlRendererChanges));
  const linuxMenuRenderer = patch(menuRenderer, remoteControlRendererChanges);
  failures.push(...diagnose(linuxMenuRenderer, computerRegistrationRendererChanges));
  const rendererHelperCollisions = [...diagnoseRendererHelperCollisions(rendererSource),
    ...diagnoseThemeHelperCollisions(rendererSource),
    ...remoteControlHelperNames.filter(name => rendererSource.includes(name)),
    ...diagnoseComputerRegistrationHelpers(rendererSource)];
  const themeHelperCollisions = diagnoseThemeMainHelpers(lifecycleSource);
  const registrationHelperCollisions = diagnoseComputerRegistrationHelpers(lifecycleSource);
  const updateHelperCollisions = diagnoseUpdateNotificationHelpers(lifecycleSource);
  const themePreloadCollisions = diagnoseThemePreloadCollisions(preloadSource);
  const themeHtmlCollisions = diagnoseThemeHtmlCollisions(rendererHtmlSource);
  if (failures.length || rendererHelperCollisions.length || themeHelperCollisions.length
      || themePreloadCollisions.length || themeHtmlCollisions.length
      || registrationHelperCollisions.length || updateHelperCollisions.length) {
    const details = [...failures.map(f => `${f.name} (count=${f.count})`),
      ...rendererHelperCollisions.map(name => `${name} (already declared upstream)`),
      ...themeHelperCollisions.map(name => `${name} (already declared upstream)`),
      ...themePreloadCollisions.map(name => `${name} (already declared upstream)`),
      ...themeHtmlCollisions.map(name => `${name} (already declared upstream)`),
      ...registrationHelperCollisions.map(name => `${name} (already declared upstream)`),
      ...updateHelperCollisions.map(name => `${name} (already declared upstream)`)];
    throw new Error(`Patches do not match vendor source ${versions.desktop}: `
      + details.join(', '));
  }
  await writeFile(lifecycle, patch(registeredLifecycle, updateNotificationMainChanges));
  await writeFile(preload, patchThemeRenderer(linuxPreload, themePreloadChanges));
  await writeFile(renderer, patch(linuxMenuRenderer, computerRegistrationRendererChanges));
  await writeFile(rendererHtml, patchThemeRenderer(identityHtml, themeHtmlChanges));
  run(process.execPath, ['--check', lifecycle]);
  run(process.execPath, ['--check', preload]);
  run(process.execPath, ['--check', renderer]);
  run(process.execPath, ['--check', path.join(ROOT, 'runtime/theme-bridge.cjs')]);
  run(process.execPath, ['--check', path.join(ROOT, 'runtime/update-notifier.cjs')]);

  // Rebuild only the inspected keytar 7.9.0 sources (they ship inside the
  // vendor archive) against this port's Linux Electron. The Windows prebuilt
  // sidecar is discarded and never shipped.
  const native = path.join(stage, 'native');
  await mkdir(path.join(native, 'node_modules'), { recursive: true });
  const keytar = path.join(app, 'node_modules', 'keytar');
  const keytarPackage = JSON.parse(await readFile(path.join(keytar, 'package.json'), 'utf8'));
  if (keytarPackage.version !== '7.9.0') throw new Error('Unexpected keytar version');
  await cp(keytar, path.join(native, 'node_modules', 'keytar'), { recursive: true });
  for (const file of await files(native)) if (file.endsWith('.node')) await unlink(file);
  await cp(path.join(ROOT, 'node_modules', 'node-addon-api'), path.join(native, 'node_modules', 'node-addon-api'), { recursive: true });
  await writeFile(path.join(native, 'package.json'), JSON.stringify({
    private: true, dependencies: { keytar: '7.9.0', 'node-addon-api': '4.3.0' },
  }));
  await rebuild({ buildPath: native, electronVersion: versions.electron, arch: 'x64',
    force: true, onlyModules: ['keytar'], buildFromSource: true, mode: 'sequential' });
  const addon = path.join(native, 'node_modules/keytar/build/Release/keytar.node');
  await elf(addon);
  for (const file of await files(keytar)) if (file.endsWith('.node')) await unlink(file);
  await mkdir(path.join(keytar, 'build', 'Release'), { recursive: true });
  await copyFile(addon, path.join(keytar, 'build', 'Release', 'keytar.node'));

  const checksums = JSON.parse(await readFile(path.join(ROOT, 'node_modules/electron/checksums.json'), 'utf8'));
  const { digest: electronHash } = pinnedElectronChecksum(checksums, versions.electron);
  // Release asset redirects are expected here. Fetch through Electron's own
  // downloader, then independently compare the locked package checksum.
  // The pinned checksum map travels with the call, so the downloader
  // verifies the artifact against the locked hashes instead of fetching
  // SHASUMS256.txt from the network: the internal check stays as strict,
  // the independent comparison below stays, and no checksum guard is
  // relaxed.
  const { downloadArtifact } = require('@electron/get');
  const runtimeZip = await downloadArtifact(electronDownloadOptions({
    version: versions.electron, checksums, cacheRoot: cache }));
  if (await hash(runtimeZip) !== electronHash) throw new Error('Electron checksum mismatch');
  const bundle = path.join(stage, 'bundle');
  await extract(runtimeZip, bundle);
  await rename(path.join(bundle, 'electron'), path.join(bundle, 'factory-desktop'));
  await copyFile(path.join(BRAND_DIR, 'factory.png'), path.join(bundle, 'resources/factory-desktop.png'));
  await chmod(path.join(bundle, 'chrome-sandbox'), 0o755);
  await asar.createPackageWithOptions(app, path.join(bundle, 'resources/app.asar'), { unpackDir: 'node_modules/keytar' });

  const droid = path.join(ROOT, 'node_modules', '@factory', 'cli-linux-x64', 'bin', 'droid');
  await elf(droid);
  if (run(droid, ['--version']).trim() !== versions.droid) throw new Error('Droid version mismatch');
  await mkdir(path.join(bundle, 'resources/bin'));
  await copyFile(droid, path.join(bundle, 'resources/bin/droid'));
  await chmod(path.join(bundle, 'resources/bin/droid'), 0o755);

  // Runtime support: launcher, usage collector, callback helper, and the
  // auth helper used by the collector. Copied read-only from runtime/,
  // excluding Python bytecode caches.
  await cp(path.join(ROOT, 'runtime'), path.join(bundle, 'port'), { recursive: true,
    filter: source => !source.includes('__pycache__') });
  await writeFile(path.join(bundle, 'port/versions.json'), JSON.stringify(versions));
  await writeFile(path.join(bundle, 'port/release.json'), JSON.stringify({ version: await portVersion() }) + '\n');

  for (const file of await files(bundle)) {
    if (file.endsWith('.exe') || file.endsWith('.dll')) throw new Error('Windows executable survived assembly');
  }
  await normalizeBundlePermissions(bundle);

  const bundleFiles = await fingerprint(bundle);
  const recipe = await recipeFingerprint();
  const manifestBody = {
    desktop: versions.desktop, electron: versions.electron, droid: versions.droid,
    installerSha256: versions.installerSha256, electronSha256: electronHash,
    publisherSignature: 'not verified', builtAt: new Date().toISOString(),
    recipe, files: bundleFiles,
  };
  await writeFile(path.join(bundle, 'manifest.json'), JSON.stringify(manifestBody, null, 2) + '\n');

  // The manifest embeds the fingerprint it excludes, so recompute once more
  // and confirm the recorded values describe the finished tree before it is
  // promoted to dist/.
  const recorded = JSON.parse(await readFile(path.join(bundle, 'manifest.json'), 'utf8'));
  if (JSON.stringify(await fingerprint(bundle)) !== JSON.stringify(recorded.files))
    throw new Error('Output fingerprint drifted while packaging');
  const addonShipped = await files(path.join(bundle, 'resources/app.asar.unpacked'));
  const nativeModules = addonShipped.filter(f => f.endsWith('.node'));
  if (nativeModules.length !== 1 || path.basename(nativeModules[0]) !== 'keytar.node')
    throw new Error(`Expected exactly one keytar.node, found ${nativeModules.length}`);

  await mkdir(path.dirname(output), { recursive: true });
  await rename(bundle, output);
  console.log(`Built ${output}. Nothing installed or registered.`);
}
main().finally(() => rm(stage, { recursive: true, force: true }))
  .catch(error => { console.error(error.message); process.exitCode = 1; });
