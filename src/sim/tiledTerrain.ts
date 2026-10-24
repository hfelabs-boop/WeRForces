// Tiled terrain for large areas: the grid posts live in tiles that are read on demand
// into a least-recently-used cache, so memory stays bounded however big the dataset is.
// TiledTerrain answers the same queries as Terrain (elevation, water, forest, mobility,
// line of sight, route planning), with identical results for the same posts.

import { dist2d } from '../shared/math.js';
import { LAND_COVER } from '../shared/terrainGrid.js';
import { type TerrainTile, type TileManifest, TilePyramid, emptyTile, tileBytes } from '../shared/terrainTiles.js';
import type { Domain, TerrainData, Vec2, Vec3 } from '../shared/types.js';
import { gridAStar } from './pathfinding.js';
import type { PostOverlay } from './postOverlay.js';
import { CANOPY_HEIGHT, FOREST_SEE_THROUGH, LOS_BLOCK, LOS_CHUNK, landMobility, Terrain, URBAN_COVERAGE, URBAN_SEE_THROUGH } from './terrain.js';

/** Where tiles come from: files on disk, a generator, or an in-memory grid. */
export interface TileSource {
  readonly manifest: TileManifest;
  /** Read (decode) one tile; null when it does not exist. */
  read(z: number, x: number, y: number): TerrainTile | null;
}

/** Default tile cache size: about 290 tiles of 257 x 257 posts, some 75 km square at 30 m. */
export const DEFAULT_TILE_CACHE_BYTES = 192 * 1024 * 1024;

export interface TileEntry {
  tile: TerrainTile;
  z: number;
  /** Index within its level: y * across + x. */
  index: number;
  bytes: number;
  used: number;
  cached: boolean;
  /** Highest obstacle per LOS_BLOCK x LOS_BLOCK block of posts (finest level), on first use. */
  tops?: Float32Array;
  /** Route costs per post, by domain and off-road factor, on first use. */
  costs?: Map<string, Float32Array>;
}

export interface TileCacheStats {
  /** Tiles held now, and their memory (decoded posts plus derived grids). */
  tiles: number;
  bytes: number;
  capacity: number;
  /** Tiles read from the source, and dropped to make room, since the cache was made. */
  loads: number;
  evictions: number;
}

/** Highest obstacle a sight line could meet over a tile's posts. */
function obstacleTop(t: TerrainTile, i: number): number {
  const urban = t.urbanCover && t.urbanCover[i] >= URBAN_COVERAGE * 100 ? t.urbanHeight![i] : 0;
  return Math.max(0, t.heights[i]) + Math.max(t.forest[i] ? CANOPY_HEIGHT : 0, urban);
}

export function tileObstacleTop(t: TerrainTile): number {
  let top = -Infinity;
  for (let i = 0; i < t.n * t.n; i++) top = Math.max(top, obstacleTop(t, i));
  return top;
}

/**
 * A least-recently-used cache of decoded tiles over a source, bounded in bytes. One cache
 * can serve several TiledTerrain instances (e.g. sessions on the same dataset).
 */
export class TileCache {
  readonly pyramid: TilePyramid;
  /** Per level: tiles per side, and the loaded tiles by index. */
  readonly across: number[];
  private readonly slots: (TileEntry | undefined)[][];
  private readonly live = new Set<TileEntry>();
  private clock = 0;
  bytes = 0;
  loads = 0;
  evictions = 0;
  /** Highest obstacle per finest tile, NaN until the tile has been read (or the manifest says). */
  readonly tops: Float32Array;

  constructor(
    readonly source: TileSource,
    public capacity = DEFAULT_TILE_CACHE_BYTES,
  ) {
    const m = source.manifest;
    this.pyramid = new TilePyramid(m.cols, m.spec.cellSize, m.tileSize);
    this.across = [];
    this.slots = [];
    for (let z = 0; z <= this.pyramid.maxZoom; z++) {
      const a = this.pyramid.across(z);
      this.across.push(a);
      this.slots.push(new Array<TileEntry | undefined>(a * a));
    }
    const n = this.across[this.pyramid.maxZoom] ** 2;
    this.tops = new Float32Array(n).fill(NaN);
    if (m.tileTops?.length === n) this.tops.set(m.tileTops);
  }

