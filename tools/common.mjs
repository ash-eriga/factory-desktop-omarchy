import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, readdir, lstat, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRODUCT_SLUG } from './app-identity.mjs';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const versions = JSON.parse(await readFile(path.join(ROOT, 'versions.json'), 'utf8'));

// Read the package revision too: a Linux-only fix is an update even when
// the upstream Desktop version has not changed.
export async function portVersion(root = ROOT) {
  const recipe = await readFile(path.join(root, 'PKGBUILD'), 'utf8');
  const desktop = recipe.match(/^pkgver=((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/m)?.[1];
  const revision = recipe.match(/^pkgrel=([1-9]\d*)$/m)?.[1];
  if (desktop !== versions.desktop || !revision || !Number.isSafeInteger(Number(revision)))
    throw new Error('Invalid port package version');
  return `${desktop}-${revision}`;
}

// The pristine snapshot of the official payload: the untouched files the
// suite validates the patch anchors against, and the source of the
// generated brand assets. The writer and every reader share this path,
// so there is one owner for the destination.
export const SNAPSHOT_DIR = path.join(ROOT, 'build', `upstream-pristine-${versions.desktop}`);

// Bundle executable policy: the complete set of files that must ship
// executable. Everything else is normalized to 0644 and every directory to
// 0755. chrome-sandbox intentionally stays non-setuid: this port relies on
// user namespaces.
const EXECUTABLE_NAMES = new Set(['factory-desktop', 'chrome-sandbox', 'chrome_crashpad_handler', 'droid']);

export function isBundleExecutable(relative) {
  const base = path.basename(relative);
  if (EXECUTABLE_NAMES.has(base)) return true;
  const parts = relative.split(path.sep);
  if (parts[0] === 'port' && base.endsWith('.sh')) return true;
  return false;
}

export function expectedExecutables(relativePaths) {
  return relativePaths.filter(f => isBundleExecutable(f)).sort();
}

export function run(program, args, options = {}) {
  const result = spawnSync(program, args, {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${program} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

export async function hash(file) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}

export function hashText(text) {
  return createHash('sha256').update(text).digest('hex');
}

export async function files(root) {
  const result = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Unexpected symbolic link: ${file}`);
    if (entry.isDirectory()) result.push(...await files(file));
    else if (entry.isFile()) result.push(file);
    else throw new Error(`Unexpected special file: ${file}`);
  }
  return result.sort();
}

export function safePath(value) {
  const name = value.replaceAll('\\', '/');
  if (!name || name.includes('\0') || name.startsWith('/') || /^[A-Za-z]:/.test(name)
      || name.split('/').includes('..')) throw new Error('Unsafe archive path');
  return name;
}

export function validateListing(text) {
  const blocks = text.split('----------').slice(1).join('----------').split(/\r?\n\r?\n/);
  const names = new Set();
  let bytes = 0;
  for (const block of blocks) {
    const name = block.match(/^Path = (.+)$/m)?.[1];
    if (!name) continue;
    const normalized = safePath(name).toLowerCase();
    if (names.has(normalized)) throw new Error('Duplicate archive path');
    names.add(normalized);
    if (/^(?:Symbolic Link|Hard Link) =/m.test(block)) throw new Error('Archive links forbidden');
    const size = Number(block.match(/^Size = (\d+)$/m)?.[1] ?? 0);
    if (!Number.isSafeInteger(size) || size > 2 * 1024 ** 3) throw new Error('Archive entry too large');
    bytes += size;
  }
  if (!names.size || names.size > 300000 || bytes > 4 * 1024 ** 3)
    throw new Error('Archive size or entry limit exceeded');
}

export async function elf(file) {
  const data = await readFile(file);
  if (data.subarray(0, 4).toString('hex') !== '7f454c46' || data[4] !== 2
      || data[5] !== 1 || data.readUInt16LE(18) !== 62) throw new Error('Expected x86_64 ELF');
}

// Fingerprint of a bundle: stable relative paths plus modes. The bundle's own
// top-level manifest.json is excluded because it embeds this fingerprint.
export async function fingerprint(root) {
  const records = {};
  for (const file of await files(root)) {
    if (path.basename(file) === 'manifest.json' && path.dirname(file) === root) continue;
    records[path.relative(root, file)] = {
      sha256: await hash(file), mode: (await lstat(file)).mode & 0o7777,
    };
  }
  return records;
}

// Recipe inputs pin the build: every file whose content can change the
// output bundle or the packaged result. The runtime and packaging trees are
// enumerated deterministically rather than maintained as a hand-written
// list, so a new shipped script is always covered.
const RECIPE_STATIC_INPUTS = ['package.json', 'package-lock.json', 'versions.json', 'PKGBUILD', 'LICENSE'];
const RECIPE_DIRS = ['tools', 'runtime', 'packaging'];

export async function recipeInputList(root = ROOT) {
  const inputs = new Set(RECIPE_STATIC_INPUTS);
  for (const dir of RECIPE_DIRS) {
    for (const file of await files(path.join(root, dir))) {
      inputs.add(path.relative(root, file));
    }
  }
  // Generated Python bytecode is never a recipe input.
  return [...inputs].filter(f => !f.includes('__pycache__') && !f.endsWith('.pyc')).sort();
}

export async function recipeFingerprint(root = ROOT) {
  const recorded = {};
  for (const name of await recipeInputList(root)) {
    const file = path.join(root, name);
    recorded[name] = {
      sha256: await hash(file),
      mode: (await stat(file)).mode & 0o7777,
    };
  }
  return recorded;
}

// A bundle may be reused or accepted only when its recorded recipe matches
// the current one exactly.
export function recipeMatches(manifest, recipe) {
  return JSON.stringify(manifest?.recipe ?? null) === JSON.stringify(recipe ?? null);
}

export async function outputBundle() {
  return path.join(ROOT, 'dist', `${PRODUCT_SLUG}-${versions.desktop}`);
}

export function hostSupported(release, arch) {
  const fields = Object.fromEntries(release.split('\n').filter(s => /^[A-Z_]+=/.test(s))
    .map(s => { const i = s.indexOf('='); return [s.slice(0, i), s.slice(i + 1).replace(/^"|"$/g, '')]; }));
  return arch === 'x64' && (fields.ID === 'arch' || fields.ID === 'omarchy'
    || (fields.ID_LIKE || '').split(/\s+/).includes('arch'));
}

// The pinned checksum of one Electron artifact, as shipped by the locked
// Electron package. The map is the only checksum authority of the build:
// nothing is fetched to replace it. The artifact name is internal: it
// selects the checksum in the map and nothing else reads it.
export function pinnedElectronChecksum(checksums, version, platform = 'linux', arch = 'x64') {
  const name = `electron-v${version}-${platform}-${arch}.zip`;
  const digest = checksums ? checksums[name] : undefined;
  if (!/^[a-f0-9]{64}$/.test(digest || '')) throw new Error('Missing Electron checksum');
  return { digest };
}

// Electron's own downloader verifies the artifact it fetched against
// SHASUMS256.txt. That file lives on the network, and the downloader
// fetches it with the cache bypassed, so an offline build fails before
// the bundle exists. Handing the downloader the checksum map that
// already ships with the locked Electron package makes it GENERATE the
// verification file from the pinned hashes instead of fetching it: the
// internal checksum check stays exactly as strict, the independent
// SHA-256 comparison of the fetched file stays, and no dependency, lock
// file entry or mirror changes. The checksum guards are never relaxed.
export function electronDownloadOptions({ version, checksums, cacheRoot, platform = 'linux', arch = 'x64' }) {
  return {
    version,
    artifactName: 'electron',
    platform,
    arch,
    cacheRoot,
    checksums,
  };
}
