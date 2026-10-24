import { describe, expect, it } from 'vitest';
import { dist2d } from '../src/shared/math.js';
import { Engine } from '../src/sim/engine.js';
import { TileCache, TiledTerrain } from '../src/sim/tiledTerrain.js';
import { SyntheticTiles } from '../src/terrain/synthetic.js';

// The synthetic 200 km x 200 km terrain at 30 m posts (6668 x 6668), made tile by tile as
// it is read. On disk it is about 60 MB (werforces-terrain --synthetic, or npm run bench:terrain).
const CACHE = 64 * 1024 * 1024;

describe('a 200 km tiled terrain', () => {
  const tiled = new TiledTerrain(new TileCache(new SyntheticTiles({ name: 'synthetic200', size: 200000, cellSize: 30 }), CACHE));

  it('runs a scenario with memory bounded by the tile cache', { timeout: 120000 }, () => {
    const engine = new Engine({ terrain: tiled });
    engine.newScenario('Large terrain', tiled.spec);
    expect(engine.terrain).toBe(tiled);
    expect(tiled.spec.size).toBe(200010);
    const towns = tiled.towns;
    expect(towns.length).toBeGreaterThan(100);
    // Two towns in the middle of the map, one road apart.
    const a = towns.reduce((best, t) => (dist2d(t, { x: 100000, y: 100000 }) < dist2d(best, { x: 100000, y: 100000 }) ? t : best));
    const b = towns.filter((t) => t !== a).reduce((best, t) => (dist2d(t, a) < dist2d(best, a) ? t : best));
    const blue = engine.createUnitFromTemplate('us-tank-platoon', 1, a.x, a.y);
    engine.createUnitFromTemplate('ru-tank-platoon', 2, b.x, b.y);
    engine.assignTask(blue.id, { type: 'moveTo', target: b });
    const start = { x: blue.leader!.x, y: blue.leader!.y };
    engine.runFor(120);
    expect(dist2d(start, blue.leader!)).toBeGreaterThan(400);
    for (const e of engine.entities.values()) expect(e.z).toBeCloseTo(tiled.surfaceHeight(e.x, e.y), 0);
    const s = tiled.cache.stats();
    expect(s.bytes).toBeLessThanOrEqual(CACHE);
    expect(s.tiles).toBeLessThan(150);
  });

  it('plans a 100 km route coarse first, then leg by leg', { timeout: 120000 }, () => {
    const towns = tiled.towns;
    const from = towns.reduce((best, t) => (dist2d(t, { x: 40000, y: 40000 }) < dist2d(best, { x: 40000, y: 40000 }) ? t : best));
    const to = towns.reduce((best, t) => (dist2d(t, { x: 120000, y: 110000 }) < dist2d(best, { x: 120000, y: 110000 }) ? t : best));
    expect(dist2d(from, to)).toBeGreaterThan(90000);
    const route = tiled.planRoute(from, to, 'ground', 0.6)!;
    expect(route).not.toBeNull();
    expect(route[route.length - 1]).toEqual(to);
    let length = 0;
    let p = { x: from.x, y: from.y };
    for (const q of route) {
      expect(Number.isFinite(tiled.segmentCost(p, q, 'ground', 0.6))).toBe(true);
      length += dist2d(p, q);
      p = q;
    }
    // Roads wind, but not absurdly.
    expect(length).toBeLessThan(dist2d(from, to) * 1.6);
    expect(tiled.cache.stats().bytes).toBeLessThanOrEqual(CACHE);
  });

  it('sees 30 km between masts but not between people on the ground', () => {
    // Over the lowlands in the south-west the ground is gentle: a 2 m eye's horizon is the limit.
    const a = { x: 20000, y: 20000 };
    const b = { x: 50000, y: 20000 };
    const eye = (p: { x: number; y: number }, h: number) => ({ ...p, z: tiled.surfaceHeight(p.x, p.y) + h });
    expect(tiled.lineOfSight(eye(a, 2), eye(b, 2))).toBe(false);
    tiled.curvature = false;
    const flat = tiled.lineOfSight(eye(a, 300), eye(b, 300));
    tiled.curvature = true;
    expect(tiled.lineOfSight(eye(a, 300), eye(b, 300))).toBe(flat);
  });
});
