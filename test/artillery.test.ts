import { describe, expect, it } from 'vitest';
import { Engine } from '../src/sim/engine.js';
import { FireMissionTask } from '../src/sim/tasks.js';
import { Terrain } from '../src/sim/terrain.js';

// Flat, open 16 km terrain: artillery ranges are long.
const base = Terrain.generate({ size: 6000, seed: 9, towns: 2 });
const cols = 161;
const flat = new Terrain({ ...base.spec, size: 16000, cellSize: 100, seed: 777 }, new Float32Array(cols * cols).fill(20), new Uint8Array(cols * cols), [], []);

function engine(seed = 1): Engine {
  const e = new Engine({ terrain: flat, seed });
  e.newScenario('artillery', flat.spec);
  return e;
}

function texts(eng: Engine): string[] {
  const out: string[] = [];
  eng.on('event', (ev) => out.push(ev.text));
  return out;
}

describe('fire missions', () => {
  it('fire the requested rounds and damage entities inside the blast radius', () => {
    const eng = engine();
    const log = texts(eng);
    const gun = eng.createEntity({ typeId: 'us-m109a7', force: 1, x: 2000, y: 8000 });
    const squad = eng.createUnitFromTemplate('ru-rifle-squad', 2, 10000, 8000);
    for (const m of squad.memberList) m.roe = 'holdFire';
    eng.assignTask(gun.id, { type: 'fireMission', target: { x: 10000, y: 8000 }, rounds: 12, radius: 30 });
    eng.runFor(240);
    expect(gun.ammo.get('how-155mm')).toBe(39 - 12);
    expect(gun.task?.status).toBe('done');
    const impacts = log.filter((t) => t.includes('155mm M284 howitzer (M795 HE) impact at'));
    expect(impacts).toHaveLength(12);
    expect(squad.memberList.some((m) => m.damage !== 'none')).toBe(true);
  });

  it('fails when the target is inside minimum range', () => {
    const eng = engine();
    const gun = eng.createEntity({ typeId: 'us-m109a7', force: 1, x: 2000, y: 8000 });
    eng.assignTask(gun.id, { type: 'fireMission', target: { x: 2500, y: 8000 } });
    eng.runFor(1);
    expect(gun.task?.status).toBe('failed');
    expect(gun.task?.message).toBe('target out of range');
  });

  it('a battery fires with every tube that can reach', () => {
    const eng = engine();
    const battery = eng.createUnitFromTemplate('ru-mortar-battery', 2, 8000, 3000);
    eng.assignTask(battery.id, { type: 'fireMission', target: { x: 8000, y: 8000 }, rounds: 2, radius: 50 });
    eng.runFor(1);
    expect(battery.memberList.every((m) => m.task instanceof FireMissionTask)).toBe(true);
    eng.runFor(90);
    expect(battery.taskStatus()).toBe('done');
    for (const m of battery.memberList) expect(m.ammo.get('mortar-120mm')).toBe(24 - 2);
  });

  it('direct-fire target selection never uses indirect weapons', () => {
    const eng = engine();
    const mortar = eng.createEntity({ typeId: 'us-mortar-team', force: 1, x: 5000, y: 5000 });
    eng.createEntity({ typeId: 'ru-ural', force: 2, x: 5000, y: 5300 });
    eng.runFor(30);
    expect(mortar.ammo.get('mortar-81mm')).toBe(30);
    expect(mortar.ammo.get('rifle-556')).toBeLessThan(eng.catalog.weapon('rifle-556').ammo);
  });

  it('resume from a checkpoint with the rounds still to fire', () => {
    const eng = engine();
    const gun = eng.createEntity({ typeId: 'us-m109a7', force: 1, x: 2000, y: 8000 });
    eng.assignTask(gun.id, { type: 'fireMission', target: { x: 12000, y: 8000 }, rounds: 5 });
    eng.runFor(55); // laid after 20 s, then a round every ~15 s
    const fired = 39 - gun.ammo.get('how-155mm')!;
    expect(fired).toBeGreaterThan(0);
    expect(fired).toBeLessThan(5);
    const copy = engine();
    copy.loadScenario(eng.toScenario());
    copy.runFor(200);
    expect(copy.entities.get(gun.id)!.ammo.get('how-155mm')).toBe(39 - 5);
    // A finished mission is not restarted when a later checkpoint is loaded.
    const again = engine();
    again.loadScenario(copy.toScenario());
    again.runFor(100);
    expect(again.entities.get(gun.id)!.ammo.get('how-155mm')).toBe(39 - 5);
  });
});

describe('call for fire', () => {
  it('an observer brings in the nearest idle battery on a hostile it sees', () => {
    const eng = engine();
    const log = texts(eng);
    const fo = eng.createEntity({ typeId: 'us-fo-team', force: 1, x: 6000, y: 8000 });
    expect(fo.reactions.callForFire).toBe(true);
    fo.roe = 'holdFire';
    const near = eng.createUnitFromTemplate('us-paladin-platoon', 1, 1000, 8000);
    const far = eng.createUnitFromTemplate('us-paladin-platoon', 1, 1000, 1000);
    const enemy = eng.createUnitFromTemplate('ru-rifle-squad', 2, 9500, 8000);
    for (const m of enemy.memberList) m.roe = 'holdFire';
    eng.runFor(150);
    expect(log.some((t) => t.startsWith(`${fo.name} called for fire on`) && t.includes(`${near.name} firing 3 rounds x 4 tubes`))).toBe(true);
    expect(near.memberList.every((m) => m.ammo.get('how-155mm')! < 39)).toBe(true);
    expect(far.memberList.every((m) => m.ammo.get('how-155mm') === 39)).toBe(true);
    expect(enemy.memberList.some((m) => m.damage !== 'none')).toBe(true);
  });

  it('holds fire when friendly troops are danger close', () => {
    const eng = engine();
    const log = texts(eng);
    const fo = eng.createEntity({ typeId: 'us-fo-team', force: 1, x: 6000, y: 8000 });
    fo.roe = 'holdFire';
    eng.createEntity({ typeId: 'us-m109a7', force: 1, x: 1000, y: 8000 });
    const tank = eng.createEntity({ typeId: 'ru-t72b3', force: 2, x: 8000, y: 8000 });
    const friend = eng.createEntity({ typeId: 'us-hmmwv', force: 1, x: 8000, y: 8080 });
    tank.roe = 'holdFire';
    friend.roe = 'holdFire';
    eng.runFor(30);
    expect(log.some((t) => t.includes('called for fire'))).toBe(false);
  });

  it('area detonations reported over DIS damage local entities', () => {
    const eng = engine(3);
    const squad = eng.createUnitFromTemplate('ru-rifle-squad', 2, 8000, 8000);
    const munition = eng.catalog.weapon('how-155mm').munition;
    for (let i = 0; i < 6; i++) expect(eng.applyExternalAreaDetonation(munition, { x: 8000, y: 8000, z: 20 })).toBe(true);
    expect(squad.memberList.some((m) => m.damage !== 'none')).toBe(true);
    expect(eng.applyExternalAreaDetonation(eng.catalog.weapon('gun-120mm').munition, { x: 8000, y: 8000, z: 20 })).toBe(false);
  });
});
