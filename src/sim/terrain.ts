// Procedural synthetic terrain: elevation, water, forest, towns and a road network,
// plus mobility, line-of-sight and route planning queries used by the engine.

import { dist2d } from '../shared/math.js';
import { base64ToBytes, bytesToBase64, decodeHeights, LAND_COVER, TerrainGrid } from '../shared/terrainGrid.js';
import type { Building, Domain, TerrainData, TerrainSpec, Town, Vec2, Vec3 } from '../shared/types.js';
import { gridAStar, simplifyPolyline } from './pathfinding.js';
import type { PostOverlay } from './postOverlay.js';
import { Rng } from './rng.js';

export const DEFAULT_TERRAIN: TerrainSpec = {
  seed: 1337,
  size: 16000,
  cellSize: 50,
  origin: { lat: 50.75, lon: 9.9 },
  relief: 320,
  waterFraction: 0.1,
  forestFraction: 0.28,
  towns: 7,
};

export const CANOPY_HEIGHT = 15;
/** Route memo key for routes planned without a cost overlay. */
const NO_OVERLAY = {};
/** Metres of forest a sight line can pass through before it is blocked. */
export const FOREST_SEE_THROUGH = 150;
/** Metres of built-up area a sight line can pass through (streets, gaps) before buildings block it. */
export const URBAN_SEE_THROUGH = 25;
/** A post counts as built-up when buildings cover at least this fraction of its cell. */
export const URBAN_COVERAGE = 0.25;

/** Off-road speed factors by land cover class: [vehicles, on foot]. */
const COVER_MOBILITY: Record<number, [number, number]> = {
  [LAND_COVER.shrub]: [0.8, 0.85],
  [LAND_COVER.builtUp]: [0.7, 0.9],
  [LAND_COVER.wetland]: [0.35, 0.6],
  [LAND_COVER.bare]: [1, 1],
  [LAND_COVER.snow]: [0.6, 0.5],
};

export interface TerrainLayers {
  landCover?: Uint8Array | null;
  buildings?: Building[];
  /** Building cover per post (0-100 % of the cell, mean height in metres), when already rasterised. */
  urban?: { cover: Uint8Array; height: Uint8Array };
}
/** Earth radius in metres. */
export const EARTH_RADIUS = 6371000;
/** Refraction coefficient: standard atmospheric refraction bends sight lines (and radar) round the earth as if it were 4/3 its size. */
export const REFRACTION_K = 4 / 3;
/** Below this range the earth's curvature lowers a sight line by under 6 cm, and is left out. */
export const CURVATURE_MIN_RANGE = 2000;

/**
 * How far the earth's curvature (with refraction) drops a point at distance d below the
 * observer's horizontal: d² / (2kR). A sight line of length d then clears the ground by
 * curvatureDrop(d) * t * (1 - t) less at fraction t along it than on a flat earth.
 */
export function curvatureDrop(d: number): number {
  return (d * d) / (2 * REFRACTION_K * EARTH_RADIUS);
}

/** Line-of-sight samples checked against the coarse obstacle grid at a time. */
export const LOS_CHUNK = 8;
/** Posts per side of a coarse obstacle-height block. */
export const LOS_BLOCK = 4;
const TOWN_NAMES = [
  'Alderford',
  'Brenham',
  'Calloway',
  'Dunmore',
  'Eastwick',
  'Fallow Cross',
  'Greystone',
  'Harrow',
  'Ironbridge',
  'Juniper',
  'Kestrel',
  'Larkhill',
];

function hash2(ix: number, iy: number, seed: number): number {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(seed, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function valueNoise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy, seed);
  const b = hash2(ix + 1, iy, seed);
  const c = hash2(ix, iy + 1, seed);
  const d = hash2(ix + 1, iy + 1, seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

export function fbm(x: number, y: number, seed: number, octaves: number): number {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise(x * freq, y * freq, seed + o * 101);
    norm += amp;
    amp *= 0.5;
    freq *= 2.03;
  }
  return sum / norm;
}

function quantile(values: Float32Array, q: number): number {
  const sorted = Float32Array.from(values).sort();
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)))];
}