  get(z: number, x: number, y: number): TileEntry {
    const i = y * this.across[z] + x;
    const e = this.slots[z][i];
    if (e) {
      e.used = ++this.clock;
      return e;
    }
    return this.load(z, x, y, i);
  }

  /** The loaded tile, if it is in the cache (does not read it). */
  peek(z: number, x: number, y: number): TileEntry | undefined {
    return this.slots[z]?.[y * this.across[z] + x];
  }

  private load(z: number, x: number, y: number, i: number): TileEntry {
    const tile = this.source.read(z, x, y);
    if (!tile) throw new Error(`terrain tile ${z}/${x}/${y} is missing`);
    const e: TileEntry = { tile, z, index: i, bytes: tileBytes(tile), used: ++this.clock, cached: true };
    this.slots[z][i] = e;
    this.live.add(e);
    this.bytes += e.bytes;
    this.loads++;
    if (z === this.pyramid.maxZoom && Number.isNaN(this.tops[i])) this.tops[i] = tileObstacleTop(tile);
    this.trim(e);
    return e;
  }

  /** Count memory added to an entry (grids derived from it), evicting others if need be. */
  grow(e: TileEntry, bytes: number): void {
    if (!e.cached) return;
    e.bytes += bytes;
    this.bytes += bytes;
    this.trim(e);
  }

  private trim(keep: TileEntry): void {
    while (this.bytes > this.capacity && this.live.size > 1) {
      let victim: TileEntry | null = null;
      for (const e of this.live) if (e !== keep && (!victim || e.used < victim.used)) victim = e;
      if (!victim) return;
      this.slots[victim.z][victim.index] = undefined;
      this.live.delete(victim);
      victim.cached = false;
      this.bytes -= victim.bytes;
      this.evictions++;
    }
  }

  clear(): void {
    for (const e of this.live) {
      this.slots[e.z][e.index] = undefined;
      e.cached = false;
    }
    this.live.clear();
    this.bytes = 0;
  }

  stats(): TileCacheStats {
    return { tiles: this.live.size, bytes: this.bytes, capacity: this.capacity, loads: this.loads, evictions: this.evictions };
  }
}

/** Posts per side of a route-planning window: bigger routes are planned coarse first. */
const ROUTE_WINDOW = 640;
/** Posts of margin around a route's end points in its window. */
const ROUTE_MARGIN = 48;

/**
 * Terrain whose posts are read tile by tile from a TileCache. Queries mirror Terrain's
 * arithmetic exactly; long sight lines skip whole tiles they pass above, and long routes
 * are planned on a coarse level first and then refined leg by leg in windows along it.
 */
export class TiledTerrain extends Terrain {
  readonly manifest: TileManifest;
  readonly pyramid: TilePyramid;
  private readonly T: number;
  private readonly fineAcross: number;
  private readonly fineSlots: number;
  /** Local post index set by postEntry(). */
  private pi = 0;
  /** Posts per side of a route-planning window; longer routes are planned coarse first. */
  routeWindow = ROUTE_WINDOW;

  constructor(readonly cache: TileCache) {
    const m = cache.source.manifest;
    super(m.spec, new Float32Array(0), new Uint8Array(0), m.roads ?? [], m.towns);
    this.manifest = m;
    this.pyramid = cache.pyramid;
    this.T = m.tileSize;
    this.fineAcross = cache.across[this.pyramid.maxZoom];
    this.fineSlots = this.fineAcross * this.fineAcross;
  }

  override get heightScale(): number {
    return 0.1;
  }

  override toData(): TerrainData {
    const m = this.manifest;
    return {
      spec: this.spec,
      cols: this.cols,
      rows: this.rows,
      heightsB64: '',
      forestB64: '',
      roads: this.roads,
      towns: this.towns,
      tiles: { tileSize: m.tileSize, maxZoom: this.pyramid.maxZoom, layers: m.layers, elevation: m.elevation, url: 'terrain/tiles/{z}/{x}/{y}' },
    };
  }

