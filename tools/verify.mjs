import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import * as asar from '@electron/asar';
import { changes, preloadChanges, rendererChanges, rendererTitleChanges,
         htmlTitleChanges } from './patches.mjs';
import { themeMainChanges } from './theme-main-patches.mjs';
import {
  htmlChanges as themeHtmlChanges,
  preloadChanges as themePreloadChanges,
  rendererChanges as themeRendererChanges,
} from './theme-renderer-patches.mjs';
import { menuRendererChanges, unpatchMenuRenderer } from './menu-renderer-patches.mjs';
import { remoteControlRendererChanges } from './remote-control-patches.mjs';
import { applicationMenuMainChanges } from './application-menu-patches.mjs';
import { computerRegistrationMainChanges, computerRegistrationRendererChanges, computerRegistrationPreloadChanges }
  from './computer-registration-patches.mjs';
import { ROOT, versions, elf, run, files, fingerprint, recipeFingerprint, recipeMatches,
         expectedExecutables, outputBundle, portVersion } from './common.mjs';
import { PRODUCT_NAME } from './app-identity.mjs';
import { updateNotificationMainChanges, unpatchUpdateNotifications } from './update-notification-patches.mjs';

const bundle = await outputBundle();
const manifest = JSON.parse(await readFile(path.join(bundle, 'manifest.json'), 'utf8'));

// 1. The bundle must match the recorded file hashes and modes exactly.
if (JSON.stringify(await fingerprint(bundle)) !== JSON.stringify(manifest.files))
  throw new Error('Bundle hashes or modes changed');

// 2. The bundle must have been built from the current recipe and lockfile.
//    A stale bundle fails here even though its files are self-consistent.
if (!recipeMatches(manifest, await recipeFingerprint()))
  throw new Error('Bundle was built from a different recipe or lockfile; rebuild');

// Check the actual shipped main/preload/renderer contracts. A hidden native
// menu alone would leave users without the inline menu; a missing renderer
// patch would resume unnecessary billing polling while the window is hidden.
const archive = path.join(bundle, 'resources/app.asar');
let menuPatchedRenderer = asar.extractFile(archive, versions.renderer).toString();
for (const [name, before, after] of [...computerRegistrationRendererChanges].reverse()) {
  if (menuPatchedRenderer.split(after).length !== 2)
    throw new Error(`Shipped computer registration patch missing or duplicated: ${name}`);
  menuPatchedRenderer = menuPatchedRenderer.replace(after, before);
}
for (const [name, before, after] of [...remoteControlRendererChanges].reverse()) {
  if (menuPatchedRenderer.split(after).length !== 2)
    throw new Error(`Shipped relay recovery patch missing or duplicated: ${name}`);
  menuPatchedRenderer = menuPatchedRenderer.replace(after, before);
}
for (const [name, , after] of menuRendererChanges) {
  if (menuPatchedRenderer.split(after).length !== 2)
    throw new Error(`Shipped menu patch missing or duplicated: ${name}`);
}
// Earlier Linux/theme transforms are validated against their exact final
// strings. Reverse only the newer menu layer in memory; do not weaken their
// anchor checks or alter the shipped ASAR.
const shippedRenderer = unpatchMenuRenderer(menuPatchedRenderer);
const finalLifecycle = asar.extractFile(archive, versions.lifecycle).toString();
const notificationUnpatchedLifecycle = unpatchUpdateNotifications(finalLifecycle);
const rendererSource = file => file === versions.renderer
  ? shippedRenderer : file === versions.lifecycle
    ? notificationUnpatchedLifecycle : asar.extractFile(archive, file).toString();
for (const [file, transformations] of [[versions.lifecycle, changes],
  ['.vite/build/preload.js', preloadChanges], [versions.renderer, rendererChanges],
  ['.vite/build/preload.js', computerRegistrationPreloadChanges],
  [versions.renderer, rendererTitleChanges]]) {
  const source = rendererSource(file);
  for (const [name, , after] of transformations) {
    if (source.split(after).length !== 2) throw new Error(`Shipped patch missing or duplicated: ${name}`);
  }
}
const shippedLifecycle = asar.extractFile(archive, versions.lifecycle).toString();
for (const [name, , after] of [...themeMainChanges, ...applicationMenuMainChanges,
  ...computerRegistrationMainChanges, ...updateNotificationMainChanges]) {
  if (shippedLifecycle.split(after).length !== 2)
    throw new Error(`Shipped main theme patch missing or duplicated: ${name}`);
}
for (const [file, transformations] of [
  ['.vite/build/preload.js', themePreloadChanges],
  [versions.renderer, themeRendererChanges],
  [versions.rendererHtml, themeHtmlChanges],
]) {
  const source = rendererSource(file);
  for (const [name, , after] of transformations) {
    if (source.split(after).length !== 2)
      throw new Error(`Shipped theme patch missing or duplicated in ${file}: ${name}`);
  }
}
if (versions.themeBridgeSchema !== 1) throw new Error('Unsupported theme bridge schema version');
// The window title is owned by the renderer and by the page: the shipped
// bundle must carry the port's own name in both, and no upstream title
// source may survive next to it.
for (const [name, , after] of htmlTitleChanges) {
  if (rendererSource(versions.rendererHtml).split(after).length !== 2)
    throw new Error(`Shipped application title patch missing or duplicated: ${name}`);
}
if (rendererSource(versions.rendererHtml).includes('<title>Factory</title>'))
  throw new Error('Shipped page title still carries the upstream name');