export class Terrain extends TerrainGrid {
  readonly roads: Vec2[][];
  readonly towns: Town[];
  private readonly roadMask: Uint8Array;
  /** Coarse obstacle heights for fast line of sight, computed on first use. */
  private tops: { cols: number; max: Float32Array } | null = null;
  /** A* node costs per domain and off-road factor, computed on first use. */
  private readonly costGrids = new Map<string, Float32Array>();
  /** Smoothed A* routes by start and goal post, per route-cost overlay (the result depends on nothing else). */
  private readonly routeMemo = new WeakMap<object, Map<string, Vec2[] | null>>();

  readonly buildings: Building[];
  /** Earth curvature and refraction in line of sight (the engine sets it from rules.curvature). */
  curvature = true;
  /** Per post: fraction (0-100) of the cell covered by buildings, and their mean height in metres. */
  private readonly urbanCover: Uint8Array | null;
  private readonly urbanHeight: Uint8Array | null;

  constructor(spec: TerrainSpec, heights: Float32Array, forest: Uint8Array, roads: Vec2[][], towns: Town[], water: Uint8Array | null = null, layers: TerrainLayers = {}) {
    super(spec, heights, forest, water, layers.landCover ?? null);
    this.roads = roads;
    this.towns = towns;
    this.buildings = layers.buildings ?? [];
    this.roadMask = new Uint8Array(heights.length);
    if (heights.length) for (const road of roads) this.rasterizeRoad(road);
    if (layers.urban) {
      this.urbanCover = layers.urban.cover;
      this.urbanHeight = layers.urban.height;
    } else if (this.buildings.length) {
      this.urbanCover = new Uint8Array(heights.length);
      this.urbanHeight = new Uint8Array(heights.length);
      this.rasterizeBuildings();
    } else {
      this.urbanCover = null;
      this.urbanHeight = null;
    }
  }

  /** Building cover per post: the share of each cell inside footprints (4x4 samples), and their height. */
  private rasterizeBuildings(): void {
    buildingCover(this.buildings, this.cols, this.rows, this.spec.cellSize, 0, 0, this.urbanCover!, this.urbanHeight!);
  }

  /** Building cover at a point: fraction of the area (0-1) and mean height (m). */
  urbanAt(x: number, y: number): { cover: number; height: number } {
    if (!this.urbanCover) return { cover: 0, height: 0 };
    const i = this.nearestPost(x, y);
    return { cover: this.urbanCover[i] / 100, height: this.urbanHeight![i] };
  }

  /** Fraction (0-1) of the area at a point covered by buildings. */
  urbanCoverAt(x: number, y: number): number {
    return this.urbanCover ? this.urbanCover[this.nearestPost(x, y)] / 100 : 0;
  }

  /** True where buildings (or built-up land cover) give cover and concealment. */
  isBuiltUp(x: number, y: number): boolean {
    if (this.urbanCover && this.urbanCover[this.nearestPost(x, y)] >= URBAN_COVERAGE * 100) return true;
    return this.coverAt(x, y) === LAND_COVER.builtUp;
  }

