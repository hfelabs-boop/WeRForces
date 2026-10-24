// Tiled terrain in the browser: tiles are fetched for what is on screen (and near the 3D
// camera), kept in a small least-recently-used store, and sampled finest-first, falling
// back to the overview tile that is always loaded.

import { TerrainGrid } from '../src/shared/terrainGrid.js';
import { renderTerrain } from './terrainRender.js';
import { type TerrainTile, TilePyramid } from '../src/shared/terrainTiles.js';
import type { TerrainData, TerrainTilesInfo } from '../src/shared/types.js';

/** Tiles held in the browser (about 650 KB each decoded). */
const MAX_TILES = 240;

interface Held {
  tile: TerrainTile;
  used: number;
  /** Rendered relief, made when first drawn. */
  image?: HTMLCanvasElement;
}

export class TiledGrid extends TerrainGrid {
  readonly info: TerrainTilesInfo;
  readonly pyramid: TilePyramid;
  private readonly held = new Map<number, Held>();
  private readonly pending = new Set<number>();
  private clock = 0;
  /** Called when a tile arrives (to redraw). */
  readonly listeners = new Set<(tile: TerrainTile) => void>();

  private constructor(
    data: TerrainData,
    private readonly fetchTile: (z: number, x: number, y: number) => Promise<TerrainTile>,
  ) {
    const info = data.tiles!;
    // No posts of its own; the layer arrays only say which layers exist.
    super(data.spec, new Float32Array(0), new Uint8Array(0), info.layers.water ? new Uint8Array(0) : null, info.layers.landCover ? new Uint8Array(0) : null);
    this.info = info;
    this.pyramid = new TilePyramid(data.cols, data.spec.cellSize, info.tileSize);
  }

  /** Open a tiled terrain: the overview tile is fetched before this returns. */
  static async open(data: TerrainData, fetchTile: (z: number, x: number, y: number) => Promise<TerrainTile>): Promise<TiledGrid> {
    const g = new TiledGrid(data, fetchTile);
    g.store(await fetchTile(0, 0, 0));
    return g;
  }

  private key(z: number, x: number, y: number): number {
    return (z * 4096 + y) * 4096 + x;
  }

  private store(tile: TerrainTile): void {
    this.held.set(this.key(tile.z, tile.x, tile.y), { tile, used: ++this.clock });
    if (this.held.size <= MAX_TILES) return;
    // Drop the least recently used, never the overview.
    let oldest: number | null = null;
    let used = Infinity;
    for (const [k, h] of this.held) {
      if (h.tile.z > 0 && h.used < used) {
        used = h.used;
        oldest = k;
      }
    }
    if (oldest !== null) this.held.delete(oldest);
  }

  /** A loaded tile (marked as used), or null. */
  get(z: number, x: number, y: number): TerrainTile | null {
    const h = this.held.get(this.key(z, x, y));
    if (!h) return null;
    h.used = ++this.clock;
    return h.tile;
  }

  /** The tile's rendered image, made once with `render`. */
  image(tile: TerrainTile, render: (t: TerrainTile) => HTMLCanvasElement): HTMLCanvasElement {
    const h = this.held.get(this.key(tile.z, tile.x, tile.y));
    if (!h) return render(tile);
    h.image ??= render(tile);
    return h.image;
  }

  /** Fetch a tile unless it is loaded or on its way. */
  request(z: number, x: number, y: number): void {
    if (!this.pyramid.valid(z, x, y)) return;
    const k = this.key(z, x, y);
    if (this.held.has(k) || this.pending.has(k)) return;
    this.pending.add(k);
    this.fetchTile(z, x, y)
      .then((t) => {
        this.store(t);
        for (const fn of this.listeners) fn(t);
      })
      .catch(() => undefined)
      .finally(() => this.pending.delete(k));
  }

  /** Tiles of a level overlapping a box in metres. */
  tilesIn(z: number, x0: number, y0: number, x1: number, y1: number): { x: number; y: number }[] {
    const span = this.pyramid.span(z);
    const n = this.pyramid.across(z);
    const out: { x: number; y: number }[] = [];
    const c = (v: number) => Math.min(n - 1, Math.max(0, Math.floor(v / span)));
    for (let y = c(y0); y <= c(y1); y++) for (let x = c(x0); x <= c(x1); x++) out.push({ x, y });
    return out;
  }

  /** The finest loaded tile at a point, with the point's position in its posts. */
  private at(x: number, y: number): { t: TerrainTile; fx: number; fy: number } {
    const p = this.pyramid;
    for (let z = p.maxZoom; z >= 0; z--) {
      const span = p.span(z);
      const n = p.across(z);
      const tx = Math.min(n - 1, Math.max(0, Math.floor(x / span)));
      const ty = Math.min(n - 1, Math.max(0, Math.floor(y / span)));
      const h = this.held.get(this.key(z, tx, ty));
      if (!h) continue;
      const cell = p.cell(z);
      const max = h.tile.n - 1.0001;
      return { t: h.tile, fx: Math.min(Math.max(x / cell - tx * p.tileSize, 0), max), fy: Math.min(Math.max(y / cell - ty * p.tileSize, 0), max) };
    }
    throw new Error('the overview tile is not loaded');
  }

  override elevation(x: number, y: number): number {
    const { t, fx, fy } = this.at(Math.min(x, this.spec.size), Math.min(y, this.spec.size));
    const n = t.n;
    const ix = Math.floor(fx);
    const iy = Math.floor(fy);
    const i = iy * n + ix;
    const h = t.heights;
    const a = h[i] + (h[i + 1] - h[i]) * (fx - ix);
    const b = h[i + n] + (h[i + n + 1] - h[i + n]) * (fx - ix);
    return a + (b - a) * (fy - iy);
  }

  private post(x: number, y: number): { t: TerrainTile; i: number } {
    const { t, fx, fy } = this.at(Math.min(x, this.spec.size), Math.min(y, this.spec.size));
    return { t, i: Math.round(fy) * t.n + Math.round(fx) };
  }

  override isWater(x: number, y: number): boolean {
    const { t, i } = this.post(x, y);
    return (!!t.water && t.water[i] === 1) || this.elevation(x, y) < 0;
  }

  override isForest(x: number, y: number): boolean {
    const { t, i } = this.post(x, y);
    return t.forest[i] === 1;
  }

  override coverAt(x: number, y: number): number {
    const { t, i } = this.post(x, y);
    return t.landCover ? t.landCover[i] : 0;
  }
}

/** A plain grid over one tile's posts (origin at the tile's south-west post), e.g. for rendering it. */
export function tileGrid(data: TerrainData, pyramid: TilePyramid, t: TerrainTile): TerrainGrid {
  const cell = pyramid.cell(t.z);
  return new TerrainGrid({ ...data.spec, size: (t.n - 1) * cell, cellSize: cell }, t.heights, t.forest, t.water, t.landCover);
}

/** A tile's relief image (made once per tile), tinted over the whole terrain's elevation range. */
export function reliefImage(g: TiledGrid, data: TerrainData, t: TerrainTile): HTMLCanvasElement {
  const range = { lo: g.info.elevation.min, hi: g.info.elevation.max };
  return g.image(t, (tile) => renderTerrain(tileGrid(data, g.pyramid, tile), 1, 20, range));
}
