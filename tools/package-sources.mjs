// The port's source archive.
//
// Both packaging workflows use the same bytes. The GitHub clone builds
// the archive locally, before makepkg runs; the AUR recipe downloads the
// very same file from the release. The archive holds the port's own
// sources and nothing else: no vendor payload, no generated output, no
// personal material.
//
// The contents of the archive are not read from a directory walk and not
// from a git index: they are the checked-in source inventory
// (packaging/source-inventory.json), which names every source file of
// the port and the mode it ships with. The inventory is what makes the
// archive reproducible in a release download, in a source ZIP and in an
// AUR checkout alike, none of which carries a git index.
//
// Every build artifact around the sources is normalized: sorted paths,
// zeroed timestamps, numeric root ownership, fixed modes and a gzip
// stream without a name and without a timestamp. The same tree therefore
// always produces the same bytes, and the checksum that PKGBUILD pins is
// a checksum of the sources rather than of one machine's directory. The
// packing step is given no override from the environment either: the
// bytes are the ones the inventory asks for.
//
// Two modes:
//   node tools/package-sources.mjs            build the archive and check
//                                             it against the pinned digest
//   node tools/package-sources.mjs --update   refresh the inventory from
//                                             the checkout, rebuild the
//                                             archive, pin its digest and
//                                             regenerate .SRCINFO
//
// The update mode is the maintainer's mode: it is the only mode that
// writes to the inventory or to the recipe. The default mode never
// rewrites the checksum on a user's machine; a mismatch is reported, not
// silently accepted.
//
// The update mode is a transaction: the candidate inventory, the
// archive, the recipe and the metadata are prepared before anything is
// replaced, and a failure puts the bytes and the modes back. The tree is
// therefore never left with a recipe that pins one digest next to a
// metadata that pins another.
import { spawnSync } from 'node:child_process';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, hash } from './common.mjs';

// The port's own sources. The recipe files are not part of them:
// PKGBUILD and .SRCINFO are provided by the packaging workflow, and a
// checksum inside the recipe cannot cover an archive that contains the
// recipe. Everything else here is either needed to build, to check or to
// package the port, or is the port's own documentation.
const SOURCE_FILES = ['package.json', 'package-lock.json', 'versions.json', 'LICENSE',
  'README.md', 'CONTRIBUTING.md'];
const SOURCE_DIRS = ['tools', 'runtime', 'packaging', 'tests', 'docs', 'omarchy'];

// The checked-in inventory of the archive's contents. It is the authority
// for what the archive holds, in a checkout as much as in a download.
const INVENTORY = 'packaging/source-inventory.json';
const INVENTORY_FORMAT = 1;

// Path segments that must never reach the archive, whatever a checkout
// or a download happens to contain: caches, build output, the vendor
// payload, personal material and the personal panel.
const FORBIDDEN_SEGMENTS = new Set(['.git', 'node_modules', 'build', 'dist', 'pkg', 'src',
  '__pycache__', '.pytest_cache', 'playwright-report', 'test-results', 'coverage', '.cache',
  'vendor', 'vendors', 'payload', 'profile', 'profiles', 'user-data', 'keyring', 'keyrings',
  'panel', 'panel-staging', 'logs', 'log', 'dumps', 'screenshots']);

// Payload-shaped files: the vendor's binaries, the archives that hold
// them and the generated brand marks are never sources.
const PAYLOAD_SUFFIXES = ['.exe', '.dll', '.so', '.dylib', '.node', '.asar', '.nupkg',
  '.appimage', '.msi', '.deb', '.rpm', '.zip', '.tar', '.tar.gz', '.tgz', '.whl', '.jar',
  '.class', '.o', '.a', '.lib', '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.bmp',
  '.icns', '.svg'];

// Credentials and key material: personal by definition.
const CREDENTIAL_NAMES = new Set(['.netrc', '_netrc', 'credentials', 'credentials.json',
  'secrets.json', 'keyring.json', 'token.json', 'id_rsa', 'id_dsa', 'id_ecdsa',
  'id_ed25519']);
const CREDENTIAL_SUFFIXES = ['.pem', '.key', '.p12', '.pfx', '.kdbx', '.jks', '.keystore',
  '.crt', '.cer'];

// The artifacts a working tree holds and the repository ignores. They
// are not sources, they never reach the archive, and they do not make
// the build fail. A source may never name one of them: an artifact
// that is listed in the inventory or tracked in the checkout is a
// mistake, not a source, and the guard refuses it in both modes.
const IGNORED_SEGMENTS = new Set(['node_modules', '__pycache__', 'playwright-report',
  'test-results', 'fake-bin']);