  /** The finest tile holding a post or cell (column, row). */
  private fine(ix: number, iy: number): TileEntry {
    const T = this.T;
    const a = this.fineAcross;
    let tx = (ix / T) | 0;
    let ty = (iy / T) | 0;
    if (tx >= a) tx = a - 1;
    if (ty >= a) ty = a - 1;
    return this.cache.get(this.pyramid.maxZoom, tx, ty);
  }

  /** The tile of the post nearest a point; its local index goes to this.pi. */
  private postEntry(x: number, y: number): TileEntry {
    const cs = this.spec.cellSize;
    const ix = Math.min(Math.max(Math.round(x / cs), 0), this.cols - 1);
    const iy = Math.min(Math.max(Math.round(y / cs), 0), this.rows - 1);
    const e = this.fine(ix, iy);
    const T = this.T;
    this.pi = (iy - (e.index / this.fineAcross | 0) * T) * e.tile.n + (ix - (e.index % this.fineAcross) * T);
    return e;
  }

  override elevation(x: number, y: number): number {
    const cs = this.spec.cellSize;
    const fx = Math.min(Math.max(x / cs, 0), this.cols - 1.0001);
    const fy = Math.min(Math.max(y / cs, 0), this.rows - 1.0001);
    const ix = Math.floor(fx);
    const iy = Math.floor(fy);
    const e = this.fine(ix, iy);
    const n = e.tile.n;
    const T = this.T;
    const i = (iy - ((e.index / this.fineAcross) | 0) * T) * n + (ix - (e.index % this.fineAcross) * T);
    const h = e.tile.heights;
    const tx = fx - ix;
    const a = h[i] + (h[i + 1] - h[i]) * tx;
    const b = h[i + n] + (h[i + n + 1] - h[i + n]) * tx;
    return a + (b - a) * (fy - iy);
  }

  override isWater(x: number, y: number): boolean {
    const e = this.postEntry(x, y);
    if (e.tile.water && e.tile.water[this.pi] === 1) return true;
    return this.elevation(x, y) < 0;
  }

  override isForest(x: number, y: number): boolean {
    const e = this.postEntry(x, y);
    return e.tile.forest[this.pi] === 1;
  }

  override coverAt(x: number, y: number): number {
    const e = this.postEntry(x, y);
    return e.tile.landCover ? e.tile.landCover[this.pi] : LAND_COVER.none;
  }

  override isRoad(x: number, y: number): boolean {
    const e = this.postEntry(x, y);
    return !!e.tile.roads && e.tile.roads[this.pi] === 1;
  }

  override urbanAt(x: number, y: number): { cover: number; height: number } {
    const e = this.postEntry(x, y);
    if (!e.tile.urbanCover) return { cover: 0, height: 0 };
    return { cover: e.tile.urbanCover[this.pi] / 100, height: e.tile.urbanHeight![this.pi] };
  }

  override urbanCoverAt(x: number, y: number): number {
    const e = this.postEntry(x, y);
    return e.tile.urbanCover ? e.tile.urbanCover[this.pi] / 100 : 0;
  }

  override isBuiltUp(x: number, y: number): boolean {
    const e = this.postEntry(x, y);
    if (e.tile.urbanCover && e.tile.urbanCover[this.pi] >= URBAN_COVERAGE * 100) return true;
    return !!e.tile.landCover && e.tile.landCover[this.pi] === LAND_COVER.builtUp;
  }

  // ------------------------------------------------------------ line of sight

  /** Finest tile index of the cell a sample at fraction t of a-b falls in. */
  private sampleTile(a: Vec3, b: Vec3, t: number): number {
    const cs = this.spec.cellSize;
    const maxF = this.cols - 1.0001;
    const x = a.x + (b.x - a.x) * t;
    const y = a.y + (b.y - a.y) * t;
    let tx = (Math.floor(Math.min(Math.max(x / cs, 0), maxF)) / this.T) | 0;
    let ty = (Math.floor(Math.min(Math.max(y / cs, 0), maxF)) / this.T) | 0;
    if (tx >= this.fineAcross) tx = this.fineAcross - 1;
    if (ty >= this.fineAcross) ty = this.fineAcross - 1;
    return ty * this.fineAcross + tx;
  }

