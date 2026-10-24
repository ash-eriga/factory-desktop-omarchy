// The nominal identity of the port: the package name, the command, the
// desktop entry, the installed paths and the visible application name.
//
// The rename is only complete when every one of those names agrees. These
// tests are the regression guard for it: they fail when a name is renamed
// in one place and forgotten in another, when the Arch handover to the
// previous package name is dropped, or when the shipped application stops
// carrying the port's own name.
import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { PRODUCT_NAME, PRODUCT_SLUG, DESKTOP_ENTRY, PREVIOUS_PACKAGE,
         pkgInfoRelationshipLines, applyAppIdentity } from '../tools/app-identity.mjs';
import { changes, patch, rendererChanges, rendererTitleChanges, htmlTitleChanges }
  from '../tools/patches.mjs';
import { rendererChanges as themeRendererChanges } from '../tools/theme-renderer-patches.mjs';
import { menuRendererChanges } from '../tools/menu-renderer-patches.mjs';
import { remoteControlRendererChanges } from '../tools/remote-control-patches.mjs';
import { computerRegistrationRendererChanges } from '../tools/computer-registration-patches.mjs';
import { SNAPSHOT_DIR, outputBundle, versions } from '../tools/common.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OLD_SLUG = 'factory-desktop-arch';
const SNAPSHOT_APP = path.join(SNAPSHOT_DIR, 'app');
const snapshotPresent = await access(SNAPSHOT_APP).then(() => true, () => false);
const SNAPSHOT_MISSING = `payload ${SNAPSHOT_APP} not present; recipe unvalidated against ${versions.desktop}`;

async function read(...parts) {
  return readFile(path.join(ROOT, ...parts), 'utf8');
}

test('the product name and the technical slug are the agreed ones', () => {
  assert.equal(PRODUCT_NAME, 'Factory Droid Desktop');
  assert.equal(PRODUCT_SLUG, 'factory-droid-desktop');
  assert.equal(DESKTOP_ENTRY, 'factory-droid-desktop.desktop');
});

test('the recipe declares the new package and the handover to the old one', async () => {
  const recipe = await read('PKGBUILD');
  assert.match(recipe, /^pkgname=factory-droid-desktop$/m);
  assert.match(recipe, /^pkgdesc='Unofficial Factory Droid Desktop port for Arch and Omarchy'$/m);
  assert.match(recipe, /^pkgrel=[0-9]+$/m);
  // The old package owns /usr/bin/factory-usage and /usr/bin/factory-callback,
  // so exactly one package may own them: the new one conflicts with the old
  // one, replaces it, and keeps its name satisfiable.
  for (const field of ['conflicts', 'replaces', 'provides']) {
    assert.match(recipe, new RegExp(`^${field}=\\('${OLD_SLUG}'\\)$`, 'm'),
      `PKGBUILD must declare ${field}=('${OLD_SLUG}')`);
  }
  // Nothing is migrated automatically: the recipe installs program files only.
  assert.ok(!recipe.includes('factory-desktop-arch/'), 'no data path may be migrated');
});

test('the installed paths carry the new slug', async () => {
  const recipe = await read('PKGBUILD');
  assert.match(recipe, /install -Dm755 packaging\/factory-droid-desktop "\$pkgdir\/usr\/bin\/factory-droid-desktop"/);
  assert.match(recipe,
    /install -Dm644 packaging\/factory-droid-desktop\.desktop "\$pkgdir\/usr\/share\/applications\/factory-droid-desktop\.desktop"/);
  assert.match(recipe, /install -Dm644 build\/brand\/factory\.svg "\$pkgdir\/usr\/share\/icons\/hicolor\/scalable\/apps\/factory-droid-desktop\.svg"/);
  assert.match(recipe, /install -Dm644 build\/brand\/factory\.png "\$pkgdir\/usr\/share\/icons\/hicolor\/256x256\/apps\/factory-droid-desktop\.png"/);
  // The independent commands keep their own names: they are contracts of
  // their own, not part of the product name.
  assert.match(recipe, /install -Dm755 packaging\/factory-usage "\$pkgdir\/usr\/bin\/factory-usage"/);
  assert.match(recipe, /install -Dm755 packaging\/factory-callback "\$pkgdir\/usr\/bin\/factory-callback"/);
});

