// Tiled terrain import for large areas: like importTerrain, but writes a tiled dataset
// (terrains/<name>/) one tile at a time, so the extent is not limited to what fits in one
// grid. The finest tiles are resampled from the DEM (read window by window) and rasterised
// from the map features and land cover; each coarser level is made from the level below.

import { rmSync } from 'node:fs';
import { fromArrayBuffer } from 'geotiff';
import { LocalFrame } from '../dis/geodesy.js';
import { pointInPolygon } from '../shared/math.js';
import { LAND_COVER } from '../shared/terrainGrid.js';
import { emptyTile, type TerrainTile, type TileManifest, TilePyramid, TILE_SIZE } from '../shared/terrainTiles.js';
import type { Building, TerrainSpec, Town, Vec2 } from '../shared/types.js';
import { simplifyPolyline } from '../sim/pathfinding.js';
import { buildingCover } from '../sim/terrain.js';
import { type Geometry, type ImportOptions, type LonLat, buildingHeight, niceCell, PLACES, rasterProjection, ROAD_TYPES, sampler, WATER_LINES } from './import.js';
import { majorityClass, WORLDCOVER_CLASSES, type BBox } from './landcover.js';
import { readTile, type TileMaker, type WriteResult, writeTileset } from './tiles.js';

export interface TiledImportOptions extends ImportOptions {
  /** Dataset folder to write (terrains/<name>). */
  dir: string;
  tileSize?: number;
  progress?: (done: number, total: number) => void;
}

/** Roads of these kinds go in the manifest too (drawn on the overview); all roads are in the tiles. */
const MAIN_ROADS = new Set(['motorway', 'trunk', 'primary', 'secondary', 'motorway_link', 'trunk_link', 'primary_link', 'secondary_link']);
/** Below this many road points in all, every road goes in the manifest. */
const MANIFEST_ROAD_POINTS = 50000;

interface Indexed<T> {
  item: T;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Features filed under the finest tiles their bounding boxes touch. */
class TileIndex<T> {
  private readonly cells = new Map<number, Indexed<T>[]>();

  constructor(
    private readonly span: number,
    private readonly across: number,
  ) {}

