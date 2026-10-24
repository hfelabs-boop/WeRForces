import { describe, expect, it } from 'vitest';
import { Engine } from '../src/sim/engine.js';
import { ammoFraction } from '../src/sim/supply.js';
import { Terrain } from '../src/sim/terrain.js';

const base = Terrain.generate({ size: 6000, seed: 9, towns: 2 });
const cols = 81;
const flat = new Terrain({ ...base.spec, size: 4000, cellSize: 50, seed: 4242 }, new Float32Array(cols * cols).fill(20), new Uint8Array(cols * cols), [], []);

function engine(): Engine {
  const e = new Engine({ terrain: flat });
  e.newScenario('supply', flat.spec);
  return e;
}

describe('fuel', () => {
  it('vehicles burn fuel by distance and stop when it runs out', () => {
    const eng = engine();
    const tank = eng.createEntity({ typeId: 'us-m1a2', force: 1, x: 500, y: 500 });
    eng.assignTask(tank.id, { type: 'moveTo', target: { x: 3500, y: 500 } });
    eng.runFor(400);
    // 3 km of a 426 km tank.
    expect(1 - tank.fuel).toBeCloseTo(3000 / 426000, 3);
    tank.fuel = 0.0001;
    const log: string[] = [];
    eng.on('event', (ev) => log.push(ev.text));
    eng.assignTask(tank.id, { type: 'moveTo', target: { x: 500, y: 500 } });
    eng.runFor(60);
    expect(log).toContain(`${tank.name} is out of fuel`);
    expect(tank.x).toBeGreaterThan(3400);
    expect(tank.speed).toBe(0);
  });

  it('aircraft burn fuel by time aloft and come down when it runs out', () => {
    const eng = engine();
    const heli = eng.createEntity({ typeId: 'us-ah64', force: 1, x: 2000, y: 2000 });
    eng.runFor(600);
    expect(heli.fuel).toBeCloseTo(1 - 600 / (2.5 * 3600), 3);
    const log: string[] = [];
    eng.on('event', (ev) => log.push(ev.text));
    heli.fuel = 0.202;
    eng.runFor(60);
    expect(log.some((t) => t.includes('is low on fuel'))).toBe(true);
    heli.fuel = 0.00001;
    eng.runFor(1);
    expect(heli.destroyed).toBe(true);
    expect(log.some((t) => t.endsWith('destroyed by fuel exhaustion'))).toBe(true);
  });

  it('can be turned off', () => {
    const eng = engine();
    eng.setRules({ fuel: false });
    const tank = eng.createEntity({ typeId: 'us-m1a2', force: 1, x: 500, y: 500 });
    eng.assignTask(tank.id, { type: 'moveTo', target: { x: 3500, y: 500 } });
    eng.runFor(300);
    expect(tank.fuel).toBe(1);
    expect(eng.snapshot().entities.find((e) => e.id === tank.id)!.fuel).toBeUndefined();
  });
});

describe('resupply', () => {
  it('a platoon drives to a supply truck and refuels and rearms', () => {
    const eng = engine();
    const truck = eng.createEntity({ typeId: 'us-hemtt', force: 1, x: 1000, y: 1000 });
    const platoon = eng.createUnitFromTemplate('us-tank-platoon', 1, 2500, 2500);
    for (const m of platoon.memberList) {
      m.fuel = 0.4;
      m.ammo.set('gun-120mm', 5);
    }
    const log: string[] = [];
    eng.on('event', (ev) => log.push(ev.text));
    eng.assignTask(platoon.id, { type: 'resupply' });
    eng.runFor(600);
    for (const m of platoon.memberList) {
      expect(m.fuel).toBeGreaterThan(0.999);
      expect(ammoFraction(eng, m)).toBe(1);
      expect(Math.hypot(m.x - truck.x, m.y - truck.y)).toBeLessThan(60);
    }
    expect(log.filter((t) => t.includes('resupplied by'))).toHaveLength(4);
    expect(platoon.taskStatus()).toBe('done');
    // Four tanks took 0.6 of a tank each and some ammunition: a bit over one load each... of ten.
    expect(truck.supplies).toBeLessThan(10 - 4 * 0.3);
    expect(truck.supplies).toBeGreaterThan(5);
  });

  it('stock runs out', () => {
    const eng = engine();
    const truck = eng.createEntity({ typeId: 'ru-ural-supply', force: 2, x: 1000, y: 1000 });
    truck.supplies = 0.1;
    const tank = eng.createEntity({ typeId: 'ru-t72b3', force: 2, x: 1030, y: 1000 });
    tank.fuel = 0.1;
    const log: string[] = [];
    eng.on('event', (ev) => log.push(ev.text));
    eng.runFor(60);
    expect(truck.supplies).toBe(0);
    expect(tank.fuel).toBeCloseTo(0.3, 5);
    expect(log).toContain(`${truck.name} has run out of supplies`);
    // Enemies get nothing; nor does anyone from an empty truck.
    eng.assignTask(tank.id, { type: 'resupply' });
    eng.runFor(1);
    expect(tank.task?.message).toBe('no supply vehicle with stock left');
  });

  it('plans can wait for low fuel or ammunition, and checkpoints keep it all', () => {
    const eng = engine();
    eng.createEntity({ typeId: 'us-hemtt', force: 1, x: 1000, y: 1000 });
    const tank = eng.createEntity({ typeId: 'us-m1a2', force: 1, x: 1500, y: 1000 });
    tank.fuel = 0.5;
    eng.assignPlan(tank.id, {
      statements: [
        { kind: 'waitUntil', condition: { type: 'fuelBelow', fraction: 0.6 } },
        { kind: 'task', task: { type: 'resupply' } },
        { kind: 'waitUntil', condition: { type: 'ammoBelow', fraction: 0.5 } },
      ],
    });
    eng.runFor(20);
    expect(tank.task?.spec.type).toBe('resupply');
    const copy = engine();
    copy.loadScenario(eng.toScenario());
    const twin = copy.entities.get(tank.id)!;
    expect(twin.fuel).toBeCloseTo(tank.fuel, 6);
    copy.step();
    expect(twin.task?.spec).toMatchObject({ type: 'resupply', supplierId: 'E1' });
    copy.runFor(200);
    expect(twin.fuel).toBeGreaterThan(0.999);
    expect(copy.entities.get('E1')!.supplies).toBeLessThan(10);
  });
});
