// Real-world terrain import: resamples a GeoTIFF elevation model (DEM) onto the
// simulation's square local grid and rasterises map features (roads, water, forest,
// towns) from GeoJSON, e.g. an OpenStreetMap export. The result is a terrain dataset
// file that scenarios refer to by name.

import { fromArrayBuffer } from 'geotiff';
import proj4 from 'proj4';
import { LocalFrame } from '../dis/geodesy.js';
import { pointInPolygon } from '../shared/math.js';
import { bytesToBase64 } from '../shared/terrainGrid.js';
import type { TerrainDataset, TerrainSpec, Town, Vec2 } from '../shared/types.js';
import { simplifyPolyline } from '../sim/pathfinding.js';
import { Terrain } from '../sim/terrain.js';

export interface ImportOptions {
  /** GeoTIFF file contents. */
  dem: ArrayBuffer;
  /** GeoJSON FeatureCollection (WGS-84 lon/lat), e.g. from OpenStreetMap. */
  features?: GeoJsonCollection;
  /** Dataset name: letters, digits, - and _. */
  name: string;
  title?: string;
  /** Centre of the extent (default: centre of the DEM). */
  center?: { lat: number; lon: number };
  /** Extent in metres (default: the largest square inside the DEM, at most 40 km). */
  size?: number;
  /** Grid spacing in metres (default: about the DEM's resolution, at least 20 m). */
  cellSize?: number;
  source?: TerrainDataset['source'];
}

interface Geometry {
  type: string;
  coordinates: unknown;
}

export interface GeoJsonCollection {
  type: 'FeatureCollection';
  features: { type: 'Feature'; geometry: Geometry | null; properties?: Record<string, unknown> | null }[];
}

type LonLat = [number, number];

const MAX_POSTS = 1201;
const ROAD_TYPES = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link', 'service', 'track']);
const WATER_LINES = new Set(['river', 'canal']);
const PLACES = new Set(['city', 'town', 'village', 'hamlet']);

interface Projection {
  /** WGS-84 lon/lat to raster coordinates. */
  forward(lon: number, lat: number): [number, number];
  /** Raster coordinates to WGS-84 lon/lat. */
  inverse(x: number, y: number): LonLat;
}

/** Projection between WGS-84 lon/lat and the raster's coordinate system. */
function rasterProjection(keys: Record<string, number | undefined>): Projection {
  const projected = keys.ProjectedCSTypeGeoKey;
  const geographic = keys.GeographicTypeGeoKey;
  if (projected && projected !== 32767) {
    let def: string | undefined;
    if (projected >= 32601 && projected <= 32660) def = `+proj=utm +zone=${projected - 32600} +datum=WGS84 +units=m +no_defs`;
    else if (projected >= 32701 && projected <= 32760) def = `+proj=utm +zone=${projected - 32700} +south +datum=WGS84 +units=m +no_defs`;
    else if (projected === 3857 || projected === 900913) def = 'EPSG:3857';
    if (!def) throw new Error(`unsupported DEM projection EPSG:${projected}; reproject it first, e.g. gdalwarp -t_srs EPSG:4326 in.tif out.tif`);
    const p = proj4('EPSG:4326', def);
    return { forward: (lon, lat) => p.forward([lon, lat]) as [number, number], inverse: (x, y) => p.inverse([x, y]) as LonLat };
  }
  // Geographic: WGS-84 and its close relatives (NAD83, ETRS89) are within a metre or so.
  if (geographic && ![4326, 4269, 4258, 4979].includes(geographic) && geographic !== 32767) {
    throw new Error(`unsupported DEM coordinate system EPSG:${geographic}; reproject it to EPSG:4326 first`);
  }
  return { forward: (lon, lat) => [lon, lat], inverse: (x, y) => [x, y] };
}

