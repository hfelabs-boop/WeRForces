import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SimRunner } from '../src/server/runner.js';
import { SimServer } from '../src/server/server.js';
import { decodeTile, type TerrainTile } from '../src/shared/terrainTiles.js';
import { Engine } from '../src/sim/engine.js';
import { Rng } from '../src/sim/rng.js';
import { Terrain } from '../src/sim/terrain.js';
import { TileCache, TiledTerrain, type TileSource } from '../src/sim/tiledTerrain.js';
import { datasetLoader, listDatasets } from '../src/terrain/store.js';
import { SyntheticTiles } from '../src/terrain/synthetic.js';
import { FileTileSource, writeTileset } from '../src/terrain/tiles.js';

const dir = mkdtempSync(path.join(tmpdir(), 'wf-tiles-'));
const NAME = 'syn20';

/** The finest tiles put back together into one grid (checking that shared edge posts agree). */
function stitch(src: TileSource): Terrain {
  const m = src.manifest;
  const T = m.tileSize;
  const cols = m.cols;
  const across = Math.ceil((cols - 1) / T);
  const heights = new Float32Array(cols * cols);
  const forest = new Uint8Array(cols * cols);
  const water = new Uint8Array(cols * cols);
  const landCover = new Uint8Array(cols * cols);
  const urban = { cover: new Uint8Array(cols * cols), height: new Uint8Array(cols * cols) };
  const seen = new Float32Array(cols * cols).fill(NaN);
  for (let ty = 0; ty < across; ty++) {
    for (let tx = 0; tx < across; tx++) {
      const t = src.read(m.maxZoom, tx, ty) as TerrainTile;
      for (let j = 0; j <= T; j++) {
        for (let i = 0; i <= T; i++) {
          const c = tx * T + i;
          const r = ty * T + j;
          if (c >= cols || r >= cols) continue;
          const g = r * cols + c;
          const p = j * t.n + i;
          if (!Number.isNaN(seen[g])) expect(t.heights[p]).toBe(seen[g]);
          seen[g] = heights[g] = t.heights[p];
          forest[g] = t.forest[p];
          water[g] = t.water![p];
          landCover[g] = t.landCover![p];
          urban.cover[g] = t.urbanCover![p];
          urban.height[g] = t.urbanHeight![p];
        }
      }
    }
  }
  return new Terrain(m.spec, heights, forest, [], m.towns, water, { landCover, urban });
}