if (rendererSource(versions.renderer).includes('GGn="Factory"'))
  throw new Error('Shipped renderer still falls back to the upstream name');
const upstreamPackage = JSON.parse(asar.extractFile(archive, 'package.json').toString());
if (upstreamPackage.version !== versions.desktop) throw new Error('Shipped Desktop version mismatch');
// The shipped application must carry the port's own name, and the main
// process must set it at runtime: the manifest alone does not decide what
// the window and the taskbar show.
if (upstreamPackage.productName !== PRODUCT_NAME) throw new Error('Shipped application name mismatch');
const themeBridge = path.join(bundle, 'port/theme-bridge.cjs');
await stat(themeBridge);
run(process.execPath, ['--check', themeBridge]);
run(process.execPath, ['--check', path.join(bundle, 'port/update-notifier.cjs')]);
const portRelease = JSON.parse(await readFile(path.join(bundle, 'port/release.json'), 'utf8'));
if (portRelease.version !== await portVersion()) throw new Error('Shipped port package revision mismatch');

// 3. Native binaries must be x86_64 ELF and link against present libraries.
for (const name of ['factory-desktop', 'resources/bin/droid',
  'resources/app.asar.unpacked/node_modules/keytar/build/Release/keytar.node']) {
  await elf(path.join(bundle, name));
  const result = run('ldd', [path.join(bundle, name)]);
  if (result.includes('not found')) throw new Error(`Missing runtime dependency: ${name}`);
}

// 4. Sandbox helper must not be setuid/setgid; this port relies on user
//    namespaces instead of a privileged sandbox.
if (((await stat(path.join(bundle, 'chrome-sandbox'))).mode & 0o7777) !== 0o755)
  throw new Error('Sandbox helper must be 0755, not setuid/setgid');

// 5. Exactly one native module, no Windows payloads, and the executable set
//    must match the policy exactly (Electron entry, sandbox helper, crash
//    handler, bundled droid, port shell scripts; nothing else).
const relative = (await files(bundle)).map(f => path.relative(bundle, f));
const nativeModules = relative.filter(f => f.endsWith('.node'));
if (nativeModules.length !== 1
    || nativeModules[0] !== 'resources/app.asar.unpacked/node_modules/keytar/build/Release/keytar.node')
  throw new Error(`Unexpected native modules: ${nativeModules.join(', ')}`);
for (const f of relative) {
  if (f.endsWith('.exe') || f.endsWith('.dll')) throw new Error(`Windows payload shipped: ${f}`);
}
const executables = [];
for (const f of relative) {
  if (f === 'manifest.json') continue;
  const mode = (await stat(path.join(bundle, f))).mode & 0o777;
  if (mode & 0o111) executables.push(f);
}
const expected = expectedExecutables(relative.filter(f => f !== 'manifest.json'));
if (JSON.stringify(executables.sort()) !== JSON.stringify(expected))
  throw new Error(`Unexpected executable files: ${executables.filter(f => !expected.includes(f)).join(', ')} `
    + `(missing: ${expected.filter(f => !executables.includes(f)).join(', ')})`);

// 6. The launcher scripts must parse and quote paths safely: they are the
//    entry point for installation paths that may contain spaces.
run('/bin/sh', ['-n', path.join(bundle, 'port/launch.sh')]);
run('/bin/sh', ['-n', path.join(bundle, 'port/factory-usage.sh')]);
run('/bin/sh', ['-n', path.join(bundle, 'port/factory-callback.sh')]);

// 7. Namespace probe: user namespaces must work so chrome-sandbox can stay
//    non-setuid.
run('unshare', ['-Ur', 'true']);

console.log(`Verified hashes, recipe identity, native modules, libraries, permissions, `
  + `crash handler and namespace probe for ${versions.desktop}.`);
console.log('GUI rendering, login, IPC chat compatibility and authenticated billing are separate checks.');
