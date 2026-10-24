import { describe, expect, it } from 'vitest';
import { DEG } from '../src/shared/math.js';
import type { SensorDef, WeaponDef } from '../src/shared/types.js';
import { validateEntityType, validateSensor, validateWeapon } from '../src/sim/catalogEdit.js';
import { effectivePk, pkParts, resolveImpact, type Shot } from '../src/sim/combat.js';
import { Engine } from '../src/sim/engine.js';
import type { Entity } from '../src/sim/entity.js';
import { aimError, aspectArmour, circularHitChance, dropAndSpread, normalCdf, radarEquation, type Models } from '../src/sim/models.js';
import { radarRange } from '../src/sim/sensors.js';
import { Terrain } from '../src/sim/terrain.js';

const base = Terrain.generate({ size: 6000, seed: 9, towns: 2 });

function flatTerrain(size: number, cellSize: number): Terrain {
  const cols = size / cellSize + 1;
  return new Terrain({ ...base.spec, size, cellSize, seed: 4242 }, new Float32Array(cols * cols).fill(20), new Uint8Array(cols * cols), [], []);
}

const flat = flatTerrain(4000, 50);
const wide = flatTerrain(40000, 500);

function engine(terrain = flat, seed?: number): Engine {
  const e = new Engine({ terrain, seed });
  e.newScenario('fidelity', terrain.spec);
  return e;
}

const at = (x: number, y: number, z = 0) => ({ x, y, z });

