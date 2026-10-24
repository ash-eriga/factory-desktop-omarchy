// Regression tests for the generated brand assets, for the recovery of a
// reused bundle and for the clean packaging path.
//
// The brand assets are generated from the checksum-pinned official
// payload, so no copy of the mark is committed. These tests use
// SYNTHETIC geometry only: the vendor logo is never embedded in a
// fixture. The module under test is the real one, copied into a
// temporary tree with its own versions.json (fake pins, a short real
// anchor) and its own build directory. The production pins, the
// production destination and the production extraction are exercised;
// only the payload is synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, versions, hashText } from '../tools/common.mjs';
import { buildTileSvg, buildMarkSvg } from '../tools/brand-assets.mjs';

// A synthetic path with the same shape as a real one: absolute move,
// relative curves, closing command.
const SYNTHETIC_ANCHOR = 'M10 20';
const SYNTHETIC_PATH = 'M10 20C11 21 12 22 13 23L14 24Z';
const SYNTHETIC_SOURCE = `const a={d:"${SYNTHETIC_PATH}"};const b='<svg><path d="${SYNTHETIC_PATH}"/></svg>';`;
const SYNTHETIC_DIGEST = hashText(SYNTHETIC_PATH);

// The expected generated outputs. This oracle belongs to the test: the
// production module keeps no second list of names, the command derives
// the names it announces from the structure that writes the files.
const EXPECTED_OUTPUTS = ['factory-mark-light.svg', 'factory-mark.svg', 'factory.png', 'factory.svg'];

const rsvg = spawnSync('rsvg-convert', ['--version'], { encoding: 'utf8' }).status === 0;

// A temporary tree with the real tools, its own versions.json (fake
// pins) and a synthetic pristine renderer. The module resolves its own
// root from its own location, so the fixture exercises the production
// pins and the production destination instead of a test-only override.
async function brandFixture({ pins = {}, prefix = 'factory-brand-fixture-' } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  await mkdir(path.join(dir, 'tools'), { recursive: true });
  await cp(path.join(ROOT, 'tools', 'brand-assets.mjs'), path.join(dir, 'tools', 'brand-assets.mjs'));
  await cp(path.join(ROOT, 'tools', 'common.mjs'), path.join(dir, 'tools', 'common.mjs'));
  // common.mjs derives the bundle path from the identity module, so the
  // fixture carries that module too.
  await cp(path.join(ROOT, 'tools', 'app-identity.mjs'), path.join(dir, 'tools', 'app-identity.mjs'));
  await writeFile(path.join(dir, 'versions.json'), JSON.stringify({
    ...versions,
    brandRotorAnchor: SYNTHETIC_ANCHOR,
    brandRotorSha256: SYNTHETIC_DIGEST,
    brandRotorOccurrences: 2,
    ...pins,
  }, null, 2));
  const renderer = path.join(dir, 'build', `upstream-pristine-${versions.desktop}`,
    'app', versions.renderer);
  await mkdir(path.dirname(renderer), { recursive: true });
  await writeFile(renderer, SYNTHETIC_SOURCE);
  const module = await import(pathToFileURL(path.join(dir, 'tools', 'brand-assets.mjs')).href);
  return { dir, module, brandDir: path.join(dir, 'build', 'brand') };
}