  static generate(partial: Partial<TerrainSpec> = {}): Terrain {
    const spec: TerrainSpec = { ...DEFAULT_TERRAIN, ...partial, origin: { ...DEFAULT_TERRAIN.origin, ...partial.origin } };
    const cols = Math.round(spec.size / spec.cellSize) + 1;
    const n = cols * cols;
    const raw = new Float32Array(n);
    const featureScale = 1 / 5000;
    for (let r = 0; r < cols; r++) {
      for (let c = 0; c < cols; c++) {
        const x = c * spec.cellSize * featureScale;
        const y = r * spec.cellSize * featureScale;
        // Domain-warped fBm gives more natural valleys than plain noise.
        const wx = fbm(x + 3.1, y + 7.7, spec.seed + 17, 3) - 0.5;
        const wy = fbm(x - 5.3, y + 1.9, spec.seed + 29, 3) - 0.5;
        const v = fbm(x + wx * 0.9, y + wy * 0.9, spec.seed, 6);
        raw[r * cols + c] = Math.pow(v, 1.4);
      }
    }
    const lo = quantile(raw, 0);
    const hi = quantile(raw, 0.999);
    const sea = quantile(raw, spec.waterFraction);
    const heights = new Float32Array(n);
    for (let i = 0; i < n; i++) heights[i] = ((raw[i] - sea) / (hi - lo)) * spec.relief;
    // Keep water clearly below sea level so shorelines are well defined.
    for (let i = 0; i < n; i++) if (heights[i] < 0) heights[i] = Math.min(heights[i] * 3 - 1, -1);

    const forestNoise = new Float32Array(n);
    for (let r = 0; r < cols; r++) {
      for (let c = 0; c < cols; c++) {
        forestNoise[r * cols + c] = fbm(c * spec.cellSize / 1800, r * spec.cellSize / 1800, spec.seed + 999, 4);
      }
    }
    const landNoise = forestNoise.filter((_, i) => heights[i] > 2);
    const forestThreshold = landNoise.length ? quantile(landNoise, 1 - spec.forestFraction) : 2;
    const forest = new Uint8Array(n);
    for (let i = 0; i < n; i++) forest[i] = heights[i] > 2 && forestNoise[i] >= forestThreshold ? 1 : 0;

    const base = new Terrain(spec, heights, forest, [], []);
    const towns = base.placeTowns(new Rng(spec.seed ^ 0x5eed));
    for (const t of towns) base.clearForest(t, 350);
    const roads = base.buildRoads(towns);
    for (const road of roads) for (const p of road) base.clearForest(p, 40);
    return new Terrain(spec, heights, base.forest, roads, towns);
  }

  toData(): TerrainData {
    const scale = this.heightScale;
    return {
      spec: this.spec,
      cols: this.cols,
      rows: this.rows,
      heightsB64: this.encodeHeights(scale),
      heightScale: scale === 0.1 ? undefined : scale,
      forestB64: this.encodeForest(),
      waterB64: this.water ? bytesToBase64(this.water) : undefined,
      landCoverB64: this.landCover ? bytesToBase64(this.landCover) : undefined,
      buildings: this.buildings.length ? this.buildings : undefined,
      roads: this.roads,
      towns: this.towns,
    };
  }

  /** Terrain from an imported dataset (or any transmitted terrain data). */
  static override fromData(data: TerrainData): Terrain {
    const spec = data.spec;
    const cols = Math.round(spec.size / spec.cellSize) + 1;
    if (data.cols !== cols || data.rows !== cols) throw new Error('terrain dataset grid does not match its size and cell size');
    return new Terrain(spec, decodeHeights(data), base64ToBytes(data.forestB64), data.roads ?? [], data.towns ?? [], data.waterB64 ? base64ToBytes(data.waterB64) : null, {
      landCover: data.landCoverB64 ? base64ToBytes(data.landCoverB64) : null,
      buildings: data.buildings ?? [],
    });
  }

  // ------------------------------------------------------------ generation helpers

  private placeTowns(rng: Rng): Town[] {
    const towns: Town[] = [];
    const margin = 800;
    const minSep = this.spec.size / Math.sqrt(this.spec.towns) * 0.6;
    for (let attempt = 0; attempt < 4000 && towns.length < this.spec.towns; attempt++) {
      const p = { x: rng.range(margin, this.spec.size - margin), y: rng.range(margin, this.spec.size - margin) };
      const h = this.elevation(p.x, p.y);
      if (h < 4 || this.slope(p.x, p.y) > 0.08) continue;
      if (towns.some((t) => dist2d(t, p) < minSep)) continue;
      towns.push({ name: TOWN_NAMES[towns.length % TOWN_NAMES.length], x: Math.round(p.x), y: Math.round(p.y) });
    }
    return towns;
  }

  private clearForest(p: Vec2, radius: number): void {
    const cs = this.spec.cellSize;
    const r = Math.ceil(radius / cs);
    const c0 = Math.round(p.x / cs);
    const r0 = Math.round(p.y / cs);
    for (let dr = -r; dr <= r; dr++) {
      for (let dc = -r; dc <= r; dc++) {
        const c = c0 + dc;
        const rr = r0 + dr;
        if (c < 0 || rr < 0 || c >= this.cols || rr >= this.rows) continue;
        if (Math.hypot(dc, dr) * cs <= radius) this.forest[rr * this.cols + c] = 0;
      }
    }
  }