test('the desktop entry names the product and its command', async () => {
  const entry = await read('packaging', DESKTOP_ENTRY);
  assert.match(entry, /^Name=Factory Droid Desktop$/m);
  assert.match(entry, /^Comment=Unofficial Factory Droid Desktop port$/m);
  assert.match(entry, /^Exec=factory-droid-desktop %u$/m);
  assert.match(entry, /^TryExec=factory-droid-desktop$/m);
  assert.match(entry, /^Icon=factory-droid-desktop$/m);
  const result = spawnSync('desktop-file-validate',
    [path.join(ROOT, 'packaging', DESKTOP_ENTRY)], { encoding: 'utf8' });
  if (result.error) {
    assert.fail(`desktop-file-validate is not available: ${result.error.message}`);
  }
  assert.equal(result.status, 0, result.stderr);
});

test('the desktop entry carries the window class the payload produces', async () => {
  // Chromium derives the window class from the product name: lowercased,
  // with the spaces turned into hyphens. Measured on the pinned Electron
  // 42.11.15, where "Factory" produced the class "factory" and "Factory
  // Droid Desktop" produced "factory-droid-desktop", in the X11
  // `WM_CLASS` property and in the Wayland application id alike. The
  // entry has to spell it the way the window does: an entry that kept
  // the upstream class would launch the app but not match its window.
  const windowClass = name => name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  assert.equal(windowClass(PRODUCT_NAME), 'factory-droid-desktop');
  assert.equal(windowClass(PRODUCT_NAME), PRODUCT_SLUG);
  const entry = await read('packaging', DESKTOP_ENTRY);
  assert.match(entry, /^StartupWMClass=factory-droid-desktop$/m);
  assert.ok(!/^StartupWMClass=Factory$/m.test(entry),
    'the upstream window class is gone with the rename');
  // The class is the name of the desktop entry too, on Wayland.
  assert.equal(DESKTOP_ENTRY, 'factory-droid-desktop.desktop');
});

test('the command wrappers point at the installed bundle', async () => {
  for (const [file, target] of [
    ['factory-droid-desktop', 'launch.sh'],
    ['factory-usage', 'factory-usage.sh'],
    ['factory-callback', 'factory-callback.sh'],
  ]) {
    const wrapper = await read('packaging', file);
    assert.equal(wrapper.trim(),
      `#!/bin/sh\nexec /opt/${PRODUCT_SLUG}/port/${target} "$@"`,
      `packaging/${file}`);
  }
});

test('the launcher keeps its state under the new data directory', async () => {
  const launcher = await read('runtime', 'launch.sh');
  assert.match(launcher, /DATA="\$\{XDG_DATA_HOME:-\$HOME\/\.local\/share\}\/factory-droid-desktop"/);
  assert.match(launcher, /FACTORY_HOME_OVERRIDE="\$DATA\/factory-home"/);
});

test('the collector and the callback follow the new profile', async () => {
  for (const file of ['runtime/collector.py', 'runtime/local_usage.py',
    'omarchy/factory-usage-service/runtime/collector.py',
    'omarchy/factory-usage-service/runtime/local_usage.py']) {
    const source = await read(file);
    assert.ok(source.includes('"factory-droid-desktop"'), `${file} must use the new data directory`);
    assert.ok(!source.includes('"factory-desktop-arch"'), `${file} must not use the old data directory`);
  }
  const callback = await read('runtime', 'factory-callback.py');
  assert.match(callback, /^DESKTOP_ID = "factory-droid-desktop-callback\.desktop"$/m);
  assert.match(callback, /^STATE_DIRNAME = "factory-droid-desktop"$/m);
  // The upstream scheme is a contract of the vendor's protocol and does not
  // change with the product name.
  assert.match(callback, /^SCHEME = "x-scheme-handler\/factory-desktop"$/m);
  assert.match(callback, /^Exec=factory-droid-desktop %u$/m);
});

