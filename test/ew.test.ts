import { describe, expect, it } from 'vitest';
import { executeCommand } from '../src/server/commands.js';
import { SimRunner } from '../src/server/runner.js';
import { Engine } from '../src/sim/engine.js';
import { explainEntity } from '../src/sim/explain.js';
import { Terrain } from '../src/sim/terrain.js';

const base = Terrain.generate({ size: 6000, seed: 9, towns: 2 });
const cols = 161;
const flat = new Terrain({ ...base.spec, size: 8000, cellSize: 50, seed: 4242 }, new Float32Array(cols * cols).fill(20), new Uint8Array(cols * cols), [], []);

function engine(): Engine {
  const e = new Engine({ terrain: flat });
  e.newScenario('ew', flat.spec);
  return e;
}

describe('electronic warfare', () => {
  it('a radio jammer delays orders, stops contact sharing, calls for fire and codewords', () => {
    const eng = engine();
    const runner = new SimRunner(eng, 0.1, 20, 0);
    const blue = eng.createUnitFromTemplate('us-tank-platoon', 1, 1000, 1000);
    const jammer = eng.createEntity({ typeId: 'ru-r330zh', force: 2, x: 7000, y: 7000 });
    eng.runFor(1);
    // 8.5 km away: inside the Zhitel's 15 km reach.
    expect(eng.ew.radioJammed(blue.leader!)).toBe(true);
    expect(eng.snapshot().entities.find((e) => e.id === blue.leader!.id)!.jammed).toEqual(['radio']);
    expect(eng.alerts.open().find((a) => a.kind === 'jammed')?.text).toBe(`${blue.name}: radio jammed`);
    const delay = eng.issueOrder(blue.id, { task: { type: 'moveTo', target: { x: 1500, y: 1000 } } });
    expect(delay).toBe(60);
    expect(eng.pendingOrders).toHaveLength(1);
    // Codewords do not get through.
    eng.assignPlan(blue.id, { statements: [{ kind: 'waitUntil', condition: { type: 'codeword', codeword: 'GO' } }, { kind: 'setRoe', roe: 'holdFire' }] });
    eng.sendCodeword(1, 'GO');
    eng.runFor(3);
    expect(blue.leader!.roe).toBe('fireAtWill');
    expect(explainEntity(eng, blue.leader!, { omniscient: true }).movement.some((f) => f.code === 'radioJammed')).toBe(true);
    // Switched off: the radio comes back, and the codeword is heard.
    expect(executeCommand(runner, { cmd: 'setJamming', id: jammer.id, on: false }).ok).toBe(true);
    eng.runFor(2);
    expect(eng.ew.radioJammed(blue.leader!)).toBe(false);
    expect(blue.leader!.roe).toBe('holdFire');
    expect(eng.toScenario().entities.find((e) => e.id === jammer.id)!.state?.jamming).toBe(false);
    expect(executeCommand(runner, { cmd: 'setJamming', id: blue.leader!.id, on: true }).error).toMatch(/not a jammer/);
  });

  it('only jams the enemy, and a radar jammer cuts radar range more the closer it is', () => {
    const eng = engine();
    const own = eng.createUnitFromTemplate('ru-tank-platoon', 2, 1000, 1000);
    eng.createEntity({ typeId: 'ru-r330zh', force: 2, x: 2000, y: 2000 });
    const krasukha = eng.createEntity({ typeId: 'ru-krasukha', force: 2, x: 7900, y: 7900 });
    const radar = eng.catalog.catalog.entityTypes.find((t) => t.sensors.some((s) => eng.catalog.sensors.get(s)?.radar) && t.domain === 'ground')!;
    const near = eng.createEntity({ typeId: radar.id, force: 1, x: 7000, y: 7900 });
    const far = eng.createEntity({ typeId: radar.id, force: 1, x: 100, y: 100 });
    eng.runFor(1);
    expect(eng.ew.radioJammed(own.leader!)).toBe(false);
    expect(eng.ew.radarFactor(near)).toBeCloseTo(0.3, 5); // 0.9 km of 25: the floor
    expect(eng.ew.radarFactor(far)).toBeCloseTo(Math.hypot(7800, 7800) / 25000, 5);
    krasukha.destroyed = true;
    eng.runFor(1);
    expect(eng.ew.radarFactor(near)).toBe(1);
  });
});
