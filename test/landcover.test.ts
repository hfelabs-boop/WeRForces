import { describe, expect, it } from 'vitest';
import { writeArrayBuffer } from 'geotiff';
import { LocalFrame } from '../src/dis/geodesy.js';
import { effectivePk } from '../src/sim/combat.js';
import { Engine } from '../src/sim/engine.js';
import { Terrain } from '../src/sim/terrain.js';
import { LAND_COVER } from '../src/shared/terrainGrid.js';
import { buildingHeight, importTerrain } from '../src/terrain/import.js';
import { landCoverFromFile, worldCoverTileUrl } from '../src/terrain/landcover.js';
import { osmXmlToGeoJson, overpassQuery, overpassToGeoJson } from '../src/terrain/osm.js';

// A flat 200 m DEM around 51.035N 10.05E.
async function flatDem(): Promise<ArrayBuffer> {
  const w = 200;
  const h = 140;
  const res = 0.0005;
  const values = new Float32Array(w * h).fill(200);
  return writeArrayBuffer(values, { width: w, height: h, ModelPixelScale: [res, res, 0], ModelTiepoint: [0, 0, 0, 10, 51.07, 0], GeographicTypeGeoKey: 4326, GTModelTypeGeoKey: 2, SampleFormat: [3], BitsPerSample: [32] });
}

/** WorldCover-style classes: trees west of 10.04E, cropland east, a wetland strip and a built-up patch. */
async function landCoverTiff(): Promise<ArrayBuffer> {
  const res = 1 / 12000;
  const w = 1200;
  const h = 840;
  const values = new Uint8Array(w * h);
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const lon = 10 + (c + 0.5) * res;
      const lat = 51.07 - (r + 0.5) * res;
      let v = lon < 10.04 ? 10 : 40;
      if (lat > 51.05 && lat < 51.055) v = 90;
      if (lon > 10.07 && lon < 10.08 && lat > 51.02 && lat < 51.03) v = 50;
      values[r * w + c] = v;
    }
  }
  return writeArrayBuffer(values, { width: w, height: h, ModelPixelScale: [res, res, 0], ModelTiepoint: [0, 0, 0, 10, 51.07, 0], GeographicTypeGeoKey: 4326, GTModelTypeGeoKey: 2, SampleFormat: [1], BitsPerSample: [8] });
}

const CENTER = { lat: 51.035, lon: 10.05 };

/** An OSM XML village: a 4x4 block of 20 m houses 25 m apart, a tall tower, a road, a wood and a place. */
function villageXml(): string {
  const f = new LocalFrame(CENTER.lat, CENTER.lon);
  const rad = Math.PI / 180;
  const ll = (x: number, y: number) => {
    const g = f.toGeodetic({ x, y, z: 0 });
    return { lat: g.lat / rad, lon: g.lon / rad };
  };
  let id = 1;
  const nodes: string[] = [];
  const ways: string[] = [];
  const node = (x: number, y: number) => {
    const p = ll(x, y);
    nodes.push(`<node id="${id}" lat="${p.lat.toFixed(8)}" lon="${p.lon.toFixed(8)}"/>`);
    return id++;
  };
  const way = (refs: number[], tags: Record<string, string>) =>
    ways.push(`<way id="${id++}">${refs.map((r) => `<nd ref="${r}"/>`).join('')}${Object.entries(tags).map(([k, v]) => `<tag k="${k}" v="${v}"/>`).join('')}</way>`);
  const box = (x: number, y: number, s: number, tags: Record<string, string>) => {
    const a = node(x, y);
    const b = node(x + s, y);
    const c = node(x + s, y + s);
    const d = node(x, y + s);
    way([a, b, c, d, a], tags);
  };
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) box(-50 + i * 25, -50 + j * 25, 20, { building: 'house' });
  box(300, 300, 15, { building: 'yes', height: '42 m' });
  box(-400, 300, 15, { building: 'apartments', 'building:levels': '4' });
  way([node(-2000, -300), node(2000, -300)], { highway: 'primary', name: 'Main &amp; High' });
  // A wood as a multipolygon relation with a clearing.
  const outer = [node(900, 500), node(1500, 500), node(1500, 1100), node(900, 1100)];
  way([...outer, outer[0]], {});
  const outerWay = id - 1;
  const hole = [node(1100, 700), node(1300, 700), node(1300, 900), node(1100, 900)];
  way([...hole, hole[0]], {});
  const holeWay = id - 1;
  const rel = `<relation id="${id++}"><member type="way" ref="${outerWay}" role="outer"/><member type="way" ref="${holeWay}" role="inner"/><tag k="type" v="multipolygon"/><tag k="natural" v="wood"/></relation>`;
  const place = ll(0, 0);
  nodes.push(`<node id="${id++}" lat="${place.lat}" lon="${place.lon}"><tag k="place" v="village"/><tag k="name" v="Oberdorf"/></node>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<osm version="0.6" generator="test">\n${nodes.join('\n')}\n${ways.join('\n')}\n${rel}\n</osm>`;
}

