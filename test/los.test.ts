import { describe, expect, it } from 'vitest';
import { Rng } from '../src/sim/rng.js';
import { Terrain } from '../src/sim/terrain.js';
import type { Vec3 } from '../src/shared/types.js';

/** The plain sample-by-sample line of sight the fast version must match exactly. */
function reference(t: Terrain, a: Vec3, b: Vec3): boolean {
  const d = Math.hypot(b.x - a.x, b.y - a.y);
  if (d < 1) return true;
  const n = Math.ceil(d / (t.spec.cellSize / 2));
  let canopy = 0;
  for (let k = 1; k < n; k++) {
    const f = k / n;
    const x = a.x + (b.x - a.x) * f;
    const y = a.y + (b.y - a.y) * f;
    const z = a.z + (b.z - a.z) * f;
    const g = t.surfaceHeight(x, y);
    if (g > z) return false;
    if (g + 15 > z && t.isForest(x, y)) {
      canopy += d / n;
      if (canopy > 150) return false;
    }
  }
  return true;
}

describe('line of sight', () => {
  it('matches the sample-by-sample reference on thousands of random lines', () => {
    const terrain = Terrain.generate({ seed: 4321, size: 12000 });
    const rng = new Rng(9);
    let visible = 0;
    for (let i = 0; i < 4000; i++) {
      const pt = () => {
        const x = rng.range(0, 12000);
        const y = rng.range(0, 12000);
        return { x, y, z: terrain.surfaceHeight(x, y) + rng.range(1, i % 10 === 0 ? 300 : 4) };
      };
      const a = pt();
      const b = rng.chance(0.5) ? pt() : { ...pt(), x: a.x + rng.range(-3000, 3000), y: a.y + rng.range(-3000, 3000) };
      b.x = Math.min(12000, Math.max(0, b.x));
      b.y = Math.min(12000, Math.max(0, b.y));
      const want = reference(terrain, a, b);
      expect(terrain.lineOfSight(a, b)).toBe(want);
      if (want) visible++;
    }
    expect(visible).toBeGreaterThan(400);
  });
});
