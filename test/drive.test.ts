import { describe, expect, it } from 'vitest';
import { executeCommand } from '../src/server/commands.js';
import { checkCommand, ForbiddenError } from '../src/server/fog.js';
import { SimRunner } from '../src/server/runner.js';
import { Engine } from '../src/sim/engine.js';
import { Terrain } from '../src/sim/terrain.js';

const base = Terrain.generate({ size: 6000, seed: 9, towns: 2 });
const cols = 81;
const flat = new Terrain({ ...base.spec, size: 4000, cellSize: 50, seed: 4242 }, new Float32Array(cols * cols).fill(20), new Uint8Array(cols * cols), [], []);

describe('direct control', () => {
  it('drives with throttle and turn, fires only at the chosen target, and the platoon follows', () => {
    const eng = new Engine({ terrain: flat });
    eng.newScenario('drive', flat.spec);
    const runner = new SimRunner(eng, 0.1, 20, 0);
    const p = eng.createUnitFromTemplate('us-tank-platoon', 1, 1000, 1000);
    const lead = p.leader!;
    expect(executeCommand(runner, { cmd: 'drive', id: lead.id, throttle: 0.5 }).ok).toBe(true);
    eng.runFor(30);
    // Straight ahead (north) at about half its top speed.
    expect(lead.y).toBeGreaterThan(1250);
    expect(Math.abs(lead.x - 1000)).toBeLessThan(10);
    expect(lead.speed).toBeCloseTo(lead.type.maxSpeed * 0.5, 0);
    // The rest of the platoon keeps formation on it.
    expect(p.memberList[1].y).toBeGreaterThan(1150);
    // Turn right while the key is held.
    const h0 = lead.heading;
    for (let i = 0; i < 5; i++) {
      executeCommand(runner, { cmd: 'drive', id: lead.id, turn: 1 });
      eng.runFor(1);
    }
    expect(lead.heading - h0).toBeGreaterThan(0.3);
    // Let go: the turn stops once input stops.
    eng.runFor(3);
    const h1 = lead.heading;
    eng.runFor(3);
    expect(Math.abs(lead.heading - h1)).toBeLessThan(0.05);
    // Pick a target: it engages that one.
    const t72 = eng.createEntity({ typeId: 'ru-t72b3', force: 2, x: lead.x + 1500, y: lead.y });
    t72.roe = 'holdFire';
    executeCommand(runner, { cmd: 'drive', id: lead.id, throttle: 0, targetId: t72.id });
    eng.runFor(60);
    expect(eng.eventsSince(0).some((e) => e.kind === 'fire' && e.entityId === lead.id && e.targetId === t72.id)).toBe(true);
    // Any other order ends direct control.
    eng.assignTask(lead.id, { type: 'moveTo', target: { x: 1000, y: 1000 } });
    expect(lead.task?.spec.type).toBe('moveTo');
    expect(lead.attackTargetId).toBeUndefined();
  });

  it('is checked for players and validated', () => {
    const eng = new Engine({ terrain: flat });
    eng.newScenario('drive', flat.spec);
    const runner = new SimRunner(eng, 0.1, 20, 0);
    const red = eng.createEntity({ typeId: 'ru-t72b3', force: 2, x: 3000, y: 3000 });
    const blue = eng.createEntity({ typeId: 'us-m1a2', force: 1, x: 1000, y: 1000 });
    expect(() => checkCommand(eng, { kind: 'player', force: 1 }, { cmd: 'drive', id: red.id, throttle: 1 })).toThrow(ForbiddenError);
    expect(() => checkCommand(eng, { kind: 'player', force: 1 }, { cmd: 'drive', id: blue.id, targetId: red.id })).toThrow(ForbiddenError); // not seen
    expect(executeCommand(runner, { cmd: 'drive', id: blue.id, targetId: 'E999' }).error).toMatch(/unknown entity/);
  });
});
