import { describe, expect, it } from 'vitest';
import { effectivePk } from '../src/sim/combat.js';
import { Engine } from '../src/sim/engine.js';
import { pointInPolygon } from '../src/shared/math.js';
import { sweepTracks } from '../src/sim/tasks.js';
import { Terrain } from '../src/sim/terrain.js';

const base = Terrain.generate({ size: 6000, seed: 9, towns: 2 });
const cols = 81;
const flat = new Terrain({ ...base.spec, size: 4000, cellSize: 50, seed: 4242 }, new Float32Array(cols * cols).fill(20), new Uint8Array(cols * cols), [], []);

function engine(): Engine {
  const e = new Engine({ terrain: flat });
  e.newScenario('tactics', flat.spec);
  return e;
}

const box = (x0: number, y0: number, x1: number, y1: number) => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];

describe('defend', () => {
  it('a platoon deploys in a line across the facing and digs in', () => {
    const eng = engine();
    const p = eng.createUnitFromTemplate('us-tank-platoon', 1, 2000, 1000);
    eng.assignTask(p.id, { type: 'defend', position: { x: 2000, y: 2000 }, facing: 0, width: 300 });
    eng.runFor(200);
    const xs = p.memberList.map((m) => m.x).sort((a, b) => a - b);
    for (const m of p.memberList) {
      expect(Math.abs(m.y - 2000)).toBeLessThan(15);
      expect(m.prepared).toBe('hullDown');
      const deg = (((m.heading * 180) / Math.PI) % 360 + 360) % 360;
      expect(Math.min(deg, 360 - deg)).toBeLessThan(5);
    }
    expect(xs[0]).toBeCloseTo(1850, -1);
    expect(xs[3]).toBeCloseTo(2150, -1);
    // Hull-down: harder to hit.
    const shooter = eng.createEntity({ typeId: 'ru-t72b3', force: 2, x: 2000, y: 3000 });
    const w = eng.catalog.weapon('gun-125mm');
    const target = p.memberList[0];
    const hidden = effectivePk(eng, shooter, target, w, 1000);
    target.prepared = undefined;
    expect(hidden).toBeCloseTo(effectivePk(eng, shooter, target, w, 1000) * 0.6, 6);
    // Moving gives it up.
    target.prepared = 'hullDown';
    eng.assignTask(target.id, { type: 'moveTo', target: { x: 1000, y: 1000 } });
    eng.runFor(10);
    expect(target.prepared).toBeUndefined();
  });
});

describe('ambush', () => {
  it('holds fire until the enemy is in the kill zone, then springs together', () => {
    const eng = engine();
    const zone = eng.addGraphic('area', box(1700, 1900, 2300, 2300), 'KZ 1', 2);
    const squad = eng.createUnitFromTemplate('ru-rifle-squad', 2, 2600, 2100, -Math.PI / 2);
    eng.assignTask(squad.id, { type: 'ambush', position: { x: 2600, y: 2100 }, killZoneId: zone.id });
    const log: string[] = [];
    eng.on('event', (ev) => log.push(`${Math.round(ev.time)} ${ev.text}`));
    eng.runFor(150);
    expect(squad.memberList.every((m) => m.roe === 'holdFire' && m.prepared === 'dugIn')).toBe(true);
    // A Blue patrol drives west to east across the zone.
    const jeep = eng.createEntity({ typeId: 'us-hmmwv', force: 1, x: 500, y: 2100, heading: Math.PI / 2 });
    jeep.roe = 'holdFire';
    eng.assignTask(jeep.id, { type: 'moveTo', target: { x: 3500, y: 2100 }, speed: 5 });
    let sprungAt: number | undefined;
    let jeepX = 0;
    for (let t = 0; t < 400 && sprungAt === undefined; t++) {
      eng.runFor(1);
      if (log.some((l) => l.includes('sprang the ambush on KZ 1'))) {
        sprungAt = eng.time;
        jeepX = jeep.x;
      }
    }
    expect(sprungAt).toBeDefined();
    expect(pointInPolygon({ x: jeepX, y: 2100 }, zone.points)).toBe(true);
    expect(squad.memberList.every((m) => m.roe === 'fireAtWill')).toBe(true);
    // Saved mid-ambush, it stays sprung.
    const copy = engine();
    copy.loadScenario(eng.toScenario());
    copy.step();
    expect(copy.units.get(squad.id)!.memberList.every((m) => m.roe === 'fireAtWill')).toBe(true);
  });
});

describe('screen', () => {
  it('watches, then falls back when the enemy closes in', () => {
    const eng = engine();
    const scouts = eng.createUnitFromTemplate('us-scout-section', 1, 2000, 1500);
    eng.assignTask(scouts.id, { type: 'screen', position: { x: 2000, y: 2000 }, facing: 0, breakContact: 1500 });
    eng.runFor(60);
    expect(scouts.memberList.every((m) => m.roe === 'returnFire')).toBe(true);
    const tanks = eng.createUnitFromTemplate('ru-tank-platoon', 2, 2000, 3900, Math.PI);
    for (const m of tanks.memberList) m.roe = 'holdFire';
    eng.assignTask(tanks.id, { type: 'moveTo', target: { x: 2000, y: 2600 } });
    const log: string[] = [];
    eng.on('event', (ev) => log.push(ev.text));
    eng.runFor(300);
    expect(log.some((t) => t.includes('screen falling back'))).toBe(true);
    // 2 km to the rear of the screen line.
    for (const m of scouts.memberList) expect(m.y).toBeLessThan(600);
  });
});