describe('OpenStreetMap input', () => {
  it('converts OSM XML to features: areas, lines, multipolygons and places', () => {
    const fc = osmXmlToGeoJson(villageXml());
    const kinds = fc.features.map((f) => `${f.geometry!.type}:${Object.keys(f.properties ?? {})[0] ?? ''}`);
    expect(kinds.filter((k) => k === 'Polygon:building')).toHaveLength(18);
    expect(kinds).toContain('LineString:highway');
    expect(kinds).toContain('MultiPolygon:type');
    expect(kinds).toContain('Point:place');
    expect(fc.features.find((f) => f.properties?.highway)!.properties!.name).toBe('Main & High');
    const wood = fc.features.find((f) => f.geometry!.type === 'MultiPolygon')!;
    expect((wood.geometry!.coordinates as unknown[][][])[0]).toHaveLength(2); // outer + hole
  });

  it('reads Overpass JSON and builds a bounding-box query', () => {
    const fc = overpassToGeoJson({
      elements: [
        { type: 'node', lat: 51, lon: 10, tags: { place: 'town', name: 'X' } },
        { type: 'way', tags: { building: 'yes' }, geometry: [{ lat: 51, lon: 10 }, { lat: 51, lon: 10.001 }, { lat: 51.001, lon: 10.001 }, { lat: 51, lon: 10 }] },
        { type: 'way', tags: { highway: 'track' }, geometry: [{ lat: 51, lon: 10 }, { lat: 51.01, lon: 10 }] },
      ],
    });
    expect(fc.features.map((f) => f.geometry!.type)).toEqual(['Point', 'Polygon', 'LineString']);
    const q = overpassQuery({ south: 51, west: 10, north: 51.1, east: 10.1 });
    expect(q).toContain('way["building"](51,10,51.1,10.1)');
    expect(q).toContain('out geom');
  });

  it('estimates building heights from tags', () => {
    expect(buildingHeight({ building: 'yes', height: '42 m' })).toBe(42);
    expect(buildingHeight({ building: 'apartments', 'building:levels': '4' })).toBe(13);
    expect(buildingHeight({ building: 'house' })).toBe(7);
    expect(buildingHeight({ building: 'garage' })).toBe(3);
  });

  it('names WorldCover tiles', () => {
    expect(worldCoverTileUrl(50.55, 9.68)).toMatch(/ESA_WorldCover_10m_2021_v200_N48E009_Map\.tif$/);
    expect(worldCoverTileUrl(-33.9, -70.6)).toMatch(/_S36W072_Map\.tif$/);
  });
});

