import { describe, expect, it } from 'vitest';
import { Engine } from '../src/sim/engine.js';
import { Terrain } from '../src/sim/terrain.js';

const base = Terrain.generate({ size: 6000, seed: 9, towns: 2 });
const cols = 81;
const flat = new Terrain({ ...base.spec, size: 4000, cellSize: 50, seed: 4242 }, new Float32Array(cols * cols).fill(20), new Uint8Array(cols * cols), [], []);

function engine(seed = 1): Engine {
  const e = new Engine({ terrain: flat, seed });
  e.newScenario('mounted', flat.spec);
  return e;
}

describe('mounted infantry', () => {
  it('a squad shares out the seats of a mech platoon and boards it', () => {
    const eng = engine();
    const mech = eng.createUnitFromTemplate('us-mech-platoon', 1, 1000, 1000);
    const squad = eng.createUnitFromTemplate('us-rifle-squad', 1, 1150, 1000);
    eng.assignTask(squad.id, { type: 'mount', carrierId: mech.id });
    eng.runFor(240);
    expect(squad.memberList.every((m) => m.embarkedIn)).toBe(true);
    for (const c of mech.memberList) expect(eng.passengersOf(c.id).length).toBeLessThanOrEqual(6);
    expect(squad.taskStatus()).toBe('done');
    const snap = eng.snapshot();
    expect(snap.entities.filter((e) => e.passengers).reduce((n, e) => n + e.passengers!.length, 0)).toBe(9);
  });

  it('passengers ride with the carrier, unseen, and get out when told', () => {
    const eng = engine();
    const ifv = eng.createEntity({ typeId: 'us-m2a3', force: 1, x: 500, y: 2000, heading: Math.PI / 2 });
    const squad = eng.createUnitFromTemplate('us-rifle-squad', 1, 500, 1900);
    expect(() => eng.embarkNow(squad.id, ifv.id)).not.toThrow();
    expect(eng.passengersOf(ifv.id)).toHaveLength(6);
    const left = squad.memberList.filter((m) => !m.embarkedIn);
    expect(left).toHaveLength(3);
    const watcher = eng.createEntity({ typeId: 'ru-brdm2', force: 2, x: 2000, y: 2600 });
    watcher.roe = 'holdFire';
    ifv.roe = 'holdFire';
    eng.assignTask(ifv.id, { type: 'moveTo', target: { x: 1800, y: 2000 } });
    eng.runFor(200);
    for (const p of eng.passengersOf(ifv.id)) {
      expect(Math.hypot(p.x - ifv.x, p.y - ifv.y)).toBeLessThan(1e-6);
      expect(watcher.contacts.has(p.id)).toBe(false);
    }
    expect(watcher.contacts.has(ifv.id)).toBe(true);
    eng.assignTask(ifv.id, { type: 'dismount' });
    eng.runFor(5);
    expect(eng.passengersOf(ifv.id)).toHaveLength(0);
    for (const m of squad.memberList) {
      if (left.includes(m)) continue;
      expect(m.embarkedIn).toBeUndefined();
      expect(Math.hypot(m.x - ifv.x, m.y - ifv.y)).toBeLessThan(25);
    }
  });

  it('a destroyed carrier kills some passengers; the rest bail out', () => {
    const eng = engine(5);
    const bmp = eng.createEntity({ typeId: 'ru-bmp2', force: 2, x: 2000, y: 2000 });
    const squad = eng.createUnitFromTemplate('ru-rifle-squad', 2, 2000, 1950);
    eng.embarkNow(squad.id, bmp.id);
    const riders = eng.passengersOf(bmp.id);
    expect(riders).toHaveLength(7);
    const log: string[] = [];
    eng.on('event', (ev) => log.push(ev.text));
    const tank = eng.createEntity({ typeId: 'us-m1a2', force: 1, x: 2000, y: 3000 });
    tank.roe = 'holdFire';
    eng.launch({ eventNumber: 1, shooterId: tank.id, targetId: bmp.id, weapon: { ...eng.catalog.weapon('gun-120mm'), pk: { light: 1 } }, from: tank.eye, to: bmp.position, fireTime: 0, impactTime: 0.5, range: 1000 });
    eng.runFor(1);
    expect(bmp.destroyed).toBe(true);
    expect(riders.every((p) => !p.embarkedIn)).toBe(true);
    const dead = riders.filter((p) => p.destroyed).length;
    expect(dead).toBeGreaterThan(0);
    expect(dead).toBeLessThan(7);
    expect(log.some((t) => t.includes('bailed out of'))).toBe(true);
  });

  it('only infantry mount, and full carriers refuse', () => {
    const eng = engine();
    const ifv = eng.createEntity({ typeId: 'us-m2a3', force: 1, x: 500, y: 500 });
    const tank = eng.createEntity({ typeId: 'us-m1a2', force: 1, x: 520, y: 500 });
    expect(() => eng.embarkNow(tank.id, ifv.id)).toThrow(/not dismounted infantry/);
    const squad = eng.createUnitFromTemplate('us-rifle-squad', 1, 600, 600);
    eng.embarkNow(squad.id, ifv.id);
    const extra = squad.memberList.find((m) => !m.embarkedIn)!;
    eng.assignTask(extra.id, { type: 'mount', carrierId: ifv.id });
    eng.runFor(1);
    expect(extra.task?.status).toBe('failed');
    expect(extra.task?.message).toBe('no free seats');
  });

  it('checkpoints keep who is mounted where', () => {
    const eng = engine();
    const ifv = eng.createEntity({ typeId: 'us-m2a3', force: 1, x: 500, y: 500 });
    const squad = eng.createUnitFromTemplate('us-rifle-squad', 1, 600, 600);
    eng.embarkNow(squad.id, ifv.id);
    for (const t of [0, 30]) {
      eng.runFor(t);
      const copy = engine();
      copy.loadScenario(eng.toScenario());
      expect(copy.passengersOf(ifv.id).map((p) => p.id)).toEqual(eng.passengersOf(ifv.id).map((p) => p.id));
    }
  });
});

describe('orders given to passengers', () => {
  it('wait until they dismount, then carry on', () => {
    const eng = engine();
    const ifv = eng.createEntity({ typeId: 'us-m2a3', force: 1, x: 500, y: 2000 });
    const squad = eng.createUnitFromTemplate('us-rifle-squad', 1, 520, 2000);
    eng.embarkNow(squad.id, ifv.id);
    eng.assignTask(squad.id, { type: 'moveTo', target: { x: 900, y: 2600 } });
    eng.assignTask(ifv.id, { type: 'moveTo', target: { x: 1500, y: 2000 } });
    eng.runFor(120);
    const lead = squad.leader!;
    expect(lead.embarkedIn).toBe(ifv.id);
    expect(squad.taskStatus()).toBe('running');
    eng.assignTask(ifv.id, { type: 'dismount' });
    eng.runFor(900);
    expect(lead.embarkedIn).toBeUndefined();
    expect(Math.hypot(lead.x - 900, lead.y - 2600)).toBeLessThan(15);
    expect(squad.taskStatus()).toBe('done');
  });
});