describe('armour by aspect', () => {
  const tank = { x: 0, y: 0, z: 0, heading: 0 };
  const gun = { indirect: false } as WeaponDef;

  it('picks the face from the bearing off the hull heading, and the roof for steep and top-attack rounds', () => {
    expect(aspectArmour.aspect(tank, at(0, 500), gun)).toBe('front');
    expect(aspectArmour.aspect(tank, at(500 * Math.sin(25 * DEG), 500 * Math.cos(25 * DEG)), gun)).toBe('front');
    expect(aspectArmour.aspect(tank, at(500 * Math.sin(35 * DEG), 500 * Math.cos(35 * DEG)), gun)).toBe('side');
    expect(aspectArmour.aspect(tank, at(-500, 0), gun)).toBe('side');
    expect(aspectArmour.aspect(tank, at(500 * Math.sin(155 * DEG), 500 * Math.cos(155 * DEG)), gun)).toBe('rear');
    expect(aspectArmour.aspect(tank, at(0, -500), gun)).toBe('rear');
    // A tank facing east is hit in the side from the north.
    expect(aspectArmour.aspect({ ...tank, heading: 90 * DEG }, at(0, 500), gun)).toBe('side');
    expect(aspectArmour.aspect({ ...tank, heading: 90 * DEG }, at(500, 0), gun)).toBe('front');
    // Steeper than 45°: the roof.
    expect(aspectArmour.aspect(tank, at(0, 100, 120), gun)).toBe('top');
    expect(aspectArmour.aspect(tank, at(0, 100, 80), gun)).toBe('front');
    expect(aspectArmour.aspect(tank, at(0, 500), { topAttack: true } as WeaponDef)).toBe('top');
    expect(aspectArmour.aspect(tank, at(0, 500), { indirect: true } as WeaponDef)).toBe('top');
  });

  it('defeats armour with probability Φ(ln(penetration / protection) / 0.35)', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 7);
    expect(normalCdf(1.959964)).toBeCloseTo(0.975, 6);
    expect(normalCdf(-1)).toBeCloseTo(0.158655, 6);
    const eng = engine();
    const m1 = eng.catalog.type('us-m1a2');
    const rpg = eng.catalog.weapon('rpg7');
    // 450 mm against 700 mm: ln(0.643) / 0.35 = -1.262, Φ = 0.103.
    expect(aspectArmour.perforation(rpg, m1, 'front')).toBeCloseTo(0.1034, 3);
    // 450 mm against 300 mm: ln(1.5) / 0.35 = 1.158, Φ = 0.877.
    expect(aspectArmour.perforation(rpg, m1, 'side')).toBeCloseTo(0.8767, 3);
    expect(aspectArmour.perforation(rpg, m1, 'rear')).toBeGreaterThan(0.9999);
    expect(aspectArmour.perforation({ ...rpg, penetration: 700 }, m1, 'front')).toBeCloseTo(0.5, 7);
    // No data on either side: armour plays no part.
    expect(aspectArmour.perforation({ ...rpg, penetration: undefined }, m1, 'front')).toBe(1);
    expect(aspectArmour.perforation(rpg, eng.catalog.type('us-hmmwv'), 'front')).toBe(1);
  });

  it('makes an RPG-7 far less lethal against the front of an M1A2 than its side, while tank guns still kill tanks head on', () => {
    const eng = engine();
    const m1 = eng.createEntity({ typeId: 'us-m1a2', force: 1, x: 2000, y: 2000, heading: 0 });
    const front = eng.createEntity({ typeId: 'ru-rifleman', force: 2, x: 2000, y: 2150 });
    const side = eng.createEntity({ typeId: 'ru-rifleman', force: 2, x: 2150, y: 2000 });
    const rpg = eng.catalog.weapon('rpg7');
    const pf = pkParts(eng, front, m1, rpg, 150);
    const ps = pkParts(eng, side, m1, rpg, 150);
    expect(pf.aspect).toBe('front');
    expect(ps.aspect).toBe('side');
    expect(pf.base).toBeCloseTo(ps.base, 9);
    expect(effectivePk(eng, front, m1, rpg, 150)).toBeCloseTo(pf.base * 0.1034, 3);
    expect(effectivePk(eng, front, m1, rpg, 150)).toBeLessThan(0.03);
    expect(effectivePk(eng, side, m1, rpg, 150)).toBeGreaterThan(0.2);
    // A round from a point other than the shooter (e.g. one in flight) uses that point.
    expect(pkParts(eng, front, m1, rpg, 150, at(2000, 1850, 20)).aspect).toBe('rear');
    // Head on at 1 km, both tank guns still kill.
    const t72 = eng.createEntity({ typeId: 'ru-t72b3', force: 2, x: 2000, y: 3000, heading: Math.PI });
    expect(pkParts(eng, m1, t72, eng.catalog.weapon('gun-120mm'), 1000).aspect).toBe('front');
    expect(effectivePk(eng, m1, t72, eng.catalog.weapon('gun-120mm'), 1000)).toBeGreaterThan(0.45);
    expect(effectivePk(eng, t72, m1, eng.catalog.weapon('gun-125mm'), 1000)).toBeGreaterThan(0.2);
    // Javelin attacks the roof, whichever way the tank faces.
    const jav = eng.createEntity({ typeId: 'us-javelin-team', force: 1, x: 2000, y: 2900 });
    const p = pkParts(eng, jav, t72, eng.catalog.weapon('javelin'), 1000);
    expect(p.aspect).toBe('top');
    expect(p.perforation).toBeGreaterThan(0.99);
  });

  it('kills a frontal M1A2 with an RPG-7 in a few per cent of shots, a side-on one in about a fifth (fixed seed)', () => {
    const eng = engine(flat, 20260601);
    const m1 = eng.createEntity({ typeId: 'us-m1a2', force: 1, x: 2000, y: 2000, heading: 0 });
    const gunner = eng.createEntity({ typeId: 'ru-rifleman', force: 2, x: 2000, y: 2150 });
    const rpg = eng.catalog.weapon('rpg7');
    const trials = 4000;
    const run = (heading: number) => {
      m1.heading = heading;
      let kills = 0;
      let held = 0;
      for (let i = 0; i < trials; i++) {
        m1.destroyed = m1.mobilityKill = m1.firepowerKill = false;
        m1.suppression = 0;
        const shot: Shot = { eventNumber: i, shooterId: gunner.id, targetId: m1.id, weapon: rpg, from: { x: gunner.x, y: gunner.y, z: gunner.z + 1.7 }, to: { x: m1.x, y: m1.y, z: m1.z + 1 }, fireTime: 0, impactTime: 0, range: 150 };
        const det = resolveImpact(eng, shot);
        if (det.outcome === 'kill') kills++;
        if (det.armourHeld) held++;
      }
      return { rate: kills / trials, held };
    };
    const front = run(0);
    const side = run(90 * DEG);
    const rear = run(180 * DEG);
    // Expected: 0.25 × 0.991 (range) × perforation = 2.6 %, 21.7 %, 24.8 %.
    expect(front.rate).toBeGreaterThan(0.01);
    expect(front.rate).toBeLessThan(0.045);
    expect(side.rate).toBeGreaterThan(0.18);
    expect(side.rate).toBeLessThan(0.26);
    expect(rear.rate).toBeGreaterThan(0.21);
    expect(side.rate).toBeGreaterThan(5 * front.rate);
    // Most frontal hits bounce off; hardly any from behind.
    expect(front.held).toBeGreaterThan(10 * Math.max(1, rear.held));
  });

  it('counts the roof for blast and fragments', () => {
    const eng = engine();
    const m1 = eng.createEntity({ typeId: 'us-m1a2', force: 1, x: 2000, y: 2000 });
    const bmp = eng.createEntity({ typeId: 'ru-bmp2', force: 2, x: 2000, y: 2000 });
    const mortar = eng.catalog.weapon('mortar-120mm');
    // 45 mm of fragment penetration against the M1A2's 60 mm roof: Φ(ln 0.75 / 0.35) = 0.206.
    expect(eng.models.hitKill.perforation(mortar, m1.type, 'top')).toBeCloseTo(normalCdf(Math.log(45 / 60) / 0.35), 9);
    expect(eng.models.hitKill.perforation(mortar, m1.type, 'top')).toBeCloseTo(0.206, 3);
    expect(eng.models.hitKill.perforation(mortar, bmp.type, 'top')).toBeGreaterThan(0.99);
  });
});

