// Brand assets of the port, generated from the checksum-pinned official
// payload.
//
// The Factory rotor geometry is proprietary, so it is NOT stored in this
// repository: no SVG or PNG copy of the mark is committed. The geometry is
// extracted, as data, from the official renderer of the pinned Desktop
// release and is accepted only when its SHA-256 digest and its occurrence
// count match the values pinned in versions.json. Nothing from the vendor
// bundle is evaluated, imported or executed here.
//
// The generated files live in the ignored build output directory:
//   factory.svg             512x512 desktop tile (rounded dark plate)
//   factory.png             256x256 raster of the same tile
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, SNAPSHOT_DIR, versions, run, hashText } from './common.mjs';

// The port's desktop tile: a 512px plate with the rotor scaled into it.
const TILE_SIZE = 512;
const TILE_RADIUS = 112;
const TILE_BACKGROUND = '#171717';
const TILE_FOREGROUND = '#ffffff';
const TILE_SCALE = 384 / 700;
// The raster of the tile, as the icon set expects it.
const RASTER_SIZE = 256;

export const BRAND_DIR = path.join(ROOT, 'build', 'brand');

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// The pinned locator, digest and count of the official rotor geometry.
// The pins live in versions.json: they are recipe inputs, not a knob.
function pinnedRotor() {
  const anchor = versions.brandRotorAnchor;
  if (!/^M[\d.]+ [\d.]+$/.test(anchor || ''))
    throw new Error('The pinned rotor anchor is missing or malformed');
  if (!/^[a-f0-9]{64}$/.test(versions.brandRotorSha256 || ''))
    throw new Error('The pinned rotor digest is missing or malformed');
  if (!Number.isInteger(versions.brandRotorOccurrences) || versions.brandRotorOccurrences < 1)
    throw new Error('The pinned rotor occurrence count is missing or malformed');
  return { anchor, sha256: versions.brandRotorSha256, occurrences: versions.brandRotorOccurrences };
}

// Extracts the rotor path data from an official renderer source.
//
// Every occurrence must carry the same geometry, the number of
// occurrences must match the pinned count, the characters must be the
// plain path alphabet, and the digest must match the pinned SHA-256. A
// changed vendor payload fails here instead of producing a wrong icon.
export function extractRotorPath(source) {
  const { anchor, sha256, occurrences } = pinnedRotor();
  const pattern = new RegExp(`(?:d:|d=)"(${escapeRegExp(anchor)}[^"]*)"`, 'g');
  const found = [...source.matchAll(pattern)].map(match => match[1]);
  if (!found.length) throw new Error('Rotor path not found in the official renderer');
  if (new Set(found).size !== 1)
    throw new Error('Rotor path geometry is not unique in the official renderer');
  const data = found[0];
  if (found.length !== occurrences)
    throw new Error(`Rotor path occurrence count changed: ${found.length}, expected ${occurrences}`);
  if (!/^[A-Za-z0-9.,+\-\s]+$/.test(data))
    throw new Error('Unexpected characters in the rotor path');
  const digest = hashText(data);
  if (digest !== sha256)
    throw new Error(`Rotor path digest mismatch: ${digest}`);
  return data;
}

// The desktop tile: the port's own wrapper around the official rotor.
export function buildTileSvg(data) {
  const offset = (TILE_SIZE - 700 * TILE_SCALE) / 2;
  const transform = `translate(${offset} ${offset}) scale(${TILE_SCALE}) translate(-100 -90)`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${TILE_SIZE} ${TILE_SIZE}">`
    + `<rect width="${TILE_SIZE}" height="${TILE_SIZE}" rx="${TILE_RADIUS}" fill="${TILE_BACKGROUND}"/>`
    + `<g transform="${transform}"><title>Factory</title>`
    + `<path d="${data}" fill="${TILE_FOREGROUND}"/></g></svg>\n`;
}

