// The source archive and the unified packaging.
//
// The archive is the one artifact both packaging workflows use: the
// GitHub clone builds it locally, the AUR recipe downloads the very same
// bytes from the release. These tests check that the archive is
// deterministic, that it carries the port's own sources and nothing
// else, that the recipe pins it, and that an AUR checkout with only the
// recipe, its metadata and the license builds from the same tree.
//
// The tests drive the production command itself, in real temporary
// source trees, and never a seam of it: a tree that carries no git
// index has to work, because a release download, a source ZIP and an
// AUR checkout carry none.
//
// Everything here is offline: no network, no credentials, no package
// build, no installed package.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, hash, recipeFingerprint, recipeInputList } from '../tools/common.mjs';

const RECIPE = path.join(ROOT, 'PKGBUILD');
const SRCINFO = path.join(ROOT, '.SRCINFO');
const INVENTORY = path.join(ROOT, 'packaging/source-inventory.json');

function haveMakepkg() {
  return spawnSync('makepkg', ['--version'], { encoding: 'utf8' }).status === 0;
}

// The maintainer's mode reads the tracked files of a checkout, so it
// needs git. The default mode does not.
function haveGit() {
  return spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
}

// The recipe's own source and digest, read by sourcing the recipe with
// bash the way makepkg does.
function recipeValues(root) {
  const script = `
set -u
source "$1"
for value in \${source[@]+"\${source[@]}"}; do
  printf 'source=%s\\n' "$value"
done
for value in \${sha256sums[@]+"\${sha256sums[@]}"}; do
  printf 'sha256sums=%s\\n' "$value"
done
`;
  const result = spawnSync('bash', ['-c', script, 'bash', path.join(root, 'PKGBUILD')],
    { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const values = new Map();
  for (const line of result.stdout.split('\n')) {
    if (!line) continue;
    const separator = line.indexOf('=');
    const key = line.slice(0, separator);
    if (!values.has(key)) values.set(key, []);
    values.get(key).push(line.slice(separator + 1));
  }
  return values;
}

async function inventory() {
  return JSON.parse(await readFile(INVENTORY, 'utf8'));
}

// A source tree of the port: the files the archive is built from, plus
// the recipe and its metadata, which travel with the packaging workflow
// and not with the archive. Nothing else: no git index, no build output.
async function sourceTree(dir) {
  const files = (await inventory()).files;
  for (const entry of files) {
    const target = path.join(dir, entry.path);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(ROOT, entry.path), target);
    await chmod(target, entry.mode === '0755' ? 0o755 : 0o644);
  }
  await copyFile(RECIPE, path.join(dir, 'PKGBUILD'));
  await copyFile(SRCINFO, path.join(dir, '.SRCINFO'));
  return files;
}

// The production command, in the tree it belongs to.
function runTool(dir, args = [], options = {}) {
  return spawnSync(process.execPath, [path.join(dir, 'tools', 'package-sources.mjs'), ...args],
    { cwd: dir, encoding: 'utf8', ...options });
}

// A PATH that holds the tools the command needs and nothing else: git
// is not among them, so a command that reached for a git index would
// fail instead of silently working.
//
// A makepkg of our own may join it: the real one writes the metadata of
// the recipe, and the tests need one that answers, one that fails and
// one that is not there at all.
async function toolPath(tools, makepkg = null) {
  const dir = await mkdtemp(path.join(tmpdir(), 'factory-path-'));
  for (const tool of tools) {
    const found = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' });
    assert.equal(found.status, 0, `${tool} must be installed`);
    await symlink(found.stdout.trim(), path.join(dir, tool));
  }
  if (makepkg === 'fixture') await writeMakepkg(dir, MAKEPKG_ANSWER);
  if (makepkg === 'failing') await writeMakepkg(dir, MAKEPKG_FAILURE);
  return dir;
}

// A PATH that holds every tool of the system except one. The test is
// then about the missing tool and not about a stripped environment: a
// source archive that needs nothing but the tools of a build machine
// has to work without the one that is left out.
async function toolPathExcept(missing) {
  const dir = await mkdtemp(path.join(tmpdir(), 'factory-path-'));
  const found = spawnSync('sh', ['-c', 'command -v sh'], { encoding: 'utf8' });
  assert.equal(found.status, 0, 'sh must be installed');
  const system = path.dirname(found.stdout.trim());
  const entries = (await readdir(system)).filter(entry => entry !== missing);
  for (let index = 0; index < entries.length; index += 256) {
    const chunk = entries.slice(index, index + 256);
    await Promise.all(chunk.map(entry =>
      symlink(path.join(system, entry), path.join(dir, entry))));
  }
  return dir;
}

// A makepkg that answers the metadata request from the recipe it is
// asked about. It is a fixture, not a second implementation of the
// metadata: it only says what the recipe pins.
const MAKEPKG_ANSWER = [
  '#!/bin/bash',
  'case "$1" in',
  '  --version) echo "makepkg (fixture) 0"; exit 0 ;;',
  '  --printsrcinfo)',
  '    digest=""',
  '    while read -r line; do',
  '      case "$line" in',
  '        sha256sums=*) digest="${line#sha256sums=\'}"; digest="${digest%\')}" ;;',
  '      esac',
  '    done < PKGBUILD',
  '    if [ -z "$digest" ]; then echo "makepkg: no digest in the recipe" >&2; exit 1; fi',
  '    echo "pkgbase = factory-droid-desktop"',
  '    printf \'\\tsha256sums = %s\\n\' "$digest"',
  '    exit 0 ;;',
  'esac',
  'exit 1',
  '',
].join('\n');

// A makepkg that answers the version and fails the metadata, the way a
// broken installation does.
const MAKEPKG_FAILURE = [
  '#!/bin/bash',
  'case "$1" in',
  '  --version) echo "makepkg (fixture) 0"; exit 0 ;;',
  '  --printsrcinfo) echo "makepkg: the fixture fails" >&2; exit 1 ;;',
  'esac',
  'exit 1',
  '',
].join('\n');

async function writeMakepkg(dir, script) {
  const file = path.join(dir, 'makepkg');
  await writeFile(file, script);
  await chmod(file, 0o755);
}

// The environment of the git commands of a test: no global
// configuration, no system configuration and no identity. Nothing is
// committed and nothing is written outside the temporary tree.
function gitEnvironment() {
  return { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
}

// A checkout of its own: the maintainer's mode reads the tracked files
// of a real repository, so the tests give it one.
async function gitCheckout(dir) {
  const env = { ...process.env, ...gitEnvironment() };
  const init = spawnSync('git', ['init', '-q'], { cwd: dir, encoding: 'utf8', env });
  assert.equal(init.status, 0, init.stderr);
  const add = spawnSync('git', ['add', '-A'], { cwd: dir, encoding: 'utf8', env });
  assert.equal(add.status, 0, add.stderr);
}

// The bytes and the mode of the files a maintainer's mode writes.
async function metadataState(dir) {
  const state = {};
  for (const relative of ['PKGBUILD', '.SRCINFO', 'packaging/source-inventory.json']) {
    const file = path.join(dir, relative);
    const info = await lstat(file);
    state[relative] = {
      bytes: (await readFile(file)).toString('base64'),
      mode: info.mode & 0o7777,
    };
  }
  return state;
}

// The maintainer's mode reads the tracked files of a checkout, so it
// needs git and a checkout of its own. Where git is not installed the
// mode has to refuse the update instead of guessing: the refusal is
// asserted, the tree is checked for what it wrote, and no test is
// skipped. The default mode keeps its own assertions either way.
async function maintainerCheckout(trees, body, options = {}) {
  const list = Array.isArray(trees) ? trees : [trees];
  if (!haveGit()) {
    for (const tree of list) {
      const before = await metadataState(tree);
      const refused = runTool(tree, ['--update'], options);
      assert.notEqual(refused.status, 0, 'the maintainer\'s mode needs a checkout of its own');
      assert.match(refused.stderr, /git/i, `the refusal must name git: ${refused.stderr}`);
      assert.deepEqual(await metadataState(tree), before,
        'a refused maintainer\'s mode must not write anything');
      assert.ok(!await exists(path.join(tree, 'build', `${archiveName()}.pending`)),
        'a refused maintainer\'s mode must leave no pending archive');
    }
    return false;
  }
  for (const tree of list) await gitCheckout(tree);
  // Ubuntu CI has no makepkg. Keep exercising the update/failure paths
  // there with the existing metadata fixture; exact metadata is checked
  // separately when the real makepkg is installed.
  const sandbox = haveMakepkg() ? null : await toolPath(['bash', 'tar', 'gzip', 'git'], 'fixture');
  try {
    await body(sandbox ? { ...process.env, PATH: sandbox } : { ...process.env });
  } finally {
    if (sandbox) await rm(sandbox, { recursive: true, force: true });
  }
  return true;
}

function archiveName() {
  const source = recipeValues(ROOT).get('source') || [];
  assert.equal(source.length, 1, 'the recipe must declare exactly one source archive');
  return path.posix.basename(source[0]);
}

function topLevelName() {
  return archiveName().replace(/\.tar\.gz$/, '');
}

async function exists(target) {
  return Boolean(await lstat(target).catch(() => null));
}

function listing(archive) {
  return spawnSync('tar', ['-tzf', archive], { encoding: 'utf8' }).stdout
    .split('\n').filter(Boolean);
}

// The archive the command builds in a tree, built in that tree.
async function buildArchive(tree) {
  const result = runTool(tree);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  return path.join(tree, 'build', archiveName());
}

test('the source archive is byte-identical across paths, times and umasks', async () => {
  const work = await mkdtemp(path.join(tmpdir(), 'factory-archive-'));
  try {
    const first = path.join(work, 'first');
    const second = path.join(work, 'second');
    await mkdir(first, { recursive: true });
    await mkdir(second, { recursive: true });
    await sourceTree(first);
    await sourceTree(second);
    // Another path, other timestamps, another umask: the bytes may not
    // depend on any of them.
    for (const entry of await readdir(path.join(second, 'tools'), { withFileTypes: true })) {
      await utimes(path.join(second, 'tools', entry.name), new Date(1000000), new Date(1000000));
    }
    const previous = process.umask(0o077);
    try {
      const firstArchive = await buildArchive(first);
      const secondArchive = await buildArchive(second);
      assert.equal(await hash(secondArchive), await hash(firstArchive),
        'the archive must not depend on the path, the timestamps or the umask');
      assert.equal(await hash(firstArchive), recipeValues(ROOT).get('sha256sums')[0],
        'the archive must be the one the recipe pins');
    } finally {
      process.umask(previous);
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('the archive carries the port\'s sources and nothing else', async () => {
  const files = (await inventory()).files.map(entry => entry.path);
  for (const required of [
    'package.json', 'package-lock.json', 'versions.json', 'LICENSE', 'README.md',
    'CONTRIBUTING.md', 'tools/build.mjs', 'tools/common.mjs', 'tools/package-sources.mjs',
    'runtime/launch.sh', 'runtime/collector.py', 'packaging/factory-droid-desktop',
    'packaging/NOTICE', 'packaging/source-inventory.json',
    'tests/package-content-proof.mjs', 'docs/architecture.md',
  ]) {
    assert.ok(files.includes(required), `the archive must carry ${required}`);
  }
  // The recipe files travel with the packaging workflow, not with the
  // archive: a checksum inside the recipe cannot cover the recipe.
  assert.ok(!files.includes('PKGBUILD'));
  assert.ok(!files.includes('.SRCINFO'));
  // The CI tree and the benchmarks are the repository's own, not the
  // port's sources.
  assert.ok(!files.some(file => file.startsWith('.github/')));
  assert.ok(!files.some(file => file.startsWith('benchmarks/')));
  // Every file of every source tree is named, so no source can be
  // shipped that the inventory does not declare.
  const trees = new Set(files.filter(file => file.includes('/')).map(file => file.split('/')[0]));
  assert.deepEqual([...trees].sort(), ['docs', 'packaging', 'runtime', 'tests', 'tools']);

  // Every input of the recipe fingerprint is a source of the archive,
  // except the recipe itself: the packaging workflow provides it and
  // copies it into the source root.
  for (const input of await recipeInputList(ROOT)) {
    if (input === 'PKGBUILD') continue;
    assert.ok(files.includes(input), `the archive must carry the recipe input ${input}`);
  }
});

test('the archive itself holds no payload and no build output', async () => {
  const work = await mkdtemp(path.join(tmpdir(), 'factory-archive-'));
  try {
    const tree = path.join(work, 'tree');
    await mkdir(tree, { recursive: true });
    await sourceTree(tree);
    const archive = await buildArchive(tree);
    const topLevel = topLevelName();
    const names = listing(archive);
    assert.ok(names.length > 0);
    for (const name of names) {
      assert.ok(name.startsWith(`${topLevel}/`), `the archive root is ${topLevel}: ${name}`);
      assert.ok(!name.includes('/../') && !name.startsWith('/'));
      assert.ok(!name.includes('node_modules/') && !name.includes('/build/')
        && !name.includes('/dist/') && !name.includes('/.git/'));
    }
    assert.ok(names.some(name => name.endsWith('tools/package-sources.mjs')));
    assert.ok(names.some(name => name.endsWith('packaging/source-inventory.json')));
    assert.ok(!names.some(name => name.endsWith('/PKGBUILD')));
    assert.ok(!names.some(name => name.endsWith('/.SRCINFO')));
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('the source inventory holds no payload, no credential and no personal file', async () => {
  const files = await inventory();
  assert.equal(files.format, 1);
  for (const entry of files.files) {
    const relative = entry.path;
    assert.ok(relative && !relative.startsWith('/') && !relative.includes('\\'),
      `the inventory must hold a safe path: ${relative}`);
    assert.ok(!relative.split('/').includes('..'), `the inventory must not traverse: ${relative}`);
    for (const segment of relative.split('/')) {
      for (const forbidden of ['.git', 'node_modules', 'build', 'dist', 'pkg', 'src',
        '__pycache__', 'vendor', 'payload', 'profile', 'keyring', 'panel', 'panel-staging'])
        assert.notEqual(segment, forbidden, `the inventory must not hold ${relative}`);
    }
    const base = relative.split('/').pop();
    assert.ok(base !== '.env' && !base.startsWith('.env.'),
      `the inventory must not hold ${relative}`);
    assert.ok(!/\.(?:exe|dll|so|dylib|node|asar|nupkg|zip|tar|gz|png|jpe?g|gif|ico|webp|svg)$/i
      .test(base), `the inventory must not hold the payload file ${relative}`);
    assert.ok(!/\.(?:pem|key|p12|pfx|kdbx|jks|keystore)$/i.test(base),
      `the inventory must not hold the credential file ${relative}`);
    assert.ok(entry.mode === '0644' || entry.mode === '0755',
      `the inventory must state a fixed mode for ${relative}`);
  }
  // The inventory names itself, and it carries no digest of its own
  // contents: the archive's checksum is what covers it.
  assert.ok(files.files.some(entry => entry.path === 'packaging/source-inventory.json'));
  assert.ok(!JSON.stringify(files).match(/[a-f0-9]{64}/),
    'the inventory must not carry a checksum of itself');
});

test('a file the source inventory does not list is refused', async () => {
  const work = await mkdtemp(path.join(tmpdir(), 'factory-unlisted-'));
  try {
    const tree = path.join(work, 'tree');
    await mkdir(tree, { recursive: true });
    await sourceTree(tree);
    // A personal note that was never declared as a source must not
    // reach the release archive.
    await writeFile(path.join(tree, 'tools', 'private-note.txt'), 'local\n');
    const result = runTool(tree);
    assert.notEqual(result.status, 0, 'the archive must not be built from an undeclared file');
    assert.match(result.stderr, /does not list/);
    assert.match(result.stderr, /private-note\.txt/);
    // A refused run leaves no archive behind that nobody verified.
    assert.ok(!await exists(path.join(tree, 'build', archiveName())));
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('the maintainer\'s mode refuses an untracked file and a source it may not carry', async () => {
  const work = await mkdtemp(path.join(tmpdir(), 'factory-update-'));
  try {
    const tree = path.join(work, 'tree');
    await mkdir(tree, { recursive: true });
    await sourceTree(tree);
    const before = {
      recipe: await readFile(path.join(tree, 'PKGBUILD'), 'utf8'),
      srcinfo: await readFile(path.join(tree, '.SRCINFO'), 'utf8'),
      inventory: await readFile(path.join(tree, 'packaging/source-inventory.json'), 'utf8'),
    };

    if (!haveGit()) {
      // Without git there is no checkout to refresh the inventory from,
      // and the maintainer's mode says so instead of guessing.
      const refused = runTool(tree, ['--update']);
      assert.notEqual(refused.status, 0, 'the maintainer\'s mode needs the checkout');
      assert.equal(await readFile(path.join(tree, 'PKGBUILD'), 'utf8'), before.recipe);
      assert.equal(await readFile(path.join(tree, '.SRCINFO'), 'utf8'), before.srcinfo);
      assert.equal(await readFile(path.join(tree, 'packaging/source-inventory.json'), 'utf8'),
        before.inventory);
      return;
    }

    const init = spawnSync('git', ['init', '-q'], { cwd: tree, encoding: 'utf8' });
    assert.equal(init.status, 0, init.stderr);
    const add = spawnSync('git', ['add', '-A'], { cwd: tree, encoding: 'utf8' });
    assert.equal(add.status, 0, add.stderr);

    // A file that was never added to the repository is not a source.
    await writeFile(path.join(tree, 'tools', 'private-note.txt'), 'local\n');
    const untracked = runTool(tree, ['--update']);
    assert.notEqual(untracked.status, 0, 'an untracked file must not reach the archive');
    assert.match(untracked.stderr, /untracked files/);
    assert.match(untracked.stderr, /private-note\.txt/);
    await rm(path.join(tree, 'tools', 'private-note.txt'));

    // And a file that is tracked but may never be shipped is refused
    // as well, whatever shape it has.
    for (const relative of ['tools/vendor/payload.exe', 'runtime/private.key',
      'tests/.env', 'tools/panel-staging/notes.txt']) {
      const target = path.join(tree, relative);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, 'not a source\n');
      const staged = spawnSync('git', ['add', '-A'], { cwd: tree, encoding: 'utf8' });
      assert.equal(staged.status, 0, staged.stderr);
      const refused = runTool(tree, ['--update']);
      assert.notEqual(refused.status, 0, `${relative} must not reach the archive`);
      assert.match(refused.stderr, /Refusing/);
      await rm(target);
    }

    // The refusal wrote nothing: the recipe, the metadata and the
    // inventory are the ones that were checked in.
    assert.equal(await readFile(path.join(tree, 'PKGBUILD'), 'utf8'), before.recipe);
    assert.equal(await readFile(path.join(tree, '.SRCINFO'), 'utf8'), before.srcinfo);
    assert.equal(await readFile(path.join(tree, 'packaging/source-inventory.json'), 'utf8'),
      before.inventory);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('the source inventory is refused when it names an unsafe path', async () => {
  const work = await mkdtemp(path.join(tmpdir(), 'factory-unsafe-'));
  try {
    const tree = path.join(work, 'tree');
    await mkdir(tree, { recursive: true });
    await sourceTree(tree);
    const inventoryPath = path.join(tree, 'packaging/source-inventory.json');
    const original = JSON.parse(await readFile(inventoryPath, 'utf8'));
    for (const [entry, expected] of [
      [{ path: '../../etc/passwd', mode: '0644' }, /traversing/],
      [{ path: '/etc/passwd', mode: '0644' }, /absolute/],
      [{ path: 'tools/../tools/build.mjs', mode: '0644' }, /traversing/],
      [{ path: 'tools/extra.mjs', mode: '0700' }, /mode of 0644 or 0755/],
      [{ path: 'tools/node_modules/left-pad/index.js', mode: '0644' }, /forbidden/],
      [{ path: 'tools/build.mjs', mode: '0755' }, /lists a file twice/],
    ]) {
      const tampered = { format: original.format, files: [...original.files, entry] };
      await writeFile(inventoryPath, `${JSON.stringify(tampered, null, 2)}\n`);
      const result = runTool(tree);
      assert.notEqual(result.status, 0, `the inventory must refuse ${entry.path}`);
      assert.match(result.stderr, expected);
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('a symbolic link in the source tree is refused', async () => {
  const work = await mkdtemp(path.join(tmpdir(), 'factory-link-'));
  try {
    const tree = path.join(work, 'tree');
    await mkdir(tree, { recursive: true });
    await sourceTree(tree);
    // A link in place of a source: the archive holds bytes, not a name
    // that points somewhere else.
    await rm(path.join(tree, 'runtime', 'collector.py'));
    await symlink('/etc/passwd', path.join(tree, 'runtime', 'collector.py'));
    const linked = runTool(tree);
    assert.notEqual(linked.status, 0, 'a symbolic link must not reach the archive');
    assert.match(linked.stderr, /symbolic link/);
    // And a link that the inventory does not know is refused as well.
    await rm(path.join(tree, 'runtime', 'collector.py'));
    await copyFile(path.join(ROOT, 'runtime', 'collector.py'), path.join(tree, 'runtime', 'collector.py'));
    await symlink('/etc/passwd', path.join(tree, 'tools', 'private-link.txt'));
    const unlisted = runTool(tree);
    assert.notEqual(unlisted.status, 0, 'a symbolic link must not reach the archive');
    assert.match(unlisted.stderr, /symbolic link/);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('a source file the tree does not hold is refused', async () => {  const work = await mkdtemp(path.join(tmpdir(), 'factory-missing-'));
  try {
    const tree = path.join(work, 'tree');
    await mkdir(tree, { recursive: true });
    await sourceTree(tree);
    await rm(path.join(tree, 'runtime', 'collector.py'));
    const result = runTool(tree);
    assert.notEqual(result.status, 0, 'a missing source must fail the build');
    assert.match(result.stderr, /does not hold a file the inventory names/);
    assert.match(result.stderr, /collector\.py/);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('a checksum that does not match the sources is refused', async () => {
  const work = await mkdtemp(path.join(tmpdir(), 'factory-tampered-'));
  try {
    const tree = path.join(work, 'tree');
    await mkdir(tree, { recursive: true });
    await sourceTree(tree);
    // A recipe that pins another digest must fail instead of shipping an
    // archive nobody verified.
    const tampered = /^sha256sums=\('[a-f0-9]{64}'\)$/m;
    const recipe = await readFile(path.join(tree, 'PKGBUILD'), 'utf8');
    await writeFile(path.join(tree, 'PKGBUILD'),
      recipe.replace(tampered, `sha256sums=('${'0'.repeat(64)}')`));
    const result = runTool(tree);
    assert.notEqual(result.status, 0, 'a mismatched checksum must fail the build');
    assert.match(result.stderr, /does not match the checksum/);
    // The recipe was not rewritten behind the user's back.
    assert.equal(await readFile(path.join(tree, 'PKGBUILD'), 'utf8'),
      recipe.replace(tampered, `sha256sums=('${'0'.repeat(64)}')`));
    assert.ok(!await exists(path.join(tree, 'build', archiveName())));
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('the default mode never rewrites the recipe, the metadata or the inventory', async () => {
  const work = await mkdtemp(path.join(tmpdir(), 'factory-readonly-'));
  try {
    const tree = path.join(work, 'tree');
    await mkdir(tree, { recursive: true });
    await sourceTree(tree);
    const before = {
      recipe: await readFile(path.join(tree, 'PKGBUILD'), 'utf8'),
      srcinfo: await readFile(path.join(tree, '.SRCINFO'), 'utf8'),
      inventory: await readFile(path.join(tree, 'packaging/source-inventory.json'), 'utf8'),
    };
    const result = runTool(tree);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /matches the pinned checksum/);
    assert.equal(await readFile(path.join(tree, 'PKGBUILD'), 'utf8'), before.recipe);
    assert.equal(await readFile(path.join(tree, '.SRCINFO'), 'utf8'), before.srcinfo);
    assert.equal(await readFile(path.join(tree, 'packaging/source-inventory.json'), 'utf8'),
      before.inventory);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('the default mode runs in a source tree without a git index', async () => {
  const work = await mkdtemp(path.join(tmpdir(), 'factory-nogit-'));
  try {
    const tree = path.join(work, 'tree');
    await mkdir(tree, { recursive: true });
    await sourceTree(tree);
    assert.ok(!await exists(path.join(tree, '.git')),
      'the tree under test must not carry a git index');
    // A PATH without git: a command that reached for a git index would
    // fail here instead of quietly working.
    const sandbox = await toolPath(['bash', 'tar', 'gzip']);
    try {
      const result = runTool(tree, [], {
        env: { ...process.env, PATH: sandbox, LC_ALL: 'C' },
      });
      assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
      assert.match(result.stdout, /matches the pinned checksum/);
      assert.equal(await hash(path.join(tree, 'build', archiveName())),
        recipeValues(ROOT).get('sha256sums')[0],
        'the archive of a tree without a git index must be the pinned one');
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('the recipe pins the digest of the archive the tool builds', async () => {
  const result = runTool(ROOT);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /matches the pinned checksum/);
  const pinned = recipeValues(ROOT).get('sha256sums') || [];
  assert.equal(pinned.length, 1);
  assert.match(pinned[0], /^[a-f0-9]{64}$/);
});

test('the recipe builds from the source tree and never from the checkout', async () => {
  const recipe = await readFile(RECIPE, 'utf8');
  // The build, the check and the package run inside the extracted
  // sources; only the prepare step reads the recipe directory.
  assert.match(recipe, /^build\(\) \{\n {2}cd "\$srcdir\/\$_source_root"$/m);
  assert.match(recipe, /^check\(\) \{\n {2}cd "\$srcdir\/\$_source_root"$/m);
  assert.match(recipe, /^package\(\) \{\n {2}cd "\$srcdir\/\$_source_root"$/m);
  for (const body of [recipe.slice(recipe.indexOf('build() {')),
    recipe.slice(recipe.indexOf('check() {')), recipe.slice(recipe.indexOf('package() {'))]) {
    assert.ok(!body.includes('$startdir'), 'the build may not read the checkout');
  }
  // The canonical recipe travels with the sources.
  assert.match(recipe, /install -Dm644 "\$startdir\/PKGBUILD" "\$srcdir\/\$_source_root\/PKGBUILD"/);
  assert.match(recipe, /install -Dm644 "\$startdir\/\.SRCINFO" "\$srcdir\/\$_source_root\/\.SRCINFO"/);
  // The archive is a real source with a real digest.
  assert.match(recipe,
    /^source=\('https:\/\/github\.com\/ash-eriga\/factory-droid-desktop\/releases\/download\/v[0-9.]+-[0-9]+\/factory-droid-desktop-port-[0-9.]+-[0-9]+\.tar\.gz'\)$/m);
  assert.match(recipe, /^sha256sums=\('[a-f0-9]{64}'\)$/m);
  // The rename and the packaging change keep their shape.
  assert.match(recipe, /^pkgrel=15$/m);
  for (const field of ['conflicts', 'replaces', 'provides'])
    assert.match(recipe, new RegExp(`^${field}=\\('factory-desktop-arch'\\)$`, 'm'));
});

test('the AUR checkout builds from the same sources as the clone', async () => {
  const work = await mkdtemp(path.join(tmpdir(), 'factory-aur-'));
  try {
    // The AUR holds the recipe, its metadata and the license. Nothing else.
    const aur = path.join(work, 'aur');
    await mkdir(aur, { recursive: true });
    await copyFile(RECIPE, path.join(aur, 'PKGBUILD'));
    await copyFile(SRCINFO, path.join(aur, '.SRCINFO'));
    await copyFile(path.join(ROOT, 'LICENSE'), path.join(aur, 'LICENSE'));

    // The archive is downloaded and unpacked the way makepkg does it.
    const tree = path.join(work, 'tree');
    await mkdir(tree, { recursive: true });
    await sourceTree(tree);
    const archive = await buildArchive(tree);
    const srcdir = path.join(aur, 'src');
    await mkdir(srcdir, { recursive: true });
    const unpack = spawnSync('tar', ['-xzf', archive, '-C', srcdir], { encoding: 'utf8' });
    assert.equal(unpack.status, 0, unpack.stderr);
    const sourceRoot = path.join(srcdir, topLevelName());
    assert.ok((await lstat(sourceRoot)).isDirectory());

    // The prepare step puts the canonical recipe into the sources.
    const prepare = spawnSync('bash', ['-c',
      'source "$1" >/dev/null 2>&1; srcdir="$2"; startdir="$3"; prepare',
      'bash', path.join(aur, 'PKGBUILD'), srcdir, aur], { encoding: 'utf8' });
    assert.equal(prepare.status, 0, prepare.stderr);
    assert.equal(await readFile(path.join(sourceRoot, 'PKGBUILD'), 'utf8'),
      await readFile(RECIPE, 'utf8'), 'the sources carry the canonical recipe');
    assert.equal(await readFile(path.join(sourceRoot, '.SRCINFO'), 'utf8'),
      await readFile(SRCINFO, 'utf8'), 'the sources carry the canonical metadata');

    // The recipe identity of the unpacked tree is the recipe identity of
    // the checkout: the archive carries exactly the build inputs.
    assert.deepEqual(await recipeFingerprint(sourceRoot), await recipeFingerprint(ROOT));
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

function parseSrcinfo(text) {
  const sections = [];
  let section = null;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const match = line.match(/^(\s*)([A-Za-z0-9_]+) = (.*)$/);
    assert.ok(match, `unexpected .SRCINFO line: ${line}`);
    const [, indent, key, value] = match;
    if (!indent.length) {
      section = { header: key, value, attributes: [] };
      sections.push(section);
    } else {
      assert.ok(section, 'an attribute without a section');
      section.attributes.push([key, value]);
    }
  }
  return sections;
}

test('the checked-in .SRCINFO describes the recipe exactly', async () => {
  const srcinfo = await readFile(SRCINFO, 'utf8');
  const sections = parseSrcinfo(srcinfo);
  assert.equal(sections.length, 2, 'the global section and the package section');
  assert.equal(sections[0].header, 'pkgbase');
  assert.equal(sections[1].header, 'pkgname');
  assert.equal(sections[1].value, 'factory-droid-desktop');

  // The source and its digest are the metadata the archive depends on:
  // they must agree with the recipe wherever the metadata was checked.
  const recipe = recipeValues(ROOT);
  const attributes = new Map();
  for (const [key, value] of sections[0].attributes) {
    if (!attributes.has(key)) attributes.set(key, []);
    attributes.get(key).push(value);
  }
  assert.deepEqual(attributes.get('source'), recipe.get('source'));
  assert.deepEqual(attributes.get('sha256sums'), recipe.get('sha256sums'));

  // And makepkg itself writes exactly this file.
  if (haveMakepkg()) {
    const printed = spawnSync('makepkg', ['--printsrcinfo'],
      { cwd: ROOT, encoding: 'utf8' });
    assert.equal(printed.status, 0, printed.stderr);
    assert.equal(srcinfo, printed.stdout, '.SRCINFO must match makepkg --printsrcinfo');
  }
});

test('a source may not name a log or another personal artifact', async () => {
  const work = await mkdtemp(path.join(tmpdir(), 'factory-artifact-'));
  try {
    const tree = path.join(work, 'tree');
    await mkdir(tree, { recursive: true });
    await sourceTree(tree);
    const inventoryPath = path.join(tree, 'packaging/source-inventory.json');
    const original = JSON.parse(await readFile(inventoryPath, 'utf8'));
    // An artifact that a source names is a mistake, not a source: the
    // inventory may not list one, in any of its shapes.
    for (const relative of ['docs/synthetic-private.log', 'docs/synthetic-private.dump',
      'docs/synthetic-private.core', 'docs/synthetic-private.prof',
      'tools/synthetic-bytecode.pyc', 'tools/synthetic-bytecode.pyo',
      'docs/credentials.json', 'docs/secrets.json', 'runtime/synthetic-private.key']) {
      const target = path.join(tree, relative);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, 'synthetic\n');
      const listed = {
        format: original.format,
        files: [...original.files, { path: relative, mode: '0644' }],
      };
      await writeFile(inventoryPath, `${JSON.stringify(listed, null, 2)}\n`);
      const result = runTool(tree);
      assert.notEqual(result.status, 0, `the inventory must refuse ${relative}`);
      assert.match(result.stderr, /Refusing/);
      assert.ok(result.stderr.includes(relative),
        `the refusal must name ${relative}: ${result.stderr}`);
      assert.ok(!await exists(path.join(tree, 'build', archiveName())),
        'a refused run leaves no archive behind');
      await rm(target);
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('a tracked log is refused by the maintainer\'s mode', async () => {
  const work = await mkdtemp(path.join(tmpdir(), 'factory-tracked-'));
  try {
    const tree = path.join(work, 'tree');
    await mkdir(tree, { recursive: true });
    await sourceTree(tree);
    const before = await metadataState(tree);
    await maintainerCheckout(tree, async () => {
      // A log that was staged by accident is a mistake, not a source.
      await writeFile(path.join(tree, 'docs', 'synthetic-private.log'), 'synthetic\n');
      const added = spawnSync('git', ['add', '-f', 'docs/synthetic-private.log'],
        { cwd: tree, encoding: 'utf8', env: { ...process.env, ...gitEnvironment() } });
      assert.equal(added.status, 0, added.stderr);
      const refused = runTool(tree, ['--update']);
      assert.notEqual(refused.status, 0, 'a tracked log must not reach the archive');
      assert.match(refused.stderr, /Refusing/);
      assert.ok(refused.stderr.includes('synthetic-private.log'),
        `the refusal must name the log: ${refused.stderr}`);
      // The refusal wrote nothing: the recipe, the metadata and the
      // inventory are the ones that were checked in.
      assert.deepEqual(await metadataState(tree), before);
      assert.ok(!await exists(path.join(tree, 'build', `${archiveName()}.pending`)));
    });
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('an artifact the inventory does not name is ignored, not refused', async () => {
  const work = await mkdtemp(path.join(tmpdir(), 'factory-ignored-'));
  try {
    const tree = path.join(work, 'tree');
    await mkdir(tree, { recursive: true });
    await sourceTree(tree);
    // The artifacts a working tree legitimately holds after a test run.
    await writeFile(path.join(tree, 'docs', 'synthetic-build.log'), 'synthetic\n');
    await writeFile(path.join(tree, 'tests', 'synthetic-bytecode.pyc'), 'synthetic\n');
    await mkdir(path.join(tree, 'tests', 'fake-bin'), { recursive: true });
    await writeFile(path.join(tree, 'tests', 'fake-bin', 'synthetic'), 'synthetic\n');
    const result = runTool(tree);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    const archive = path.join(tree, 'build', archiveName());
    assert.equal(await hash(archive), recipeValues(ROOT).get('sha256sums')[0],
      'an ignored artifact must not change the archive');
    const names = listing(archive);
    for (const ignored of ['synthetic-build.log', 'synthetic-bytecode.pyc', 'fake-bin'])
      assert.ok(!names.some(name => name.includes(ignored)),
        `the archive must not carry ${ignored}`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('a source tree that is a link is refused', async () => {
  const work = await mkdtemp(path.join(tmpdir(), 'factory-rootlink-'));
  try {
    const tree = path.join(work, 'tree');
    await mkdir(tree, { recursive: true });
    await sourceTree(tree);
    // A copy of a source tree that lives outside of it.
    const outside = path.join(work, 'outside');
    await mkdir(outside, { recursive: true });
    await copyFile(path.join(ROOT, 'runtime', 'collector.py'),
      path.join(outside, 'collector.py'));
    // The source tree is a link to that copy: the archive would carry
    // bytes that the tree does not hold.
    await rm(path.join(tree, 'runtime'), { recursive: true, force: true });
    await symlink(outside, path.join(tree, 'runtime'));
    const linked = runTool(tree);
    assert.notEqual(linked.status, 0, 'a linked source tree must not reach the archive');
    assert.match(linked.stderr, /symbolic link/);
    assert.ok(!await exists(path.join(tree, 'build', archiveName())));

    // The maintainer's mode refuses it as well.
    const checkout = path.join(work, 'checkout');
    await mkdir(checkout, { recursive: true });
    await sourceTree(checkout);
    await rm(path.join(checkout, 'runtime'), { recursive: true, force: true });
    await symlink(outside, path.join(checkout, 'runtime'));
    await maintainerCheckout(checkout, async () => {
      const before = await metadataState(checkout);
      const refused = runTool(checkout, ['--update']);
      assert.notEqual(refused.status, 0, 'a linked source tree must not reach the archive');
      assert.match(refused.stderr, /symbolic link/);
      assert.deepEqual(await metadataState(checkout), before);
      assert.ok(!await exists(path.join(checkout, 'build', `${archiveName()}.pending`)));
    });
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('a link in the middle of a source path is refused', async () => {
  const work = await mkdtemp(path.join(tmpdir(), 'factory-parentlink-'));
  try {
    const tree = path.join(work, 'tree');
    await mkdir(tree, { recursive: true });
    await sourceTree(tree);
    // A directory outside the tree, reached through a link inside it.
    const outside = path.join(work, 'outside');
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, 'note.md'), 'outside\n');
    await symlink(outside, path.join(tree, 'docs', 'link'));
    const inventoryPath = path.join(tree, 'packaging/source-inventory.json');
    const original = JSON.parse(await readFile(inventoryPath, 'utf8'));
    const listed = {
      format: original.format,
      files: [...original.files, { path: 'docs/link/note.md', mode: '0644' }],
    };
    await writeFile(inventoryPath, `${JSON.stringify(listed, null, 2)}\n`);
    const result = runTool(tree);
    assert.notEqual(result.status, 0, 'a link in a source path must not reach the archive');
    assert.match(result.stderr, /symbolic link/);
    assert.ok(!await exists(path.join(tree, 'build', archiveName())));

    // A tree with real directories is still fine.
    const plain = path.join(work, 'plain');
    await mkdir(plain, { recursive: true });
    await sourceTree(plain);
    const built = runTool(plain);
    assert.equal(built.status, 0, `${built.stdout}${built.stderr}`);
    assert.equal(await hash(path.join(plain, 'build', archiveName())),
      recipeValues(ROOT).get('sha256sums')[0]);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('the archive does not depend on the environment around it', async () => {
  const work = await mkdtemp(path.join(tmpdir(), 'factory-environment-'));
  try {
    const tree = path.join(work, 'tree');
    await mkdir(tree, { recursive: true });
    await sourceTree(tree);
    const pinned = recipeValues(ROOT).get('sha256sums')[0];
    // A shell startup file that would replace the packing command.
    const startup = path.join(work, 'startup.sh');
    await writeFile(startup, 'tar() { echo "not an archive"; }\n');
    // Every one of these would change the bytes of the archive if the
    // command let the environment decide them.
    for (const environment of [
      { TAR_OPTIONS: '--exclude=README.md' },
      { GZIP: '-1' },
      { BASH_ENV: startup },
      { POSIXLY_CORRECT: '1' },
    ]) {
      const result = runTool(tree, [], { env: { ...process.env, ...environment } });
      assert.equal(result.status, 0,
        `the environment must not decide the archive: ${result.stdout}${result.stderr}`);
      assert.equal(await hash(path.join(tree, 'build', archiveName())), pinned,
        `the environment must not change the archive: ${Object.keys(environment).join(', ')}`);
    }

    // The maintainer's mode publishes the same archive under the same
    // environment: the bytes are the inventory's, not the environment's.
    const clean = path.join(work, 'clean');
    const hostile = path.join(work, 'hostile');
    for (const dir of [clean, hostile]) {
      await mkdir(dir, { recursive: true });
      await sourceTree(dir);
    }
    const tools = haveGit() ? ['bash', 'tar', 'gzip', 'git'] : ['bash', 'tar', 'gzip'];
    const sandbox = await toolPath(tools, 'fixture');
    try {
      const environment = { ...process.env, ...gitEnvironment(), PATH: sandbox };
      await maintainerCheckout([clean, hostile], async () => {
        const published = runTool(clean, ['--update'], { env: environment });
        assert.equal(published.status, 0, `${published.stdout}${published.stderr}`);
        const excluded = runTool(hostile, ['--update'],
          { env: { ...environment, TAR_OPTIONS: '--exclude=README.md' } });
        assert.equal(excluded.status, 0, `${excluded.stdout}${excluded.stderr}`);
        const cleanArchive = path.join(clean, 'build', archiveName());
        const hostileArchive = path.join(hostile, 'build', archiveName());
        assert.equal(await hash(hostileArchive), await hash(cleanArchive),
          'the environment must not change the archive the maintainer publishes');
        const names = listing(hostileArchive);
        assert.ok(names.some(name => name.endsWith('/README.md')),
          'the archive must carry every source the inventory names');
        const refreshed = JSON.parse(
          await readFile(path.join(hostile, 'packaging/source-inventory.json'), 'utf8'));
        assert.equal(refreshed.files.length, (await inventory()).files.length,
          'the inventory must still name every source');
      }, { env: environment });
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('a failed update leaves the recipe, the metadata and the inventory as they were', async () => {
  const work = await mkdtemp(path.join(tmpdir(), 'factory-rollback-'));
  try {
    const tree = path.join(work, 'tree');
    await mkdir(tree, { recursive: true });
    await sourceTree(tree);
    const before = await metadataState(tree);
    // A valid archive is published first: a failed update may not lose it.
    const built = runTool(tree);
    assert.equal(built.status, 0, `${built.stdout}${built.stderr}`);
    const archive = path.join(tree, 'build', archiveName());
    const published = await hash(archive);
    // An ordinary tracked change of a source.
    const source = path.join(tree, 'docs', 'architecture.md');
    await writeFile(source, `${await readFile(source, 'utf8')}\n<!-- synthetic -->\n`);

    await maintainerCheckout(tree, async () => {
      // A makepkg that is not there, and a makepkg that fails: both are
      // failures of the update, and neither may leave a half-written
      // tree behind.
      for (const makepkg of [null, 'failing']) {
        const sandbox = await toolPath(['bash', 'tar', 'gzip', 'git'], makepkg);
        try {
          const result = runTool(tree, ['--update'], {
            env: { ...process.env, ...gitEnvironment(), PATH: sandbox },
          });
          assert.notEqual(result.status, 0, 'the update must fail');
          assert.deepEqual(await metadataState(tree), before,
            'a failed update must leave the recipe, the metadata and the inventory as they were');
          assert.ok(!await exists(`${archive}.pending`),
            'a failed update must leave no pending archive');
          assert.ok(await exists(archive), 'a failed update must not lose the published archive');
          assert.equal(await hash(archive), published,
            'a failed update must not touch the published archive');
        } finally {
          await rm(sandbox, { recursive: true, force: true });
        }
      }
    });

    // The tree is still coherent: the default mode refuses the changed
    // sources against the digest that was never replaced, and it never
    // accepts a recipe and a metadata that disagree.
    const after = runTool(tree);
    assert.notEqual(after.status, 0, 'the changed sources must not match the old digest');
    assert.match(after.stderr, /does not match the checksum/);
    assert.deepEqual(await metadataState(tree), before);
    const pinned = recipeValues(tree).get('sha256sums')[0];
    assert.ok((await readFile(path.join(tree, '.SRCINFO'), 'utf8')).includes(pinned),
      'the recipe and the metadata must still agree');
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('a successful update refreshes the inventory, the digest and the metadata', async () => {
  const work = await mkdtemp(path.join(tmpdir(), 'factory-success-'));
  try {
    const tree = path.join(work, 'tree');
    await mkdir(tree, { recursive: true });
    await sourceTree(tree);
    await maintainerCheckout(tree, async () => {
      // A new source, tracked, and a change to an existing one.
      await writeFile(path.join(tree, 'docs', 'synthetic-note.md'), '# synthetic\n');
      const source = path.join(tree, 'docs', 'architecture.md');
      await writeFile(source, `${await readFile(source, 'utf8')}\n<!-- synthetic -->\n`);
      const added = spawnSync('git', ['add', '-A'],
        { cwd: tree, encoding: 'utf8', env: { ...process.env, ...gitEnvironment() } });
      assert.equal(added.status, 0, added.stderr);

      const sandbox = await toolPath(['bash', 'tar', 'gzip', 'git'], 'fixture');
      try {
        const result = runTool(tree, ['--update'], {
          env: { ...process.env, ...gitEnvironment(), PATH: sandbox },
        });
        assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
        // The inventory names the new source.
        const refreshed = JSON.parse(
          await readFile(path.join(tree, 'packaging/source-inventory.json'), 'utf8'));
        assert.ok(refreshed.files.some(entry => entry.path === 'docs/synthetic-note.md'),
          'the inventory must name the new source');
        // The recipe pins the archive that was published, and the
        // metadata carries the same digest.
        const archive = path.join(tree, 'build', archiveName());
        const digest = await hash(archive);
        assert.equal(recipeValues(tree).get('sha256sums')[0], digest,
          'the recipe must pin the archive that was published');
        assert.ok((await readFile(path.join(tree, '.SRCINFO'), 'utf8')).includes(digest),
          'the metadata must carry the digest of the published archive');
        // And the default mode accepts the tree the update just wrote.
        const checked = runTool(tree, [], {
          env: { ...process.env, ...gitEnvironment(), PATH: sandbox },
        });
        assert.equal(checked.status, 0, `${checked.stdout}${checked.stderr}`);
      } finally {
        await rm(sandbox, { recursive: true, force: true });
      }
    });

    // The same update with the real makepkg writes the metadata the
    // real makepkg writes. The real makepkg needs the tools of a build
    // environment, so it runs with the environment of this machine.
    if (haveMakepkg() && haveGit()) {
      const real = path.join(work, 'real');
      await mkdir(real, { recursive: true });
      await sourceTree(real);
      await gitCheckout(real);
      await writeFile(path.join(real, 'docs', 'synthetic-note.md'), '# synthetic\n');
      const staged = spawnSync('git', ['add', '-A'],
        { cwd: real, encoding: 'utf8', env: { ...process.env, ...gitEnvironment() } });
      assert.equal(staged.status, 0, staged.stderr);
      const result = runTool(real, ['--update'], {
        env: { ...process.env, ...gitEnvironment() },
      });
      assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
      const printed = spawnSync('makepkg', ['--printsrcinfo'],
        { cwd: real, encoding: 'utf8' });
      assert.equal(printed.status, 0, printed.stderr);
      assert.equal(await readFile(path.join(real, '.SRCINFO'), 'utf8'), printed.stdout,
        '.SRCINFO must be what makepkg writes');
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('the source archive needs no git, and the maintainer\'s mode refuses without it', async () => {
  const work = await mkdtemp(path.join(tmpdir(), 'factory-nogit-'));
  // TMPDIR may itself live inside a checkout. Bound Git discovery for
  // this fixture, not for the caller or the other checkout fixtures.
  const isolated = { ...process.env, GIT_CEILING_DIRECTORIES: work };
  try {
    const tree = path.join(work, 'tree');
    await mkdir(tree, { recursive: true });
    await sourceTree(tree);
    // The tree is the layout of a release download and of an AUR
    // checkout: it carries the sources and no git index.
    if (haveGit()) {
      const ancestor = spawnSync('git', ['rev-parse', '--show-toplevel'],
        { cwd: tree, encoding: 'utf8', env: isolated });
      assert.notEqual(ancestor.status, 0, 'the tree must have no git ancestor');
    }
    const before = await metadataState(tree);

    // A PATH with every tool of the system except git: the archive is
    // built from the inventory, and nothing of the checkout is read.
    const sandbox = await toolPathExcept('git');
    try {
      const environment = { ...isolated, PATH: sandbox };
      const built = runTool(tree, [], { env: environment });
      assert.equal(built.status, 0, `${built.stdout}${built.stderr}`);
      const archive = path.join(tree, 'build', archiveName());
      assert.equal(await hash(archive), recipeValues(ROOT).get('sha256sums')[0],
        'the archive without git must be the pinned one');
      // The maintainer's mode needs the checkout, and it says so
      // instead of writing anything.
      const refused = runTool(tree, ['--update'], { env: environment });
      assert.notEqual(refused.status, 0, 'the maintainer\'s mode needs a checkout');
      assert.match(refused.stderr, /git/i, `the refusal must name git: ${refused.stderr}`);
      assert.deepEqual(await metadataState(tree), before,
        'a refused maintainer\'s mode must not write anything');
      assert.ok(!await exists(`${archive}.pending`),
        'a refused maintainer\'s mode must leave no pending archive');
      assert.equal(await hash(archive), recipeValues(ROOT).get('sha256sums')[0],
        'the refusal must not touch the published archive');
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }

    // And with git itself there, a tree that is not a checkout is
    // refused the same way.
    if (haveGit()) {
      const refused = runTool(tree, ['--update'], { env: isolated });
      assert.notEqual(refused.status, 0, 'the maintainer\'s mode needs a checkout');
      assert.match(refused.stderr, /git/i, `the refusal must name git: ${refused.stderr}`);
      assert.deepEqual(await metadataState(tree), before,
        'a refused maintainer\'s mode must not write anything');
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('an exported shell function cannot decide the archive', async () => {
  const work = await mkdtemp(path.join(tmpdir(), 'factory-exported-'));
  try {
    const tree = path.join(work, 'tree');
    await mkdir(tree, { recursive: true });
    await sourceTree(tree);
    // A shell that exports a tar() decides the members of the archive
    // for every bash that inherits it.
    const exported = {
      'BASH_FUNC_tar%%': '() { /usr/bin/tar --exclude=README.md "$@"; }',
    };

    // The default mode: the archive is the pinned one.
    const attacked = runTool(tree, [], { env: { ...process.env, ...exported } });
    assert.equal(attacked.status, 0, `${attacked.stdout}${attacked.stderr}`);
    const archive = path.join(tree, 'build', archiveName());
    assert.equal(await hash(archive), recipeValues(ROOT).get('sha256sums')[0],
      'an exported function must not change the archive');
    assert.ok(listing(archive).some(name => name.endsWith('/README.md')),
      'the archive must carry every source the inventory names');

    // The maintainer's mode publishes the same archive, with and
    // without the exported function.
    const clean = path.join(work, 'clean');
    const hostile = path.join(work, 'hostile');
    for (const dir of [clean, hostile]) {
      await mkdir(dir, { recursive: true });
      await sourceTree(dir);
    }
    await maintainerCheckout([clean, hostile], async (environment) => {
      const published = runTool(clean, ['--update'], { env: environment });
      assert.equal(published.status, 0, `${published.stdout}${published.stderr}`);
      const excluded = runTool(hostile, ['--update'],
        { env: { ...environment, ...exported } });
      assert.equal(excluded.status, 0, `${excluded.stdout}${excluded.stderr}`);
      const cleanArchive = path.join(clean, 'build', archiveName());
      const hostileArchive = path.join(hostile, 'build', archiveName());
      assert.equal(await hash(hostileArchive), await hash(cleanArchive),
        'an exported function must not change the archive the maintainer publishes');
      assert.deepEqual(listing(hostileArchive), listing(cleanArchive),
        'an exported function must not change the members of the archive');
      assert.ok(listing(hostileArchive).some(name => name.endsWith('/README.md')),
        'the archive must carry every source the inventory names');
      const refreshed = JSON.parse(
        await readFile(path.join(hostile, 'packaging/source-inventory.json'), 'utf8'));
      assert.equal(refreshed.files.length, (await inventory()).files.length,
        'the inventory must still name every source');
    });
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('a read-only recipe or metadata does not break the rollback', async () => {
  const work = await mkdtemp(path.join(tmpdir(), 'factory-readonly-'));
  try {
    for (const readonly of ['PKGBUILD', '.SRCINFO']) {
      const tree = path.join(work, readonly);
      await mkdir(tree, { recursive: true });
      await sourceTree(tree);
      // A valid archive is published first: a failed update may not lose it.
      const built = runTool(tree);
      assert.equal(built.status, 0, `${built.stdout}${built.stderr}`);
      const archive = path.join(tree, 'build', archiveName());
      const published = await hash(archive);
      // An ordinary tracked change of a source, so the update has work.
      const source = path.join(tree, 'docs', 'architecture.md');
      await writeFile(source, `${await readFile(source, 'utf8')}\n<!-- synthetic -->\n`);
      // The file the update has to write is read-only.
      await chmod(path.join(tree, readonly), 0o444);
      const before = await metadataState(tree);

      await maintainerCheckout(tree, async (environment) => {
        const refused = runTool(tree, ['--update'], { env: environment });
        assert.notEqual(refused.status, 0, 'the update must fail');
        assert.match(refused.stderr, /EACCES/, 'the update must reach the read-only write');
        // The bytes and the modes are the ones that were there.
        assert.deepEqual(await metadataState(tree), before,
          `a failed update must leave ${readonly} as it was`);
        // The published archive is untouched and the archive that was
        // still pending is gone.
        assert.ok(await exists(archive), 'the published archive must survive');
        assert.equal(await hash(archive), published,
          'the published archive must not change');
        assert.ok(!await exists(`${archive}.pending`),
          'a failed update must leave no pending archive');
      });
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('a rollback that cannot finish still cleans up and reports it', async () => {
  const work = await mkdtemp(path.join(tmpdir(), 'factory-rollback-fail-'));
  try {
    const tree = path.join(work, 'tree');
    await mkdir(tree, { recursive: true });
    await sourceTree(tree);
    const built = runTool(tree);
    assert.equal(built.status, 0, `${built.stdout}${built.stderr}`);
    const archive = path.join(tree, 'build', archiveName());
    const published = await hash(archive);
    const before = await metadataState(tree);
    const source = path.join(tree, 'docs', 'architecture.md');
    await writeFile(source, `${await readFile(source, 'utf8')}\n<!-- synthetic -->\n`);
    // A new source as well, so the inventory the update writes differs
    // from the one that is checked in and has to be restored.
    await writeFile(path.join(tree, 'docs', 'synthetic-note.md'), '# synthetic\n');

    // A preload for the copied command only: the metadata write fails
    // the way a read-only file fails, and the rollback of the
    // inventory cannot write the file back. The sources of the port
    // are not touched.
    const preload = path.join(work, 'preload.mjs');
    await writeFile(preload, [
      "import fs from 'node:fs/promises';",
      "import { syncBuiltinESMExports } from 'node:module';",
      'const write = fs.writeFile;',
      'const deny = (file) => {',
      "  const error = new Error(`EACCES: permission denied, open '${file}'`);",
      "  error.code = 'EACCES';",
      '  return error;',
      '};',
      'let inventories = 0;',
      'fs.writeFile = async (file, ...args) => {',
      '  const name = String(file);',
      "  if (name.endsWith('/.SRCINFO')) throw deny(name);",
      "  if (name.endsWith('source-inventory.json')) {",
      '    inventories += 1;',
      '    if (inventories > 1) throw deny(name);',
      '  }',
      '  return write(file, ...args);',
      '};',
      'syncBuiltinESMExports();',
      '',
    ].join('\n'));

    await maintainerCheckout(tree, async (environment) => {
      const refused = runTool(tree, ['--update'], {
        env: {
          ...environment,
          NODE_OPTIONS: `--import ${pathToFileURL(preload).href}`,
        },
      });
      assert.notEqual(refused.status, 0, 'the update must fail');
      // The failure that caused the rollback is the one that is
      // reported, and the rollback that could not finish is reported
      // next to it.
      assert.ok(refused.stderr.includes('.SRCINFO'),
        `the failure must be reported: ${refused.stderr}`);
      assert.ok(/rollback could not finish/i.test(refused.stderr),
        `the rollback must be reported: ${refused.stderr}`);
      assert.ok(refused.stderr.includes('source-inventory.json'),
        `the rollback must name the file it could not restore: ${refused.stderr}`);
      // The other files were restored all the same: one file that
      // cannot be written does not leave the rest half-restored.
      assert.equal(await readFile(path.join(tree, 'PKGBUILD'), 'utf8'),
        Buffer.from(before['PKGBUILD'].bytes, 'base64').toString('utf8'),
        'the recipe must be restored even when the inventory is not');
      assert.equal(await readFile(path.join(tree, '.SRCINFO'), 'utf8'),
        Buffer.from(before['.SRCINFO'].bytes, 'base64').toString('utf8'),
        'the metadata must be left as it was');
      // And the archive that was still pending is gone.
      assert.ok(!await exists(`${archive}.pending`),
        'a failed update must leave no pending archive');
      assert.ok(await exists(archive), 'the published archive must survive');
      assert.equal(await hash(archive), published,
        'the published archive must not change');
    });
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});