test('the shipped application carries the port name and sets it at runtime', async () => {
  // The official manifest names the application "Factory"; only that field
  // is rewritten, and only when it is there exactly once.
  const rewritten = applyAppIdentity('{\n  "name": "desktop",\n  "productName": "Factory",\n  "version": "0.205.0"\n}\n');
  assert.match(rewritten, /"productName": "Factory Droid Desktop"/);
  assert.match(rewritten, /"name": "desktop"/);
  assert.match(rewritten, /"version": "0.205.0"/);
  assert.throws(() => applyAppIdentity('{\n  "name": "desktop"\n}\n'));
  assert.throws(() => applyAppIdentity('{"productName": "Factory", "other": {"productName": "Factory"}}'));

  // The main process sets the same name before the first window exists.
  const names = new Map(changes.map(([name]) => [name, name]));
  assert.ok(names.has('application name'), 'the main process must set the application name');
  const source = changes.map(([, before]) => before).join('\n');
  assert.ok(patch(source).includes(`T.app.setName("${PRODUCT_NAME}")`));
  // The desktop entry name follows the package name, so the window and the
  // launcher entry describe the same application.
  assert.ok(patch(source).includes(`T.app.setDesktopName("${DESKTOP_ENTRY}")`));
});

test('the build keeps the vendor snapshot pristine and rewrites the name after it', async () => {
  const build = await read('tools', 'build.mjs');
  const snapshot = build.indexOf('writeVendorSnapshot(app)');
  const identity = build.indexOf('applyAppIdentity(');
  assert.ok(snapshot >= 0 && identity > snapshot,
    'the official snapshot must be written before the application name changes');
});

test('the old slug is gone from the shipped tree', async () => {
  const stale = [];
  for (const dir of ['tools', 'runtime', 'packaging']) {
    const root = path.join(ROOT, dir);
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const file = path.join(root, entry.name);
      const source = await readFile(file, 'utf8');
      // The identity module owns the previous package name: it is the
      // name the rename contract is written against.
      if (path.relative(ROOT, file) === 'tools/app-identity.mjs') continue;
      if (source.includes(OLD_SLUG)) stale.push(path.relative(ROOT, file));
    }
  }
  assert.deepEqual(stale, [], 'the old slug must not survive in the shipped tree');
});