  private buildRoads(towns: Town[]): Vec2[][] {
    if (towns.length < 2) return [];
    // Minimum spanning tree over towns plus the shortest remaining link for a loop.
    const inTree = [0];
    const edges: [number, number][] = [];
    while (inTree.length < towns.length) {
      let best: [number, number] | null = null;
      let bestD = Infinity;
      for (const a of inTree) {
        for (let b = 0; b < towns.length; b++) {
          if (inTree.includes(b)) continue;
          const d = dist2d(towns[a], towns[b]);
          if (d < bestD) {
            bestD = d;
            best = [a, b];
          }
        }
      }
      if (!best) break;
      edges.push(best);
      inTree.push(best[1]);
    }
    let extra: [number, number] | null = null;
    let extraD = Infinity;
    for (let a = 0; a < towns.length; a++) {
      for (let b = a + 1; b < towns.length; b++) {
        if (edges.some(([x, y]) => (x === a && y === b) || (x === b && y === a))) continue;
        const d = dist2d(towns[a], towns[b]);
        if (d < extraD) {
          extraD = d;
          extra = [a, b];
        }
      }
    }
    if (extra) edges.push(extra);

    const roadNodes = new Uint8Array(this.heights.length);
    const roads: Vec2[][] = [];
    const cost = (c: number, r: number) => {
      const i = r * this.cols + c;
      if (this.heights[i] < 0.5) return Infinity;
      const x = c * this.spec.cellSize;
      const y = r * this.spec.cellSize;
      const s = this.slope(x, y);
      if (s > 0.35) return Infinity;
      if (roadNodes[i]) return 0.35;
      return 1 + s * 25 + this.forest[i] * 0.8;
    };
    for (const [a, b] of edges) {
      const res = gridAStar(this.cols, this.rows, this.nearestPost(towns[a].x, towns[a].y), this.nearestPost(towns[b].x, towns[b].y), cost, 0.35);
      if (!res) continue;
      for (const i of res.nodes) roadNodes[i] = 1;
      const pts = res.nodes.map((i) => this.postPosition(i));
      roads.push(simplifyPolyline(pts, this.spec.cellSize * 0.4).map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) })));
    }
    return roads;
  }

  private rasterizeRoad(road: Vec2[]): void {
    const step = this.spec.cellSize / 3;
    for (let i = 1; i < road.length; i++) {
      const a = road[i - 1];
      const b = road[i];
      const len = dist2d(a, b);
      const n = Math.max(1, Math.ceil(len / step));
      for (let k = 0; k <= n; k++) {
        const t = k / n;
        this.roadMask[this.nearestPost(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)] = 1;
      }
    }
  }

  postPosition(i: number): Vec2 {
    return { x: (i % this.cols) * this.spec.cellSize, y: Math.floor(i / this.cols) * this.spec.cellSize };
  }

  // ------------------------------------------------------------ queries

  isRoad(x: number, y: number): boolean {
    return this.roadMask[this.nearestPost(x, y)] === 1;
  }

  /**
   * Fraction of maximum speed achievable at a point for a domain (0 = impassable).
   * `offroadFactor` comes from the entity type.
   */
  mobilityFactor(x: number, y: number, domain: Domain, offroadFactor: number): number {
    if (!this.inBounds(x, y)) return 0;
    if (domain === 'air') return 1;
    const water = this.isWater(x, y);
    if (domain === 'surface') return water ? 1 : 0;
    if (water) return 0;
    const road = this.isRoad(x, y);
    return landMobility(domain, offroadFactor, this.slope(x, y), road, this.isForest(x, y), road ? LAND_COVER.none : this.coverAt(x, y), road ? 0 : this.urbanCoverAt(x, y));
  }

  /**
   * Line of sight between two points (z = altitude MSL). Terrain blocks outright; forest
   * canopy only blocks once the sight line has passed through more than
   * FOREST_SEE_THROUGH metres of it, so vehicles at short range or at a wood's edge
   * can still see each other.
   */
  lineOfSight(a: Vec3, b: Vec3): boolean {
    const d = dist2d(a, b);
    if (d < 1) return true;
    const n = Math.ceil(d / (this.spec.cellSize / 2));
    const stepLen = d / n;
    let underCanopy = 0;
    let amongBuildings = 0;
    const bulge = this.bulge(d);
    const tops = this.obstacleTops();
    const cs = this.spec.cellSize;
    const cols = this.cols;
    const maxF = this.cols - 1.0001;
    const h = this.heights;
    for (let k = 1; k < n; k++) {
      // Skip a stretch of samples whose sight line passes above everything below it:
      // neither terrain nor canopy can touch it, so the result is exactly the same.
      if ((k - 1) % LOS_CHUNK === 0) {
        const k1 = Math.min(n - 1, k + LOS_CHUNK - 1);
        if (this.clearAbove(a, b, k / n, k1 / n, tops, bulge)) {
          k = k1;
          continue;
        }
      }
      const t = k / n;
      const x = a.x + (b.x - a.x) * t;
      const y = a.y + (b.y - a.y) * t;
      const z = a.z + (b.z - a.z) * t - bulge * t * (1 - t);
      // Inlined surfaceHeight(x, y): the same arithmetic as TerrainGrid.elevation.
      const fx = Math.min(Math.max(x / cs, 0), maxF);
      const fy = Math.min(Math.max(y / cs, 0), maxF);
      const ix = Math.floor(fx);
      const iy = Math.floor(fy);
      const tx = fx - ix;
      const i = iy * cols + ix;
      const h0 = h[i] + (h[i + 1] - h[i]) * tx;
      const h1 = h[i + cols] + (h[i + cols + 1] - h[i + cols]) * tx;
      const ground = Math.max(0, h0 + (h1 - h0) * (fy - iy));
      if (ground > z) return false;
      if (ground + CANOPY_HEIGHT > z && this.isForest(x, y)) {
        underCanopy += stepLen;
        if (underCanopy > FOREST_SEE_THROUGH) return false;
      }
      if (this.urbanCover) {
        const p = this.nearestPost(x, y);
        if (this.urbanCover[p] >= URBAN_COVERAGE * 100 && ground + this.urbanHeight![p] > z) {
          amongBuildings += stepLen;
          if (amongBuildings > URBAN_SEE_THROUGH) return false;
        }
      }
    }
    return true;
  }

  /**
   * What blocks a sight line, and where: the same test as lineOfSight, sample by sample,
   * for explanations (slower; not for the simulation loop). Null when the line is clear.
   */
  sightBlocker(a: Vec3, b: Vec3): { cause: 'terrain' | 'forest' | 'buildings'; x: number; y: number } | null {
    const d = dist2d(a, b);
    if (d < 1) return null;
    const n = Math.ceil(d / (this.spec.cellSize / 2));
    const stepLen = d / n;
    let underCanopy = 0;
    let amongBuildings = 0;
    const bulge = this.bulge(d);
    for (let k = 1; k < n; k++) {
      const t = k / n;
      const x = a.x + (b.x - a.x) * t;
      const y = a.y + (b.y - a.y) * t;
      const z = a.z + (b.z - a.z) * t - bulge * t * (1 - t);
      const ground = this.surfaceHeight(x, y);
      const at = { x: Math.round(x), y: Math.round(y) };
      if (ground > z) return { cause: 'terrain', ...at };
      if (ground + CANOPY_HEIGHT > z && this.isForest(x, y)) {
        underCanopy += stepLen;
        if (underCanopy > FOREST_SEE_THROUGH) return { cause: 'forest', ...at };
      }
      const urban = this.urbanAt(x, y);
      if (urban.cover >= URBAN_COVERAGE && ground + urban.height > z) {
        amongBuildings += stepLen;
        if (amongBuildings > URBAN_SEE_THROUGH) return { cause: 'buildings', ...at };
      }
    }
    return null;
  }

  /** Highest terrain-or-canopy top per block of LOS_BLOCK x LOS_BLOCK posts (blocks share their edge posts). */
  private obstacleTops(): { cols: number; max: Float32Array } {
    if (this.tops) return this.tops;
    const bc = Math.ceil((this.cols - 1) / LOS_BLOCK) + 1;
    const max = new Float32Array(bc * bc).fill(-Infinity);
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const i = r * this.cols + c;
        const urban = this.urbanCover && this.urbanCover[i] >= URBAN_COVERAGE * 100 ? this.urbanHeight![i] : 0;
        const top = Math.max(0, this.heights[i]) + Math.max(this.forest[i] ? CANOPY_HEIGHT : 0, urban);
        // A post on a block edge belongs to the blocks on both sides.
        for (const br of r % LOS_BLOCK === 0 && r > 0 ? [r / LOS_BLOCK - 1, r / LOS_BLOCK] : [Math.floor(r / LOS_BLOCK)]) {
          for (const bcol of c % LOS_BLOCK === 0 && c > 0 ? [c / LOS_BLOCK - 1, c / LOS_BLOCK] : [Math.floor(c / LOS_BLOCK)]) {
            const j = br * bc + bcol;
            if (top > max[j]) max[j] = top;
          }
        }
      }
    }
    this.tops = { cols: bc, max };
    return this.tops;
  }

  /**
   * Curvature term for a sight line of length d: the line is lowered by bulge * t * (1 - t)
   * at fraction t (0 when the rule is off or the line is short).
   */
  protected bulge(d: number): number {
    return this.curvature && d > CURVATURE_MIN_RANGE ? curvatureDrop(d) : 0;
  }

  /** True when the sight line between fractions t0..t1 of a-b is above every obstacle beneath it. */
  private clearAbove(a: Vec3, b: Vec3, t0: number, t1: number, tops: { cols: number; max: Float32Array }, bulge: number): boolean {
    const cs = this.spec.cellSize;
    const xa = a.x + (b.x - a.x) * t0;
    const xb = a.x + (b.x - a.x) * t1;
    const ya = a.y + (b.y - a.y) * t0;
    const yb = a.y + (b.y - a.y) * t1;
    // The lowest the line gets here: the lower end, less the most curvature takes off in the stretch.
    const tm = Math.min(Math.max(0.5, t0), t1);
    const zMin = Math.min(a.z + (b.z - a.z) * t0, a.z + (b.z - a.z) * t1) - bulge * tm * (1 - tm);
    // Posts that can influence samples in this stretch (bilinear corners and nearest post).
    const c0 = Math.max(0, Math.floor(Math.min(xa, xb) / cs));
    const c1 = Math.min(this.cols - 1, Math.ceil(Math.max(xa, xb) / cs));
    const r0 = Math.max(0, Math.floor(Math.min(ya, yb) / cs));
    const r1 = Math.min(this.rows - 1, Math.ceil(Math.max(ya, yb) / cs));
    for (let br = Math.floor(r0 / LOS_BLOCK); br <= Math.floor(r1 / LOS_BLOCK); br++) {
      for (let bcol = Math.floor(c0 / LOS_BLOCK); bcol <= Math.floor(c1 / LOS_BLOCK); bcol++) {
        if (tops.max[br * tops.cols + bcol] >= zMin) return false;
      }
    }
    return true;
  }

  /** Find the passable grid node nearest to a point, searching outward. */
  private nearestPassable(p: Vec2, cost: (c: number, r: number) => number, maxRadius = 8): number {
    const cs = this.spec.cellSize;
    const c0 = Math.round(p.x / cs);
    const r0 = Math.round(p.y / cs);
    for (let rad = 0; rad <= maxRadius; rad++) {
      let best = -1;
      let bestD = Infinity;
      for (let dr = -rad; dr <= rad; dr++) {
        for (let dc = -rad; dc <= rad; dc++) {
          if (Math.max(Math.abs(dr), Math.abs(dc)) !== rad) continue;
          const c = c0 + dc;
          const r = r0 + dr;
          if (c < 0 || r < 0 || c >= this.cols || r >= this.rows) continue;
          if (!Number.isFinite(cost(c, r))) continue;
          const d = dc * dc + dr * dr;
          if (d < bestD) {
            bestD = d;
            best = r * this.cols + c;
          }
        }
      }
      if (best >= 0) return best;
    }
    return -1;
  }

  /**
   * Plan a route for a domain. Air routes are direct. Ground routes minimise travel
   * time (so they prefer roads) and avoid water and steep slopes.
   * Returns waypoints excluding the start point, or null if unreachable.
   */
  planRoute(from: Vec2, to: Vec2, domain: Domain, offroadFactor: number, overlay: PostOverlay | null = null): Vec2[] | null {
    if (domain === 'air') return [to];
    const cs = this.spec.cellSize;
    const grid = this.costGrid(domain, offroadFactor);
    const cols = this.cols;
    const cost = overlay ? (c: number, r: number) => grid[r * cols + c] * overlay.get(r * cols + c) : (c: number, r: number) => grid[r * cols + c];
    // Short hops with a clear straight line do not need a grid search.
    if (dist2d(from, to) < cs * 6 && Number.isFinite(this.segmentCost(from, to, domain, offroadFactor, overlay))) {
      return [to];
    }
    const start = this.nearestPassable(from, cost);
    const goal = this.nearestPassable(to, cost);
    if (start < 0 || goal < 0) return null;
    const memoKey = overlay ?? NO_OVERLAY;
    let memo = this.routeMemo.get(memoKey);
    if (!memo || memo.size > 5000) this.routeMemo.set(memoKey, (memo = new Map()));
    const key = `${domain}:${offroadFactor}:${start}:${goal}`;
    let route = memo.get(key);
    if (route === undefined) {
      const res = gridAStar(this.cols, this.rows, start, goal, cost, 1);
      route = res ? this.smoothPath(res.nodes.map((i) => this.postPosition(i)), domain, offroadFactor, overlay) : null;
      memo.set(key, route);
    }
    if (!route) return null;
    const smoothed = route.map((p) => ({ x: p.x, y: p.y }));
    smoothed.shift(); // drop the start node; the entity is already there
    const last = smoothed[smoothed.length - 1];
    if (!last || dist2d(last, to) > 1) {
      if (this.mobilityFactor(to.x, to.y, domain, offroadFactor) > 0) smoothed.push({ ...to });
    }
    return smoothed.length ? smoothed : [to];
  }

  /** Per-post traversal cost (1 / mobility, Infinity when impassable) for route planning. */
  private costGrid(domain: Domain, offroadFactor: number): Float32Array {
    const key = `${domain}:${offroadFactor}`;
    let grid = this.costGrids.get(key);
    if (!grid) {
      const cs = this.spec.cellSize;
      grid = new Float32Array(this.cols * this.rows);
      for (let r = 0; r < this.rows; r++) {
        for (let c = 0; c < this.cols; c++) {
          const f = this.mobilityFactor(c * cs, r * cs, domain, offroadFactor);
          grid[r * this.cols + c] = f <= 0.01 ? Infinity : 1 / f;
        }
      }
      this.costGrids.set(key, grid);
    }
    return grid;
  }

  /**
   * Time-cost of a straight segment, Infinity if any sample is impassable. With `limit`,
   * also Infinity as soon as the cost is sure to exceed it (the sum only grows).
   */
  segmentCost(a: Vec2, b: Vec2, domain: Domain, offroadFactor: number, overlay: PostOverlay | null = null, limit = Infinity): number {
    const d = dist2d(a, b);
    const step = this.spec.cellSize / 2;
    const n = Math.max(1, Math.ceil(d / step));
    let cost = 0;
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      const x = a.x + (b.x - a.x) * t;
      const y = a.y + (b.y - a.y) * t;
      const f = this.mobilityFactor(x, y, domain, offroadFactor);
      if (f <= 0.01) return Infinity;
      const extra = overlay ? overlay.get(this.nearestPost(x, y)) : 1;
      if (!Number.isFinite(extra)) return Infinity;
      cost += extra / f;
      if ((cost / (n + 1)) * d > limit) return Infinity;
    }
    return (cost / (n + 1)) * d;
  }

  /** Greedy string pulling: skip nodes when a straight segment is not slower. */
  protected smoothPath(pts: Vec2[], domain: Domain, offroadFactor: number, overlay: PostOverlay | null): Vec2[] {
    if (pts.length <= 2) return pts;
    const prefix: number[] = [0];
    for (let i = 1; i < pts.length; i++) {
      prefix.push(prefix[i - 1] + this.segmentCost(pts[i - 1], pts[i], domain, offroadFactor, overlay));
    }
    const out: Vec2[] = [pts[0]];
    let i = 0;
    while (i < pts.length - 1) {
      let best = i + 1;
      for (let j = Math.min(pts.length - 1, i + 60); j > i + 1; j--) {
        const budget = (prefix[j] - prefix[i]) * 1.02;
        if (this.segmentCost(pts[i], pts[j], domain, offroadFactor, overlay, budget) <= budget) {
          best = j;
          break;
        }
      }
      out.push(pts[best]);
      i = best;
    }
    return out;
  }
}

