import { describe, expect, it } from 'vitest';
import { Engine } from '../src/sim/engine.js';
import { Rng } from '../src/sim/rng.js';
import { SpatialIndex } from '../src/sim/spatial.js';

describe('spatial index', () => {
  it('returns every entity within the radius, in build order, skipping a force', () => {
    const engine = new Engine();
    engine.newScenario('grid');
    const rng = new Rng(7);
    for (let i = 0; i < 300; i++) {
      const p = engine.findValidPosition({ x: rng.range(0, 16000), y: rng.range(0, 16000) }, 'ground');
      if (p) engine.createEntity({ typeId: 'us-hmmwv', force: i % 2 === 0 ? 1 : 2, x: p.x, y: p.y });
    }
    const index = new SpatialIndex(1000);
    index.build(engine.entities.values(), 0);
    const all = [...engine.entities.values()];
    for (const [x, y, r] of [[8000, 8000, 2500], [100, 15900, 4000], [5000, 3000, 60000]]) {
      const got = index.query(x, y, r, 2);
      const order = got.map((e) => all.indexOf(e));
      expect(order).toEqual([...order].sort((a, b) => a - b));
      expect(got.every((e) => e.force !== 2)).toBe(true);
      const want = all.filter((e) => e.force !== 2 && Math.hypot(e.x - x, e.y - y) <= r);
      for (const e of want) expect(got).toContain(e);
    }
  });

  it('copes with entities spread very far apart (coarser cells) and finds every one in range', () => {
    const engine = new Engine();
    engine.newScenario('far');
    const rng = new Rng(11);
    for (let i = 0; i < 200; i++) {
      const p = engine.findValidPosition({ x: rng.range(0, 16000), y: rng.range(0, 16000) }, 'ground');
      if (p) engine.createEntity({ typeId: 'us-hmmwv', force: (1 + (i % 3)) as 1 | 2 | 3, x: p.x, y: p.y });
    }
    const all = [...engine.entities.values()];
    // A remote-style entity thousands of kilometres off the map.
    all[0].x = 5e6;
    all[0].y = -3e6;
    const index = new SpatialIndex();
    index.build(all, 0);
    for (const [x, y, r] of [[8000, 8000, 3000], [0, 0, 1500], [5e6, -3e6, 10], [8000, 8000, 1e8]]) {
      const got = index.query(x, y, r);
      const want = all.filter((e) => Math.hypot(e.x - x, e.y - y) <= r);
      for (const e of want) expect(got).toContain(e);
      const order = got.map((e) => all.indexOf(e));
      expect(order).toEqual([...order].sort((a, b) => a - b));
    }
  });
});
