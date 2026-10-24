import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Engine } from '../src/sim/engine.js';
import { Terrain } from '../src/sim/terrain.js';

// Flat, open 4 km terrain so line of sight and movement are predictable.
const base = Terrain.generate({ size: 6000, seed: 9, towns: 2 });
const cols = 81;
const flat = new Terrain({ ...base.spec, size: 4000, cellSize: 50, seed: 4242 }, new Float32Array(cols * cols).fill(20), new Uint8Array(cols * cols), [], []);

function engine(seed = 1): Engine {
  const e = new Engine({ terrain: flat, seed });
  e.newScenario('model', flat.spec);
  return e;
}

describe('command-guided missiles', () => {
  it('miss when the launcher is destroyed before impact', () => {
    const eng = engine();
    const bmp = eng.createEntity({ typeId: 'ru-bmp2', force: 2, x: 1000, y: 2000, heading: Math.PI / 2 });
    const tank = eng.createEntity({ typeId: 'us-m1a2', force: 1, x: 3500, y: 2000, heading: -Math.PI / 2 });
    tank.roe = 'holdFire';
    bmp.roe = 'holdFire';
    const konkurs = eng.catalog.weapon('atgm-konkurs');
    eng.launch({ eventNumber: 1, shooterId: bmp.id, targetId: tank.id, weapon: konkurs, from: bmp.eye, to: tank.position, fireTime: 0, impactTime: 5, range: 2500 });
    bmp.destroyed = true;
    const texts: string[] = [];
    eng.on('event', (ev) => texts.push(ev.text));
    eng.runFor(6);
    expect(texts.some((t) => t.includes('lost guidance'))).toBe(true);
    expect(tank.damage).toBe('none');
  });

  it('fire-and-forget missiles still arrive', () => {
    expect(new Engine({ terrain: flat }).catalog.weapon('hellfire').commandGuided).toBeFalsy();
    expect(new Engine({ terrain: flat }).catalog.weapon('atgm-tow').commandGuided).toBe(true);
  });
});

describe('plan conditions', () => {
  it('enemyInArea fires when a hostile enters the area', () => {
    const eng = engine();
    const area = eng.addGraphic('area', [{ x: 2000, y: 1500 }, { x: 2600, y: 1500 }, { x: 2600, y: 2500 }, { x: 2000, y: 2500 }], 'KZ');
    const watcher = eng.createEntity({ typeId: 'us-hmmwv', force: 1, x: 500, y: 500 });
    eng.assignPlan(watcher.id, { statements: [{ kind: 'waitUntil', condition: { type: 'enemyInArea', areaId: area.id } }, { kind: 'setRoe', roe: 'holdFire' }] });
    const truck = eng.createEntity({ typeId: 'ru-ural', force: 2, x: 3500, y: 2000 });
    eng.runFor(2);
    expect(watcher.roe).toBe('fireAtWill');
    eng.assignTask(truck.id, { type: 'moveTo', target: { x: 2300, y: 2000 } });
    eng.runFor(120);
    expect(watcher.roe).toBe('holdFire');
  });

  it('strengthBelow compares surviving members', () => {
    const eng = engine();
    const unit = eng.createUnitFromTemplate('us-tank-platoon', 1, 1000, 1000);
    eng.assignPlan(unit.id, { statements: [{ kind: 'waitUntil', condition: { type: 'strengthBelow', fraction: 0.6 } }, { kind: 'setFormation', formation: 'line' }] });
    eng.runFor(1);
    unit.memberList[1].destroyed = true;
    eng.runFor(1);
    expect(unit.formation).toBe('wedge'); // 3/4 = 0.75
    unit.memberList[2].destroyed = true;
    eng.runFor(1);
    expect(unit.formation).toBe('line'); // 2/4 = 0.5
  });
});

