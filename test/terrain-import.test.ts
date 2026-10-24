import { describe, expect, it } from 'vitest';
import { writeArrayBuffer } from 'geotiff';
import proj4 from 'proj4';
import { LocalFrame } from '../src/dis/geodesy.js';
import { Engine } from '../src/sim/engine.js';
import { type GeoJsonCollection, importTerrain } from '../src/terrain/import.js';
import type { TerrainDataset } from '../src/shared/types.js';

// A synthetic DEM around 51.035N 10.05E: a slope rising to the east with a flat lake
// basin (180 m) in the south-west.
const LAKE = { lon: [10.01, 10.03], lat: [51.005, 51.02] };
function elevation(lon: number, lat: number): number {
  if (lon > LAKE.lon[0] && lon < LAKE.lon[1] && lat > LAKE.lat[0] && lat < LAKE.lat[1]) return 180;
  return 200 + (lon - 10) * 3000 + Math.sin(lat * 400) * 5;
}

async function geographicDem(): Promise<ArrayBuffer> {
  const w = 200;
  const h = 140;
  const res = 0.0005;
  const values = new Float32Array(w * h);
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) values[r * w + c] = elevation(10 + (c + 0.5) * res, 51.07 - (r + 0.5) * res);
  return writeArrayBuffer(values, { width: w, height: h, ModelPixelScale: [res, res, 0], ModelTiepoint: [0, 0, 0, 10, 51.07, 0], GeographicTypeGeoKey: 4326, GTModelTypeGeoKey: 2, SampleFormat: [3], BitsPerSample: [32] });
}

async function utmDem(epsg = 32632): Promise<ArrayBuffer> {
  const p = proj4('EPSG:4326', '+proj=utm +zone=32 +datum=WGS84 +units=m +no_defs');
  const [x0, y1] = p.forward([10.0, 51.07]);
  const res = 40;
  const w = 180;
  const h = 200;
  const values = new Float32Array(w * h);
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const [lon, lat] = p.inverse([x0 + (c + 0.5) * res, y1 - (r + 0.5) * res]);
      values[r * w + c] = elevation(lon, lat);
    }
  }
  return writeArrayBuffer(values, { width: w, height: h, ModelPixelScale: [res, res, 0], ModelTiepoint: [0, 0, 0, x0, y1, 0], ProjectedCSTypeGeoKey: epsg, GTModelTypeGeoKey: 1, SampleFormat: [3], BitsPerSample: [32] });
}

const features: GeoJsonCollection = {
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', properties: { natural: 'water', name: 'Test Lake' }, geometry: { type: 'Polygon', coordinates: [[[LAKE.lon[0], LAKE.lat[0]], [LAKE.lon[1], LAKE.lat[0]], [LAKE.lon[1], LAKE.lat[1]], [LAKE.lon[0], LAKE.lat[1]], [LAKE.lon[0], LAKE.lat[0]]]] } },
    { type: 'Feature', properties: { landuse: 'forest' }, geometry: { type: 'Polygon', coordinates: [[[10.06, 51.04], [10.08, 51.04], [10.08, 51.055], [10.06, 51.055], [10.06, 51.04]]] } },
    { type: 'Feature', properties: { highway: 'primary', name: 'B1' }, geometry: { type: 'LineString', coordinates: [[9.99, 51.035], [10.05, 51.036], [10.11, 51.034]] } },
    { type: 'Feature', properties: { waterway: 'river' }, geometry: { type: 'LineString', coordinates: [[10.045, 51.0], [10.045, 51.07]] } },
    { type: 'Feature', properties: { place: 'village', name: 'Testdorf' }, geometry: { type: 'Point', coordinates: [10.05, 51.045] } },
    { type: 'Feature', properties: { building: 'yes' }, geometry: { type: 'Point', coordinates: [10.05, 51.045] } },
  ],
};

function localOf(ds: TerrainDataset, lon: number, lat: number) {
  const f = new LocalFrame(ds.spec.origin.lat, ds.spec.origin.lon);
  return f.fromGeodetic({ lat: (lat * Math.PI) / 180, lon: (lon * Math.PI) / 180, alt: 0 });
}

