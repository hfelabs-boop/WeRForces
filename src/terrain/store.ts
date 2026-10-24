// Terrain datasets on disk: terrains/<name>.json, written by werforces-terrain, and tiled
// datasets in terrains/<name>/ (a manifest and tiles) for large areas.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { TileManifest } from '../shared/terrainTiles.js';
import type { TerrainDataset } from '../shared/types.js';
import { DEFAULT_TILE_CACHE_BYTES, TileCache, TiledTerrain } from '../sim/tiledTerrain.js';
import { FileTileSource, MANIFEST } from './tiles.js';

export const DATASET_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** Tile caches by dataset folder, shared by every engine (session, batch run) using the dataset. */
const tileCaches = new Map<string, TileCache>();
let tileCacheBytes = DEFAULT_TILE_CACHE_BYTES;

/** Memory for each tiled dataset's tile cache (werforces --terrain-cache). */
export function setTileCacheBytes(bytes: number): void {
  tileCacheBytes = bytes;
  for (const c of tileCaches.values()) c.capacity = bytes;
}

/** The shared tile cache of a tiled dataset folder. */
export function tileCacheFor(dir: string): TileCache {
  const key = path.resolve(dir);
  let cache = tileCaches.get(key);
  if (!cache) {
    cache = new TileCache(new FileTileSource(key), tileCacheBytes);
    tileCaches.set(key, cache);
  }
  return cache;
}

export function isTiledDataset(dir: string, name: string): boolean {
  return existsSync(path.join(dir, name, MANIFEST));
}

/**
 * A loader for Engine.terrainLoader that reads datasets from a folder (cached). Tiled
 * datasets come back as a TiledTerrain over the dataset's shared tile cache.
 */
export function datasetLoader(dir: string): (name: string) => TerrainDataset | TiledTerrain {
  const cache = new Map<string, TerrainDataset>();
  return (name) => {
    if (!DATASET_NAME.test(name)) throw new Error(`invalid terrain dataset name "${name}"`);
    if (isTiledDataset(dir, name)) return new TiledTerrain(tileCacheFor(path.join(dir, name)));
    let ds = cache.get(name);
    if (!ds) {
      const file = path.join(dir, `${name}.json`);
      if (!existsSync(file)) throw new Error(`unknown terrain dataset "${name}" (no ${file}); import one with werforces-terrain`);
      ds = JSON.parse(readFileSync(file, 'utf8')) as TerrainDataset;
      if (ds.format !== 'werforces-terrain') throw new Error(`${file} is not a WeRForces terrain dataset`);
      cache.set(name, ds);
    }
    return ds;
  };
}

/** Summaries of the datasets in a folder. */
export function listDatasets(dir: string) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) => {
    try {
      const full = path.join(dir, f);
      if (statSync(full).isDirectory()) {
        if (!existsSync(path.join(full, MANIFEST))) return [];
        const m = JSON.parse(readFileSync(path.join(full, MANIFEST), 'utf8')) as TileManifest;
        if (m.format !== 'werforces-terrain-tiles') return [];
        return [{ name: m.name, title: m.title ?? m.name, size: m.spec.size, cellSize: m.spec.cellSize, origin: m.spec.origin, relief: m.spec.relief, towns: m.towns.length, source: m.source, tiled: true }];
      }
      if (!f.endsWith('.json')) return [];
      const ds = JSON.parse(readFileSync(full, 'utf8')) as TerrainDataset;
      if (ds.format !== 'werforces-terrain') return [];
      return [{ name: ds.name, title: ds.title ?? ds.name, size: ds.spec.size, cellSize: ds.spec.cellSize, origin: ds.spec.origin, relief: ds.spec.relief, towns: ds.towns.length, source: ds.source }];
    } catch {
      return [];
    }
  });
}
