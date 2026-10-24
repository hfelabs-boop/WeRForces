// A synthetic tiled terrain of any size, for tests and benchmarks: rolling hills, lakes,
// forest, land cover, towns on a loose lattice with built-up centres, and roads between
// neighbouring towns. Every tile is computed from the position alone, so any tile can be
// made on its own, in any order (and the same tiles come out every time).

import { LAND_COVER } from '../shared/terrainGrid.js';
import { emptyTile, type TerrainTile, type TileManifest, TilePyramid, TILE_SIZE } from '../shared/terrainTiles.js';
import type { TerrainSpec, Town, Vec2 } from '../shared/types.js';
import { fbm } from '../sim/terrain.js';
import type { TileSource } from '../sim/tiledTerrain.js';

export interface SyntheticOptions {
  name: string;
  title?: string;
  /** Extent in metres (rounded to whole cells). */
  size: number;
  cellSize: number;
  seed?: number;
  origin?: { lat: number; lon: number };
  /** Highest ground in metres (about). */
  relief?: number;
  tileSize?: number;
}

/** Towns are about this far apart. */
const TOWN_SPACING = 16000;
const SYLLABLES = ['al', 'ber', 'cal', 'dun', 'east', 'fal', 'grey', 'har', 'iron', 'jun', 'kes', 'lark', 'mor', 'nor', 'ock', 'pem', 'quar', 'ros', 'sel', 'tor', 'ul', 'ven', 'wick', 'yar'];
const SUFFIXES = ['ford', 'ham', 'ton', 'by', 'wick', 'stead', 'bridge', 'field', 'moor', 'dale'];

