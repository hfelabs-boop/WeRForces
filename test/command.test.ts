import { describe, expect, it } from 'vitest';
import { executeCommand } from '../src/server/commands.js';
import { SimRunner } from '../src/server/runner.js';
import { Engine } from '../src/sim/engine.js';
import { Terrain } from '../src/sim/terrain.js';

const base = Terrain.generate({ size: 6000, seed: 9, towns: 2 });
const cols = 121;
const flat = new Terrain({ ...base.spec, size: 6000, cellSize: 50, seed: 4242 }, new Float32Array(cols * cols).fill(20), new Uint8Array(cols * cols), [], []);

function engine(): Engine {
  const e = new Engine({ terrain: flat });
  e.newScenario('command', flat.spec);
  return e;
}

describe('chain of command', () => {
  it('a company template builds an HQ with three platoons under it', () => {
    const eng = engine();
    const coy = eng.createUnitFromTemplate('us-tank-company', 1, 3000, 2000);
    const subs = eng.subordinatesOf(coy);
    expect(subs.map((u) => u.name)).toEqual(['1st Platoon', '2nd Platoon', '3rd Platoon']);
    expect(subs[0].memberList[0].name).toBe('1st Platoon Lead');
    expect(coy.memberList.map((m) => m.name)).toEqual(['US Tank Company HQ 1', 'US Tank Company HQ 2']);
    expect(eng.entities.size).toBe(14);
    const snap = eng.snapshot().units.find((u) => u.id === coy.id)!;
    expect(snap.childIds).toEqual(subs.map((u) => u.id));
    // Saved and loaded, the hierarchy survives.
    const copy = engine();
    copy.loadScenario(eng.toScenario());
    expect(copy.subordinatesOf(copy.units.get(coy.id)!).map((u) => u.id)).toEqual(subs.map((u) => u.id));
  });

  it('orders pass down: moves keep relative positions, defence spreads the platoons in a line', () => {
    const eng = engine();
    const coy = eng.createUnitFromTemplate('us-tank-company', 1, 3000, 1500);
    const subs = eng.subordinatesOf(coy);
    const before = subs.map((u) => u.centroid());
    const hq = coy.centroid();
    eng.assignTask(coy.id, { type: 'moveTo', target: { x: 3000, y: 3500 } });
    subs.forEach((u, i) => {
      const t = u.taskSpec as { type: string; target: { x: number; y: number } };
      expect(t.type).toBe('moveTo');
      expect(t.target.x).toBeCloseTo(3000 + before[i].x - hq.x, -1);
      expect(t.target.y).toBeCloseTo(3500 + before[i].y - hq.y, -1);
    });
    eng.assignTask(coy.id, { type: 'defend', position: { x: 3000, y: 3500 }, facing: 0, width: 1200 });
    const xs = subs.map((u) => (u.taskSpec as { position: { x: number } }).position.x).sort((a, b) => a - b);
    expect(xs).toEqual([2600, 3000, 3400]);
    expect((coy.taskSpec as { position: { y: number } }).position.y).toBe(3200);
    // The company's plan step lasts until the platoons are done too.
    eng.assignPlan(coy.id, { statements: [{ kind: 'task', task: { type: 'moveTo', target: { x: 3000, y: 2500 } } }, { kind: 'task', task: { type: 'wait', duration: 1 } }] });
    eng.runFor(30);
    expect(coy.plan!.index).toBe(0);
    eng.runFor(300);
    expect(coy.plan!.finished).toBe(true);
    // Everyone got there, platoons still in the company's wedge.
    for (const u of subs) expect(Math.abs(u.centroid().y - 2500)).toBeLessThan(800);
    expect(subs.every((u) => u.taskStatus() === 'done')).toBe(true);
  });

  it('refuses loops and other forces', () => {
    const eng = engine();
    const a = eng.createUnitFromTemplate('us-tank-platoon', 1, 1000, 1000);
    const b = eng.createUnitFromTemplate('us-mech-platoon', 1, 2000, 1000);
    const r = eng.createUnitFromTemplate('ru-tank-platoon', 2, 4000, 4000);
    eng.setSuperior(b.id, a.id);
    expect(() => eng.setSuperior(a.id, b.id)).toThrow(/under/);
    expect(() => eng.setSuperior(r.id, a.id)).toThrow(/same force/);
    const runner = new SimRunner(eng);
    expect(executeCommand(runner, { cmd: 'setSuperior', unitId: b.id, superiorId: null }).ok).toBe(true);
    expect(b.parentId).toBeUndefined();
    // Deleting a superior frees its subordinates.
    eng.setSuperior(b.id, a.id);
    eng.deleteObject(a.id);
    expect(b.parentId).toBeUndefined();
  });
});

describe('order delay', () => {
  it('orders take time to arrive, by echelon, and pass down level by level', () => {
    const eng = engine();
    eng.setRules({ orderDelay: true });
    const coy = eng.createUnitFromTemplate('us-tank-company', 1, 3000, 1500);
    const subs = eng.subordinatesOf(coy);
    const runner = new SimRunner(eng);
    const log: string[] = [];
    eng.on('event', (ev) => log.push(`${ev.time.toFixed(1)} ${ev.text}`));
    expect(executeCommand(runner, { cmd: 'assignTask', targetId: coy.id, task: { type: 'moveTo', target: { x: 3000, y: 3500 } } }).ok).toBe(true);
    expect(coy.taskSpec).toBeNull();
    expect(eng.snapshot().orders).toHaveLength(1);
    // A company order: 60 s ± 20%.
    eng.runFor(47);
    expect(coy.taskSpec).toBeNull();
    eng.runFor(26);
    expect(coy.taskSpec).toMatchObject({ type: 'moveTo' });
    // Then each platoon gets its part 30 s ± 20% later.
    expect(subs.every((u) => u.taskSpec === null)).toBe(true);
    expect(eng.pendingOrders).toHaveLength(3);
    // A checkpoint keeps orders in flight.
    const copy = engine();
    copy.loadScenario(eng.toScenario());
    expect(copy.pendingOrders).toEqual(eng.pendingOrders);
    eng.runFor(37);
    expect(subs.every((u) => u.taskSpec?.type === 'moveTo')).toBe(true);
    copy.runFor(37);
    expect(copy.subordinatesOf(copy.units.get(coy.id)!).every((u) => u.taskSpec?.type === 'moveTo')).toBe(true);
    // Stop is immediate and cancels anything still on its way.
    executeCommand(runner, { cmd: 'assignTask', targetId: subs[0].id, task: { type: 'wait', duration: 5 } });
    executeCommand(runner, { cmd: 'stop', targetId: subs[0].id });
    expect(eng.pendingOrders).toHaveLength(0);
  });
});