/**
 * Speed factor on land (0 = impassable) for a domain, from the slope and what is there:
 * a road, forest, a land cover class and the share of the area covered by buildings.
 */
export function landMobility(domain: Domain, offroadFactor: number, s: number, road: boolean, forest: boolean, coverClass: number, urban: number): number {
  const cover = COVER_MOBILITY[coverClass];
  if (domain === 'lifeform') {
    if (s > 1.0) return 0;
    let f = road ? 1 : offroadFactor;
    if (forest) f *= 0.75;
    if (cover) f *= cover[1];
    if (urban >= URBAN_COVERAGE) f *= 0.8;
    return f * Math.max(0.3, 1 - s * 0.8);
  }
  if (s > 0.6 && !road) return 0;
  // Vehicles cannot drive through solid blocks of buildings.
  if (urban >= 0.5) return 0;
  let f = road ? 1 : offroadFactor;
  if (!road && forest) f *= 0.45;
  if (cover) f *= cover[0];
  if (urban >= URBAN_COVERAGE) f *= 0.4;
  return f * Math.max(0.2, 1 - s * 1.4);
}

/**
 * Rasterise building footprints onto a grid of posts (cols x rows, cellSize apart, the first
 * at ox, oy): per post, the share (0-100) of its cell inside footprints, from 4 x 4 samples,
 * and the footprints' mean height in metres.
 */