describe('screen without a set break distance', () => {
  it('falls back before the enemy is within its direct-fire reach', () => {
    const eng = engine();
    const scouts = eng.createUnitFromTemplate('us-scout-section', 1, 2000, 300);
    eng.assignTask(scouts.id, { type: 'screen', position: { x: 2000, y: 300 }, facing: 0 });
    // The T-72B3's gun reaches further than the old fixed 1500 m: the screen goes before it is in range.
    const tanks = eng.createUnitFromTemplate('ru-tank-platoon', 2, 2000, 3900, Math.PI);
    for (const m of tanks.memberList) m.roe = 'holdFire';
    eng.assignTask(tanks.id, { type: 'moveTo', target: { x: 2000, y: 1000 } });
    const log: { t: number; d: number; text: string }[] = [];
    eng.on('event', (ev) => {
      if (ev.text.includes('screen falling back')) log.push({ t: ev.time, d: Math.min(...scouts.memberList.flatMap((s) => tanks.memberList.map((t) => Math.hypot(t.x - s.x, t.y - s.y)))), text: ev.text });
    });
    eng.runFor(240);
    expect(log.length).toBeGreaterThan(0);
    const reach = Math.max(...eng.catalog.type('ru-t72b3').weapons.map((w) => eng.catalog.weapon(w)).filter((w) => !w.indirect && w.targets.includes('ground')).map((w) => w.maxRange));
    expect(reach).toBeGreaterThan(2500);
    // It goes as soon as it sees them, well before the old fixed 1500 m.
    expect(log[0].d).toBeGreaterThan(2500);
  });

  it('falls back as soon as it comes under fire', () => {
    const eng = engine();
    const scout = eng.createEntity({ typeId: 'us-hmmwv', force: 1, x: 2000, y: 1000 });
    eng.assignTask(scout.id, { type: 'screen', position: { x: 2000, y: 1000 }, facing: 0 });
    eng.runFor(5);
    scout.underFireUntil = eng.time + 15;
    const enemy = eng.createEntity({ typeId: 'ru-rifleman', force: 2, x: 2000, y: 3900 });
    scout.contacts.set(enemy.id, { id: enemy.id, x: enemy.x, y: enemy.y, time: eng.time } as never);
    eng.runFor(1);
    expect(scout.task?.describe(eng)).toBe('Screen: falling back');
  });
});

describe('overwatch', () => {
  it('takes the position facing the given way and ends after its duration', () => {
    const eng = engine();
    const tank = eng.createEntity({ typeId: 'us-m1a2', force: 1, x: 1000, y: 1000 });
    eng.assignTask(tank.id, { type: 'overwatch', position: { x: 1500, y: 1000 }, facing: 45, duration: 60 });
    eng.runFor(60);
    expect(Math.hypot(tank.x - 1500, tank.y - 1000)).toBeLessThan(10);
    expect((tank.heading * 180) / Math.PI).toBeCloseTo(45, 0);
    expect(tank.task?.status).toBe('running');
    eng.runFor(60);
    expect(tank.task?.status).toBe('done');
  });
});

describe('search', () => {
  it('sweeps tracks covering an area', () => {
    const poly = box(1000, 1000, 3000, 2000);
    const tracks = sweepTracks(poly, 500);
    // Tracks along x (the long side), 2 of them across 1 km, back and forth.
    expect(tracks).toHaveLength(4);
    expect(tracks[0].y).toBe(1250);
    expect(tracks[2].y).toBe(1750);
    expect(tracks[1].x).toBeGreaterThan(tracks[0].x);
    expect(tracks[3].x).toBeLessThan(tracks[2].x);
  });

  it('finds an enemy hiding in the area', () => {
    const eng = engine();
    const area = eng.addGraphic('area', box(500, 500, 3500, 3500), 'NAI 1', 1);
    const jeep = eng.createEntity({ typeId: 'us-hmmwv', force: 1, x: 300, y: 300 });
    jeep.roe = 'holdFire';
    const hider = eng.createEntity({ typeId: 'ru-rifleman', force: 2, x: 3200, y: 3300 });
    hider.roe = 'holdFire';
    const log: string[] = [];
    eng.on('event', (ev) => log.push(ev.text));
    eng.assignTask(jeep.id, { type: 'search', areaId: area.id });
    let found = false;
    for (let t = 0; t < 2000 && jeep.task?.status === 'running'; t += 10) {
      eng.runFor(10);
      found ||= jeep.contacts.has(hider.id);
    }
    expect(found).toBe(true);
    expect(log.some((t) => /finished searching NAI 1: 1 enemy found/.test(t))).toBe(true);
  });
});
