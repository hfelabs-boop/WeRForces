// Terrain grid sampling shared by the engine and the browser front-end.

import type { TerrainData, TerrainSpec } from './types.js';

export function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

export function base64ToBytes(b64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** A regular grid of elevation posts plus a forest mask, with bilinear sampling. */
export class TerrainGrid {
  readonly cols: number;
  readonly rows: number;

  constructor(
    readonly spec: TerrainSpec,
    /** Elevation in metres per post, row-major from the south-west corner. */
    readonly heights: Float32Array,
    /** 1 = forest canopy, per post. */
    readonly forest: Uint8Array,
  ) {
    this.cols = Math.round(spec.size / spec.cellSize) + 1;
    this.rows = this.cols;
    if (heights.length !== this.cols * this.rows) throw new Error('terrain height grid size mismatch');
  }

  static fromData(data: TerrainData): TerrainGrid {
    const raw = base64ToBytes(data.heightsB64);
    const dm = new Int16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
    const heights = new Float32Array(dm.length);
    for (let i = 0; i < dm.length; i++) heights[i] = dm[i] / 10;
    return new TerrainGrid(data.spec, heights, base64ToBytes(data.forestB64));
  }

  encodeHeights(): string {
    const dm = new Int16Array(this.heights.length);
    for (let i = 0; i < dm.length; i++) dm[i] = Math.round(this.heights[i] * 10);
    return bytesToBase64(new Uint8Array(dm.buffer));
  }

  encodeForest(): string {
    return bytesToBase64(this.forest);
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x <= this.spec.size && y <= this.spec.size;
  }

  /** Bilinear elevation at a local position (clamped to the grid edges). */
  elevation(x: number, y: number): number {
    const cs = this.spec.cellSize;
    const fx = Math.min(Math.max(x / cs, 0), this.cols - 1.0001);
    const fy = Math.min(Math.max(y / cs, 0), this.rows - 1.0001);
    const ix = Math.floor(fx);
    const iy = Math.floor(fy);
    const tx = fx - ix;
    const ty = fy - iy;
    const i = iy * this.cols + ix;
    const h = this.heights;
    const a = h[i] + (h[i + 1] - h[i]) * tx;
    const b = h[i + this.cols] + (h[i + this.cols + 1] - h[i + this.cols]) * tx;
    return a + (b - a) * ty;
  }

  /** Ground or water surface height (water surface is at sea level 0). */
  surfaceHeight(x: number, y: number): number {
    return Math.max(0, this.elevation(x, y));
  }

  isWater(x: number, y: number): boolean {
    return this.elevation(x, y) < 0;
  }

  nearestPost(x: number, y: number): number {
    const cs = this.spec.cellSize;
    const ix = Math.min(Math.max(Math.round(x / cs), 0), this.cols - 1);
    const iy = Math.min(Math.max(Math.round(y / cs), 0), this.rows - 1);
    return iy * this.cols + ix;
  }

  isForest(x: number, y: number): boolean {
    return this.forest[this.nearestPost(x, y)] === 1;
  }

  /** Slope magnitude (rise over run) using central differences. */
  slope(x: number, y: number): number {
    const d = this.spec.cellSize;
    const dx = (this.elevation(x + d, y) - this.elevation(x - d, y)) / (2 * d);
    const dy = (this.elevation(x, y + d) - this.elevation(x, y - d)) / (2 * d);
    return Math.hypot(dx, dy);
  }
}
