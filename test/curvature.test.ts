import { describe, expect, it } from 'vitest';
import { Engine } from '../src/sim/engine.js';
import { computeViewshed } from '../src/sim/viewshed.js';
import { curvatureDrop, Terrain } from '../src/sim/terrain.js';
import { Rng } from '../src/sim/rng.js';
import { DEFAULT_TERRAIN } from '../src/sim/terrain.js';

/** Flat open ground 10 m above sea level. */
function flat(size = 40000, cellSize = 100): Terrain {
  const cols = size / cellSize + 1;
  return new Terrain({ ...DEFAULT_TERRAIN, size, cellSize, towns: 0 }, new Float32Array(cols * cols).fill(10), new Uint8Array(cols * cols), [], []);
}

describe('earth curvature in line of sight', () => {
  it('drops a point by d²/(2kR): about 53 m at 30 km', () => {
    expect(curvatureDrop(30000)).toBeCloseTo(52.97, 1);
  });

  it('hides two 2 m eyes from each other across 30 km of flat ground; a 100 m mast sees', () => {
    const t = flat();
    const a = { x: 5000, y: 20000, z: 12 };
    const b = { x: 35000, y: 20000, z: 12 };
    expect(t.lineOfSight(a, b)).toBe(false);
    expect(t.sightBlocker(a, b)?.cause).toBe('terrain');
    const mast = { ...a, z: 110 };
    expect(t.lineOfSight(mast, b)).toBe(true);
    expect(t.lineOfSight(b, mast)).toBe(true);
    expect(t.sightBlocker(mast, b)).toBeNull();
    // Off, the earth is flat.
    t.curvature = false;
    expect(t.lineOfSight(a, b)).toBe(true);
  });

  it('puts the horizon of a 2 m eye at sqrt(2kR·2) ≈ 5.8 km for a target on the ground', () => {
    const t = flat();
    const eye = { x: 1000, y: 20000, z: 12 };
    expect(t.lineOfSight(eye, { x: 1000 + 5700, y: 20000, z: 10.001 })).toBe(true);
    expect(t.lineOfSight(eye, { x: 1000 + 6000, y: 20000, z: 10.001 })).toBe(false);
    // Two 2 m eyes: twice that.
    expect(t.lineOfSight(eye, { x: 1000 + 11500, y: 20000, z: 12 })).toBe(true);
    expect(t.lineOfSight(eye, { x: 1000 + 11900, y: 20000, z: 12 })).toBe(false);
  });

  it('leaves short sight lines exactly as on a flat earth', () => {
    const terrain = Terrain.generate({ seed: 77, size: 8000 });
    const rng = new Rng(3);
    for (let i = 0; i < 2000; i++) {
      const x = rng.range(0, 8000);
      const y = rng.range(0, 8000);
      const a = { x, y, z: terrain.surfaceHeight(x, y) + 2 };
      const bx = Math.min(8000, Math.max(0, x + rng.range(-1400, 1400)));
      const by = Math.min(8000, Math.max(0, y + rng.range(-1400, 1400)));
      const b = { x: bx, y: by, z: terrain.surfaceHeight(bx, by) + 2 };
      terrain.curvature = true;
      const curved = terrain.lineOfSight(a, b);
      terrain.curvature = false;
      expect(curved).toBe(terrain.lineOfSight(a, b));
    }
  });

  it('is a simulation rule, on by default, that the viewshed and radar follow', () => {
    const engine = new Engine({ terrain: flat() });
    expect(engine.rules.curvature).toBe(true);
    const a = { x: 5000, y: 20000, z: 12 };
    const b = { x: 35000, y: 20000, z: 12 };
    expect(engine.lineOfSight(a, b)).toBe(false);
    expect(engine.lineOfSight(a, b, true)).toBe(false);
    // An aircraft 100 m up at 60 km is below the radar horizon of a 10 m mast (13 + 41 km); at 1000 m it is above.
    const radar = { x: 1000, y: 20000, z: 20 };
    expect(engine.lineOfSight(radar, { x: 39000, y: 39000, z: 310 }, true)).toBe(true);
    const far = new Engine({ terrain: flat(80000, 200) });
    expect(far.lineOfSight({ x: 1000, y: 40000, z: 20 }, { x: 61000, y: 40000, z: 110 }, true)).toBe(false);
    expect(far.lineOfSight({ x: 1000, y: 40000, z: 20 }, { x: 61000, y: 40000, z: 1010 }, true)).toBe(true);
    const seen = computeViewshed(engine, { x: 20000, y: 20000, z: 12 }, 15000).visibleFraction;
    engine.setRules({ curvature: false });
    expect(engine.terrain.curvature).toBe(false);
    expect(engine.lineOfSight(a, b)).toBe(true);
    expect(computeViewshed(engine, { x: 20000, y: 20000, z: 12 }, 15000).visibleFraction).toBe(1);
    // With it, a 2 m target beyond about 11.7 km is hidden: (11.7 / 15)² of the disc is seen.
    expect(seen).toBeLessThan(0.7);
    expect(seen).toBeGreaterThan(0.5);
    // Kept in the scenario.
    expect(engine.toScenario().rules?.curvature).toBe(false);
  });
});