function hash(ix: number, iy: number, seed: number): number {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(seed, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export class SyntheticTiles implements TileSource {
  readonly manifest: TileManifest;
  readonly pyramid: TilePyramid;
  private readonly seed: number;
  private readonly relief: number;
  private readonly size: number;
  /** Road segments filed by bucket (one finest tile square), for rasterising a tile. */
  private readonly buckets = new Map<number, [Vec2, Vec2][]>();
  private readonly bucket: number;
  private readonly bucketsAcross: number;

  constructor(opts: SyntheticOptions) {
    const cellSize = opts.cellSize;
    const cells = Math.max(1, Math.round(opts.size / cellSize));
    this.size = cells * cellSize;
    this.seed = opts.seed ?? 2026;
    this.relief = opts.relief ?? 600;
    const tileSize = opts.tileSize ?? TILE_SIZE;
    this.pyramid = new TilePyramid(cells + 1, cellSize, tileSize);
    const towns = this.placeTowns();
    const roads = this.buildRoads(towns);
    this.bucket = tileSize * cellSize;
    this.bucketsAcross = Math.ceil(this.size / this.bucket) + 1;
    for (const road of roads) {
      for (let i = 1; i < road.length; i++) {
        const a = road[i - 1];
        const b = road[i];
        for (const k of this.bucketsOver(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y))) {
          let list = this.buckets.get(k);
          if (!list) this.buckets.set(k, (list = []));
          list.push([a, b]);
        }
      }
    }
    const spec: TerrainSpec = {
      seed: this.seed,
      size: this.size,
      cellSize,
      origin: opts.origin ?? { lat: 50.5, lon: 9.0 },
      relief: this.relief,
      waterFraction: 0.04,
      forestFraction: 0.3,
      towns: towns.length,
      dataset: opts.name,
    };
    this.manifest = {
      format: 'werforces-terrain-tiles',
      version: 1,
      name: opts.name,
      title: opts.title ?? `Synthetic ${(this.size / 1000).toFixed(0)} km`,
      source: { generator: `synthetic, seed ${this.seed}`, imported: new Date().toISOString() },
      spec,
      cols: cells + 1,
      tileSize,
      maxZoom: this.pyramid.maxZoom,
      layers: { water: true, landCover: true, roads: true, urban: true },
      elevation: { min: 0, max: this.relief + 40 },
      tileTops: [],
      towns,
      roads,
    };
  }

  private bucketsOver(x0: number, y0: number, x1: number, y1: number): number[] {
    const out: number[] = [];
    const a = this.bucketsAcross;
    const clamp = (v: number) => Math.min(a - 1, Math.max(0, Math.floor(v / this.bucket)));
    for (let by = clamp(y0); by <= clamp(y1); by++) for (let bx = clamp(x0); bx <= clamp(x1); bx++) out.push(by * a + bx);
    return out;
  }

  /** Ground height in metres. */
  height(x: number, y: number): number {
    const s = this.seed;
    const base = fbm(x / 30000 + 3.1, y / 30000 + 7.7, s, 3);
    const hills = fbm(x / 4000, y / 4000, s + 7, 4);
    return 20 + this.relief * (0.65 * base ** 1.6 + 0.35 * hills * base);
  }

  private isLake(x: number, y: number): boolean {
    return fbm(x / 9000 + 11.3, y / 9000 + 2.9, this.seed + 31, 3) > 0.7 && fbm(x / 30000 + 3.1, y / 30000 + 7.7, this.seed, 3) < 0.5;
  }

  private placeTowns(): Town[] {
    const towns: Town[] = [];
    const n = Math.max(1, Math.round(this.size / TOWN_SPACING));
    const step = this.size / n;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const x = Math.round((i + 0.5 + (hash(i, j, this.seed) - 0.5) * 0.5) * step);
        const y = Math.round((j + 0.5 + (hash(j, i, this.seed + 1) - 0.5) * 0.5) * step);
        if (this.isLake(x, y)) continue;
        const k = Math.floor(hash(i, j, this.seed + 2) * SYLLABLES.length * SUFFIXES.length);
        const name = SYLLABLES[k % SYLLABLES.length] + SUFFIXES[Math.floor(k / SYLLABLES.length) % SUFFIXES.length];
        towns.push({ name: `${name[0].toUpperCase()}${name.slice(1)}${towns.some((t) => t.name.startsWith(name[0].toUpperCase() + name.slice(1))) ? ` ${i}-${j}` : ''}`, x, y });
      }
    }
    return towns;
  }

  /** Roads from each town to its nearest neighbours east and north, gently winding. */
  private buildRoads(towns: Town[]): Vec2[][] {
    const roads: Vec2[][] = [];
    const near = (t: Town, dx: number, dy: number) => {
      let best: Town | null = null;
      let bestD = Infinity;
      for (const o of towns) {
        const ex = o.x - t.x;
        const ey = o.y - t.y;
        // Within 45 degrees of the direction.
        if (ex * dx + ey * dy <= Math.abs(ex * dy - ey * dx)) continue;
        const d = Math.hypot(ex, ey);
        if (d < bestD && d < TOWN_SPACING * 1.8) {
          bestD = d;
          best = o;
        }
      }
      return best;
    };
    towns.forEach((t, k) => {
      for (const [dx, dy] of [
        [1, 0],
        [0, 1],
      ]) {
        const o = near(t, dx, dy);
        if (!o) continue;
        const pts: Vec2[] = [{ x: t.x, y: t.y }];
        const len = Math.hypot(o.x - t.x, o.y - t.y);
        const nx = -(o.y - t.y) / len;
        const ny = (o.x - t.x) / len;
        for (let s = 1; s < 4; s++) {
          const f = s / 4;
          const off = (hash(k, s + dx * 7, this.seed + 5) - 0.5) * 2400;
          pts.push({ x: Math.round(t.x + (o.x - t.x) * f + nx * off), y: Math.round(t.y + (o.y - t.y) * f + ny * off) });
        }
        pts.push({ x: o.x, y: o.y });
        roads.push(pts.map((p) => ({ x: Math.min(this.size, Math.max(0, p.x)), y: Math.min(this.size, Math.max(0, p.y)) })));
      }
    });
    return roads;
  }

  read(z: number, x: number, y: number): TerrainTile | null {
    const pyr = this.pyramid;
    if (!pyr.valid(z, x, y)) return null;
    const n = pyr.tileSize + 1;
    const cs = this.manifest.spec.cellSize;
    const cell = pyr.cell(z);
    const t = emptyTile(z, x, y, n, this.manifest.layers);
    const x0 = pyr.post(z, x, 0) * cs;
    const y0 = pyr.post(z, y, 0) * cs;
    // Roads first: a line traced across the tile at its own spacing marks the posts it passes.
    const span = pyr.span(z);
    const seen = new Set<[Vec2, Vec2]>();
    for (const k of this.bucketsOver(x0 - cell, y0 - cell, x0 + span + cell, y0 + span + cell)) {
      for (const seg of this.buckets.get(k) ?? []) {
        if (seen.has(seg)) continue;
        seen.add(seg);
        const [a, b] = seg;
        const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (cell / 3)));
        for (let s = 0; s <= steps; s++) {
          const px = a.x + ((b.x - a.x) * s) / steps;
          const py = a.y + ((b.y - a.y) * s) / steps;
          const i = Math.round((Math.min(px, this.size) - x0) / cell);
          const j = Math.round((Math.min(py, this.size) - y0) / cell);
          if (i >= 0 && j >= 0 && i < n && j < n) t.roads![j * n + i] = 1;
        }
      }
    }
    const towns = this.manifest.towns.filter((tw) => tw.x > x0 - 1000 && tw.x < x0 + span + 1000 && tw.y > y0 - 1000 && tw.y < y0 + span + 1000);
    for (let j = 0; j < n; j++) {
      const py = pyr.post(z, y, j) * cs;
      for (let i = 0; i < n; i++) {
        const px = pyr.post(z, x, i) * cs;
        const p = j * n + i;
        const h = this.height(px, py);
        t.heights[p] = h;
        let townD = Infinity;
        for (const tw of towns) townD = Math.min(townD, Math.hypot(tw.x - px, tw.y - py));
        const road = t.roads![p] === 1;
        if (this.isLake(px, py) && !road && townD > 800) {
          t.water![p] = 1;
          t.landCover![p] = LAND_COVER.water;
          continue;
        }
        if (townD < 600) {
          t.landCover![p] = LAND_COVER.builtUp;
          if (!road) {
            t.urbanCover![p] = townD < 350 ? 45 : 30;
            t.urbanHeight![p] = townD < 350 ? 10 : 7;
          }
          continue;
        }
        if (!road && townD > 900 && fbm(px / 1800, py / 1800, this.seed + 999, 4) > 0.56) {
          t.forest[p] = 1;
          t.landCover![p] = LAND_COVER.forest;
        } else {
          t.landCover![p] = fbm(px / 2500 + 5.5, py / 2500, this.seed + 77, 2) > 0.64 ? LAND_COVER.shrub : LAND_COVER.open;
        }
      }
    }
    return t;
  }
}