describe('terrain import', () => {
  it('resamples a geographic DEM and rasterises features', async () => {
    const ds = await importTerrain({ dem: await geographicDem(), features, name: 'testland', title: 'Test land' });
    expect(ds.format).toBe('werforces-terrain');
    expect(ds.spec.dataset).toBe('testland');
    expect(ds.spec.size).toBeGreaterThan(6000);
    expect(ds.spec.size).toBeLessThan(7100);
    expect(ds.towns.map((t) => t.name)).toEqual(['Testdorf']);
    expect(ds.roads.length).toBe(1);

    const eng = new Engine({ terrainLoader: (n) => (n === 'testland' ? ds : (() => { throw new Error('no'); })()) });
    eng.newScenario('real', { dataset: 'testland' });
    const t = eng.terrain;
    expect(t.spec.dataset).toBe('testland');
    const p = localOf(ds, 10.07, 51.03);
    expect(t.elevation(p.x, p.y)).toBeCloseTo(elevation(10.07, 51.03), -0.5);
    const lake = localOf(ds, 10.02, 51.012);
    expect(t.isWater(lake.x, lake.y)).toBe(true);
    expect(t.surfaceHeight(lake.x, lake.y)).toBeCloseTo(180, 0);
    const wood = localOf(ds, 10.07, 51.048);
    expect(t.isForest(wood.x, wood.y)).toBe(true);
    // The river is water, except where the road bridges it.
    const river = localOf(ds, 10.045, 51.05);
    expect(t.isWater(river.x, river.y)).toBe(true);
    const bridge = localOf(ds, 10.045, 51.035 + (0.001 * 0.055) / 0.06);
    expect(t.isWater(bridge.x, bridge.y)).toBe(false);
    expect(t.isRoad(bridge.x, bridge.y)).toBe(true);

    // Boats float on the lake at its altitude; tanks cannot drive into it.
    const boat = eng.createEntity({ typeId: 'us-patrol-boat', force: 1, x: lake.x, y: lake.y });
    expect(boat.z).toBeCloseTo(180, 0);
    expect(() => eng.createEntity({ typeId: 'us-m1a2', force: 1, x: lake.x, y: lake.y })).toThrow();
    eng.runFor(5);
    expect(boat.z).toBeCloseTo(180, 0);

    // Scenarios keep the dataset reference and reload it.
    const saved = eng.toScenario();
    expect(saved.terrain.dataset).toBe('testland');
    const other = new Engine({ terrainLoader: () => ds });
    other.loadScenario(saved);
    expect(other.terrain.spec.size).toBe(ds.spec.size);
    expect(other.entities.size).toBe(1);
  });

  it('accepts UTM DEMs and agrees with the geographic import', async () => {
    const geo = await importTerrain({ dem: await geographicDem(), name: 'geo', center: { lat: 51.035, lon: 10.05 }, size: 4000, cellSize: 50 });
    const utm = await importTerrain({ dem: await utmDem(), name: 'utm', center: { lat: 51.035, lon: 10.05 }, size: 4000, cellSize: 50 });
    expect(utm.spec.origin.lat).toBeCloseTo(geo.spec.origin.lat, 6);
    const a = new Engine({ terrainLoader: () => geo });
    a.newScenario('a', { dataset: 'geo' });
    const b = new Engine({ terrainLoader: () => utm });
    b.newScenario('b', { dataset: 'utm' });
    for (const [x, y] of [[1000, 1000], [2000, 3000], [3500, 500]]) {
      expect(Math.abs(a.terrain.elevation(x, y) - b.terrain.elevation(x, y))).toBeLessThan(3);
    }
  });

  it('rejects unsupported projections and empty extents', async () => {
    await expect(importTerrain({ dem: await utmDem(2154), name: 'x' })).rejects.toThrow(/unsupported DEM projection EPSG:2154/);
    await expect(importTerrain({ dem: await geographicDem(), name: 'bad name' })).rejects.toThrow(/letters, digits/);
    await expect(importTerrain({ dem: await geographicDem(), name: 'far', center: { lat: 40, lon: 0 } })).rejects.toThrow(/outside the DEM/);
  });

  it('stores heights above 3.2 km with a coarser scale', async () => {
    const w = 20;
    const values = new Float32Array(w * w).map((_, i) => 4000 + i);
    const dem = await writeArrayBuffer(values, { width: w, height: w, ModelPixelScale: [0.001, 0.001, 0], ModelTiepoint: [0, 0, 0, 7, 46.02, 0], GeographicTypeGeoKey: 4326, GTModelTypeGeoKey: 2, SampleFormat: [3], BitsPerSample: [32] });
    const ds = await importTerrain({ dem, name: 'alps' });
    expect(ds.heightScale).toBeGreaterThan(0.1);
    const eng = new Engine({ terrainLoader: () => ds });
    eng.newScenario('alps', { dataset: 'alps' });
    expect(eng.terrain.elevation(eng.terrain.spec.size / 2, eng.terrain.spec.size / 2)).toBeGreaterThan(4000);
  });
});
