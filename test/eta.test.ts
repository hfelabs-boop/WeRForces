import { describe, expect, it } from 'vitest';
import { Engine } from '../src/sim/engine.js';
import { estimateTravel } from '../src/sim/eta.js';
import { Terrain } from '../src/sim/terrain.js';

const base = Terrain.generate({ size: 6000, seed: 9, towns: 2 });
const cols = 81;
const flat = new Terrain({ ...base.spec, size: 4000, cellSize: 50, seed: 4242 }, new Float32Array(cols * cols).fill(20), new Uint8Array(cols * cols), [], []);

describe('travel estimates', () => {
  it('predicts the arrival of a move within a few percent, and counts down', () => {
    const eng = new Engine({ terrain: flat });
    eng.newScenario('eta', flat.spec);
    const t = eng.createEntity({ typeId: 'us-m1a2', force: 1, x: 500, y: 500 });
    eng.assignTask(t.id, { type: 'moveTo', target: { x: 3500, y: 2500 } });
    eng.step();
    const first = estimateTravel(eng, t)!;
    expect(first.remaining).toBeGreaterThan(3500);
    expect(first.etaLocal).toMatch(/^\d\d:\d\d$/);
    let arrived = 0;
    let mid: ReturnType<typeof estimateTravel>;
    for (let i = 0; i < 6000 && !arrived; i++) {
      eng.step();
      if (Math.abs(eng.time - 60) < 0.05) mid = estimateTravel(eng, t);
      if (t.task?.status !== 'running') arrived = eng.time;
    }
    expect(arrived).toBeGreaterThan(0);
    expect(Math.abs(first.eta! - arrived) / arrived).toBeLessThan(0.1);
    expect(mid!.remaining).toBeLessThan(first.remaining);
    expect(Math.abs(mid!.eta! - arrived)).toBeLessThan(Math.abs(first.eta! - arrived) + 5);
    expect(estimateTravel(eng, t)).toBeUndefined();
  });

  it('is in the snapshot for leaders and units, and says when a vehicle is stalled', () => {
    const eng = new Engine({ terrain: flat });
    eng.newScenario('eta', flat.spec);
    const p = eng.createUnitFromTemplate('us-tank-platoon', 1, 500, 500);
    eng.assignTask(p.id, { type: 'moveTo', target: { x: 2000, y: 500 } });
    eng.runFor(2);
    const s = eng.snapshot();
    const u = s.units.find((x) => x.id === p.id)!;
    expect(u.travel!.remaining).toBeGreaterThan(1000);
    expect(s.entities.find((e) => e.id === p.leader!.id)!.travel).toEqual(u.travel);
    expect(s.entities.filter((e) => e.travel).length).toBe(1); // followers have none
    p.leader!.fuel = 0;
    eng.runFor(2);
    expect(eng.snapshot().units.find((x) => x.id === p.id)!.travel).toMatchObject({ stalled: 'out of fuel' });
  });
});
