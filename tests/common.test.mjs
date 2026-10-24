import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { safePath, validateListing, elf, fingerprint } from '../tools/common.mjs';

test('safePath rejects traversal, absolute, and drive paths', () => {
  for (const bad of ['../escape', '/abs', 'C:/win', 'a/../../b', 'x\0y', '']) {
    assert.throws(() => safePath(bad), undefined, `expected rejection: ${bad}`);
  }
  assert.equal(safePath('resources/app.asar'), 'resources/app.asar');
  assert.equal(safePath('a\\b\\c.js'), 'a/b/c.js');
});

test('validateListing accepts a normal listing and rejects boundaries', () => {
  const entry = (p, size = 10) => `---------- 0000000\nPath = ${p}\nSize = ${size}\n\n`;
  validateListing(entry('app/package.json') + entry('app/main.js'));
  // Path traversal in an entry.
  assert.throws(() => validateListing(entry('../evil')));
  // Duplicate path (case-insensitive).
  assert.throws(() => validateListing(entry('App/main.js') + entry('app/main.js')));
  // Link entries.
  assert.throws(() => validateListing(`---------- 0000000\nPath = link\nSize = 1\nSymbolic Link = -> /etc/passwd\n\n`));
  // Oversize entry.
  assert.throws(() => validateListing(entry('big', 3 * 1024 ** 3)));
  // Empty listing.
  assert.throws(() => validateListing('no blocks'));
});

test('elf rejects non-ELF content', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'factory-elf-'));
  try {
    const file = path.join(dir, 'a.bin');
    await writeFile(file, Buffer.from('MZ not an elf'));
    await assert.rejects(() => elf(file));
    // Minimal x86_64 ELF header: magic, 64-bit, little-endian, machine 62.
    const header = Buffer.alloc(20);
    Buffer.from('7f454c460201', 'hex').copy(header);
    header.writeUInt16LE(62, 18);
    await writeFile(file, header);
    await elf(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('fingerprint includes relative paths and modes, excludes only the top-level manifest', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'factory-fp-'));
  try {
    await mkdir(path.join(dir, 'sub'));
    await writeFile(path.join(dir, 'sub', 'file.txt'), 'content');
    await writeFile(path.join(dir, 'manifest.json'), '{}');
    await chmod(path.join(dir, 'sub', 'file.txt'), 0o755);
    const fp = await fingerprint(dir);
    assert.deepEqual(Object.keys(fp), ['sub/file.txt']);
    assert.equal(fp['sub/file.txt'].mode, 0o755);
    assert.match(fp['sub/file.txt'].sha256, /^[a-f0-9]{64}$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