// The generated outputs of the port: the vector and raster desktop tile.
//
// This structure is the only inventory of the output names. The writer
// writes it, the recovery compares it against the files on disk and the
// command announces the names it wrote, so there is no second list of
// names that could drift away from what is produced.
function brandOutputs(data) {
  const tile = { name: 'factory.svg', content: buildTileSvg(data) };
  return [
    tile,
    { name: tile.name.replace(/\.svg$/, '.png'), rasterOf: tile.name },
  ];
}

// The names of the outputs, sorted as they are reported.
function outputNames(outputs) {
  return outputs.map(output => output.name).sort();
}

// Renders the tile vector into the raster icon. rsvg-convert keeps the
// vector the single source of truth.
function renderPng(svgPath, pngPath) {
  try {
    run('rsvg-convert', ['-w', String(RASTER_SIZE), '-h', String(RASTER_SIZE), '-o', pngPath, svgPath]);
  } catch (error) {
    if (error.code === 'ENOENT')
      throw new Error('rsvg-convert is required to render the icon (package librsvg)');
    throw error;
  }
}

// The raster of a vector, as bytes, rendered in a temporary directory.
async function renderedRaster(svg) {
  const dir = await mkdtemp(path.join(tmpdir(), 'factory-brand-'));
  try {
    const svgPath = path.join(dir, 'factory.svg');
    const pngPath = path.join(dir, 'factory.png');
    await writeFile(svgPath, svg);
    renderPng(svgPath, pngPath);
    return await readFile(pngPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Writes every generated brand asset. The raster is produced by
// rsvg-convert, so the vector stays the single source of truth. The
// names of the files that were written are returned: the caller
// announces exactly what was produced.
export async function writeBrandAssets(source) {
  const outputs = brandOutputs(extractRotorPath(source));
  await mkdir(BRAND_DIR, { recursive: true });
  for (const output of outputs) {
    if (output.rasterOf) continue;
    await writeFile(path.join(BRAND_DIR, output.name), output.content);
  }
  const raster = outputs.find(output => output.rasterOf);
  renderPng(path.join(BRAND_DIR, raster.rasterOf), path.join(BRAND_DIR, raster.name));
  return outputNames(outputs);
}

// Verifies the generated assets and restores the ones that are missing or
// altered.
//
// A reused bundle can outlive a cleaned build directory, and a generated
// file can be removed or changed. Both outputs are
// compared with the pinned geometry: an icon that was not verified is
// never kept. The names of the restored files are returned.
export async function ensureBrandAssets(source) {
  const outputs = brandOutputs(extractRotorPath(source));
  const problems = [];
  for (const output of outputs) {
    const file = path.join(BRAND_DIR, output.name);
    if (output.rasterOf) {
      const current = await readFile(file).catch(() => null);
      if (!current) {
        problems.push(output.name);
        continue;
      }
      const vector = outputs.find(item => item.name === output.rasterOf);
      const raster = await renderedRaster(vector.content);
      if (!current.equals(raster)) problems.push(output.name);
      continue;
    }
    const current = await readFile(file, 'utf8').catch(() => null);
    if (current === null) problems.push(output.name);
    else if (current !== output.content) problems.push(output.name);
  }
  if (!problems.length) return [];
  await writeBrandAssets(source);
  return problems.sort();
}

// The pristine official renderer the geometry is extracted from.
function brandSourcePath() {
  return path.join(SNAPSHOT_DIR, 'app', versions.renderer);
}

// Reads the pristine official renderer.
export async function brandSource() {
  const file = brandSourcePath();
  const source = await readFile(file, 'utf8').catch(() => null);
  if (source === null)
    throw new Error(`The pristine vendor snapshot is absent (${path.relative(ROOT, file)}); `
      + 'run the build to produce it, and remove a stale bundle before rebuilding');
  return source;
}

export async function main() {
  const generated = await writeBrandAssets(await brandSource());
  console.log(`Generated ${generated.join(', ')} in ${path.relative(ROOT, BRAND_DIR)}`);
}

// True when this module is the entry point of the process. Both sides are
// resolved as real paths: a checkout in a directory whose name contains
// spaces, accented characters or a '#' is recognised too.
function isEntryPoint() {
  const invoked = process.argv[1];
  if (!invoked) return false;
  try {
    return realpathSync(invoked) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
