// Terrain tiles over HTTP (GET /api/v1/terrain/tiles/{z}/{x}/{y}): a tiled dataset's tiles as
// stored, or tiles cut on demand from a small in-memory terrain, so the GUI can show any
// terrain one view at a time.

import { gzipSync } from 'node:zlib';
import { encodeTile, TilePyramid } from '../shared/terrainTiles.js';
import type { Terrain } from '../sim/terrain.js';
import { gridTileSource, type TileSource, TiledTerrain } from '../sim/tiledTerrain.js';
import { FileTileSource } from '../terrain/tiles.js';
import { HttpError, type RouteResponse } from './router.js';

const TILE_HEADERS = { 'Content-Encoding': 'gzip', 'Cache-Control': 'private, max-age=600' };

export class TileServer {
  /** Tiles of the current small terrain, made on first request. */
  private grid: { terrain: Terrain; source: TileSource; tiles: Map<string, Uint8Array> } | null = null;

  private source(t: Terrain): TileSource {
    if (t instanceof TiledTerrain) return t.cache.source;
    if (this.grid?.terrain !== t) this.grid = { terrain: t, source: gridTileSource(t), tiles: new Map() };
    return this.grid.source;
  }

  /** The tiling of the terrain, and (tiled datasets) how full the server's tile cache is. */
  info(t: Terrain) {
    const m = this.source(t).manifest;
    const p = new TilePyramid(m.cols, m.spec.cellSize, m.tileSize);
    return {
      tiled: t instanceof TiledTerrain,
      tileSize: m.tileSize,
      cols: m.cols,
      cellSize: m.spec.cellSize,
      maxZoom: p.maxZoom,
      levels: Array.from({ length: p.maxZoom + 1 }, (_, z) => ({ z, across: p.across(z), cellSize: p.cell(z), span: p.span(z) })),
      layers: m.layers,
      elevation: m.elevation,
      url: 'terrain/tiles/{z}/{x}/{y}',
      cache: t instanceof TiledTerrain ? t.cache.stats() : undefined,
    };
  }

  tile(t: Terrain, zs: string, xs: string, ys: string): RouteResponse {
    const [z, x, y] = [zs, xs, ys].map(Number);
    const src = this.source(t);
    const m = src.manifest;
    if (!new TilePyramid(m.cols, m.spec.cellSize, m.tileSize).valid(z, x, y)) throw new HttpError(404, `no tile ${zs}/${xs}/${ys}`);
    let bytes: Uint8Array | null | undefined;
    if (src instanceof FileTileSource) bytes = src.raw(z, x, y);
    else {
      const key = `${z}/${x}/${y}`;
      const cached = this.grid?.source === src ? this.grid.tiles : null;
      bytes = cached?.get(key);
      if (!bytes) {
        const tile = src.read(z, x, y);
        bytes = tile ? gzipSync(encodeTile(tile), { level: 4 }) : null;
        if (bytes && cached) {
          if (cached.size > 200) cached.clear();
          cached.set(key, bytes);
        }
      }
    }
    if (!bytes) throw new HttpError(404, `no tile ${zs}/${xs}/${ys}`);
    return { bytes, contentType: 'application/vnd.werforces.tile', headers: TILE_HEADERS };
  }
}
