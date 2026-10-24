import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeArrayBuffer } from 'geotiff';
import { describe, expect, it } from 'vitest';
import { Rng } from '../src/sim/rng.js';
import { Terrain } from '../src/sim/terrain.js';
import { TileCache, TiledTerrain } from '../src/sim/tiledTerrain.js';
import { type GeoJsonCollection, importTerrain } from '../src/terrain/import.js';
import { importTiledTerrain } from '../src/terrain/importTiled.js';
import { landCoverFromFile } from '../src/terrain/landcover.js';
import { FileTileSource } from '../src/terrain/tiles.js';

// Hills around 51.035N 10.05E, a lake, a wood, a road over a river, a village of houses.
const LAKE = { lon: [10.01, 10.03], lat: [51.005, 51.02] };
function elevation(lon: number, lat: number): number {
  if (lon > LAKE.lon[0] && lon < LAKE.lon[1] && lat > LAKE.lat[0] && lat < LAKE.lat[1]) return 180;
  return 200 + (lon - 10) * 3000 + Math.sin(lat * 400) * 25 + Math.cos(lon * 300) * 15;
}

async function dem(): Promise<ArrayBuffer> {
  const w = 200;
  const h = 140;
  const res = 0.0005;
  const values = new Float32Array(w * h);
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) values[r * w + c] = elevation(10 + (c + 0.5) * res, 51.07 - (r + 0.5) * res);
  return writeArrayBuffer(values, { width: w, height: h, ModelPixelScale: [res, res, 0], ModelTiepoint: [0, 0, 0, 10, 51.07, 0], GeographicTypeGeoKey: 4326, GTModelTypeGeoKey: 2, SampleFormat: [3], BitsPerSample: [32] });
}

async function landCover(): Promise<ArrayBuffer> {
  const res = 1 / 6000;
  const w = 600;
  const h = 420;
  const values = new Uint8Array(w * h);
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const lon = 10 + (c + 0.5) * res;
      const lat = 51.07 - (r + 0.5) * res;
      values[r * w + c] = lon < 10.04 ? 10 : lat > 51.05 && lat < 51.055 ? 90 : lat < 51.02 ? 20 : 40;
    }
  }
  return writeArrayBuffer(values, { width: w, height: h, ModelPixelScale: [res, res, 0], ModelTiepoint: [0, 0, 0, 10, 51.07, 0], GeographicTypeGeoKey: 4326, GTModelTypeGeoKey: 2, SampleFormat: [1], BitsPerSample: [8] });
}

const square = (lon: number, lat: number, d: number) => [[[lon, lat], [lon + d, lat], [lon + d, lat + d], [lon, lat + d], [lon, lat]]];
const features: GeoJsonCollection = {
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', properties: { natural: 'water' }, geometry: { type: 'Polygon', coordinates: [[[LAKE.lon[0], LAKE.lat[0]], [LAKE.lon[1], LAKE.lat[0]], [LAKE.lon[1], LAKE.lat[1]], [LAKE.lon[0], LAKE.lat[1]], [LAKE.lon[0], LAKE.lat[0]]]] } },
    { type: 'Feature', properties: { landuse: 'forest' }, geometry: { type: 'Polygon', coordinates: [[[10.06, 51.04], [10.08, 51.04], [10.08, 51.055], [10.06, 51.055], [10.06, 51.04]]] } },
    { type: 'Feature', properties: { highway: 'primary' }, geometry: { type: 'LineString', coordinates: [[9.99, 51.035], [10.05, 51.036], [10.11, 51.034]] } },
    { type: 'Feature', properties: { highway: 'track' }, geometry: { type: 'LineString', coordinates: [[10.05, 51.036], [10.052, 51.06]] } },
    { type: 'Feature', properties: { waterway: 'river' }, geometry: { type: 'LineString', coordinates: [[10.045, 51.0], [10.045, 51.07]] } },
    { type: 'Feature', properties: { place: 'village', name: 'Testdorf' }, geometry: { type: 'Point', coordinates: [10.05, 51.045] } },
    ...Array.from({ length: 12 }, (_, i) => ({ type: 'Feature' as const, properties: { building: 'house' }, geometry: { type: 'Polygon', coordinates: square(10.048 + (i % 4) * 0.0005, 51.044 + Math.floor(i / 4) * 0.0004, 0.0003) } })),
  ],
};

describe('tiled terrain import', () => {
  it('writes tiles that agree post by post with the single-file import', { timeout: 60000 }, async () => {
    const lc = await landCover();
    const opts = { dem: await dem(), features, name: 'hills', center: { lat: 51.035, lon: 10.05 }, size: 6000, cellSize: 25, landCover: (bbox: Parameters<typeof landCoverFromFile>[1]) => landCoverFromFile(lc, bbox) };
    const single = Terrain.fromData(await importTerrain(opts));
    const dir = path.join(mkdtempSync(path.join(tmpdir(), 'wf-tiled-import-')), 'hills');
    const r = await importTiledTerrain({ ...opts, dem: await dem(), dir, tileSize: 64 });
    expect(r.manifest).toMatchObject({ cols: 241, tileSize: 64, maxZoom: 2, layers: { water: true, landCover: true, roads: true, urban: true } });
    expect(r.manifest.towns.map((t) => t.name)).toEqual(['Testdorf']);
    expect(r.manifest.spec).toMatchObject({ size: single.spec.size, origin: single.spec.origin, waterFraction: single.spec.waterFraction, forestFraction: single.spec.forestFraction });
    expect(r.manifest.roads?.length).toBe(single.roads.length);
    const tiled = new TiledTerrain(new TileCache(new FileTileSource(dir)));
    const cs = single.spec.cellSize;
    for (let row = 0; row < single.rows; row++) {
      for (let col = 0; col < single.cols; col++) {
        const [x, y] = [col * cs, row * cs];
        expect(tiled.elevation(x, y)).toBe(single.elevation(x, y));
        expect(tiled.isWater(x, y)).toBe(single.isWater(x, y));
        expect(tiled.isForest(x, y)).toBe(single.isForest(x, y));
        expect(tiled.isRoad(x, y)).toBe(single.isRoad(x, y));
        expect(tiled.coverAt(x, y)).toBe(single.coverAt(x, y));
        expect(tiled.urbanAt(x, y)).toEqual(single.urbanAt(x, y));
      }
    }
    const rng = new Rng(4);
    for (let i = 0; i < 500; i++) {
      const p = () => {
        const x = rng.range(0, single.spec.size);
        const y = rng.range(0, single.spec.size);
        return { x, y, z: single.surfaceHeight(x, y) + rng.range(2, 20) };
      };
      const [a, b] = [p(), p()];
      expect(tiled.lineOfSight(a, b)).toBe(single.lineOfSight(a, b));
    }
    // Every house is drawn from exactly one tile; the roads are cut at tile edges.
    const src = new FileTileSource(dir);
    let houses = 0;
    let roadPieces = 0;
    for (let ty = 0; ty < 4; ty++) {
      for (let tx = 0; tx < 4; tx++) {
        const t = src.read(2, tx, ty)!;
        houses += t.features?.buildings?.length ?? 0;
        roadPieces += t.features?.roads?.length ?? 0;
      }
    }
    expect(houses).toBe(12);
    expect(roadPieces).toBeGreaterThan(2);
    // Coarser levels keep the river (a barrier) and the road (connected).
    const overview = src.read(0, 0, 0)!;
    expect(overview.water!.some((v) => v === 1)).toBe(true);
    expect(overview.roads!.some((v) => v === 1)).toBe(true);
  });
});