/** Bilinear sampler over a raster, skipping no-data cells. */
function sampler(values: ArrayLike<number>, width: number, height: number, noData: number | null) {
  const valid = (v: number) => Number.isFinite(v) && (noData === null || Math.abs(v - noData) > 1e-6) && v > -1e4;
  return (col: number, row: number): number | null => {
    const c = Math.min(Math.max(col - 0.5, 0), width - 1);
    const r = Math.min(Math.max(row - 0.5, 0), height - 1);
    const c0 = Math.floor(c);
    const r0 = Math.floor(r);
    const c1 = Math.min(c0 + 1, width - 1);
    const r1 = Math.min(r0 + 1, height - 1);
    const tx = c - c0;
    const ty = r - r0;
    let sum = 0;
    let wsum = 0;
    for (const [cc, rr, w] of [
      [c0, r0, (1 - tx) * (1 - ty)],
      [c1, r0, tx * (1 - ty)],
      [c0, r1, (1 - tx) * ty],
      [c1, r1, tx * ty],
    ] as const) {
      const v = values[rr * width + cc];
      if (!valid(v) || w <= 0) continue;
      sum += v * w;
      wsum += w;
    }
    return wsum > 0 ? sum / wsum : null;
  };
}

const niceCell = (m: number) => [10, 15, 20, 25, 30, 40, 50, 60, 75, 100, 150, 200, 250].find((c) => c >= m) ?? Math.ceil(m / 50) * 50;

