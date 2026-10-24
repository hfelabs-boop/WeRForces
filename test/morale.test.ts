import { describe, expect, it } from 'vitest';
import { effectivePk } from '../src/sim/combat.js';
import { Engine } from '../src/sim/engine.js';
import { SUPPRESSION_HALF_LIFE } from '../src/sim/morale.js';
import { Terrain } from '../src/sim/terrain.js';

const base = Terrain.generate({ size: 6000, seed: 9, towns: 2 });
const cols = 81;
const flat = new Terrain({ ...base.spec, size: 4000, cellSize: 50, seed: 4242 }, new Float32Array(cols * cols).fill(20), new Uint8Array(cols * cols), [], []);

function engine(): Engine {
  const e = new Engine({ terrain: flat });
  e.newScenario('morale', flat.spec);
  return e;
}

/** A Red rifle squad walking into two Blue HMMWVs' heavy machine guns. */
function ambush(eng: Engine) {
  const squad = eng.createUnitFromTemplate('ru-rifle-squad', 2, 2000, 3200, Math.PI);
  const guns = eng.createUnitFromTemplate('us-scout-section', 1, 2000, 1800);
  eng.assignTask(squad.id, { type: 'moveTo', target: { x: 2000, y: 1900 } });
  const log: string[] = [];
  eng.on('event', (ev) => log.push(`${Math.round(ev.time)} ${ev.text}`));
  return { squad, guns, log };
}

describe('suppression', () => {
  it('builds up under fire, pins infantry down and wears off', () => {
    const eng = engine();
    const { squad, log } = ambush(eng);
    eng.runFor(20);
    expect(log.some((t) => t.endsWith('pinned down'))).toBe(true);
    const victim = squad.alive().find((m) => m.suppression > 0)!;
    expect(victim).toBeDefined();
    // Take the guns away: suppression halves every few seconds.
    for (const e of [...eng.entities.values()]) if (e.force === 1) eng.deleteObject(e.id);
    eng.runFor(3); // rounds already in the air still land
    const before = victim.suppression;
    eng.runFor(SUPPRESSION_HALF_LIFE);
    expect(victim.suppression).toBeCloseTo(before / 2, 2);
  });

  it('makes a suppressed shooter less accurate and pinned infantry harder to hit', () => {
    const eng = engine();
    const tank = eng.createEntity({ typeId: 'us-m1a2', force: 1, x: 1000, y: 1000 });
    const man = eng.createEntity({ typeId: 'ru-rifleman', force: 2, x: 1500, y: 1000 });
    const w = eng.catalog.weapon('mg-762');
    const clean = effectivePk(eng, tank, man, w, 500);
    tank.suppression = 0.5;
    expect(effectivePk(eng, tank, man, w, 500)).toBeCloseTo(clean * 0.7, 6);
    tank.suppression = 0;
    man.pinned = true;
    expect(effectivePk(eng, tank, man, w, 500)).toBeCloseTo(clean * 0.5, 6);
  });
});

describe('morale', () => {
  it('a unit under heavy losses becomes shaken, breaks and falls back away from the enemy', () => {
    const eng = engine();
    const { squad, log } = ambush(eng);
    let brokeAt: number | undefined;
    let yAtBreak = 0;
    for (let t = 0; t < 150 && brokeAt === undefined; t++) {
      eng.runFor(1);
      if (squad.moraleState === 'broken') {
        brokeAt = eng.time;
        yAtBreak = squad.centroid().y;
      }
    }
    expect(log.some((t) => t.endsWith('RU Rifle Squad is shaken'))).toBe(true);
    expect(brokeAt).toBeDefined();
    expect(squad.alive().length).toBeGreaterThan(0);
    // Falling back north, away from the guns to the south (as far as the map edge allows).
    expect(squad.taskSpec).toMatchObject({ type: 'moveTo' });
    expect((squad.taskSpec as { target: { y: number } }).target.y).toBeGreaterThan(Math.min(yAtBreak + 1400, 3900));
    expect(squad.memberList.every((m) => m.roe === 'returnFire')).toBe(true);
  });

  it('rallies once the fire stops', () => {
    const eng = engine();
    const squad = eng.createUnitFromTemplate('ru-rifle-squad', 2, 2000, 2000);
    squad.morale = 0.2;
    squad.moraleState = 'broken';
    const log: string[] = [];
    eng.on('event', (ev) => log.push(ev.text));
    eng.runFor(25);
    expect(squad.moraleState).toBe('shaken');
    expect(log).toContain('RU Rifle Squad rallied');
  });

  it('can be switched off, with suppression, for comparison runs', () => {
    const eng = engine();
    eng.setRules({ suppression: false, morale: false });
    const { squad, log } = ambush(eng);
    eng.runFor(120);
    expect(squad.memberList.every((m) => m.suppression === 0)).toBe(true);
    expect(squad.morale).toBe(1);
    expect(log.some((t) => /pinned|shaken|broke/.test(t))).toBe(false);
    // The setting is saved with the scenario.
    const copy = engine();
    copy.loadScenario(eng.toScenario());
    expect(copy.rules).toEqual({ suppression: false, morale: false, fuel: true, orderDelay: false });
  });

  it('checkpoints keep suppression and morale', () => {
    const eng = engine();
    const { squad } = ambush(eng);
    eng.runFor(60);
    const copy = engine();
    copy.loadScenario(eng.toScenario());
    const twin = copy.units.get(squad.id)!;
    expect(twin.morale).toBeCloseTo(squad.morale, 6);
    expect(twin.moraleState).toBe(squad.moraleState);
    for (const m of squad.alive()) expect(copy.entities.get(m.id)!.suppression).toBeCloseTo(m.suppression, 6);
  });
});