  /** Highest obstacle per block of a finest tile's posts (as Terrain's coarse obstacle grid). */
  private blockTops(e: TileEntry): Float32Array {
    if (e.tops) return e.tops;
    const t = e.tile;
    const n = t.n;
    const bc = Math.ceil((n - 1) / LOS_BLOCK) + 1;
    const max = new Float32Array(bc * bc).fill(-Infinity);
    // Block (br, bcol) holds posts LOS_BLOCK * br .. LOS_BLOCK * (br + 1): edge posts are in both blocks.
    const tops = new Float32Array(n * n);
    for (let i = 0; i < n * n; i++) tops[i] = obstacleTop(t, i);
    for (let br = 0; br < bc; br++) {
      for (let bcol = 0; bcol < bc; bcol++) {
        let m = -Infinity;
        for (let r = br * LOS_BLOCK; r <= Math.min(n - 1, (br + 1) * LOS_BLOCK); r++) {
          for (let c = bcol * LOS_BLOCK; c <= Math.min(n - 1, (bcol + 1) * LOS_BLOCK); c++) if (tops[r * n + c] > m) m = tops[r * n + c];
        }
        max[br * bc + bcol] = m;
      }
    }
    e.tops = max;
    this.cache.grow(e, max.byteLength);
    return max;
  }

  /** Lowest the sight line gets between fractions t0..t1, curvature included. */
  private static lowest(a: Vec3, b: Vec3, t0: number, t1: number, bulge: number): number {
    const tm = Math.min(Math.max(0.5, t0), t1);
    return Math.min(a.z + (b.z - a.z) * t0, a.z + (b.z - a.z) * t1) - bulge * tm * (1 - tm);
  }

  override lineOfSight(a: Vec3, b: Vec3): boolean {
    const d = dist2d(a, b);
    if (d < 1) return true;
    const cs = this.spec.cellSize;
    const n = Math.ceil(d / (cs / 2));
    const stepLen = d / n;
    const bulge = this.bulge(d);
    const T = this.T;
    const A = this.fineAcross;
    const cols = this.cols;
    const maxF = cols - 1.0001;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    let underCanopy = 0;
    let amongBuildings = 0;
    let k = 1;
    while (k < n) {
      // The run of samples k..kEnd whose cells are in one tile: a line crosses a tile once.
      const tile = this.sampleTile(a, b, k / n);
      const tx = tile % A;
      const ty = (tile / A) | 0;
      let tExit = 1;
      if (dx > 0 && tx < A - 1) tExit = Math.min(tExit, ((tx + 1) * T * cs - a.x) / dx);
      if (dx < 0 && tx > 0) tExit = Math.min(tExit, (tx * T * cs - a.x) / dx);
      if (dy > 0 && ty < A - 1) tExit = Math.min(tExit, ((ty + 1) * T * cs - a.y) / dy);
      if (dy < 0 && ty > 0) tExit = Math.min(tExit, (ty * T * cs - a.y) / dy);
      let kEnd = Math.min(n - 1, Math.max(k, Math.floor(tExit * n)));
      while (kEnd > k && this.sampleTile(a, b, kEnd / n) !== tile) kEnd--;
      while (kEnd + 1 < n && this.sampleTile(a, b, (kEnd + 1) / n) === tile) kEnd++;
      // A tile wholly below the line is skipped without reading it.
      const top = this.cache.tops[tile];
      if (top < TiledTerrain.lowest(a, b, k / n, kEnd / n, bulge)) {
        k = kEnd + 1;
        continue;
      }
      const e = this.cache.get(this.pyramid.maxZoom, tx, ty);
      const t = e.tile;
      const tn = t.n;
      const h = t.heights;
      const c0 = tx * T;
      const r0 = ty * T;
      const tops = this.blockTops(e);
      const bc = Math.ceil((tn - 1) / LOS_BLOCK) + 1;
      for (let j = k; j <= kEnd; j++) {
        if ((j - k) % LOS_CHUNK === 0) {
          const j1 = Math.min(kEnd, j + LOS_CHUNK - 1);
          if (this.clearAboveLocal(a, b, j / n, j1 / n, tops, bc, c0, r0, tn, bulge)) {
            j = j1;
            continue;
          }
        }
        const f = j / n;
        const x = a.x + (b.x - a.x) * f;
        const y = a.y + (b.y - a.y) * f;
        const z = a.z + (b.z - a.z) * f - bulge * f * (1 - f);
        const fx = Math.min(Math.max(x / cs, 0), maxF);
        const fy = Math.min(Math.max(y / cs, 0), maxF);
        const ix = Math.floor(fx);
        const iy = Math.floor(fy);
        const i = (iy - r0) * tn + (ix - c0);
        const h0 = h[i] + (h[i + 1] - h[i]) * (fx - ix);
        const h1 = h[i + tn] + (h[i + tn + 1] - h[i + tn]) * (fx - ix);
        const ground = Math.max(0, h0 + (h1 - h0) * (fy - iy));
        if (ground > z) return false;
        const p = (Math.min(Math.max(Math.round(y / cs), 0), cols - 1) - r0) * tn + (Math.min(Math.max(Math.round(x / cs), 0), cols - 1) - c0);
        if (ground + CANOPY_HEIGHT > z && t.forest[p] === 1) {
          underCanopy += stepLen;
          if (underCanopy > FOREST_SEE_THROUGH) return false;
        }
        if (t.urbanCover && t.urbanCover[p] >= URBAN_COVERAGE * 100 && ground + t.urbanHeight![p] > z) {
          amongBuildings += stepLen;
          if (amongBuildings > URBAN_SEE_THROUGH) return false;
        }
      }
      k = kEnd + 1;
    }
    return true;
  }