describe('tiled terrain datasets', () => {
  let server: SimServer;

  beforeAll(async () => {
    const maker = new SyntheticTiles({ name: NAME, size: 20000, cellSize: 30, tileSize: 64 });
    await writeTileset(maker, path.join(dir, NAME));
  }, 60000);

  afterAll(async () => {
    if (server) {
      server.runner.stop();
      await server.close();
    }
  });

  it('are written as a manifest and tiles, listed and loaded as a TiledTerrain', () => {
    const src = new FileTileSource(path.join(dir, NAME));
    expect(src.manifest.cols).toBe(668);
    expect(src.manifest.maxZoom).toBe(4);
    expect(src.manifest.tileTops.length).toBe(11 * 11);
    expect(listDatasets(dir)).toMatchObject([{ name: NAME, tiled: true, size: 20010, cellSize: 30 }]);
    const t = datasetLoader(dir)(NAME);
    expect(t).toBeInstanceOf(TiledTerrain);
  });

  it('give the same heights and sight lines as one grid, across tile edges', () => {
    const src = new FileTileSource(path.join(dir, NAME));
    const plain = stitch(src);
    const tiled = new TiledTerrain(new TileCache(src, 40 * 65 * 65 * 12));
    const size = plain.spec.size;
    const rng = new Rng(21);
    for (let i = 0; i < 3000; i++) {
      const x = rng.range(0, size);
      const y = i % 2 ? Math.round(rng.range(0, size) / 1920) * 1920 : rng.range(0, size);
      expect(tiled.elevation(x, y)).toBe(plain.elevation(x, y));
      expect(tiled.isWater(x, y)).toBe(plain.isWater(x, y));
      expect(tiled.isForest(x, y)).toBe(plain.isForest(x, y));
      expect(tiled.coverAt(x, y)).toBe(plain.coverAt(x, y));
    }
    let visible = 0;
    for (let i = 0; i < 1500; i++) {
      const p = () => {
        const x = rng.range(0, size);
        const y = rng.range(0, size);
        return { x, y, z: plain.surfaceHeight(x, y) + rng.range(2, i % 5 ? 10 : 150) };
      };
      const a = p();
      const b = p();
      const want = plain.lineOfSight(a, b);
      expect(tiled.lineOfSight(a, b)).toBe(want);
      if (want) visible++;
    }
    expect(visible).toBeGreaterThan(100);
    expect(tiled.cache.stats().evictions).toBeGreaterThan(0);
  });

  it('serve tiles and a light terrain description to the GUI', async () => {
    const engine = new Engine({ terrainLoader: datasetLoader(dir) });
    engine.newScenario('tiled', { dataset: NAME });
    expect(engine.terrain).toBeInstanceOf(TiledTerrain);
    const runner = new SimRunner(engine, 0.1, 20);
    server = new SimServer(runner, { port: 0, host: '127.0.0.1', webRoot: 'dist/web', scenarioDir: 'scenarios', recordingDir: mkdtempSync(path.join(tmpdir(), 'wf-rec-')), terrainDir: dir });
    await server.listen();
    const base = server.address;
    const terrain = await (await fetch(`${base}/api/terrain`)).json();
    expect(terrain.tiles).toMatchObject({ tileSize: 64, maxZoom: 4, url: 'terrain/tiles/{z}/{x}/{y}' });
    expect(terrain.heightsB64).toBe('');
    const info = await (await fetch(`${base}/api/v1/terrain/tiles`)).json();
    expect(info).toMatchObject({ tiled: true, maxZoom: 4, cols: 668 });
    expect(info.levels[0]).toMatchObject({ z: 0, across: 1 });
    const r = await fetch(`${base}/api/v1/terrain/tiles/0/0/0`);
    expect(r.status).toBe(200);
    // fetch undoes the gzip content encoding.
    const tile = decodeTile(new Uint8Array(await r.arrayBuffer()));
    expect([tile.z, tile.x, tile.y, tile.n]).toEqual([0, 0, 0, 65]);
    const raw = new FileTileSource(path.join(dir, NAME)).raw(4, 3, 2)!;
    const fine = await fetch(`${base}/api/v1/terrain/tiles/4/3/2`);
    expect(new Uint8Array(await fine.arrayBuffer())).toEqual(new Uint8Array(gunzipSync(raw)));
    expect((await fetch(`${base}/api/v1/terrain/tiles/5/0/0`)).status).toBe(404);
    expect((await fetch(`${base}/api/v1/terrain/tiles/4/11/0`)).status).toBe(404);
    // Queries work on it as on any terrain.
    const town = engine.terrain.towns[0];
    const pt = await (await fetch(`${base}/api/v1/terrain/point?x=${town.x}&y=${town.y}`)).json();
    expect(pt.elevation).toBeCloseTo(engine.terrain.elevation(town.x, town.y), 0);
  });

  it('serve tiles cut from a small generated terrain too', async () => {
    const engine = new Engine({ terrain: Terrain.generate({ size: 6000, seed: 3, towns: 2 }) });
    const runner = new SimRunner(engine, 0.1, 20);
    const s = new SimServer(runner, { port: 0, host: '127.0.0.1', webRoot: 'dist/web', scenarioDir: 'scenarios', recordingDir: mkdtempSync(path.join(tmpdir(), 'wf-rec-')) });
    await s.listen();
    try {
      const info = await (await fetch(`${s.address}/api/v1/terrain/tiles`)).json();
      expect(info).toMatchObject({ tiled: false, cols: 121, maxZoom: 0 });
      const tile = decodeTile(new Uint8Array(await (await fetch(`${s.address}/api/v1/terrain/tiles/0/0/0`)).arrayBuffer()));
      expect(tile.n).toBe(257);
      expect(tile.heights[5 * 257 + 7]).toBeCloseTo(engine.terrain.heights[5 * 121 + 7], 1);
    } finally {
      await s.close();
    }
  });
});
