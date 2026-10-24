// Tiled terrain datasets on disk: terrains/<name>/manifest.json and gzipped tiles in
// terrains/<name>/tiles/<z>/<x>/<y>.wft (see src/shared/terrainTiles.ts for the format).

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { decodeTile, encodeTile, type TerrainTile, type TileManifest, TilePyramid } from '../shared/terrainTiles.js';
import { tileObstacleTop, type TileSource } from '../sim/tiledTerrain.js';

export const MANIFEST = 'manifest.json';

/** Tiles read from a dataset folder. */
export class FileTileSource implements TileSource {
  readonly manifest: TileManifest;

  constructor(readonly dir: string) {
    const file = path.join(dir, MANIFEST);
    if (!existsSync(file)) throw new Error(`${dir} is not a tiled terrain dataset (no ${MANIFEST})`);
    this.manifest = JSON.parse(readFileSync(file, 'utf8')) as TileManifest;
    if (this.manifest.format !== 'werforces-terrain-tiles') throw new Error(`${file} is not a WeRForces tiled terrain manifest`);
  }

  /** The tile as stored (gzipped), for sending as is; null when there is no such tile. */
  raw(z: number, x: number, y: number): Uint8Array | null {
    return rawTile(this.dir, z, x, y);
  }

  read(z: number, x: number, y: number): TerrainTile | null {
    return readTile(this.dir, z, x, y);
  }
}

function tileFile(dir: string, z: number, x: number, y: number): string {
  return path.join(dir, 'tiles', String(z), String(x), `${y}.wft`);
}

/** A tile file's bytes (gzipped), or null. */
export function rawTile(dir: string, z: number, x: number, y: number): Uint8Array | null {
  if (![z, x, y].every((v) => Number.isInteger(v) && v >= 0)) return null;
  const f = tileFile(dir, z, x, y);
  return existsSync(f) ? readFileSync(f) : null;
}

/** A tile read from a dataset folder (also while the dataset is being written), or null. */
export function readTile(dir: string, z: number, x: number, y: number): TerrainTile | null {
  const raw = rawTile(dir, z, x, y);
  return raw ? decodeTile(gunzipSync(raw)) : null;
}

/** Something that makes tiles for a dataset (a generator or an importer). */
export interface TileMaker {
  manifest: TileManifest;
  read(z: number, x: number, y: number): TerrainTile | null | Promise<TerrainTile | null>;
}

export interface WriteResult {
  manifest: TileManifest;
  tiles: number;
  /** Bytes written (gzipped tiles and manifest). */
  bytes: number;
}

/**
 * Write every tile of every level, then the manifest (with each finest tile's highest
 * obstacle and the elevation range). Replaces the folder's tiles.
 */
export async function writeTileset(maker: TileMaker, dir: string, progress?: (done: number, total: number) => void): Promise<WriteResult> {
  const m = maker.manifest;
  const pyr = new TilePyramid(m.cols, m.spec.cellSize, m.tileSize);
  rmSync(path.join(dir, 'tiles'), { recursive: true, force: true });
  let total = 0;
  for (let z = 0; z <= pyr.maxZoom; z++) total += pyr.across(z) ** 2;
  const fine = pyr.across(pyr.maxZoom);
  const tileTops = new Array<number>(fine * fine).fill(0);
  let min = Infinity;
  let max = -Infinity;
  let done = 0;
  let bytes = 0;
  for (let z = pyr.maxZoom; z >= 0; z--) {
    for (let x = 0; x < pyr.across(z); x++) {
      const folder = path.join(dir, 'tiles', String(z), String(x));
      mkdirSync(folder, { recursive: true });
      for (let y = 0; y < pyr.across(z); y++) {
        const tile = await maker.read(z, x, y);
        if (!tile) throw new Error(`no tile ${z}/${x}/${y}`);
        const encoded = encodeTile(tile);
        if (z === pyr.maxZoom) {
          // From the heights as stored, rounded up with a margin: skipping must never be wrong.
          const stored = decodeTile(encoded);
          tileTops[y * fine + x] = Math.ceil(tileObstacleTop(stored) * 10) / 10 + 0.1;
          for (const h of stored.heights) {
            if (h < min) min = h;
            if (h > max) max = h;
          }
        }
        const gz = gzipSync(encoded, { level: 6 });
        writeFileSync(tileFile(dir, z, x, y), gz);
        bytes += gz.byteLength;
        done++;
        progress?.(done, total);
      }
    }
  }
  const manifest: TileManifest = {
    ...m,
    maxZoom: pyr.maxZoom,
    elevation: { min: Math.round(min * 10) / 10, max: Math.round(max * 10) / 10 },
    tileTops,
    spec: { ...m.spec, relief: Math.round(max - min) },
  };
  const json = JSON.stringify(manifest);
  writeFileSync(path.join(dir, MANIFEST), json);
  return { manifest, tiles: done, bytes: bytes + json.length };
}
