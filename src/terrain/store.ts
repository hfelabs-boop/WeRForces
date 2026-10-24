// Terrain datasets on disk: terrains/<name>.json, written by werforces-terrain.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { TerrainDataset } from '../shared/types.js';

export const DATASET_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** A loader for Engine.terrainLoader that reads datasets from a folder (cached). */
export function datasetLoader(dir: string): (name: string) => TerrainDataset {
  const cache = new Map<string, TerrainDataset>();
  return (name) => {
    if (!DATASET_NAME.test(name)) throw new Error(`invalid terrain dataset name "${name}"`);
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
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .flatMap((f) => {
      try {
        const ds = JSON.parse(readFileSync(path.join(dir, f), 'utf8')) as TerrainDataset;
        if (ds.format !== 'werforces-terrain') return [];
        return [{ name: ds.name, title: ds.title ?? ds.name, size: ds.spec.size, cellSize: ds.spec.cellSize, origin: ds.spec.origin, relief: ds.spec.relief, towns: ds.towns.length, source: ds.source }];
      } catch {
        return [];
      }
    });
}