test('the rotor path is extracted from the official source, data only', async () => {
  const { dir, module } = await brandFixture();
  try {
    assert.equal(module.extractRotorPath(SYNTHETIC_SOURCE), SYNTHETIC_PATH);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a changed geometry is refused by the pinned digest', async () => {
  const { dir, module } = await brandFixture({ pins: { brandRotorSha256: '0'.repeat(64) } });
  try {
    assert.throws(() => module.extractRotorPath(SYNTHETIC_SOURCE), /digest mismatch/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a changed occurrence count is refused', async () => {
  const { dir, module } = await brandFixture({ pins: { brandRotorOccurrences: 3 } });
  try {
    assert.throws(() => module.extractRotorPath(SYNTHETIC_SOURCE), /occurrence count changed/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('two different geometries in the same source are refused', async () => {
  const { dir, module } = await brandFixture();
  try {
    const source = `const a={d:"${SYNTHETIC_PATH}"};const b={d:"${SYNTHETIC_ANCHOR}C1 2 3 4Z"};`;
    assert.throws(() => module.extractRotorPath(source), /not unique/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a missing path is refused', async () => {
  const { dir, module } = await brandFixture();
  try {
    assert.throws(() => module.extractRotorPath('const a=1;'), /not found/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('unexpected characters in the path are refused', async () => {
  const { dir, module } = await brandFixture();
  try {
    const source = `const a={d:"${SYNTHETIC_ANCHOR} javascript:alert(1)"};`
      + `const b={d:"${SYNTHETIC_ANCHOR} javascript:alert(1)"};`;
    assert.throws(() => module.extractRotorPath(source), /Unexpected characters/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the generated documents carry the geometry once, inside the port wrapper', () => {
  const tile = buildTileSvg(SYNTHETIC_PATH);
  assert.match(tile, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 512 512">/);
  assert.equal(tile.split(`d="${SYNTHETIC_PATH}"`).length - 1, 1);
  assert.match(tile, /<rect width="512" height="512" rx="112" fill="#171717"\/>/);
  assert.match(tile, /<path d="[^"]+" fill="#ffffff"\/>/);
  const mark = buildMarkSvg(SYNTHETIC_PATH, '#111111');
  assert.match(mark, /viewBox="100 90 700 700"/);
  assert.equal(mark.split(`d="${SYNTHETIC_PATH}"`).length - 1, 1);
  assert.match(mark, /fill="#111111"/);
});

test('the generated assets are written to the module\'s own destination', {
  skip: rsvg ? false : 'rsvg-convert is not available on this machine',
}, async () => {
  const { dir, module, brandDir } = await brandFixture();
  try {
    const written = await module.writeBrandAssets(SYNTHETIC_SOURCE);
    assert.deepEqual((await readdir(brandDir)).sort(), EXPECTED_OUTPUTS);
    assert.deepEqual(written, EXPECTED_OUTPUTS, 'the writer reports the files it wrote');
    for (const name of EXPECTED_OUTPUTS) await access(path.join(brandDir, name));
    const png = await readFile(path.join(brandDir, 'factory.png'));
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'a real PNG was rendered');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the reuse restores every output that is missing', {
  skip: rsvg ? false : 'rsvg-convert is not available on this machine',
}, async () => {
  const { dir, module, brandDir } = await brandFixture();
  try {
    await module.writeBrandAssets(SYNTHETIC_SOURCE);
    const before = new Map();
    for (const name of EXPECTED_OUTPUTS)
      before.set(name, await readFile(path.join(brandDir, name)));
    // One missing file at a time: the reuse must restore exactly that
    // one, with the pinned content.
    for (const name of EXPECTED_OUTPUTS) {
      await rm(path.join(brandDir, name));
      const restored = await module.ensureBrandAssets(SYNTHETIC_SOURCE);
      assert.deepEqual(restored, [name], `the missing ${name} must be reported`);
      assert.deepEqual(await readFile(path.join(brandDir, name)), before.get(name),
        `the missing ${name} must be restored`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the reuse replaces an altered output', {
  skip: rsvg ? false : 'rsvg-convert is not available on this machine',
}, async () => {
  const { dir, module, brandDir } = await brandFixture();
  try {
    await module.writeBrandAssets(SYNTHETIC_SOURCE);
    const before = new Map();
    for (const name of EXPECTED_OUTPUTS)
      before.set(name, await readFile(path.join(brandDir, name)));
    await writeFile(path.join(brandDir, 'factory.svg'), '<svg>corrupted</svg>');
    assert.deepEqual(await module.ensureBrandAssets(SYNTHETIC_SOURCE), ['factory.svg']);
    assert.deepEqual(await readFile(path.join(brandDir, 'factory.svg')), before.get('factory.svg'));
    await writeFile(path.join(brandDir, 'factory.png'), 'not a png');
    assert.deepEqual(await module.ensureBrandAssets(SYNTHETIC_SOURCE), ['factory.png']);
    assert.deepEqual(await readFile(path.join(brandDir, 'factory.png')), before.get('factory.png'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the brand command runs from a checkout path with spaces, accents and #', {
  skip: rsvg ? false : 'rsvg-convert is not available on this machine',
}, async () => {
  // The command is documented as `npm run brand`: it must work from the
  // directory the user cloned or unpacked, whatever its name is.
  const { dir, brandDir } = await brandFixture({ prefix: 'factory brand espaço #1-' });
  try {
    const result = spawnSync(process.execPath, ['tools/brand-assets.mjs'], {
      cwd: dir, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /factory\.svg/);
    assert.deepEqual((await readdir(brandDir)).sort(),
      ['factory-mark-light.svg', 'factory-mark.svg', 'factory.png', 'factory.svg']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the command announces exactly the files it wrote', {
  skip: rsvg ? false : 'rsvg-convert is not available on this machine',
}, async () => {
  // The announced names must be the names of the files that were
  // produced. A list that merely repeats the inventory of the writer
  // would announce something else.
  const { dir, brandDir } = await brandFixture({ prefix: 'factory brand inventory-' });
  try {
    const result = spawnSync(process.execPath, ['tools/brand-assets.mjs'], {
      cwd: dir, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const line = result.stdout.trim();
    assert.match(line, /^Generated .+ in build\/brand$/);
    const announced = line.replace(/^Generated /, '').replace(/ in build\/brand$/, '').split(', ');
    const produced = (await readdir(brandDir)).sort();
    assert.deepEqual(announced.sort(), produced, 'the announced names are the produced names');
    assert.deepEqual(produced, EXPECTED_OUTPUTS, 'the four expected outputs are produced');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the recipe installs the regenerated icons', {
  skip: rsvg ? false : 'rsvg-convert is not available on this machine',
}, async () => {
  // The recipe's own package() runs on a synthetic tree: a stub bundle,
  // the packaging files and the generated icons. Nothing is installed
  // and no makepkg is involved. The raster is missing when the bundle is
  // reused, so the recovery has to restore it before the recipe can
  // install it.
  const { dir, module, brandDir } = await brandFixture();
  try {
    await module.writeBrandAssets(SYNTHETIC_SOURCE);
    await rm(path.join(brandDir, 'factory.png'));
    assert.deepEqual(await module.ensureBrandAssets(SYNTHETIC_SOURCE), ['factory.png']);
    await cp(path.join(ROOT, 'packaging'), path.join(dir, 'packaging'), { recursive: true });
    await cp(path.join(ROOT, 'omarchy'), path.join(dir, 'omarchy'), { recursive: true });
    await cp(path.join(ROOT, 'LICENSE'), path.join(dir, 'LICENSE'));
    await cp(path.join(ROOT, 'PKGBUILD'), path.join(dir, 'PKGBUILD'));
    const bundle = path.join(dir, 'dist', `factory-droid-desktop-${versions.desktop}`);
    await mkdir(bundle, { recursive: true });
    await writeFile(path.join(bundle, 'factory-desktop'), 'stub');
    const pkgdir = path.join(dir, 'pkg');
    const result = spawnSync('bash', ['-c',
      'source "$1" >/dev/null 2>&1; pkgdir="$2"; startdir="$3"; package',
      'bash', path.join(dir, 'PKGBUILD'), pkgdir, dir], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const packaged = async (...parts) => readFile(path.join(pkgdir, ...parts));
    assert.equal((await packaged('usr/share/icons/hicolor/scalable/apps/factory-droid-desktop.svg')).toString(),
      (await readFile(path.join(brandDir, 'factory.svg'))).toString());
    const raster = await packaged('usr/share/icons/hicolor/256x256/apps/factory-droid-desktop.png');
    assert.equal(raster.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal((await packaged('usr/share/doc/factory-droid-desktop/omarchy/factory-usage-service/assets/factory.svg')).toString(),
      (await readFile(path.join(brandDir, 'factory-mark.svg'))).toString());
    assert.equal((await packaged('usr/share/doc/factory-droid-desktop/omarchy/factory-usage-service/assets/factory-light.svg')).toString(),
      (await readFile(path.join(brandDir, 'factory-mark-light.svg'))).toString());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the pinned rotor values are well formed', () => {
  assert.match(versions.brandRotorSha256, /^[a-f0-9]{64}$/);
  assert.ok(Number.isInteger(versions.brandRotorOccurrences) && versions.brandRotorOccurrences > 0);
  assert.match(versions.brandRotorAnchor, /^M[\d.]+ [\d.]+$/);
});

test('the package path uses the generated icons, not a committed copy', async () => {
  // No copy of the mark is committed: the recipe installs the generated
  // files, and the build writes them from the official payload.
  await assert.rejects(access(path.join(ROOT, 'packaging', 'factory.svg')));
  await assert.rejects(access(path.join(ROOT, 'packaging', 'factory.png')));
  const recipe = await readFile(path.join(ROOT, 'PKGBUILD'), 'utf8');
  assert.match(recipe, /install -Dm644 build\/brand\/factory\.svg/);
  assert.match(recipe, /install -Dm644 build\/brand\/factory\.png/);
  assert.match(recipe, /makedepends=\([^)]*librsvg/);
  // The recovery of the generated icons belongs to the build that
  // reuses the bundle. The recipe must not repeat that decision with a
  // second, weaker guard.
  assert.doesNotMatch(recipe, /if \[\[ ! -f build\/brand\//);
  assert.match(recipe, /^ {2}npm run build$/m);
});
