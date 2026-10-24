import { describe, expect, it } from 'vitest';
import { decodeTile, encodeTile, TilePyramid } from '../src/shared/terrainTiles.js';
import { LAND_COVER } from '../src/shared/terrainGrid.js';
import type { Building } from '../src/shared/types.js';
import { Rng } from '../src/sim/rng.js';
import { Terrain } from '../src/sim/terrain.js';
import { gridTileSource, TileCache, TiledTerrain } from '../src/sim/tiledTerrain.js';

/** A generated terrain with every layer: inland water, land cover and a block of buildings. */
function fullTerrain(): Terrain {
  const g = Terrain.generate({ seed: 4242, size: 12000, cellSize: 50 });
  const n = g.heights.length;
  const rng = new Rng(5);
  const water = new Uint8Array(n);
  const landCover = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    landCover[i] = 1 + Math.floor(rng.next() * 7);
    if (rng.chance(0.01)) water[i] = 1;
  }
  const t = g.towns[0];
  const buildings: Building[] = [];
  for (let i = 0; i < 40; i++) {
    const x = t.x - 200 + (i % 8) * 50;
    const y = t.y - 120 + Math.floor(i / 8) * 50;
    buildings.push({ pts: [x, y, x + 30, y, x + 30, y + 30, x, y + 30], h: 6 + (i % 5) * 3 });
  }
  return new Terrain(g.spec, g.heights, g.forest, g.roads, g.towns, water, { landCover, buildings });
}

describe('tiled terrain', () => {
  const plain = fullTerrain();
  const size = plain.spec.size;

  it('round-trips tiles through the binary format', () => {
    const src = gridTileSource(plain, 32);
    const t = src.read(src.manifest.maxZoom, 2, 3)!;
    const back = decodeTile(encodeTile(t));
    expect(back.n).toBe(33);
    expect([back.z, back.x, back.y]).toEqual([t.z, t.x, t.y]);
    for (let i = 0; i < t.heights.length; i++) expect(Math.abs(back.heights[i] - t.heights[i])).toBeLessThanOrEqual(0.05 + 1e-6);
    expect([...back.forest]).toEqual([...t.forest]);
    expect([...back.landCover!]).toEqual([...t.landCover!]);
    expect([...back.urbanCover!]).toEqual([...t.urbanCover!]);
  });

  it('lays out a pyramid down to one overview tile', () => {
    const p = new TilePyramid(6668, 30, 256);
    expect(p.maxZoom).toBe(5);
    expect(p.across(5)).toBe(27);
    expect(p.across(0)).toBe(1);
    expect(p.span(0)).toBeGreaterThanOrEqual(200000);
  });

  it('answers every query exactly as the whole grid does, across tile edges', () => {
    const tiled = new TiledTerrain(new TileCache(gridTileSource(plain, 32)));
    const rng = new Rng(11);
    const edge = 32 * plain.spec.cellSize;
    for (let i = 0; i < 5000; i++) {
      // Half the points on or next to a tile edge.
      let x = rng.range(0, size);
      let y = rng.range(0, size);
      if (i % 2 === 0) x = Math.min(size, Math.round(x / edge) * edge + rng.range(-30, 30));
      if (i % 4 === 0) y = Math.min(size, Math.round(y / edge) * edge + rng.range(-30, 30));
      expect(tiled.elevation(x, y)).toBe(plain.elevation(x, y));
      expect(tiled.isWater(x, y)).toBe(plain.isWater(x, y));
      expect(tiled.isForest(x, y)).toBe(plain.isForest(x, y));
      expect(tiled.coverAt(x, y)).toBe(plain.coverAt(x, y));
      expect(tiled.isRoad(x, y)).toBe(plain.isRoad(x, y));
      expect(tiled.urbanAt(x, y)).toEqual(plain.urbanAt(x, y));
      expect(tiled.isBuiltUp(x, y)).toBe(plain.isBuiltUp(x, y));
      expect(tiled.mobilityFactor(x, y, 'ground', 0.6)).toBe(plain.mobilityFactor(x, y, 'ground', 0.6));
      expect(tiled.mobilityFactor(x, y, 'lifeform', 0.8)).toBe(plain.mobilityFactor(x, y, 'lifeform', 0.8));
    }
    expect(plain.coverAt(100, 100)).not.toBe(LAND_COVER.none);
  });

  it('has the same line of sight and sight blockers, with a cache far smaller than the terrain', () => {
    const cache = new TileCache(gridTileSource(plain, 32), 12 * 33 * 33 * 10);
    const tiled = new TiledTerrain(cache);
    const rng = new Rng(9);
    let visible = 0;
    for (let i = 0; i < 3000; i++) {
      const pt = () => {
        const x = rng.range(0, size);
        const y = rng.range(0, size);
        return { x, y, z: plain.surfaceHeight(x, y) + rng.range(1, i % 10 === 0 ? 300 : 4) };
      };
      const a = pt();
      const b = rng.chance(0.5) ? pt() : { ...pt(), x: Math.min(size, Math.max(0, a.x + rng.range(-3000, 3000))), y: Math.min(size, Math.max(0, a.y + rng.range(-3000, 3000))) };
      const want = plain.lineOfSight(a, b);
      expect(tiled.lineOfSight(a, b)).toBe(want);
      if (i % 10 === 0) expect(tiled.sightBlocker(a, b)).toEqual(plain.sightBlocker(a, b));
      if (want) visible++;
    }
    expect(visible).toBeGreaterThan(300);
    const s = cache.stats();
    expect(s.evictions).toBeGreaterThan(0);
    expect(s.bytes).toBeLessThanOrEqual(s.capacity);
  });

  it('evicts the least recently used tile', () => {
    const src = gridTileSource(plain, 32);
    const one = 33 * 33 * 4 + 33 * 33 * 6;
    const cache = new TileCache(src, one * 3);
    const z = src.manifest.maxZoom;
    cache.get(z, 0, 0);
    cache.get(z, 1, 0);
    cache.get(z, 2, 0);
    expect(cache.stats().tiles).toBe(3);
    cache.get(z, 0, 0); // used again: 1,0 is now the oldest
    cache.get(z, 3, 0);
    expect(cache.peek(z, 1, 0)).toBeUndefined();
    expect(cache.peek(z, 0, 0)).toBeDefined();
    expect(cache.peek(z, 2, 0)).toBeDefined();
    expect(cache.stats()).toMatchObject({ tiles: 3, loads: 4, evictions: 1 });
  });

  it('plans routes across tiles, coarse first when they are long', () => {
    const tiled = new TiledTerrain(new TileCache(gridTileSource(plain, 32)));
    const [a, b] = [plain.towns[0], plain.towns[plain.towns.length - 1]];
    const want = plain.planRoute(a, b, 'ground', 0.6)!;
    const direct = tiled.planRoute(a, b, 'ground', 0.6)!;
    // A small route window forces the coarse-then-fine planner.
    tiled.routeWindow = 120;
    const long = tiled.planRoute(a, b, 'ground', 0.6)!;
    const time = (r: { x: number; y: number }[]) => {
      let t = 0;
      let p = a as { x: number; y: number };
      for (const q of r) {
        const c = plain.segmentCost(p, q, 'ground', 0.6);
        expect(Number.isFinite(c)).toBe(true);
        t += c;
        p = q;
      }
      return t;
    };
    for (const r of [want, direct, long]) expect(r[r.length - 1]).toEqual(b);
    // Within a few percent of the whole-grid route.
    expect(time(direct)).toBeLessThan(time(want) * 1.05);
    expect(time(long)).toBeLessThan(time(want) * 1.25);
  });
});