  add(item: T, pts: Vec2[]): void {
    if (!pts.length) return;
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const e: Indexed<T> = { item, x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
    for (const k of this.keys(e.x0, e.y0, e.x1, e.y1)) {
      let l = this.cells.get(k);
      if (!l) this.cells.set(k, (l = []));
      l.push(e);
    }
  }

  private keys(x0: number, y0: number, x1: number, y1: number): number[] {
    const c = (v: number) => Math.min(this.across - 1, Math.max(0, Math.floor(v / this.span)));
    const out: number[] = [];
    for (let y = c(y0); y <= c(y1); y++) for (let x = c(x0); x <= c(x1); x++) out.push(y * this.across + x);
    return out;
  }

  /** Items whose boxes overlap the box. */
  query(x0: number, y0: number, x1: number, y1: number): T[] {
    const seen = new Set<Indexed<T>>();
    for (const k of this.keys(x0, y0, x1, y1)) for (const e of this.cells.get(k) ?? []) if (e.x1 >= x0 && e.x0 <= x1 && e.y1 >= y0 && e.y0 <= y1) seen.add(e);
    return [...seen].map((e) => e.item);
  }
}

/** Clip segment a-b to a box (Liang-Barsky); null when it lies outside. */
function clipSegment(a: Vec2, b: Vec2, x0: number, y0: number, x1: number, y1: number): [Vec2, Vec2] | null {
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  for (const [p, q] of [
    [-dx, a.x - x0],
    [dx, x1 - a.x],
    [-dy, a.y - y0],
    [dy, y1 - a.y],
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
}

/** The parts of a polyline inside a box, cut at its edges. */
function clipLine(pts: Vec2[], x0: number, y0: number, x1: number, y1: number): Vec2[][] {
  const out: Vec2[][] = [];
  let run: Vec2[] = [];
  const flush = () => {
    if (run.length >= 2) out.push(run);
    run = [];
  };
  for (let i = 1; i < pts.length; i++) {
    const seg = clipSegment(pts[i - 1], pts[i], x0, y0, x1, y1);
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
  return out;
}

/** Import a DEM (and optional features and land cover) as a tiled dataset. */
export async function importTiledTerrain(opts: TiledImportOptions): Promise<WriteResult> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(opts.name)) throw new Error('dataset name may only contain letters, digits, - and _');
  const tiff = await fromArrayBuffer(opts.dem);
  const image = await tiff.getImage();
  const width = image.getWidth();
  const height = image.getHeight();
  const [minX, minY, maxX, maxY] = image.getBoundingBox();
  const [resX, resY] = image.getResolution();
  const [originX, originY] = image.getOrigin();
  const proj = rasterProjection(image.getGeoKeys() as Record<string, number | undefined>);
  const noDataRaw = image.getGDALNoData();
  const noData = noDataRaw === null ? null : Number(noDataRaw);

  // Extent: a square in a local frame around the centre (no size limit here).
  const rad = Math.PI / 180;
  const corners = [proj.inverse(minX, minY), proj.inverse(maxX, maxY)];
  const center = opts.center ?? { lat: (corners[0][1] + corners[1][1]) / 2, lon: (corners[0][0] + corners[1][0]) / 2 };
  const centerFrame = new LocalFrame(center.lat, center.lon);
  const sw = centerFrame.fromGeodetic({ lat: corners[0][1] * rad, lon: corners[0][0] * rad, alt: 0 });
  const ne = centerFrame.fromGeodetic({ lat: corners[1][1] * rad, lon: corners[1][0] * rad, alt: 0 });
  const fit = 2 * Math.min(-sw.x, -sw.y, ne.x, ne.y) * 0.98;
  if (!(fit > 0)) throw new Error('the centre is outside the DEM');
  const size = Math.round(Math.min(opts.size ?? fit, fit));
  const [cx] = proj.forward(center.lon, center.lat);
  const [ex] = proj.forward(center.lon + 0.001, center.lat);
  const metresPerUnit = (0.001 * rad * 6371000 * Math.cos(center.lat * rad)) / Math.max(1e-12, Math.abs(ex - cx));
  const cellSize = opts.cellSize ?? niceCell(Math.max(20, Math.abs(resX) * metresPerUnit));
  const cols = Math.round(size / cellSize) + 1;
  const extent = (cols - 1) * cellSize;
  const swCorner = centerFrame.toGeodetic({ x: -extent / 2, y: -extent / 2, z: 0 });
  // Features and heights are placed with the exact corner, as importTerrain does; the dataset keeps it rounded.
  const frame = new LocalFrame(swCorner.lat / rad, swCorner.lon / rad);
  const origin = { lat: Math.round((swCorner.lat / rad) * 1e7) / 1e7, lon: Math.round((swCorner.lon / rad) * 1e7) / 1e7 };
  const toLocal = ([lon, lat]: LonLat): Vec2 => {
    const p = frame.fromGeodetic({ lat: lat * rad, lon: lon * rad, alt: 0 });
    return { x: p.x, y: p.y };
  };
  const toLonLat = (x: number, y: number): LonLat => {
    const g = frame.toGeodetic({ x, y, z: 0 });
    return [g.lon / rad, g.lat / rad];
  };
  const bboxOf = (x0: number, y0: number, x1: number, y1: number): BBox => {
    const cs = [toLonLat(x0, y0), toLonLat(x1, y0), toLonLat(x0, y1), toLonLat(x1, y1)];
    return { west: Math.min(...cs.map((c) => c[0])), east: Math.max(...cs.map((c) => c[0])), south: Math.min(...cs.map((c) => c[1])), north: Math.max(...cs.map((c) => c[1])) };
  };

  const tileSize = opts.tileSize ?? TILE_SIZE;
  const pyr = new TilePyramid(cols, cellSize, tileSize);
  const fineSpan = pyr.span(pyr.maxZoom);
  const fineAcross = pyr.across(pyr.maxZoom);

  // Features, in local metres, filed by tile.
  const features = [...(opts.features?.features ?? []), ...(opts.fetchFeatures ? (await opts.fetchFeatures(bboxOf(0, 0, extent, extent))).features : [])];
  const polys = { water: new TileIndex<Vec2[][]>(fineSpan, fineAcross), forest: new TileIndex<Vec2[][]>(fineSpan, fineAcross) };
  const roadIndex = new TileIndex<Vec2[]>(fineSpan, fineAcross);
  const riverIndex = new TileIndex<Vec2[]>(fineSpan, fineAcross);
  const buildingIndex = new TileIndex<Building>(fineSpan, fineAcross);
  const roads: { pts: Vec2[]; main: boolean }[] = [];
  const towns: Town[] = [];
  const inside = (p: Vec2) => p.x >= 0 && p.y >= 0 && p.x <= extent && p.y <= extent;
  const polygons = (g: Geometry): LonLat[][][] => (g.type === 'Polygon' ? [g.coordinates as LonLat[][]] : g.type === 'MultiPolygon' ? (g.coordinates as LonLat[][][]) : []);
  const lines = (g: Geometry): LonLat[][] => (g.type === 'LineString' ? [g.coordinates as LonLat[]] : g.type === 'MultiLineString' ? (g.coordinates as LonLat[][]) : []);
  let buildingCount = 0;
  for (const f of features) {
    const g = f.geometry;
    if (!g) continue;
    const p = f.properties ?? {};
    if (p.building !== undefined && p.building !== 'no') {
      for (const poly of polygons(g)) {
        const pts = (poly[0] ?? []).map(toLocal);
        if (pts.length < 3 || !pts.some(inside)) continue;
        const ring = pts[0].x === pts[pts.length - 1].x && pts[0].y === pts[pts.length - 1].y ? pts.slice(0, -1) : pts;
        buildingIndex.add({ pts: ring.flatMap((q) => [Math.round(q.x * 10) / 10, Math.round(q.y * 10) / 10]), h: buildingHeight(p) }, ring);
        buildingCount++;
      }
      continue;
    }
    const kind = String(p.kind ?? '');
    const isWater = kind === 'water' || p.natural === 'water' || p.water !== undefined || p.landuse === 'reservoir' || p.landuse === 'basin' || p.waterway === 'riverbank';
    const isForest = kind === 'forest' || p.natural === 'wood' || p.landuse === 'forest';
    if (isWater || isForest) {
      for (const poly of polygons(g)) {
        const rings = poly.map((r) => r.map(toLocal));
        if (rings[0]?.length >= 3) (isWater ? polys.water : polys.forest).add(rings, rings[0]);
      }
    }
    if (kind === 'road' || ROAD_TYPES.has(String(p.highway))) {
      for (const l of lines(g)) {
        for (const run of clipLine(l.map(toLocal), 0, 0, extent, extent)) {
          const pts = simplifyPolyline(run, cellSize * 0.4).map((q) => ({ x: Math.round(q.x), y: Math.round(q.y) }));
          roads.push({ pts, main: kind === 'road' || MAIN_ROADS.has(String(p.highway)) });
          roadIndex.add(pts, pts);
        }
      }
    }
    if (kind === 'river' || WATER_LINES.has(String(p.waterway))) for (const l of lines(g)) riverIndex.add(l.map(toLocal), l.map(toLocal));
    if (g.type === 'Point' && (kind === 'town' || PLACES.has(String(p.place))) && p.name) {
      const t = toLocal(g.coordinates as LonLat);
      if (inside(t)) towns.push({ name: String(p.name), x: Math.round(t.x), y: Math.round(t.y) });
    }
  }
  const roadPoints = roads.reduce((n, r) => n + r.pts.length, 0);
  const manifestRoads = roads.filter((r) => roadPoints <= MANIFEST_ROAD_POINTS || r.main).map((r) => r.pts);

  const layers = { water: true, landCover: !!opts.landCover, roads: true, urban: buildingCount > 0 };
  const spec: TerrainSpec = { seed: 0, size: extent, cellSize, origin, relief: 0, waterFraction: 0, forestFraction: 0, towns: towns.length, dataset: opts.name };
  const manifest: TileManifest = {
    format: 'werforces-terrain-tiles',
    version: 1,
    name: opts.name,
    title: opts.title,
    source: { imported: new Date().toISOString(), ...opts.source },
    spec,
    cols,
    tileSize,
    maxZoom: pyr.maxZoom,
    layers,
    elevation: { min: 0, max: 0 },
    tileTops: [],
    towns,
    roads: manifestRoads,
  };
  let posts = 0;
  let missing = 0;
  let wet = 0;
  let wooded = 0;

  /** A finest tile, from the sources. */
  const fineTile = async (tx: number, ty: number): Promise<TerrainTile> => {
    const n = tileSize + 1;
    const z = pyr.maxZoom;
    const t = emptyTile(z, tx, ty, n, layers);
    const x0 = tx * fineSpan;
    const y0 = ty * fineSpan;
    const px = (i: number) => pyr.post(z, tx, i) * cellSize;
    const py = (j: number) => pyr.post(z, ty, j) * cellSize;
    // The DEM window under the tile, with a margin.
    const cornersPx = [
      [x0, y0],
      [x0 + fineSpan, y0],
      [x0, y0 + fineSpan],
      [x0 + fineSpan, y0 + fineSpan],
      [x0 + fineSpan / 2, y0],
      [x0 + fineSpan / 2, y0 + fineSpan],
      [x0, y0 + fineSpan / 2],
      [x0 + fineSpan, y0 + fineSpan / 2],
    ].map(([x, y]) => {
      const [X, Y] = proj.forward(...toLonLat(Math.min(x, extent), Math.min(y, extent)));
      return [(X - originX) / resX, (Y - originY) / resY];
    });
    const wx0 = Math.max(0, Math.floor(Math.min(...cornersPx.map((c) => c[0]))) - 3);
    const wx1 = Math.min(width, Math.ceil(Math.max(...cornersPx.map((c) => c[0]))) + 3);
    const wy0 = Math.max(0, Math.floor(Math.min(...cornersPx.map((c) => c[1]))) - 3);
    const wy1 = Math.min(height, Math.ceil(Math.max(...cornersPx.map((c) => c[1]))) + 3);
    const sample = wx1 > wx0 && wy1 > wy0 ? sampler((await image.readRasters({ window: [wx0, wy0, wx1, wy1], samples: [0] }))[0] as ArrayLike<number>, width, height, noData, { x0: wx0, y0: wy0, w: wx1 - wx0 }) : null;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const [X, Y] = proj.forward(...toLonLat(px(i), py(j)));
        const v = sample ? sample((X - originX) / resX, (Y - originY) / resY) : null;
        if (v === null) missing++;
        t.heights[j * n + i] = v ?? 0;
      }
    }
    const box = [x0 - cellSize, y0 - cellSize, x0 + fineSpan + cellSize, y0 + fineSpan + cellSize] as const;
    const post = (p: Vec2) => {
      const i = Math.round(p.x / cellSize) - tx * tileSize;
      const j = Math.round(p.y / cellSize) - ty * tileSize;
      return i >= 0 && j >= 0 && i < n && j < n ? j * n + i : -1;
    };
    const fill = (rings: Vec2[][], mask: Uint8Array) => {
      const outer = rings[0];
      const xs = outer.map((p) => p.x);
      const ys = outer.map((p) => p.y);
      const i0 = Math.max(0, Math.floor(Math.min(...xs) / cellSize) - tx * tileSize);
      const i1 = Math.min(n - 1, Math.ceil(Math.max(...xs) / cellSize) - tx * tileSize);
      const j0 = Math.max(0, Math.floor(Math.min(...ys) / cellSize) - ty * tileSize);
      const j1 = Math.min(n - 1, Math.ceil(Math.max(...ys) / cellSize) - ty * tileSize);
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const q = { x: px(i), y: py(j) };
          if (pointInPolygon(q, outer) && !rings.slice(1).some((hole) => pointInPolygon(q, hole))) mask[j * n + i] = 1;
        }
      }
    };
    const trace = (pts: Vec2[], mask: Uint8Array) => {
      for (let k = 1; k < pts.length; k++) {
        const a = pts[k - 1];
        const b = pts[k];
        const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (cellSize / 3)));
        for (let s = 0; s <= steps; s++) {
          const q = post({ x: a.x + ((b.x - a.x) * s) / steps, y: a.y + ((b.y - a.y) * s) / steps });
          if (q >= 0) mask[q] = 1;
        }
      }
    };
    for (const rings of polys.water.query(...box)) fill(rings, t.water!);
    for (const rings of polys.forest.query(...box)) fill(rings, t.forest);
    const tileRoads = roadIndex.query(...box);
    for (const r of tileRoads) trace(r, t.roads!);
    const river = new Uint8Array(n * n);
    for (const r of riverIndex.query(...box)) trace(r, river);
    for (let p = 0; p < n * n; p++) if (river[p] && !t.roads![p]) t.water![p] = 1;
    if (opts.landCover) {
      const lc = await opts.landCover(bboxOf(Math.max(0, x0 - cellSize), Math.max(0, y0 - cellSize), Math.min(extent, x0 + fineSpan + cellSize), Math.min(extent, y0 + fineSpan + cellSize)));
      const k = Math.max(1, Math.min(5, Math.round(cellSize / 10)));
      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
          const pts: [number, number][] = [];
          for (let a = 0; a < k; a++) for (let b = 0; b < k; b++) pts.push(toLonLat(px(i) + (-0.5 + (b + 0.5) / k) * cellSize, py(j) + (-0.5 + (a + 0.5) / k) * cellSize));
          const code = majorityClass(lc, pts);
          const cls = code === null ? LAND_COVER.none : (WORLDCOVER_CLASSES[code] ?? LAND_COVER.none);
          const p = j * n + i;
          t.landCover![p] = cls;
          if (cls === LAND_COVER.forest) t.forest[p] = 1;
          if (cls === LAND_COVER.water && t.heights[p] >= 0) t.water![p] = 1;
        }
      }
    }
    for (let p = 0; p < n * n; p++) if (t.water![p] || t.roads![p] || t.heights[p] < 0) t.forest[p] = 0;
    const tileBuildings = buildingIndex.query(...box);
    if (t.urbanCover && tileBuildings.length) buildingCover(tileBuildings, n, n, cellSize, x0, y0, t.urbanCover, t.urbanHeight!);
    // Lines and footprints for drawing: roads cut at the tile's edges, buildings by their first corner.
    const roadsHere = tileRoads.flatMap((r) => clipLine(r, x0, y0, x0 + fineSpan, y0 + fineSpan)).map((r) => r.map((q) => ({ x: Math.round(q.x), y: Math.round(q.y) })));
    const buildingsHere = tileBuildings.filter((b) => Math.floor(b.pts[0] / fineSpan) === tx && Math.floor(b.pts[1] / fineSpan) === ty);
    if (roadsHere.length || buildingsHere.length) t.features = { roads: roadsHere.length ? roadsHere : undefined, buildings: buildingsHere.length ? buildingsHere : undefined };
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        if (tx * tileSize + i >= cols || ty * tileSize + j >= cols || i === n - 1 || j === n - 1) continue;
        const p = j * n + i;
        posts++;
        if (t.water![p] || t.heights[p] < 0) wet++;
        else if (t.forest[p]) wooded++;
      }
    }
    // Running totals: complete once the finest level is written, before the manifest is.
    spec.waterFraction = Math.round((wet / Math.max(1, posts)) * 1000) / 1000;
    spec.forestFraction = Math.round((wooded / Math.max(1, posts - wet)) * 1000) / 1000;
    return t;
  };

  // Coarser levels from the level below (already written): every second post; roads where any
  // post around is a road, so the network stays connected; water where most posts around are.
  const coarseTile = (z: number, tx: number, ty: number): TerrainTile => {
    const n = tileSize + 1;
    const t = emptyTile(z, tx, ty, n, layers);
    const below = pyr.across(z + 1);
    const cache = new Map<number, TerrainTile>();
    const child = (cx: number, cy: number) => {
      const k = cy * below + cx;
      let c = cache.get(k);
      if (!c) {
        c = readTile(opts.dir, z + 1, cx, cy)!;
        cache.set(k, c);
      }
      return c;
    };
    /** Post (k, m) of level z + 1, clamped to the grid as the tiles store it. */
    const at = (k: number, m: number): { c: TerrainTile; p: number } => {
      const lastK = (below - 1) * tileSize + tileSize;
      k = Math.min(Math.max(k, 0), lastK);
      m = Math.min(Math.max(m, 0), lastK);
      const cx = Math.min(Math.floor(k / tileSize), below - 1);
      const cy = Math.min(Math.floor(m / tileSize), below - 1);
      const c = child(cx, cy);
      return { c, p: (m - cy * tileSize) * c.n + (k - cx * tileSize) };
    };
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const K = 2 * (tx * tileSize + i);
        const M = 2 * (ty * tileSize + j);
        const { c, p } = at(K, M);
        const q = j * n + i;
        t.heights[q] = c.heights[p];
        t.forest[q] = c.forest[p];
        if (t.landCover) t.landCover[q] = c.landCover![p];
        if (t.urbanCover) {
          t.urbanCover[q] = c.urbanCover![p];
          t.urbanHeight![q] = c.urbanHeight![p];
        }
        let road = 0;
        let water = 0;
        for (let dm = -1; dm <= 1; dm++) {
          for (let dk = -1; dk <= 1; dk++) {
            const o = at(K + dk, M + dm);
            road |= o.c.roads![o.p];
            water += o.c.water![o.p];
          }
        }
        t.roads![q] = road;
        t.water![q] = c.water![p] || (water >= 3 && !road) ? 1 : 0;
      }
    }
    return t;
  };

  const maker: TileMaker = {
    manifest,
    read: (z, x, y) => (z === pyr.maxZoom ? fineTile(x, y) : coarseTile(z, x, y)),
  };
  const result = await writeTileset(maker, opts.dir, opts.progress);
  if (missing > posts * 0.5) {
    rmSync(opts.dir, { recursive: true, force: true });
    throw new Error('most of the extent has no elevation data; check the centre and size');
  }
  return result;
}