  /** As Terrain.clearAbove, over the block maxima of one tile (c0, r0: its south-west post). */
  private clearAboveLocal(a: Vec3, b: Vec3, t0: number, t1: number, tops: Float32Array, bc: number, c0: number, r0: number, n: number, bulge: number): boolean {
    const cs = this.spec.cellSize;
    const xa = a.x + (b.x - a.x) * t0;
    const xb = a.x + (b.x - a.x) * t1;
    const ya = a.y + (b.y - a.y) * t0;
    const yb = a.y + (b.y - a.y) * t1;
    const zMin = TiledTerrain.lowest(a, b, t0, t1, bulge);
    const lc0 = Math.max(0, Math.floor(Math.min(xa, xb) / cs) - c0);
    const lc1 = Math.min(n - 1, Math.ceil(Math.max(xa, xb) / cs) - c0);
    const lr0 = Math.max(0, Math.floor(Math.min(ya, yb) / cs) - r0);
    const lr1 = Math.min(n - 1, Math.ceil(Math.max(ya, yb) / cs) - r0);
    for (let br = Math.floor(lr0 / LOS_BLOCK); br <= Math.floor(lr1 / LOS_BLOCK); br++) {
      for (let bcol = Math.floor(lc0 / LOS_BLOCK); bcol <= Math.floor(lc1 / LOS_BLOCK); bcol++) {
        if (tops[br * bc + bcol] >= zMin) return false;
      }
    }
    return true;
  }

  // ------------------------------------------------------------ route planning