const IGNORED_SUFFIXES = ['.pyc', '.pyo', '.log', '.dump', '.core', '.prof'];

// The variables that would change the bytes of the archive or the
// result of a child process. Tar and gzip read their own options from
// the environment, and bash reads a startup file from it, so a child
// that inherits them can write something else than the sources say.
const SCRUBBED_ENVIRONMENT = ['TAR_OPTIONS', 'GZIP', 'BASH_ENV', 'ENV', 'SHELLOPTS',
  'BASHOPTS', 'POSIXLY_CORRECT'];

// The exported functions of a bash shell. Bash imports them from the
// environment under the name BASH_FUNC_<name>%%, and a child that
// inherits one calls the function instead of the tool: a shell that
// exports a tar() decides the members of the archive.
const EXPORTED_FUNCTION_PREFIX = 'BASH_FUNC_';

// The environment of a child process: the environment of this process
// without the variables that would override what the tool asks for.
function childEnvironment(extra = {}) {
  const environment = { ...process.env, ...extra };
  for (const name of SCRUBBED_ENVIRONMENT) delete environment[name];
  for (const name of Object.keys(environment))
    if (name.startsWith(EXPORTED_FUNCTION_PREFIX)) delete environment[name];
  return environment;
}

function shell(program, args, options = {}) {
  const { env, ...rest } = options;
  const result = spawnSync(program, args, {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 ** 2,
    env: childEnvironment(env), ...rest,
  });
  if (result.error) throw result.error;
  return result;
}

function gitLines(args) {
  const result = shell('git', args);
  if (result.status !== 0)
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
  return result.stdout.split('\0').filter(Boolean);
}

// The recipe's own metadata, read by sourcing the recipe with bash: the
// recipe is the authority, and the shell expands it exactly like makepkg
// does. Only the two attributes the archive needs are read: the source
// it declares and the digest it pins for it.
function readRecipe() {
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
  const result = shell('bash', ['-c', script, 'bash', path.join(ROOT, 'PKGBUILD')]);
  if (result.status !== 0)
    throw new Error(`The recipe could not be read: ${result.stderr.trim()}`);
  const values = new Map();
  for (const line of result.stdout.split('\n')) {
    if (!line) continue;
    const separator = line.indexOf('=');
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (!values.has(key)) values.set(key, []);
    values.get(key).push(value);
  }
  return values;
}

function allowed(relative) {
  if (SOURCE_FILES.includes(relative)) return true;
  return SOURCE_DIRS.some(dir => relative.startsWith(`${dir}/`));
}

// The path rules every source file has to satisfy, in the checkout and
// in the inventory alike: no traversal, no absolute path, no link, no
// payload, no credential and no personal material.
function guardSourcePath(relative) {
  if (typeof relative !== 'string' || !relative)
    throw new Error('The source inventory holds a file without a path');
  if (relative.includes('\0') || relative.includes('\\'))
    throw new Error(`Refusing an unsafe source path: ${relative}`);
  if (relative.startsWith('/') || /^[A-Za-z]:/.test(relative))
    throw new Error(`Refusing an absolute source path: ${relative}`);
  const segments = relative.split('/');
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..')
      throw new Error(`Refusing a traversing source path: ${relative}`);
    if (FORBIDDEN_SEGMENTS.has(segment))
      throw new Error(`Refusing a forbidden source path: ${relative}`);
    if (IGNORED_SEGMENTS.has(segment))
      throw new Error(`Refusing a generated artifact: ${relative}`);
  }
  const base = segments[segments.length - 1];
  if (base === '.env' || base.startsWith('.env.'))
    throw new Error(`Refusing a personal environment file: ${relative}`);
  if (CREDENTIAL_NAMES.has(base))
    throw new Error(`Refusing a credential file: ${relative}`);
  const lower = base.toLowerCase();
  for (const suffix of PAYLOAD_SUFFIXES)
    if (lower.endsWith(suffix))
      throw new Error(`Refusing a payload-shaped source file: ${relative}`);
  for (const suffix of CREDENTIAL_SUFFIXES)
    if (lower.endsWith(suffix))
      throw new Error(`Refusing a credential file: ${relative}`);
  // The personal artifacts of a working tree: logs, dumps, core files,
  // profiler output and generated bytecode. A tree may hold them and
  // ignore them; a source may never name one of them.
  for (const suffix of IGNORED_SUFFIXES)
    if (lower.endsWith(suffix))
      throw new Error(`Refusing a personal artifact: ${relative}`);
}