describe('ballistics of unguided direct fire', () => {
  it('works out the miss distance from spread and gravity drop (hand-worked RPG-7 at 300 m)', () => {
    const eng = engine();
    const rpg = eng.catalog.weapon('rpg7');
    // 2 mrad × 300 m = 0.6 m; flight 300 / 240 = 1.25 s, drop ½ × 9.81 × 1.25² = 7.664 m,
    // misjudged by 10 %: 2 × 7.664 × 0.1 = 1.533 m. Together: 1.646 m.
    expect(aimError(rpg, 300)).toBeCloseTo(Math.hypot(0.6, 1.5328), 3);
    expect(aimError(rpg, 300)).toBeCloseTo(1.646, 3);
    // Inside 1.5 m of the aim point: 1 − exp(−1.5² / (2 × 1.646²)) = 0.340.
    expect(circularHitChance(1.5, aimError(rpg, 300))).toBeCloseTo(0.34, 2);
    const m1 = eng.catalog.type('us-m1a2');
    // At 100 m it hardly misses, so the range factor at 300 m is the hit chance there.
    expect(dropAndSpread.rangeFactor(rpg, 100, m1)).toBe(1);
    expect(dropAndSpread.rangeFactor(rpg, 300, m1)).toBeCloseTo(0.34, 2);
    expect(dropAndSpread.rangeFactor(rpg, 200, m1)).toBeGreaterThan(0.8);
  });

  it('costs slow rounds more at long range than fast ones; guided missiles and machine guns keep the generic falloff', () => {
    const eng = engine();
    const bmp = eng.catalog.type('ru-bmp2');
    const tank = eng.catalog.type('ru-t72b3');
    const f = (id: string, range: number, t = bmp) => dropAndSpread.rangeFactor(eng.catalog.weapon(id), range, t);
    // 120 mm APFSDS at 1650 m/s with a laser rangefinder: still good at 2 km.
    expect(f('gun-120mm', 2000, tank)).toBeGreaterThan(0.9);
    // 30 mm at 960 m/s with a stadia rangefinder: poor at 2 km.
    expect(f('gun-30mm-2a42', 2000)).toBeLessThan(0.2);
    expect(f('gun-30mm-2a42', 2000)).toBeLessThan(f('gun-25mm', 2000));
    for (const r of [500, 1000, 1500]) expect(f('gun-30mm-2a42', r)).toBeGreaterThan(f('gun-30mm-2a42', r + 500));
    const tow = eng.catalog.weapon('atgm-tow');
    expect(dropAndSpread.rangeFactor(tow, 3000, tank)).toBeCloseTo(1 - 0.5 * (3000 / 3750) ** 2, 9);
    const mg = eng.catalog.weapon('mg-762');
    expect(dropAndSpread.rangeFactor(mg, 450, eng.catalog.type('ru-rifleman'))).toBeCloseTo(1 - 0.5 * 0.25, 9);
  });
});