export function buildingCover(buildings: Building[], cols: number, rows: number, cs: number, ox: number, oy: number, cover: Uint8Array, height: Uint8Array): void {
  const hits = new Uint16Array(cols * rows);
  const hsum = new Float32Array(cols * rows);
  const S = 4;
  for (const b of buildings) {
    const n = b.pts.length / 2;
    if (n < 3) continue;
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (let i = 0; i < n; i++) {
      x0 = Math.min(x0, b.pts[2 * i]);
      x1 = Math.max(x1, b.pts[2 * i]);
      y0 = Math.min(y0, b.pts[2 * i + 1]);
      y1 = Math.max(y1, b.pts[2 * i + 1]);
    }
    const c0 = Math.max(0, Math.round((x0 - ox) / cs - 0.5));
    const c1 = Math.min(cols - 1, Math.round((x1 - ox) / cs + 0.5));
    const r0 = Math.max(0, Math.round((y0 - oy) / cs - 0.5));
    const r1 = Math.min(rows - 1, Math.round((y1 - oy) / cs + 0.5));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        let k = 0;
        for (let sy = 0; sy < S; sy++) {
          for (let sx = 0; sx < S; sx++) {
            const px = ox + (c - 0.5 + (sx + 0.5) / S) * cs;
            const py = oy + (r - 0.5 + (sy + 0.5) / S) * cs;
            if (px < x0 || px > x1 || py < y0 || py > y1) continue;
            if (insideFlat(px, py, b.pts)) k++;
          }
        }
        if (!k) continue;
        const i = r * cols + c;
        hits[i] += k;
        hsum[i] += k * b.h;
      }
    }
  }
  for (let i = 0; i < hits.length; i++) {
    if (!hits[i]) continue;
    cover[i] = Math.min(100, Math.round((hits[i] / (S * S)) * 100));
    height[i] = Math.min(255, Math.round(hsum[i] / hits[i]));
  }
}

/** Point-in-polygon for a flat x,y coordinate array. */
function insideFlat(x: number, y: number, pts: number[]): boolean {
  let inside = false;
  const n = pts.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = pts[2 * i];
    const yi = pts[2 * i + 1];
    const xj = pts[2 * j];
    const yj = pts[2 * j + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