// The artifacts a working tree may hold. They are ignored, exactly like
// the repository ignores them, and they never reach the archive.
function ignoredPath(relative) {
  const segments = relative.split('/');
  if (segments.some(segment => IGNORED_SEGMENTS.has(segment))) return true;
  const base = segments[segments.length - 1];
  if (base === '.env' || base.startsWith('.env.')) return true;
  return IGNORED_SUFFIXES.some(suffix => base.endsWith(suffix));
}

// The checked-in inventory, parsed and checked. The inventory is the
// authority for the archive's contents, so it is read as data and never
// as code.
function parseInventory(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`The source inventory is not valid JSON: ${INVENTORY}`);
  }
  if (!data || data.format !== INVENTORY_FORMAT)
    throw new Error(`The source inventory must declare the format ${INVENTORY_FORMAT}: ${INVENTORY}`);
  if (!Array.isArray(data.files) || data.files.length === 0)
    throw new Error(`The source inventory holds no files: ${INVENTORY}`);
  const entries = [];
  const seen = new Set();
  for (const item of data.files) {
    const relative = item?.path;
    guardSourcePath(relative);
    if (seen.has(relative))
      throw new Error(`The source inventory lists a file twice: ${relative}`);
    seen.add(relative);
    if (!allowed(relative))
      throw new Error(`The source inventory lists a file outside the source scope: ${relative}`);
    if (item.mode !== '0644' && item.mode !== '0755')
      throw new Error(`The source inventory must state a mode of 0644 or 0755: ${relative}`);
    entries.push({ path: relative, mode: item.mode === '0755' ? 0o755 : 0o644 });
  }
  for (const file of SOURCE_FILES)
    if (!seen.has(file))
      throw new Error(`The source inventory does not list a source file: ${file}`);
  entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return entries;
}

// A source tree of the archive. It has to be a real directory of the
// tree: a link in its place would carry the bytes of a copy that lives
// somewhere else, and neither the walk nor the copy would notice.
async function sourceRoot(dir) {
  const root = path.join(ROOT, dir);
  const info = await lstat(root).catch(() => null);
  if (!info)
    throw new Error(`The source tree does not hold a source tree: ${dir}`);
  if (info.isSymbolicLink())
    throw new Error(`Refusing to archive a symbolic link: ${dir}`);
  if (!info.isDirectory())
    throw new Error(`Refusing to archive a special file: ${dir}`);
  return root;
}

// Every directory on the way to a source file has to be a real
// directory as well: a link in the middle of a path would let the
// archive hold bytes from outside the tree.
async function realParents(relative) {
  const segments = relative.split('/');
  for (let index = 1; index < segments.length; index++) {
    const parent = segments.slice(0, index).join('/');
    const info = await lstat(path.join(ROOT, parent)).catch(() => null);
    if (!info)
      throw new Error(`The source tree does not hold a source directory: ${parent}`);
    if (info.isSymbolicLink())
      throw new Error(`Refusing to archive a symbolic link: ${parent}`);
    if (!info.isDirectory())
      throw new Error(`Refusing to archive a special file: ${parent}`);
  }
}

// The file a source path names: a regular file of the tree, behind
// real directories only.
async function inspectSource(relative) {
  await realParents(relative);
  const info = await lstat(path.join(ROOT, relative)).catch(() => null);
  if (!info)
    throw new Error(`The source tree does not hold a file the inventory names: ${relative}`);
  if (info.isSymbolicLink())
    throw new Error(`Refusing to archive a symbolic link: ${relative}`);
  if (!info.isFile())
    throw new Error(`Refusing to archive a special file: ${relative}`);
  return info;
}

// Every file of the source scope that the tree holds. A file the
// inventory does not name is a source change that was not declared: it
// is refused instead of being shipped.
async function unlistedSources(entries) {
  const listed = new Set(entries.map(entry => entry.path));
  const found = [];
  for (const dir of SOURCE_DIRS) {
    await walk(await sourceRoot(dir), found);
  }
  return found.filter(relative => !listed.has(relative)).sort();
}