  /** Route cost (1 / mobility, Infinity when impassable) of a finest-level post. */
  private fineCost(c: number, r: number, key: string, domain: Domain, offroadFactor: number): number {
    const e = this.fine(c, r);
    const T = this.T;
    const n = e.tile.n;
    const lc = c - (e.index % this.fineAcross) * T;
    const lr = r - ((e.index / this.fineAcross) | 0) * T;
    let grid = e.costs?.get(key);
    if (!grid) {
      grid = new Float32Array(n * n);
      const cs = this.spec.cellSize;
      const gc0 = (e.index % this.fineAcross) * T;
      const gr0 = ((e.index / this.fineAcross) | 0) * T;
      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
          const f = this.mobilityFactor(Math.min(gc0 + i, this.cols - 1) * cs, Math.min(gr0 + j, this.rows - 1) * cs, domain, offroadFactor);
          grid[j * n + i] = f <= 0.01 ? Infinity : 1 / f;
        }
      }
      (e.costs ??= new Map()).set(key, grid);
      this.cache.grow(e, grid.byteLength);
    }
    return grid[lr * n + lc];
  }

  /** Route cost of a post of a coarse level, from that level's own (subsampled) posts. */
  private coarseCost(z: number, c: number, r: number, key: string, domain: Domain, offroadFactor: number): number {
    const T = this.T;
    const a = this.cache.across[z];
    const tx = Math.min((c / T) | 0, a - 1);
    const ty = Math.min((r / T) | 0, a - 1);
    const e = this.cache.get(z, tx, ty);
    const t = e.tile;
    const n = t.n;
    let grid = e.costs?.get(key);
    if (!grid) {
      grid = new Float32Array(n * n);
      const cell = this.pyramid.cell(z);
      const h = t.heights;
      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
          const p = j * n + i;
          const water = h[p] < 0 || (!!t.water && t.water[p] === 1);
          let f: number;
          if (domain === 'surface') f = water ? 1 : 0;
          else if (water) f = 0;
          else {
            const sx = (h[j * n + Math.min(n - 1, i + 1)] - h[j * n + Math.max(0, i - 1)]) / ((Math.min(n - 1, i + 1) - Math.max(0, i - 1)) * cell);
            const sy = (h[Math.min(n - 1, j + 1) * n + i] - h[Math.max(0, j - 1) * n + i]) / ((Math.min(n - 1, j + 1) - Math.max(0, j - 1)) * cell);
            const road = !!t.roads && t.roads[p] === 1;
            f = landMobility(domain, offroadFactor, Math.hypot(sx, sy), road, t.forest[p] === 1, road || !t.landCover ? LAND_COVER.none : t.landCover[p], road || !t.urbanCover ? 0 : t.urbanCover[p] / 100);
          }
          grid[p] = f <= 0.01 ? Infinity : 1 / f;
        }
      }
      (e.costs ??= new Map()).set(key, grid);
      this.cache.grow(e, grid.byteLength);
    }
    return grid[(r - ty * T) * n + (c - tx * T)];
  }

  override planRoute(from: Vec2, to: Vec2, domain: Domain, offroadFactor: number, overlay: PostOverlay | null = null): Vec2[] | null {
    if (domain === 'air') return [to];
    const cs = this.spec.cellSize;
    if (dist2d(from, to) < cs * 6 && Number.isFinite(this.segmentCost(from, to, domain, offroadFactor, overlay))) return [to];
    const key = `${domain}:${offroadFactor}`;
    const cols = this.cols;
    const cost = overlay
      ? (c: number, r: number) => this.fineCost(c, r, key, domain, offroadFactor) * overlay.get(r * cols + c)
      : (c: number, r: number) => this.fineCost(c, r, key, domain, offroadFactor);
    const span = Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y)) / cs;
    let pts: Vec2[] | null;
    if (span + 2 * ROUTE_MARGIN <= this.routeWindow) {
      pts = this.windowRoute(from, to, [from, to], ROUTE_MARGIN, cost) ?? this.windowRoute(from, to, [from, to], ROUTE_MARGIN * 3, cost);
    } else {
      pts = this.longRoute(from, to, key, domain, offroadFactor, cost);
    }
    if (!pts) return null;
    const smoothed = this.smoothPath(pts, domain, offroadFactor, overlay);
    smoothed.shift(); // drop the start node; the entity is already there
    const last = smoothed[smoothed.length - 1];
    if (!last || dist2d(last, to) > 1) {
      if (this.mobilityFactor(to.x, to.y, domain, offroadFactor) > 0) smoothed.push({ ...to });
    }
    return smoothed.length ? smoothed : [to];
  }

  /**
   * Grid A* from a to b over the finest posts in a window around `cover` (plus a margin).
   * Returns the posts passed, a's nearest passable post first; null when there is no way.
   */
  private windowRoute(a: Vec2, b: Vec2, cover: Vec2[], margin: number, cost: (c: number, r: number) => number): Vec2[] | null {
    const cs = this.spec.cellSize;
    const xs = cover.map((p) => p.x / cs);
    const ys = cover.map((p) => p.y / cs);
    const c0 = Math.max(0, Math.floor(Math.min(...xs)) - margin);
    const c1 = Math.min(this.cols - 1, Math.ceil(Math.max(...xs)) + margin);
    const r0 = Math.max(0, Math.floor(Math.min(...ys)) - margin);
    const r1 = Math.min(this.rows - 1, Math.ceil(Math.max(...ys)) + margin);
    const w = c1 - c0 + 1;
    const hgt = r1 - r0 + 1;
    const local = (c: number, r: number) => cost(c0 + c, r0 + r);
    const start = nearestPassable(a.x / cs - c0, a.y / cs - r0, w, hgt, local);
    const goal = nearestPassable(b.x / cs - c0, b.y / cs - r0, w, hgt, local);
    if (start < 0 || goal < 0) return null;
    const res = gridAStar(w, hgt, start, goal, local, 1, w * hgt);
    if (!res) return null;
    return res.nodes.map((i) => ({ x: (c0 + (i % w)) * cs, y: (r0 + Math.floor(i / w)) * cs }));
  }

  /** Coarse route over a subsampled level, then finest-level legs in windows along it. */
  private longRoute(from: Vec2, to: Vec2, key: string, domain: Domain, offroadFactor: number, cost: (c: number, r: number) => number): Vec2[] | null {
    const cs = this.spec.cellSize;
    const span = Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y)) / cs;
    // The finest level whose window covers the whole route.
    let z = this.pyramid.maxZoom;
    while (z > 0 && span / this.pyramid.stride(z) + 2 * ROUTE_MARGIN > this.routeWindow) z--;
    const cell = this.pyramid.cell(z);
    const levelCols = Math.ceil((this.cols - 1) / this.pyramid.stride(z)) + 1;
    const c0 = Math.max(0, Math.floor(Math.min(from.x, to.x) / cell) - ROUTE_MARGIN);
    const c1 = Math.min(levelCols - 1, Math.ceil(Math.max(from.x, to.x) / cell) + ROUTE_MARGIN);
    const r0 = Math.max(0, Math.floor(Math.min(from.y, to.y) / cell) - ROUTE_MARGIN);
    const r1 = Math.min(levelCols - 1, Math.ceil(Math.max(from.y, to.y) / cell) + ROUTE_MARGIN);
    const w = c1 - c0 + 1;
    const hgt = r1 - r0 + 1;
    const coarse = (c: number, r: number) => this.coarseCost(z, c0 + c, r0 + r, key, domain, offroadFactor);
    const start = nearestPassable(from.x / cell - c0, from.y / cell - r0, w, hgt, coarse);
    const goal = nearestPassable(to.x / cell - c0, to.y / cell - r0, w, hgt, coarse);
    if (start < 0 || goal < 0) return null;
    const res = gridAStar(w, hgt, start, goal, coarse, 1, w * hgt);
    if (!res) return null;
    const guide = res.nodes.map((i) => ({ x: Math.min((c0 + (i % w)) * cell, this.spec.size), y: Math.min((r0 + Math.floor(i / w)) * cell, this.spec.size) }));
    guide[guide.length - 1] = to;
    // Legs short enough for a finest-level window, each following its stretch of the coarse route.
    const legLength = (this.routeWindow - 2 * ROUTE_MARGIN) * cs * 0.9;
    const out: Vec2[] = [];
    let at = from;
    let i = 0;
    while (i < guide.length - 1) {
      let j = i + 1;
      while (j < guide.length - 1 && Math.max(Math.abs(guide[j + 1].x - at.x), Math.abs(guide[j + 1].y - at.y)) < legLength) j++;
      const stretch = [at, ...guide.slice(i + 1, j + 1)];
      const leg = this.windowRoute(at, guide[j], stretch, ROUTE_MARGIN, cost) ?? this.windowRoute(at, guide[j], stretch, ROUTE_MARGIN * 3, cost);
      if (!leg) return null;
      out.push(...(out.length ? leg.slice(1) : leg));
      at = leg[leg.length - 1];
      i = j;
    }
    return out;
  }
}

