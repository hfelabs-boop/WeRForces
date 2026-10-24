// Tiled terrain: a pyramid of square tiles of grid posts, for terrain too big to hold or
// send whole. Shared by the server (tile files, the simulation's terrain) and the browser
// (tiles for the current view). No Node APIs here.
//
// The finest level (z = maxZoom) holds every post. Each coarser level keeps every second
// post of the one below, so level z has a stride of 2^(maxZoom - z) posts and level 0 is
// one tile over the whole extent (the overview). A tile has tileSize cells, so
// tileSize + 1 posts, per side: neighbouring tiles share their edge posts, and every grid
// cell lies wholly inside one tile.

import type { Building, TerrainSpec, Town, Vec2 } from './types.js';

export const TILE_SIZE = 256;
/** Tile file magic: "WFT1". */
const MAGIC = 0x31544657;
const HEADER = 28;

export const TILE_LAYERS = { forest: 1, water: 2, landCover: 4, roads: 8, urban: 16 } as const;

/** A tiled terrain dataset: terrains/<name>/manifest.json, with tiles in terrains/<name>/tiles/<z>/<x>/<y>.wft. */
export interface TileManifest {
  format: 'werforces-terrain-tiles';
  version: 1;
  name: string;
  title?: string;
  source?: { dem?: string; features?: string; landCover?: string; imported?: string; attribution?: string; generator?: string };
  spec: TerrainSpec;
  /** Posts per side of the whole grid: spec.size / spec.cellSize + 1. */
  cols: number;
  /** Cells per tile side. */
  tileSize: number;
  maxZoom: number;
  /** Which optional layers the tiles have. */
  layers: { water: boolean; landCover: boolean; roads: boolean; urban: boolean };
  elevation: { min: number; max: number };
  /**
   * Highest obstacle (ground or water surface, plus canopy or buildings) in each finest tile,
   * row-major from the south-west: long sight lines skip tiles they pass above unread.
   */
  tileTops: number[];
  towns: Town[];
  /** Main roads over the whole extent (drawn on the overview; the tiles have every road). */
  roads?: Vec2[][];
}

/** One tile's posts, row-major from its south-west post; n = tileSize + 1 per side. */
export interface TerrainTile {
  z: number;
  x: number;
  y: number;
  n: number;
  heights: Float32Array;
  forest: Uint8Array;
  water: Uint8Array | null;
  landCover: Uint8Array | null;
  /** 1 where a road passes the post. */
  roads: Uint8Array | null;
  /** Share (0-100) of the post's cell covered by buildings, and their mean height in metres. */
  urbanCover: Uint8Array | null;
  urbanHeight: Uint8Array | null;
  /** Road lines and building footprints that start in the tile (finest level only), for drawing. */
  features?: { roads?: Vec2[][]; buildings?: Building[] };
}

/** The tiling of a grid with cols posts per side. */
export class TilePyramid {
  readonly maxZoom: number;

  constructor(
    readonly cols: number,
    readonly cellSize: number,
    readonly tileSize = TILE_SIZE,
  ) {
    const cells = cols - 1;
    let z = 0;
    while (tileSize * 2 ** z < cells) z++;
    this.maxZoom = z;
  }

  /** Posts between neighbouring posts of a level. */
  stride(z: number): number {
    return 2 ** (this.maxZoom - z);
  }

  /** Tiles per side at a level. */
  across(z: number): number {
    return Math.max(1, Math.ceil((this.cols - 1) / (this.tileSize * this.stride(z))));
  }

  /** Metres between posts at a level. */
  cell(z: number): number {
    return this.cellSize * this.stride(z);
  }

  /** Metres a tile spans at a level. */
  span(z: number): number {
    return this.tileSize * this.cell(z);
  }

  valid(z: number, x: number, y: number): boolean {
    return Number.isInteger(z) && Number.isInteger(x) && Number.isInteger(y) && z >= 0 && z <= this.maxZoom && x >= 0 && y >= 0 && x < this.across(z) && y < this.across(z);
  }

  /** Global post (column or row) of a tile's local post i, clamped to the grid. */
  post(z: number, t: number, i: number): number {
    return Math.min(this.cols - 1, (t * this.tileSize + i) * this.stride(z));
  }
}

/** Heights are stored as Int16 in units of this many metres (decimetres unless too high). */
export function heightScaleFor(maxAbs: number): number {
  return maxAbs * 10 < 32000 ? 0.1 : Math.ceil((maxAbs / 32000) * 4) / 4;
}

export function emptyTile(z: number, x: number, y: number, n: number, layers: TileManifest['layers']): TerrainTile {
  const m = n * n;
  return {
    z,
    x,
    y,
    n,
    heights: new Float32Array(m),
    forest: new Uint8Array(m),
    water: layers.water ? new Uint8Array(m) : null,
    landCover: layers.landCover ? new Uint8Array(m) : null,
    roads: layers.roads ? new Uint8Array(m) : null,
    urbanCover: layers.urban ? new Uint8Array(m) : null,
    urbanHeight: layers.urban ? new Uint8Array(m) : null,
  };
}