async function walk(directory, found) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name);
    const relative = path.relative(ROOT, child);
    if (ignoredPath(relative)) continue;
    if (entry.isSymbolicLink())
      throw new Error(`Refusing to archive a symbolic link: ${relative}`);
    if (entry.isDirectory()) await walk(child, found);
    else if (entry.isFile()) found.push(relative);
    else throw new Error(`Refusing to archive a special file: ${relative}`);
  }
}

// The sources of the archive: the files the inventory names, checked
// against the tree they live in. A file that is missing, a file whose
// mode drifted and a file the inventory does not know are all refused.
async function collectSources() {
  let text;
  try {
    text = await readFile(path.join(ROOT, INVENTORY), 'utf8');
  } catch {
    throw new Error(`The source inventory is missing: ${INVENTORY}`);
  }
  return validateTree(parseInventory(text));
}

// The same check for the maintainer's mode, where the inventory is the
// candidate one: the tree has to hold it before anything is written.
async function validateTree(entries) {
  // Every source tree is checked before a single file of it is read.
  for (const dir of SOURCE_DIRS) await sourceRoot(dir);
  for (const entry of entries) {
    const info = await inspectSource(entry.path);
    if ((info.mode & 0o111 ? 0o755 : 0o644) !== entry.mode)
      throw new Error(`The mode of a source file does not match the inventory: ${entry.path}`);
  }
  const unlisted = await unlistedSources(entries);
  if (unlisted.length)
    throw new Error('The source tree holds files the source inventory does not list: '
      + unlisted.join(', '));
  return entries;
}

// The inventory of the maintainer's mode: the tracked files of the
// checkout that the source scope covers. An untracked file inside that
// scope is refused instead of being shipped, because that is how
// personal material and leftover build output enter a release.
function trackedSources() {
  const tracked = gitLines(['ls-files', '-z']);
  const untracked = gitLines(['ls-files', '-z', '--others', '--exclude-standard']);
  const foreign = untracked.filter(allowed);
  if (foreign.length)
    throw new Error('The source tree holds untracked files that the archive would ship: '
      + foreign.join(', '));
  return tracked.filter(allowed).sort();
}

// The canonical form of the inventory: the paths in the order the
// archive lists them, the modes it ships them with, and nothing else.
function serializeInventory(entries) {
  const files = [...entries]
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    .map(entry => ({
      path: entry.path,
      mode: entry.mode === 0o755 ? '0755' : '0644',
    }));
  return `${JSON.stringify({ format: INVENTORY_FORMAT, files }, null, 2)}\n`;
}

// The archive itself. The files are staged with their normalized modes
// and packed by GNU tar with sorted names, zeroed timestamps and numeric
// root ownership; gzip writes the stream without a name and without a
// timestamp, so the bytes only depend on the content.
async function createArchive(entries, topLevel, output) {
  const stage = await mkdtemp(path.join(tmpdir(), 'factory-sources-'));
  try {
    const tree = path.join(stage, topLevel);
    await mkdir(tree, { recursive: true });
    for (const entry of entries) {
      const target = path.join(tree, entry.path);
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(path.join(ROOT, entry.path), target);
      await chmod(target, entry.mode);
    }
    await normalizeDirectories(tree);
    // The environment of the packing step carries no override: the
    // bytes are the ones the inventory and the explicit options ask
    // for, whatever the shell around this command has set.
    const result = shell('bash', ['-c',
      'set -o pipefail; tar "$@" | gzip -n -9 > "$OUT"', 'bash',
      '--sort=name', '--format=gnu', '--mtime=@0', '--owner=0', '--group=0',
      '--numeric-owner', '--no-acls', '--no-selinux', '--no-xattrs', '-cf', '-', topLevel],
    { cwd: stage, env: { OUT: output, LC_ALL: 'C', LANG: 'C' } });
    if (result.status !== 0)
      throw new Error(`The archive could not be written: ${result.stderr.trim()}`);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

async function normalizeDirectories(root) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const child = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await normalizeDirectories(child);
      await chmod(child, 0o755);
    }
  }
  await chmod(root, 0o755);
}

// The digest the recipe pins. The recipe is rewritten only in the
// maintainer's mode, and only in this one line. The new text is
// returned rather than written: the recipe is written when everything
// else of the update is ready.
function replaceDigest(text, digest) {
  const pattern = /^sha256sums=\('[a-f0-9]{64}'\)$/m;
  const matches = text.match(new RegExp(pattern.source, 'gm')) || [];
  if (matches.length !== 1)
    throw new Error(`The recipe must pin exactly one sha256 digest, found ${matches.length}`);
  return text.replace(pattern, `sha256sums=('${digest}')`);
}