describe('radar range equation', () => {
  const radar: SensorDef = { id: 'r', name: 'r', maxRange: 30000, fov: 2 * Math.PI, detects: ['air'], radar: true, refRange: 25000, refRcs: 5 };

  it('scales detection range with the fourth root of the radar cross-section, up to the instrumented range', () => {
    expect(radarEquation.detectionRange(radar, 5)).toBeCloseTo(25000, 6);
    // A sixteenth of the cross-section: half the range.
    expect(radarEquation.detectionRange(radar, 5 / 16)).toBeCloseTo(12500, 6);
    expect(radarEquation.detectionRange(radar, 5 * 1.2 ** 4)).toBeCloseTo(30000, 6);
    expect(radarEquation.detectionRange(radar, 80)).toBe(30000);
    expect(radarEquation.detectionRange({ ...radar, refRange: undefined }, 0.01)).toBe(30000);
    // Reference cross-section defaults to 1 m².
    expect(radarEquation.detectionRange({ ...radar, refRcs: undefined }, 16)).toBe(30000);
    expect(radarEquation.detectionRange({ ...radar, refRcs: undefined, maxRange: 1e6 }, 16)).toBeCloseTo(50000, 6);
  });

  it('gives types a cross-section, defaulting by symbol and domain', () => {
    const eng = engine();
    expect(radarEquation.rcs(eng.catalog.type('us-f16'))).toBe(1.2);
    expect(radarEquation.rcs({ ...eng.catalog.type('us-f16'), rcs: undefined })).toBe(5);
    expect(radarEquation.rcs(eng.catalog.type('us-m1a2'))).toBe(20);
    expect(radarEquation.rcs(eng.catalog.type('ru-rifleman'))).toBe(1);
    const sam = eng.catalog.sensors.get('sam-radar')!;
    // 25 km against 5 m²: an F-16 (1.2 m²) is seen at 25 × 0.24^¼ = 17.5 km.
    expect(radarRange(eng, sam, eng.catalog.type('us-f16'))).toBeCloseTo(25000 * 0.24 ** 0.25, 3);
  });

  it('lets a SAM radar see a Black Hawk further than an Apache, and jamming still cuts it', () => {
    const eng = engine(wide, 7);
    const sa8 = eng.createEntity({ typeId: 'ru-sa8', force: 2, x: 2000, y: 2000 });
    // UH-60 (10 m²) seen to 29.7 km; AH-64 (3 m²) to 22.0 km. Both are 24 km away.
    const uh60 = eng.createEntity({ typeId: 'us-uh60', force: 1, x: 2000, y: 26000 });
    const ah64 = eng.createEntity({ typeId: 'us-ah64', force: 1, x: 26000, y: 2000 });
    eng.runFor(15);
    expect(sa8.contacts.has(uh60.id)).toBe(true);
    expect(sa8.contacts.has(ah64.id)).toBe(false);
    // Closer than its 22 km, the Apache is seen too.
    ah64.x = 2000 + 20000 * Math.SQRT1_2;
    ah64.y = 2000 + 20000 * Math.SQRT1_2;
    eng.runFor(15);
    expect(sa8.contacts.has(ah64.id)).toBe(true);
    // A radar jammer 10 km off leaves 40 % of the range: 11.9 km for the Black Hawk.
    const fresh = engine(wide, 7);
    const sa8b = fresh.createEntity({ typeId: 'ru-sa8', force: 2, x: 2000, y: 2000 });
    const uh60b = fresh.createEntity({ typeId: 'us-uh60', force: 1, x: 2000, y: 26000 });
    const jammer = fresh.createEntity({ typeId: 'ru-krasukha', force: 1, x: 12000, y: 2000 });
    jammer.jamming = true;
    fresh.runFor(15);
    expect(fresh.ew.radarFactor(sa8b)).toBeCloseTo(0.4, 5);
    expect(sa8b.contacts.has(uh60b.id)).toBe(false);
  });
});

describe('model registry', () => {
  it('lets an engine swap a model', () => {
    const eng = engine();
    const m1 = eng.createEntity({ typeId: 'us-m1a2', force: 1, x: 2000, y: 2000, heading: 0 });
    const man: Entity = eng.createEntity({ typeId: 'ru-rifleman', force: 2, x: 2000, y: 2150 });
    const rpg = eng.catalog.weapon('rpg7');
    expect(effectivePk(eng, man, m1, rpg, 150)).toBeLessThan(0.03);
    const noArmour: Models['hitKill'] = { ...aspectArmour, name: 'none', perforation: () => 1 };
    eng.models = { ...eng.models, hitKill: noArmour };
    expect(effectivePk(eng, man, m1, rpg, 150)).toBeGreaterThan(0.2);
    // Other engines keep the defaults.
    expect(engine().models.hitKill.name).toBe('aspect-armour');
  });
});

describe('catalog fields', () => {
  it('keeps and checks protection, cross-section, penetration, ballistics and radar reference', () => {
    const eng = engine();
    const m1 = validateEntityType(eng.catalog.type('us-m1a2'));
    expect(m1.protection).toEqual({ front: 700, side: 300, rear: 100, top: 60 });
    expect(validateEntityType({ ...eng.catalog.type('us-f16') }).rcs).toBe(1.2);
    expect(() => validateEntityType({ ...m1, protection: { front: 700, side: 300 } })).toThrow(/protection.rear/);
    expect(() => validateEntityType({ ...m1, rcs: -1 })).toThrow(/rcs/);
    const rpg = validateWeapon(eng.catalog.weapon('rpg7'));
    expect([rpg.penetration, rpg.spreadMrad, rpg.rangeError]).toEqual([450, 2, 0.1]);
    expect(validateWeapon(eng.catalog.weapon('javelin')).topAttack).toBe(true);
    expect(() => validateWeapon({ ...rpg, rangeError: 2 })).toThrow(/rangeError/);
    const sam = validateSensor(eng.catalog.sensors.get('sam-radar'));
    expect([sam.refRange, sam.refRcs]).toEqual([25000, 5]);
    // Old entries without the new fields are still valid and unchanged.
    const old = validateWeapon({ ...rpg, penetration: undefined, spreadMrad: undefined, rangeError: undefined });
    expect('penetration' in old || 'spreadMrad' in old).toBe(false);
  });
});