describe('land cover and buildings in imported terrain', () => {
  let dataset: Awaited<ReturnType<typeof importTerrain>>;
  const get = async () => {
    if (dataset) return dataset;
    const tiff = await landCoverTiff();
    dataset = await importTerrain({
      dem: await flatDem(),
      name: 'village',
      center: CENTER,
      size: 6000,
      cellSize: 25,
      features: osmXmlToGeoJson(villageXml()),
      landCover: (bbox) => landCoverFromFile(tiff, bbox),
    });
    return dataset;
  };

  it('imports land cover classes and buildings', async () => {
    const d = await get();
    expect(d.buildings).toHaveLength(18);
    expect(d.buildings!.map((b) => b.h).sort((a, b) => b - a).slice(0, 2)).toEqual([42, 13]);
    const t = Terrain.fromData(JSON.parse(JSON.stringify(d)));
    const f = new LocalFrame(t.spec.origin.lat, t.spec.origin.lon);
    const local = (lat: number, lon: number) => f.fromGeodetic({ lat: (lat * Math.PI) / 180, lon: (lon * Math.PI) / 180, alt: 0 });
    const west = local(51.035, 10.03);
    const east = local(51.035, 10.06);
    const wet = local(51.0525, 10.06);
    const town = local(51.025, 10.075);
    expect(t.coverAt(west.x, west.y)).toBe(LAND_COVER.forest);
    expect(t.isForest(west.x, west.y)).toBe(true);
    expect(t.coverAt(east.x, east.y)).toBe(LAND_COVER.open);
    expect(t.coverAt(wet.x, wet.y)).toBe(LAND_COVER.wetland);
    expect(t.coverAt(town.x, town.y)).toBe(LAND_COVER.builtUp);
    // Wetland and built-up land slow vehicles down.
    expect(t.mobilityFactor(wet.x, wet.y, 'ground', 0.7)).toBeLessThan(t.mobilityFactor(east.x, east.y, 'ground', 0.7) * 0.5);
    expect(t.mobilityFactor(town.x, town.y, 'ground', 0.7)).toBeLessThan(t.mobilityFactor(east.x, east.y, 'ground', 0.7));
    // The OSM wood is forest, but not its clearing.
    const c = t.spec.size / 2;
    expect(t.isForest(c + 1000, c + 600)).toBe(true);
    expect(t.isForest(c + 1200, c + 800)).toBe(false);
  });

  it('buildings block sight at ground level, give cover and stop vehicles', async () => {
    const d = await get();
    const t = Terrain.fromData(JSON.parse(JSON.stringify(d)));
    const eng = new Engine({ terrain: t, terrainLoader: () => d });
    eng.newScenario('village', { dataset: 'village' });
    const c = t.spec.size / 2;
    const block = { x: c - 10, y: c - 10 }; // the middle of the 4x4 block of houses
    expect(t.urbanAt(block.x, block.y).cover).toBeGreaterThan(0.5);
    expect(t.isBuiltUp(block.x, block.y)).toBe(true);
    const z = t.surfaceHeight(c, c);
    // Looking across the block at head height: blocked; from 30 m up (over 7 m roofs): clear.
    expect(t.lineOfSight({ x: c - 300, y: block.y, z: z + 2 }, { x: c + 300, y: block.y, z: z + 2 })).toBe(false);
    expect(t.lineOfSight({ x: c - 300, y: block.y, z: z + 30 }, { x: c + 300, y: block.y, z: z + 2 })).toBe(true);
    // Away from the buildings, open ground is visible.
    expect(t.lineOfSight({ x: c - 300, y: c - 500, z: z + 2 }, { x: c + 300, y: c - 500, z: z + 2 })).toBe(true);
    expect(t.mobilityFactor(block.x, block.y, 'ground', 0.7)).toBe(0);
    expect(t.mobilityFactor(block.x, block.y, 'lifeform', 0.9)).toBeGreaterThan(0);
    // Infantry among the buildings are harder to hit.
    const tank = eng.createEntity({ typeId: 'ru-t72b3', force: 2, x: c, y: c - 600 });
    const inTown = eng.createEntity({ typeId: 'us-rifleman', force: 1, x: block.x, y: block.y });
    const inOpen = eng.createEntity({ typeId: 'us-rifleman', force: 1, x: c + 400, y: c - 400 });
    const w = eng.catalog.weapon('mg-762');
    expect(effectivePk(eng, tank, inTown, w, 500)).toBeCloseTo(effectivePk(eng, tank, inOpen, w, 500) * 0.6, 6);
  });
});