test('the technical slug has exactly one owner', async () => {
  // The bundle path is derived from the canonical slug, not from a second
  // literal: the builder and the verifier must not carry their own.
  const bundle = await outputBundle();
  assert.equal(path.basename(bundle), `${PRODUCT_SLUG}-${versions.desktop}`);
  const owners = [];
  for (const entry of await readdir(path.join(ROOT, 'tools'), { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.mjs')) continue;
    const source = await read('tools', entry.name);
    if (source.includes(PRODUCT_SLUG)) owners.push(entry.name);
  }
  assert.deepEqual(owners, ['app-identity.mjs'],
    'the technical slug may only live in its owner module');
  // The owner is a leaf: it imports nothing, so no cycle can form.
  const identity = await read('tools', 'app-identity.mjs');
  assert.ok(!/^\s*import\s/m.test(identity),
    'the identity module must not import anything');
});

test('the package metadata check uses the keys makepkg really writes', async () => {
  // makepkg serializes PKGBUILD's plural `conflicts` array under the
  // singular `conflict` key. These are the metadata lines of the real
  // renamed package, as they were written.
  assert.deepEqual(pkgInfoRelationshipLines(), [
    'conflict = factory-desktop-arch',
    'replaces = factory-desktop-arch',
    'provides = factory-desktop-arch',
  ]);
  // The plural spelling is not a metadata key: the old expectation
  // rejected every correctly built package.
  assert.ok(!pkgInfoRelationshipLines().includes('conflicts = factory-desktop-arch'));
  // The proof checks the real keys through the shared owner, so the
  // mapping cannot drift from the recipe's spelling.
  const proof = await read('tests', 'package-content-proof.mjs');
  assert.match(proof, /pkgInfoRelationshipLines\(\)/);
  // The recipe keeps the plural spelling; only the serialized key differs.
  const recipe = await read('PKGBUILD');
  for (const field of ['conflicts', 'replaces', 'provides']) {
    assert.match(recipe, new RegExp(`^${field}=\\('${PREVIOUS_PACKAGE}'\\)$`, 'm'));
  }
});

test('the README rolls the old callback back before the package is replaced', async () => {
  const readme = await read('README.md');
  const handoverAt = readme.indexOf('#### The handover, in order');
  assert.ok(handoverAt > 0, 'the README must document the handover order');
  const end = readme.indexOf('\n### ', handoverAt);
  const handover = readme.slice(handoverAt, end > 0 ? end : readme.length);
  // The new helper reads only its own journal directory, so it cannot undo
  // a registration made by the old helper.
  assert.match(handover, /cannot undo a registration made by the old helper/);
  const rollback = handover.indexOf('factory-callback rollback');
  const install = handover.indexOf('pacman -U');
  assert.ok(rollback > 0, 'the handover must document the rollback');
  assert.ok(install > 0, 'the handover must document the replacement');
  assert.ok(rollback < install,
    'the old registration must be rolled back before the package is replaced');
});

test('the window title carries the port name and keeps the session title',
  { skip: snapshotPresent ? false : SNAPSHOT_MISSING }, async () => {
    const renderer = await readFile(path.join(SNAPSHOT_APP, versions.renderer), 'utf8');
    let patched = patch(renderer, rendererChanges);
    patched = patch(patched, rendererTitleChanges);
    patched = patch(patched, themeRendererChanges);
    patched = patch(patched, menuRendererChanges);
    patched = patch(patched, remoteControlRendererChanges);
    patched = patch(patched, computerRegistrationRendererChanges);

    // The renderer owns the window title: Electron propagates a page title
    // to the native window.
    const start = patched.indexOf('function hyo(');
    const end = patched.indexOf('function T8c(', start);
    assert.ok(start > 0 && end > start, 'the title hook was not found');
    const hook = patched.slice(start, end);
    const fallback = patched.match(/GGn="([^"]+)"/)?.[1];
    assert.equal(fallback, PRODUCT_NAME, 'the default title must be the port name');

    const run = props => {
      let cleanup;
      const context = {
        document: { title: '' },
        GGn: fallback,
        fyo: {},
        z: { c: n => Array(n) },
        Cs: () => () => {},
        Zt: effect => { cleanup = effect(); },
        props,
      };
      vm.runInNewContext(`${hook};hyo(props);`, context, { timeout: 1000 });
      return { context, cleanup: () => cleanup() };
    };

    // An untitled view shows the port name.
    const untitled = run({});
    assert.equal(untitled.context.document.title, PRODUCT_NAME);
    untitled.cleanup();
    assert.equal(untitled.context.document.title, PRODUCT_NAME);
    // A session keeps its own title and gains the port name as suffix.
    const session = run({ title: 'Review fixture', isSessionTitle: true });
    assert.equal(session.context.document.title, `Review fixture - ${PRODUCT_NAME}`);
    session.cleanup();
    assert.equal(session.context.document.title, PRODUCT_NAME);

    // The page carries the same name before the renderer takes over.
    const html = await readFile(path.join(SNAPSHOT_APP, versions.rendererHtml), 'utf8');
    assert.match(html, /<title>Factory<\/title>/, 'the upstream title is the source');
    assert.match(patch(html, htmlTitleChanges), new RegExp(`<title>${PRODUCT_NAME}</title>`));
    assert.ok(!patch(html, htmlTitleChanges).includes('<title>Factory</title>'));
  });

test('the upstream names that are contracts stay untouched', async () => {
  // The vendor's own product name, the protocol scheme and the internal
  // Electron binary are not the port's name and must not be renamed.
  const notice = await read('packaging', 'NOTICE');
  assert.match(notice, /Factory Desktop and Droid are proprietary products of The San Francisco AI/);
  assert.match(notice, /Factory Droid Desktop is an unofficial, experimental, personal-use port\./);
  const license = await read('LICENSE');
  assert.match(license, /^MIT License$/m);
  const collector = await read('runtime', 'collector.py');
  assert.match(collector, /electron = bundle \/ "factory-desktop"/);
  // The CLI and the SDK keep their own storage: the desktop profile is
  // separate from the CLI profile.
  const usage = await read('runtime', 'local_usage.py');
  assert.match(usage, /\("cli", home \/ "\.factory" \/ "sessions"\)/);
});