/** Index of the passable node nearest local (fx, fy) in a w x h window, searching outward; -1 if none. */
function nearestPassable(fx: number, fy: number, w: number, h: number, cost: (c: number, r: number) => number, maxRadius = 8): number {
  const c0 = Math.round(fx);
  const r0 = Math.round(fy);
  for (let rad = 0; rad <= maxRadius; rad++) {
    let best = -1;
    let bestD = Infinity;
    for (let dr = -rad; dr <= rad; dr++) {
      for (let dc = -rad; dc <= rad; dc++) {
        if (Math.max(Math.abs(dr), Math.abs(dc)) !== rad) continue;
        const c = c0 + dc;
        const r = r0 + dr;
        if (c < 0 || r < 0 || c >= w || r >= h) continue;
        if (!Number.isFinite(cost(c, r))) continue;
        const d = dc * dc + dr * dr;
        if (d < bestD) {
          bestD = d;
          best = r * w + c;
        }
      }
    }
    if (best >= 0) return best;
  }
  return -1;
}

/**
 * Tiles cut from an in-memory Terrain: for serving small terrains as tiles, and for tests.
 * Coarser levels keep every stride-th post; their roads mark any road nearby, so the road
 * network stays connected.
 */
export function gridTileSource(terrain: Terrain, tileSize = 256, name = terrain.spec.dataset ?? 'generated'): TileSource {
  const pyr = new TilePyramid(terrain.cols, terrain.spec.cellSize, tileSize);
  const cs = terrain.spec.cellSize;
  let hasUrban = false;
  for (let r = 0; r < terrain.rows && !hasUrban; r++) for (let c = 0; c < terrain.cols && !hasUrban; c++) if (terrain.urbanAt(c * cs, r * cs).cover > 0) hasUrban = true;
  const layers = { water: !!terrain.water, landCover: !!terrain.landCover, roads: true, urban: hasUrban };
  let min = Infinity;
  let max = -Infinity;
  for (const h of terrain.heights) {
    min = Math.min(min, h);
    max = Math.max(max, h);
  }
  const read = (z: number, x: number, y: number): TerrainTile | null => {
    if (!pyr.valid(z, x, y)) return null;
    const n = tileSize + 1;
    const t = emptyTile(z, x, y, n, layers);
    const s = pyr.stride(z);
    for (let j = 0; j < n; j++) {
      const gr = pyr.post(z, y, j);
      for (let i = 0; i < n; i++) {
        const gc = pyr.post(z, x, i);
        const g = gr * terrain.cols + gc;
        const p = j * n + i;
        t.heights[p] = terrain.heights[g];
        t.forest[p] = terrain.forest[g];
        if (t.water) t.water[p] = terrain.water![g];
        if (t.landCover) t.landCover[p] = terrain.landCover![g];
        let road = false;
        const half = s >> 1;
        for (let dr = -half; dr <= half && !road; dr++) for (let dc = -half; dc <= half && !road; dc++) road = terrain.isRoad((gc + dc) * cs, (gr + dr) * cs);
        t.roads![p] = road ? 1 : 0;
        if (t.urbanCover) {
          const u = terrain.urbanAt(gc * cs, gr * cs);
          t.urbanCover[p] = Math.round(u.cover * 100);
          t.urbanHeight![p] = u.height;
        }
      }
    }
    return t;
  };
  const fine = pyr.across(pyr.maxZoom);
  const tileTops: number[] = [];
  for (let ty = 0; ty < fine; ty++) for (let tx = 0; tx < fine; tx++) tileTops.push(tileObstacleTop(read(pyr.maxZoom, tx, ty)!));
  const manifest: TileManifest = {
    format: 'werforces-terrain-tiles',
    version: 1,
    name,
    spec: terrain.spec,
    cols: terrain.cols,
    tileSize,
    maxZoom: pyr.maxZoom,
    layers,
    elevation: { min, max },
    tileTops,
    towns: terrain.towns,
    roads: terrain.roads,
  };
  return { manifest, read };
}