// The .SRCINFO of the recipe, written by makepkg itself: the file is
// the metadata makepkg would publish, not a second description of it.
function printSrcinfo() {
  const result = spawnSync('makepkg', ['--printsrcinfo'], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 ** 2, env: childEnvironment(),
  });
  if (result.error || result.status !== 0)
    throw new Error('makepkg could not write the metadata of the recipe: '
      + (result.error ? result.error.message : result.stderr.trim()));
  return result.stdout;
}

// The metadata is written by makepkg, so makepkg has to be there before
// the maintainer's mode writes anything at all.
function requireMakepkg() {
  const result = spawnSync('makepkg', ['--version'], {
    cwd: ROOT, encoding: 'utf8', env: childEnvironment(),
  });
  if (result.error || result.status !== 0)
    throw new Error('makepkg is required to regenerate .SRCINFO: '
      + 'the metadata of the recipe is written by makepkg itself.');
}

// The bytes and the mode of a file, so a failed update can put back
// exactly what was there.
async function snapshotFile(file) {
  const info = await lstat(file).catch(() => null);
  if (!info) return null;
  return { bytes: await readFile(file), mode: info.mode & 0o7777 };
}

// The file is put back exactly as it was. A file that still holds the
// bytes and the mode it was snapshotted with is not written at all: a
// read-only file that the update never changed stays read-only, and
// the rollback cannot fail on it. A file that has to be written is
// made writable first and gets its old mode back afterwards.
async function restoreFile(file, snapshot) {
  if (!snapshot) {
    await rm(file, { force: true });
    return;
  }
  const info = await lstat(file).catch(() => null);
  if (info && info.isFile()) {
    const bytes = await readFile(file);
    if (bytes.equals(snapshot.bytes) && (info.mode & 0o7777) === snapshot.mode) return;
  }
  await chmod(file, snapshot.mode | 0o600).catch(() => {});
  await writeFile(file, snapshot.bytes);
  await chmod(file, snapshot.mode);
}

// The maintainer's inventory: the tracked files of the checkout, checked
// against the same path rules the default mode applies.
async function refreshInventory() {
  const entries = [];
  for (const relative of trackedSources()) {
    guardSourcePath(relative);
    await realParents(relative);
    const info = await lstat(path.join(ROOT, relative)).catch(() => null);
    if (!info) throw new Error(`The tracked file is missing from the checkout: ${relative}`);
    if (info.isSymbolicLink()) throw new Error(`Refusing to archive a symbolic link: ${relative}`);
    if (!info.isFile()) throw new Error(`Refusing to archive a special file: ${relative}`);
    entries.push({ path: relative, mode: info.mode & 0o111 ? 0o755 : 0o644 });
  }
  return entries;
}

// The default mode: build the archive and check it against the digest
// the recipe pins. It never writes the recipe, the metadata or the
// inventory.
async function runDefault(archiveName, topLevel, pinned) {
  const entries = await collectSources();
  const output = path.join(ROOT, 'build', archiveName);
  await mkdir(path.dirname(output), { recursive: true });
  // The archive is written next to its destination and moved into place
  // only when it is the archive the recipe expects: a refused run leaves
  // no archive behind that nobody verified.
  const pending = `${output}.pending`;
  let digest;
  try {
    await createArchive(entries, topLevel, pending);
    digest = await hash(pending);
  } catch (error) {
    await rm(pending, { force: true });
    throw error;
  }
  if (digest !== pinned) {
    await rm(pending, { force: true });
    throw new Error('The source archive does not match the checksum the recipe pins.\n'
      + `  archive: ${path.relative(ROOT, output)}\n`
      + `  built:   ${digest}\n`
      + `  pinned:  ${pinned}\n`
      + 'The sources changed since the recipe was pinned. A maintainer regenerates the '
      + 'checksum and .SRCINFO with `npm run package:sources:update`.');
  }
  await rename(pending, output);
  console.log(`The source archive matches the pinned checksum: ${path.relative(ROOT, output)}`);
  console.log(`  sha256: ${digest}`);
  console.log(`  files:  ${entries.length}`);
  console.log('Build it with: SRCDEST="$PWD/build" makepkg -si');
}