/** Build a terrain dataset from a DEM and optional map features. */
export async function importTerrain(opts: ImportOptions): Promise<TerrainDataset> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(opts.name)) throw new Error('dataset name may only contain letters, digits, - and _');
  const tiff = await fromArrayBuffer(opts.dem);
  const image = await tiff.getImage();
  const width = image.getWidth();
  const height = image.getHeight();
  const [minX, minY, maxX, maxY] = image.getBoundingBox();
  const [resX, resY] = image.getResolution();
  const [originX, originY] = image.getOrigin();
  const proj = rasterProjection(image.getGeoKeys() as Record<string, number | undefined>);
  const raster = (await image.readRasters({ samples: [0] }))[0] as ArrayLike<number>;
  const noDataRaw = image.getGDALNoData();
  const sample = sampler(raster, width, height, noDataRaw === null ? null : Number(noDataRaw));

  // Extent: a square in a local frame around the centre.
  const corners = [proj.inverse(minX, minY), proj.inverse(maxX, maxY)];
  const center = opts.center ?? { lat: (corners[0][1] + corners[1][1]) / 2, lon: (corners[0][0] + corners[1][0]) / 2 };
  const centerFrame = new LocalFrame(center.lat, center.lon);
  const rad = Math.PI / 180;
  const sw = centerFrame.fromGeodetic({ lat: corners[0][1] * rad, lon: corners[0][0] * rad, alt: 0 });
  const ne = centerFrame.fromGeodetic({ lat: corners[1][1] * rad, lon: corners[1][0] * rad, alt: 0 });
  const fit = 2 * Math.min(-sw.x, -sw.y, ne.x, ne.y) * 0.98;
  if (!(fit > 0)) throw new Error('the centre is outside the DEM');
  const size = Math.round(Math.min(opts.size ?? Math.min(fit, 40000), fit));
  // Native resolution in metres at the centre.
  const [cx] = proj.forward(center.lon, center.lat);
  const [ex] = proj.forward(center.lon + 0.001, center.lat);
  const metresPerUnit = (0.001 * rad * 6371000 * Math.cos(center.lat * rad)) / Math.max(1e-12, Math.abs(ex - cx));
  const nativeRes = Math.abs(resX) * metresPerUnit;
  let cellSize = opts.cellSize ?? niceCell(Math.max(20, nativeRes));
  if (size / cellSize + 1 > MAX_POSTS) cellSize = niceCell(size / (MAX_POSTS - 1));
  const cols = Math.round(size / cellSize) + 1;
  const extent = (cols - 1) * cellSize;
  const swCorner = centerFrame.toGeodetic({ x: -extent / 2, y: -extent / 2, z: 0 });
  const origin = { lat: swCorner.lat / rad, lon: swCorner.lon / rad };
  const frame = new LocalFrame(origin.lat, origin.lon);

  const toLocal = ([lon, lat]: LonLat): Vec2 => {
    const p = frame.fromGeodetic({ lat: lat * rad, lon: lon * rad, alt: 0 });
    return { x: p.x, y: p.y };
  };
  const toLonLat = (x: number, y: number): LonLat => {
    const g = frame.toGeodetic({ x, y, z: 0 });
    return [g.lon / rad, g.lat / rad];
  };

  // Elevation.
  const n = cols * cols;
  const heights = new Float32Array(n);
  let missing = 0;
  for (let r = 0; r < cols; r++) {
    for (let c = 0; c < cols; c++) {
      const [lon, lat] = toLonLat(c * cellSize, r * cellSize);
      const [X, Y] = proj.forward(lon, lat);
      const v = sample((X - originX) / resX, (Y - originY) / resY);
      if (v === null) missing++;
      heights[r * cols + c] = v ?? 0;
    }
  }
  if (missing > n * 0.5) throw new Error('most of the extent has no elevation data; check the centre and size');

  // Features.
  const forest = new Uint8Array(n);
  const water = new Uint8Array(n);
  const river = new Uint8Array(n);
  const roads: Vec2[][] = [];
  const towns: Town[] = [];
  const post = (p: Vec2) => {
    const c = Math.round(p.x / cellSize);
    const r = Math.round(p.y / cellSize);
    return c >= 0 && r >= 0 && c < cols && r < cols ? r * cols + c : -1;
  };
  const fillPolygon = (rings: LonLat[][], mask: Uint8Array) => {
    const local = rings.map((ring) => ring.map(toLocal));
    const outer = local[0];
    if (!outer || outer.length < 3) return;
    const xs = outer.map((p) => p.x);
    const ys = outer.map((p) => p.y);
    const c0 = Math.max(0, Math.floor(Math.min(...xs) / cellSize));
    const c1 = Math.min(cols - 1, Math.ceil(Math.max(...xs) / cellSize));
    const r0 = Math.max(0, Math.floor(Math.min(...ys) / cellSize));
    const r1 = Math.min(cols - 1, Math.ceil(Math.max(...ys) / cellSize));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const p = { x: c * cellSize, y: r * cellSize };
        if (pointInPolygon(p, outer) && !local.slice(1).some((hole) => pointInPolygon(p, hole))) mask[r * cols + c] = 1;
      }
    }
  };
  const traceLine = (line: LonLat[], mask: Uint8Array) => {
    const pts = line.map(toLocal);
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (cellSize / 3)));
      for (let k = 0; k <= steps; k++) {
        const j = post({ x: a.x + ((b.x - a.x) * k) / steps, y: a.y + ((b.y - a.y) * k) / steps });
        if (j >= 0) mask[j] = 1;
      }
    }
  };
  const inside = (p: Vec2) => p.x >= 0 && p.y >= 0 && p.x <= extent && p.y <= extent;
  /** Clip segment a-b to the extent (Liang-Barsky); null when it lies outside. */
  const clip = (a: Vec2, b: Vec2): [Vec2, Vec2] | null => {
    let t0 = 0;
    let t1 = 1;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    for (const [p, q] of [
      [-dx, a.x],
      [dx, extent - a.x],
      [-dy, a.y],
      [dy, extent - a.y],
    ]) {
      if (p === 0) {
        if (q < 0) return null;
        continue;
      }
      const r = q / p;
      if (p < 0) t0 = Math.max(t0, r);
      else t1 = Math.min(t1, r);
      if (t0 > t1) return null;
    }
    return [
      { x: a.x + dx * t0, y: a.y + dy * t0 },
      { x: a.x + dx * t1, y: a.y + dy * t1 },
    ];
  };
  const addRoad = (line: LonLat[]) => {
    // Keep the parts of the line inside the extent, cut exactly at its edges.
    let run: Vec2[] = [];
    const flush = () => {
      if (run.length >= 2) roads.push(simplifyPolyline(run, cellSize * 0.4).map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) })));
      run = [];
    };
    const pts = line.map(toLocal);
    for (let i = 1; i < pts.length; i++) {
      const seg = clip(pts[i - 1], pts[i]);
      if (!seg) {
        flush();
        continue;
      }
      const last = run[run.length - 1];
      if (!last || Math.hypot(last.x - seg[0].x, last.y - seg[0].y) > 1e-6) {
        flush();
        run.push(seg[0]);
      }
      run.push(seg[1]);
      if (seg[1].x !== pts[i].x || seg[1].y !== pts[i].y) flush();
    }
    flush();
  };
  const polygons = (g: Geometry): LonLat[][][] => (g.type === 'Polygon' ? [g.coordinates as LonLat[][]] : g.type === 'MultiPolygon' ? (g.coordinates as LonLat[][][]) : []);
  const lines = (g: Geometry): LonLat[][] => (g.type === 'LineString' ? [g.coordinates as LonLat[]] : g.type === 'MultiLineString' ? (g.coordinates as LonLat[][]) : []);

  for (const f of opts.features?.features ?? []) {
    const g = f.geometry;
    if (!g) continue;
    const p = f.properties ?? {};
    const kind = String(p.kind ?? '');
    const isWater = kind === 'water' || p.natural === 'water' || p.water !== undefined || p.landuse === 'reservoir' || p.landuse === 'basin' || p.waterway === 'riverbank';
    const isForest = kind === 'forest' || p.natural === 'wood' || p.landuse === 'forest';
    if (isWater) for (const poly of polygons(g)) fillPolygon(poly, water);
    if (isForest) for (const poly of polygons(g)) fillPolygon(poly, forest);
    if (kind === 'road' || ROAD_TYPES.has(String(p.highway))) for (const l of lines(g)) addRoad(l);
    if (kind === 'river' || WATER_LINES.has(String(p.waterway))) for (const l of lines(g)) traceLine(l, river);
    if (g.type === 'Point' && (kind === 'town' || PLACES.has(String(p.place))) && p.name) {
      const t = toLocal(g.coordinates as LonLat);
      if (inside(t)) towns.push({ name: String(p.name), x: Math.round(t.x), y: Math.round(t.y) });
    }
  }
  // Rivers are water except where a road crosses them (bridges).
  const roadPosts = new Uint8Array(n);
  for (const road of roads) traceLine(road.map((q) => toLonLat(q.x, q.y)), roadPosts);
  for (let i = 0; i < n; i++) if (river[i] && !roadPosts[i]) water[i] = 1;
  // No forest on water or roads.
  for (let i = 0; i < n; i++) if (water[i] || roadPosts[i] || heights[i] < 0) forest[i] = 0;

  let lo = Infinity;
  let hi = -Infinity;
  let wet = 0;
  let wooded = 0;
  for (let i = 0; i < n; i++) {
    lo = Math.min(lo, heights[i]);
    hi = Math.max(hi, heights[i]);
    if (water[i] || heights[i] < 0) wet++;
    if (forest[i]) wooded++;
  }
  const spec: TerrainSpec = {
    seed: 0,
    size: extent,
    cellSize,
    origin: { lat: Math.round(origin.lat * 1e7) / 1e7, lon: Math.round(origin.lon * 1e7) / 1e7 },
    relief: Math.round(hi - lo),
    waterFraction: Math.round((wet / n) * 1000) / 1000,
    forestFraction: Math.round((wooded / Math.max(1, n - wet)) * 1000) / 1000,
    towns: towns.length,
    dataset: opts.name,
  };
  const terrain = new Terrain(spec, heights, forest, roads, towns, water.some((v) => v) ? water : null);
  const data = terrain.toData();
  return {
    format: 'werforces-terrain',
    version: 1,
    name: opts.name,
    title: opts.title,
    source: { imported: new Date().toISOString(), ...opts.source },
    ...data,
    waterB64: terrain.water ? bytesToBase64(terrain.water) : undefined,
  };
}
