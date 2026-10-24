// The offline build gate: Electron's own downloader must verify the
// artifact against the PINNED checksums instead of fetching
// SHASUMS256.txt from the network.
//
// The contract under test is the real one: the real @electron/get, the
// real locked checksum map, and the real options the build passes. The
// network is replaced by a stub downloader that records every URL, so
// this test never touches the network and never downloads an artifact.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { downloadArtifact } from '@electron/get';
import { ROOT, versions, pinnedElectronChecksum, electronDownloadOptions } from '../tools/common.mjs';

const pinned = JSON.parse(await readFile(path.join(ROOT, 'node_modules/electron/checksums.json'), 'utf8'));

// A stub downloader: it stands in for the network and records what the
// downloader tried to fetch.
function stubDownloader(payload, calls) {
  return {
    async download(url, targetFilePath) {
      calls.push(url);
      await writeFile(targetFilePath, payload);
    },
  };
}

test('the locked Electron package pins the checksum of the artifact', () => {
  const artifact = `electron-v${versions.electron}-linux-x64.zip`;
  const { digest } = pinnedElectronChecksum(pinned, versions.electron);
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.equal(pinned[artifact], digest,
    'the digest must be the one the locked Electron package ships');
  // The artifact name selects the checksum and is not part of the
  // contract of the helper: nothing outside the helper reads it.
  assert.deepEqual(Object.keys(pinnedElectronChecksum(pinned, versions.electron)), ['digest']);
  // A map without the artifact, or with a malformed digest, is refused.
  assert.throws(() => pinnedElectronChecksum({}, versions.electron), /Missing Electron checksum/);
  assert.throws(() => pinnedElectronChecksum({ [artifact]: 'not-a-digest' }, versions.electron),
    /Missing Electron checksum/);
});

test('the download options carry the pinned map and relax nothing', () => {
  const options = electronDownloadOptions({
    version: versions.electron, checksums: pinned, cacheRoot: '/synthetic/cache',
  });
  assert.equal(options.checksums, pinned, 'the pinned map must travel with the call');
  assert.equal(options.version, versions.electron);
  assert.equal(options.artifactName, 'electron');
  assert.equal(options.platform, 'linux');
  assert.equal(options.arch, 'x64');
  assert.equal(options.cacheRoot, '/synthetic/cache');
  // No guard is switched off and no mirror takes the place of the pinned
  // hashes.
  assert.equal(options.unsafelyDisableChecksums, undefined);
  assert.equal(options.mirrorOptions, undefined);
  assert.equal(options.downloadOptions, undefined);
});

test('with the pinned map the downloader never asks for SHASUMS256.txt', async (t) => {
  const cacheRoot = await mkdtemp(path.join(tmpdir(), 'electron-download-'));
  t.after(() => rm(cacheRoot, { recursive: true, force: true }));
  const payload = Buffer.from('synthetic-electron-zip-payload');
  const digest = createHash('sha256').update(payload).digest('hex');
  const name = `electron-v${versions.electron}-linux-x64.zip`;
  const calls = [];
  const options = electronDownloadOptions({
    version: versions.electron, checksums: { [name]: digest }, cacheRoot,
  });
  options.downloader = stubDownloader(payload, calls);
  const file = await downloadArtifact(options);
  assert.ok(file.endsWith(name));
  assert.equal(calls.filter(url => url.includes('SHASUMS256.txt')).length, 0,
    'the checksum file must not be fetched: the pinned map replaces it');
  assert.equal(calls.length, 1, 'only the artifact itself is fetched');
});

test('a warm cache is verified against the pinned map without any fetch', async (t) => {
  const cacheRoot = await mkdtemp(path.join(tmpdir(), 'electron-download-'));
  t.after(() => rm(cacheRoot, { recursive: true, force: true }));
  const payload = Buffer.from('synthetic-electron-zip-payload');
  const digest = createHash('sha256').update(payload).digest('hex');
  const name = `electron-v${versions.electron}-linux-x64.zip`;
  const checksums = { [name]: digest };
  const firstCalls = [];
  await downloadArtifact({
    ...electronDownloadOptions({ version: versions.electron, checksums, cacheRoot }),
    downloader: stubDownloader(payload, firstCalls),
  });
  // The cached artifact is now verified again, and the network is not
  // consulted at all: this is the offline build path.
  const secondCalls = [];
  const cached = await downloadArtifact({
    ...electronDownloadOptions({ version: versions.electron, checksums, cacheRoot }),
    downloader: {
      async download(url) {
        secondCalls.push(url);
        throw new Error(`network access attempted: ${url}`);
      },
    },
  });
  assert.ok(cached.endsWith(name));
  assert.deepEqual(secondCalls, [], 'the cached artifact must be verified offline');
});

test('without the pinned map the downloader does ask for SHASUMS256.txt', async (t) => {
  const cacheRoot = await mkdtemp(path.join(tmpdir(), 'electron-download-'));
  t.after(() => rm(cacheRoot, { recursive: true, force: true }));
  const payload = Buffer.from('synthetic-electron-zip-payload');
  const calls = [];
  // The control: the same call without the map behaves the way the
  // downloader always behaved, and reaches for the network.
  await assert.rejects(() => downloadArtifact({
    ...electronDownloadOptions({ version: versions.electron, checksums: undefined, cacheRoot }),
    downloader: stubDownloader(payload, calls),
  }));
  assert.equal(calls.filter(url => url.includes('SHASUMS256.txt')).length, 1,
    'without the map the checksum file comes from the network');
});

test('a wrong artifact is refused against the pinned map, offline', async (t) => {
  const cacheRoot = await mkdtemp(path.join(tmpdir(), 'electron-download-'));
  t.after(() => rm(cacheRoot, { recursive: true, force: true }));
  const payload = Buffer.from('synthetic-electron-zip-payload');
  const name = `electron-v${versions.electron}-linux-x64.zip`;
  const calls = [];
  // The pinned digest of the real artifact, against a synthetic payload:
  // the downloader must refuse it and must not fall back to the network.
  await assert.rejects(() => downloadArtifact({
    ...electronDownloadOptions({ version: versions.electron, checksums: pinned, cacheRoot }),
    downloader: stubDownloader(payload, calls),
  }));
  assert.equal(calls.filter(url => url.includes('SHASUMS256.txt')).length, 0,
    'a refused artifact must not trigger a network fetch either');
});

test('the build passes the locked map to the downloader', async () => {
  const source = await readFile(path.join(ROOT, 'tools/build.mjs'), 'utf8');
  assert.match(source, /electronDownloadOptions\(\{/,
    'the build must use the shared download options');
  assert.match(source, /checksums,/,
    'the build must hand the pinned map to the downloader');
  assert.match(source, /hash\(runtimeZip\) !== electronHash/,
    'the independent SHA-256 comparison must stay');
  assert.ok(!/unsafelyDisableChecksums/.test(source),
    'the checksum guard must never be switched off');
  assert.ok(!/ELECTRON_MIRROR|mirrorOptions|customDir|resolveAssetURL/.test(source),
    'no mirror may take the place of the pinned hashes');
});