// The maintainer's mode: refresh the inventory, pin the digest of the
// new archive and regenerate the metadata.
//
// The update is a transaction. Everything that can fail is done first,
// and the bytes that are replaced are kept until the last step: a
// failure restores the inventory, the recipe and the metadata exactly
// as they were, removes the archive that was still pending and leaves
// the archive that was published before untouched. The tree is never
// left with a recipe that pins one digest and a metadata that pins
// another.
async function runUpdate(archiveName, topLevel) {
  const entries = await refreshInventory();
  // The tree has to hold the candidate inventory before anything is
  // written, and the candidate inventory has to be one the inventory
  // reader accepts: there is one format, not two.
  await validateTree(entries);
  const inventoryText = serializeInventory(entries);
  parseInventory(inventoryText);
  // The metadata is written by makepkg, so makepkg has to be there
  // before the update writes anything at all.
  requireMakepkg();

  const inventoryFile = path.join(ROOT, INVENTORY);
  const recipeFile = path.join(ROOT, 'PKGBUILD');
  const srcinfoFile = path.join(ROOT, '.SRCINFO');
  const output = path.join(ROOT, 'build', archiveName);
  await mkdir(path.dirname(output), { recursive: true });
  const pending = `${output}.pending`;
  const snapshot = {
    inventory: await snapshotFile(inventoryFile),
    recipe: await snapshotFile(recipeFile),
    srcinfo: await snapshotFile(srcinfoFile),
  };
  let digest;
  try {
    // The archive carries the inventory it is built with, so the
    // inventory is written before the archive is packed.
    await writeFile(inventoryFile, inventoryText);
    await chmod(inventoryFile, 0o644);
    await createArchive(entries, topLevel, pending);
    digest = await hash(pending);
    // The metadata is written by makepkg from the recipe that carries
    // the new digest, so the recipe is written before makepkg runs.
    const recipeText = await readFile(recipeFile, 'utf8');
    await writeFile(recipeFile, replaceDigest(recipeText, digest));
    await writeFile(srcinfoFile, printSrcinfo());
    // The new archive replaces the published one only now, and it
    // replaces it in one step: the archive that was published before
    // stays until this one is complete.
    await rename(pending, output);
  } catch (error) {
    // The rollback runs whatever the failure was. Every file is
    // restored, not only the first one that fails, so one file that
    // cannot be written does not leave the other two half-restored,
    // and the archive that was still pending is removed even when a
    // restore fails. The failure that caused the rollback stays the
    // failure that is reported; a rollback that could not finish is
    // reported next to it, never in place of it.
    const problems = [];
    for (const [file, fileSnapshot] of [
      [inventoryFile, snapshot.inventory],
      [recipeFile, snapshot.recipe],
      [srcinfoFile, snapshot.srcinfo],
    ]) {
      try {
        await restoreFile(file, fileSnapshot);
      } catch (restoreError) {
        problems.push(`${path.relative(ROOT, file)}: ${restoreError.message}`);
      }
    }
    try {
      await rm(pending, { force: true });
    } catch (cleanupError) {
      problems.push(`${path.relative(ROOT, pending)}: ${cleanupError.message}`);
    }
    if (problems.length)
      throw new Error(`${error.message}\nThe rollback could not finish:\n  ${problems.join('\n  ')}`,
        { cause: error });
    throw error;
  }
  console.log('Refreshed the source inventory, pinned the source archive in PKGBUILD '
    + 'and regenerated .SRCINFO.');
  console.log(`  archive: ${path.relative(ROOT, output)}`);
  console.log(`  sha256: ${digest}`);
  console.log(`  files:  ${entries.length}`);
}

async function main(argv) {
  const update = argv.includes('--update');
  const recipe = readRecipe();
  const sources = recipe.get('source') || [];
  if (sources.length !== 1)
    throw new Error(`The recipe must declare exactly one source archive, found ${sources.length}`);
  const archiveName = path.posix.basename(sources[0]);
  if (!archiveName.endsWith('.tar.gz'))
    throw new Error(`The source must be a tar.gz archive: ${sources[0]}`);
  const topLevel = archiveName.slice(0, -'.tar.gz'.length);
  const pinned = recipe.get('sha256sums') || [];
  if (pinned.length !== 1 || !/^[a-f0-9]{64}$/.test(pinned[0]))
    throw new Error('The recipe must pin exactly one sha256 digest for the source archive');

  if (update) {
    await runUpdate(archiveName, topLevel);
    return;
  }
  await runDefault(archiveName, topLevel, pinned[0]);
}

// The module is imported by the test suite as well, so the command only
// runs when this file is the program that was started.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2)).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