describe('reactions', () => {
  it('halt on contact stops movement while an enemy is in range, then resumes', () => {
    const eng = engine();
    const tank = eng.createEntity({ typeId: 'us-m1a2', force: 1, x: 500, y: 2000, heading: Math.PI / 2 });
    tank.roe = 'holdFire';
    eng.setReactions(tank.id, { onContact: 'halt' });
    eng.assignTask(tank.id, { type: 'moveTo', target: { x: 3500, y: 2000 } });
    const enemy = eng.createEntity({ typeId: 'ru-ural', force: 2, x: 3000, y: 2400 });
    enemy.roe = 'holdFire';
    eng.runFor(30);
    expect(tank.halted).toBe(true);
    expect(tank.speed).toBeLessThan(0.5);
    expect(tank.task?.status).toBe('running');
    const stoppedAt = tank.x;
    eng.deleteObject(enemy.id);
    eng.runFor(60);
    expect(tank.halted).toBe(false);
    expect(tank.x).toBeGreaterThan(stoppedAt + 100);
  });

  it('a unit withdraws when its strength drops below the threshold', () => {
    const eng = engine();
    const unit = eng.createUnitFromTemplate('us-tank-platoon', 1, 1000, 1000);
    eng.setReactions(unit.id, { withdrawBelow: 0.75 });
    expect(unit.reactions.withdrawTo).toBeDefined();
    eng.assignPlan(unit.id, { statements: [{ kind: 'task', task: { type: 'moveTo', target: { x: 3000, y: 3000 } } }] });
    eng.runFor(60);
    unit.memberList[0].destroyed = true;
    unit.memberList[1].destroyed = true;
    eng.runFor(1);
    expect(unit.withdrawn).toBe(true);
    expect(unit.plan).toBeNull();
    expect(unit.leader!.task?.spec).toMatchObject({ type: 'moveTo', target: unit.reactions.withdrawTo });
    expect(unit.leader!.roe).toBe('returnFire');
  });
});

describe('checkpoints', () => {
  const scenario = JSON.parse(readFileSync('scenarios/calloway-crossroads.json', 'utf8'));

  it('save and load keep damage, ammunition, contacts, plan progress and RNG state', () => {
    const a = new Engine();
    a.loadScenario(scenario);
    a.runFor(1800);
    const cp = JSON.parse(JSON.stringify(a.toScenario()));
    const b = new Engine();
    b.loadScenario(cp);
    expect(b.time).toBeCloseTo(a.time, 6);
    expect(b.rng.state).toBe(a.rng.state);
    for (const ea of a.entities.values()) {
      const eb = b.entities.get(ea.id)!;
      expect(eb.damage, ea.name).toBe(ea.damage);
      expect([...eb.ammo]).toEqual([...ea.ammo]);
      expect(eb.contacts.size).toBe(ea.contacts.size);
    }
    for (const ua of a.units.values()) {
      const ub = b.units.get(ua.id)!;
      expect(ub.leader?.id).toBe(ua.leader?.id);
      expect(ub.plan?.index).toBe(ua.plan?.index);
    }
  });

  it('two engines loading the same checkpoint continue identically', () => {
    const a = new Engine();
    a.loadScenario(scenario);
    a.runFor(1500);
    const cp = JSON.parse(JSON.stringify(a.toScenario()));
    const runs = [new Engine(), new Engine()].map((eng) => {
      eng.loadScenario(cp);
      eng.runFor(600);
      return [...eng.entities.values()].map((e) => `${e.id}:${e.damage}:${Math.round(e.x)}:${Math.round(e.y)}`).join('|');
    });
    expect(runs[0]).toBe(runs[1]);
  });

  it('keeps wrecks and munitions in flight', () => {
    const eng = engine();
    const bmp = eng.createEntity({ typeId: 'ru-bmp2', force: 2, x: 1000, y: 2000 });
    const tank = eng.createEntity({ typeId: 'us-m1a2', force: 1, x: 3000, y: 2000 });
    tank.destroyed = true;
    eng.launch({ eventNumber: 9, shooterId: bmp.id, targetId: tank.id, weapon: eng.catalog.weapon('atgm-konkurs'), from: bmp.eye, to: tank.position, fireTime: 0, impactTime: 10, range: 2000 });
    const cp = eng.toScenario();
    expect(cp.shots).toHaveLength(1);
    const b = new Engine({ terrain: flat });
    b.loadScenario(JSON.parse(JSON.stringify(cp)));
    expect(b.entities.get(tank.id)!.destroyed).toBe(true);
    expect(b.toScenario().shots).toHaveLength(1);
  });
});