/**
 * Tile file layout (little-endian): "WFT1", u16 posts per side, u16 layer flags, f64 metres
 * per height unit, u32 bytes of feature JSON, u16 z, x, y and a spare u16; then the heights
 * (Int16 per post), one byte per post for each layer present (forest, water, land cover,
 * roads, urban cover, urban height), and the feature JSON. Files are gzipped on disk.
 */
export function encodeTile(t: TerrainTile): Uint8Array {
  const m = t.n * t.n;
  let maxAbs = 0;
  for (let i = 0; i < m; i++) maxAbs = Math.max(maxAbs, Math.abs(t.heights[i]));
  const scale = heightScaleFor(maxAbs);
  const flags = TILE_LAYERS.forest | (t.water ? TILE_LAYERS.water : 0) | (t.landCover ? TILE_LAYERS.landCover : 0) | (t.roads ? TILE_LAYERS.roads : 0) | (t.urbanCover ? TILE_LAYERS.urban : 0);
  const layers = [t.forest, t.water, t.landCover, t.roads, t.urbanCover, t.urbanHeight].filter((l): l is Uint8Array => !!l);
  const features = t.features && (t.features.roads?.length || t.features.buildings?.length) ? new TextEncoder().encode(JSON.stringify(t.features)) : new Uint8Array(0);
  const out = new Uint8Array(HEADER + m * 2 + layers.length * m + features.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, MAGIC, true);
  dv.setUint16(4, t.n, true);
  dv.setUint16(6, flags, true);
  dv.setFloat64(8, scale, true);
  dv.setUint32(16, features.length, true);
  dv.setUint16(20, t.z, true);
  dv.setUint16(22, t.x, true);
  dv.setUint16(24, t.y, true);
  for (let i = 0; i < m; i++) dv.setInt16(HEADER + 2 * i, Math.max(-32768, Math.min(32767, Math.round(t.heights[i] / scale))), true);
  let o = HEADER + m * 2;
  for (const l of layers) {
    out.set(l, o);
    o += m;
  }
  out.set(features, o);
  return out;
}

export function decodeTile(bytes: Uint8Array): TerrainTile {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < HEADER || dv.getUint32(0, true) !== MAGIC) throw new Error('not a WeRForces terrain tile');
  const n = dv.getUint16(4, true);
  const flags = dv.getUint16(6, true);
  const scale = dv.getFloat64(8, true);
  const featureBytes = dv.getUint32(16, true);
  const m = n * n;
  const heights = new Float32Array(m);
  for (let i = 0; i < m; i++) heights[i] = dv.getInt16(HEADER + 2 * i, true) * scale;
  let o = HEADER + m * 2;
  const layer = (bit: number) => {
    if (!(flags & bit)) return null;
    const l = bytes.slice(o, o + m);
    o += m;
    return l;
  };
  const forest = layer(TILE_LAYERS.forest) ?? new Uint8Array(m);
  const water = layer(TILE_LAYERS.water);
  const landCover = layer(TILE_LAYERS.landCover);
  const roads = layer(TILE_LAYERS.roads);
  const urbanCover = layer(TILE_LAYERS.urban);
  const urbanHeight = layer(TILE_LAYERS.urban);
  const tile: TerrainTile = { z: dv.getUint16(20, true), x: dv.getUint16(22, true), y: dv.getUint16(24, true), n, heights, forest, water, landCover, roads, urbanCover, urbanHeight };
  if (featureBytes) tile.features = JSON.parse(new TextDecoder().decode(bytes.subarray(o, o + featureBytes)));
  return tile;
}

/** Bytes a decoded tile holds in memory. */
export function tileBytes(t: TerrainTile): number {
  let b = t.heights.byteLength + t.forest.byteLength;
  for (const l of [t.water, t.landCover, t.roads, t.urbanCover, t.urbanHeight]) if (l) b += l.byteLength;
  return b;
}

/** Bilinear elevation inside a tile at local post coordinates (0..n-1). */
export function tileElevation(t: TerrainTile, fx: number, fy: number): number {
  const n = t.n;
  const ix = Math.min(Math.floor(fx), n - 2);
  const iy = Math.min(Math.floor(fy), n - 2);
  const tx = fx - ix;
  const ty = fy - iy;
  const i = iy * n + ix;
  const h = t.heights;
  const a = h[i] + (h[i + 1] - h[i]) * tx;
  const b = h[i + n] + (h[i + n + 1] - h[i + n]) * tx;
  return a + (b - a) * ty;
}
