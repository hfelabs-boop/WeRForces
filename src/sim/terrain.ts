// Procedural synthetic terrain: elevation, water, forest, towns and a road network,
// plus mobility, line-of-sight and route planning queries used by the engine.

import { dist2d } from '../shared/math.js';
import { TerrainGrid } from '../shared/terrainGrid.js';
import type { Domain, TerrainData, TerrainSpec, Town, Vec2, Vec3 } from '../shared/types.js';
import { gridAStar, simplifyPolyline } from './pathfinding.js';
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

const CANOPY_HEIGHT = 15;
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

function fbm(x: number, y: number, seed: number, octaves: number): number {
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

  constructor(spec: TerrainSpec, heights: Float32Array, forest: Uint8Array, roads: Vec2[][], towns: Town[]) {
    super(spec, heights, forest);
    this.roads = roads;
    this.towns = towns;
    this.roadMask = new Uint8Array(heights.length);
    for (const road of roads) this.rasterizeRoad(road);
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

  static override fromData(data: TerrainData): Terrain {
    const grid = TerrainGrid.fromData(data);
    return new Terrain(data.spec, grid.heights, grid.forest, data.roads, data.towns);
  }

  toData(): TerrainData {
    return {
      spec: this.spec,
      cols: this.cols,
      rows: this.rows,
      heightsB64: this.encodeHeights(),
      forestB64: this.encodeForest(),
      roads: this.roads,
      towns: this.towns,
    };
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
    const s = this.slope(x, y);
    const road = this.isRoad(x, y);
    if (domain === 'lifeform') {
      if (s > 1.0) return 0;
      let f = road ? 1 : offroadFactor;
      if (this.isForest(x, y)) f *= 0.75;
      return f * Math.max(0.3, 1 - s * 0.8);
    }
    if (s > 0.6 && !road) return 0;
    let f = road ? 1 : offroadFactor;
    if (!road && this.isForest(x, y)) f *= 0.45;
    return f * Math.max(0.2, 1 - s * 1.4);
  }

  /** Terrain/canopy line of sight between two points (z = altitude MSL). */
  lineOfSight(a: Vec3, b: Vec3): boolean {
    const d = dist2d(a, b);
    if (d < 1) return true;
    const step = this.spec.cellSize / 2;
    const n = Math.ceil(d / step);
    const canopyClear = 60;
    for (let k = 1; k < n; k++) {
      const t = k / n;
      const x = a.x + (b.x - a.x) * t;
      const y = a.y + (b.y - a.y) * t;
      const z = a.z + (b.z - a.z) * t;
      let ground = this.surfaceHeight(x, y);
      const along = t * d;
      if (along > canopyClear && d - along > canopyClear && this.isForest(x, y)) ground += CANOPY_HEIGHT;
      if (ground > z) return false;
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
  planRoute(from: Vec2, to: Vec2, domain: Domain, offroadFactor: number): Vec2[] | null {
    if (domain === 'air') return [to];
    const cs = this.spec.cellSize;
    const cost = (c: number, r: number) => {
      const f = this.mobilityFactor(c * cs, r * cs, domain, offroadFactor);
      return f <= 0.01 ? Infinity : 1 / f;
    };
    // Short hops with a clear straight line do not need a grid search.
    if (dist2d(from, to) < cs * 6 && Number.isFinite(this.segmentCost(from, to, domain, offroadFactor))) {
      return [to];
    }
    const start = this.nearestPassable(from, cost);
    const goal = this.nearestPassable(to, cost);
    if (start < 0 || goal < 0) return null;
    const res = gridAStar(this.cols, this.rows, start, goal, cost, 1);
    if (!res) return null;
    const pts = res.nodes.map((i) => this.postPosition(i));
    const smoothed = this.smoothPath(pts, domain, offroadFactor);
    smoothed.shift(); // drop the start node; the entity is already there
    const last = smoothed[smoothed.length - 1];
    if (!last || dist2d(last, to) > 1) {
      if (this.mobilityFactor(to.x, to.y, domain, offroadFactor) > 0) smoothed.push({ ...to });
    }
    return smoothed.length ? smoothed : [to];
  }

  /** Time-cost of a straight segment, Infinity if any sample is impassable. */
  segmentCost(a: Vec2, b: Vec2, domain: Domain, offroadFactor: number): number {
    const d = dist2d(a, b);
    const step = this.spec.cellSize / 2;
    const n = Math.max(1, Math.ceil(d / step));
    let cost = 0;
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      const f = this.mobilityFactor(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, domain, offroadFactor);
      if (f <= 0.01) return Infinity;
      cost += 1 / f;
    }
    return (cost / (n + 1)) * d;
  }

  /** Greedy string pulling: skip nodes when a straight segment is not slower. */
  private smoothPath(pts: Vec2[], domain: Domain, offroadFactor: number): Vec2[] {
    if (pts.length <= 2) return pts;
    const prefix: number[] = [0];
    for (let i = 1; i < pts.length; i++) {
      prefix.push(prefix[i - 1] + this.segmentCost(pts[i - 1], pts[i], domain, offroadFactor));
    }
    const out: Vec2[] = [pts[0]];
    let i = 0;
    while (i < pts.length - 1) {
      let best = i + 1;
      for (let j = Math.min(pts.length - 1, i + 60); j > i + 1; j--) {
        const direct = this.segmentCost(pts[i], pts[j], domain, offroadFactor);
        if (direct <= (prefix[j] - prefix[i]) * 1.02) {
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
