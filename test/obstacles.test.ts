import { describe, expect, it } from 'vitest';
import { Engine } from '../src/sim/engine.js';
import { Terrain } from '../src/sim/terrain.js';

const base = Terrain.generate({ size: 6000, seed: 9, towns: 2 });
const cols = 81;
const flat = new Terrain({ ...base.spec, size: 4000, cellSize: 50, seed: 4242 }, new Float32Array(cols * cols).fill(20), new Uint8Array(cols * cols), [], []);

function engine(): Engine {
  const e = new Engine({ terrain: flat });
  e.newScenario('obstacles', flat.spec);
  return e;
}

const crossesY = (path: { x: number; y: number }[], y: number, x0: number, x1: number) =>
  path.some((p, i) => i > 0 && (path[i - 1].y - y) * (p.y - y) <= 0 && Math.min(p.x, path[i - 1].x) < x1 && Math.max(p.x, path[i - 1].x) > x0);

describe('obstacles', () => {
  it('vehicles route round an obstacle line through its gap, and are stopped by it', () => {
    const eng = engine();
    // An anti-tank ditch across the map at y = 2000, with a gap at the east end.
    eng.addGraphic('obstacle', [{ x: 0, y: 2000 }, { x: 3300, y: 2000 }], 'AT ditch', 2);
    const tank = eng.createEntity({ typeId: 'us-m1a2', force: 1, x: 1000, y: 1000 });
    const route = eng.planRoute(tank, { x: 1000, y: 3000 }, 'ground', tank.type.offroadFactor, 1)!;
    expect(route).not.toBeNull();
    expect(crossesY([{ x: 1000, y: 1000 }, ...route], 2000, 0, 3300)).toBe(false);
    eng.assignTask(tank.id, { type: 'moveTo', target: { x: 1000, y: 3000 } });
    eng.runFor(600);
    expect(Math.hypot(tank.x - 1000, tank.y - 3000)).toBeLessThan(20);
    // Driving straight at it, a tank stops at the ditch.
    const other = eng.createEntity({ typeId: 'us-m1a2', force: 1, x: 500, y: 1900 });
    other.steer = { x: 500, y: 2300, speed: 10, arrive: false };
    for (let i = 0; i < 100; i++) {
      other.steer = { x: 500, y: 2300, speed: 10, arrive: false };
      eng.step();
    }
    expect(other.y).toBeLessThan(2000);
    // Infantry climb through.
    const man = eng.createEntity({ typeId: 'us-rifleman', force: 1, x: 700, y: 1990 });
    eng.assignTask(man.id, { type: 'moveTo', target: { x: 700, y: 2100 } });
    eng.runFor(200);
    expect(man.y).toBeGreaterThan(2050);
  });

  it('engineers breach a lane that vehicles then use', () => {
    const eng = engine();
    const ditch = eng.addGraphic('obstacle', [{ x: 0, y: 2000 }, { x: 4000, y: 2000 }], 'AT ditch', 2);
    const tank = eng.createEntity({ typeId: 'us-m1a2', force: 1, x: 1000, y: 1000 });
    expect(eng.planRoute(tank, { x: 1000, y: 3000 }, 'ground', tank.type.offroadFactor, 1)).toBeNull();
    const abv = eng.createEntity({ typeId: 'us-m1150', force: 1, x: 1000, y: 1500 });
    const log: string[] = [];
    eng.on('event', (ev) => log.push(ev.text));
    eng.assignTask(abv.id, { type: 'breach', graphicId: ditch.id });
    eng.runFor(200);
    expect(log.some((t) => t.includes('breached a lane through AT ditch'))).toBe(true);
    expect(ditch.lanes).toHaveLength(1);
    const route = eng.planRoute(tank, { x: 1000, y: 3000 }, 'ground', tank.type.offroadFactor, 1);
    expect(route).not.toBeNull();
    eng.assignTask(tank.id, { type: 'moveTo', target: { x: 1000, y: 3000 } });
    eng.runFor(400);
    expect(tank.y).toBeGreaterThan(2900);
    // Only engineers can breach.
    eng.assignTask(tank.id, { type: 'breach', graphicId: ditch.id });
    eng.runFor(1);
    expect(tank.task?.message).toBe('not an engineer');
  });

  it('a whole platoon goes through the lane, followers included', () => {
    const eng = engine();
    const ditch = eng.addGraphic('obstacle', [{ x: 0, y: 2000 }, { x: 4000, y: 2000 }], 'AT ditch', 2);
    ditch.lanes = [{ from: { x: 2000, y: 1985 }, to: { x: 2000, y: 2015 } }];
    eng.obstacles.changed();
    const p = eng.createUnitFromTemplate('us-tank-platoon', 1, 1500, 1000);
    eng.assignTask(p.id, { type: 'moveTo', target: { x: 1500, y: 3000 } });
    eng.runFor(900);
    for (const m of p.memberList) expect(m.y).toBeGreaterThan(2400);
  });

  it('minefield state survives undo checkpoints and reloads', () => {
    const eng = engine();
    const mf = eng.addGraphic('minefield', [{ x: 1500, y: 1800 }, { x: 2500, y: 1800 }, { x: 2500, y: 2200 }], 'MF 1', 2);
    mf.density = 1.2;
    mf.knownBy = [1];
    mf.lanes = [{ from: { x: 2000, y: 1790 }, to: { x: 2000, y: 2210 } }];
    const saved = eng.toScenario();
    mf.lanes.push({ from: { x: 1600, y: 1790 }, to: { x: 1600, y: 2210 } });
    expect(saved.graphics[0].lanes).toHaveLength(1); // a copy, not the live object
    eng.loadScenario(saved);
    expect(eng.graphics.get(mf.id)).toMatchObject({ density: 1.2, knownBy: [1], lanes: [{ from: { x: 2000, y: 1790 }, to: { x: 2000, y: 2210 } }] });
  });
});

describe('minefields', () => {
  it('an unknown minefield damages vehicles crossing it; once found it is avoided', () => {
    const eng = engine();
    const mf = eng.addGraphic('minefield', [{ x: 1500, y: 1800 }, { x: 2500, y: 1800 }, { x: 2500, y: 2200 }, { x: 1500, y: 2200 }], 'MF 1', 2);
    mf.density = 1.5;
    const tanks = eng.createUnitFromTemplate('us-tank-platoon', 1, 2000, 1000);
    const log: string[] = [];
    eng.on('event', (ev) => log.push(ev.text));
    // Blue does not know the field is there: the route goes straight through.
    eng.assignTask(tanks.id, { type: 'moveTo', target: { x: 2000, y: 3000 } });
    eng.runFor(300);
    expect(log.some((t) => t.includes('struck a mine in MF 1'))).toBe(true);
    expect(mf.knownBy).toContain(1);
    expect(tanks.memberList.some((m) => m.mobilityKill || m.destroyed)).toBe(true);
    // Now known, new routes go round it.
    const route = eng.planRoute({ x: 2000, y: 1000 }, { x: 2000, y: 3000 }, 'ground', 0.7, 1)!;
    const inside = (p: { x: number; y: number }) => p.x > 1500 && p.x < 2500 && p.y > 1800 && p.y < 2200;
    expect(route.some(inside)).toBe(false);
    // Its own side always knew.
    expect(eng.planRoute({ x: 2000, y: 1000 }, { x: 2000, y: 3000 }, 'ground', 0.7, 2)!.some(inside)).toBe(false);
  });

  it('once found, the rest of a moving unit goes round it, and engineers sent to breach it know it', () => {
    const eng = engine();
    const mf = eng.addGraphic('minefield', [{ x: 1000, y: 1800 }, { x: 3000, y: 1800 }, { x: 3000, y: 2200 }, { x: 1000, y: 2200 }], 'MF 1', 2);
    mf.density = 3;
    const tanks = eng.createUnitFromTemplate('us-tank-platoon', 1, 2000, 1000);
    eng.assignTask(tanks.id, { type: 'moveTo', target: { x: 2000, y: 3000 } });
    const strikes: number[] = [];
    eng.on('event', (ev) => /struck a mine/.test(ev.text) && strikes.push(ev.time));
    eng.runFor(600);
    expect(strikes.length).toBeGreaterThan(0);
    // The first strike reveals it: those already in the field may hit more getting out,
    // but the rest route round it instead of driving on through.
    expect(strikes.filter((t) => t > strikes[0] + 20)).toEqual([]);
    const sappers = engine();
    const field = sappers.addGraphic('minefield', [{ x: 1000, y: 1800 }, { x: 3000, y: 1800 }, { x: 3000, y: 2200 }], 'MF 2', 2);
    const abv = sappers.createEntity({ typeId: 'us-m1150', force: 1, x: 2000, y: 1500 });
    sappers.assignTask(abv.id, { type: 'breach', graphicId: field.id });
    sappers.step();
    expect(field.knownBy).toContain(1);
  });
});

describe('smoke', () => {
  it('blocks sight but not radar, and disperses', () => {
    const eng = engine();
    const a = { x: 1000, y: 2000, z: 22 };
    const b = { x: 3000, y: 2000, z: 22 };
    expect(eng.lineOfSight(a, b)).toBe(true);
    eng.smoke.add({ x: 2000, y: 2000 }, 50, 60);
    expect(eng.lineOfSight(a, b)).toBe(false);
    expect(eng.lineOfSight(a, b, true)).toBe(true);
    // Grazing the edge is not enough.
    expect(eng.lineOfSight({ ...a, y: 2049 }, { ...b, y: 2049 })).toBe(true);
    eng.runFor(61);
    expect(eng.smoke.clouds).toHaveLength(0);
    expect(eng.lineOfSight(a, b)).toBe(true);
  });

  it('smoke missions screen a target, and tanks pop smoke at incoming missiles', () => {
    const eng = engine();
    const guns = eng.createEntity({ typeId: 'us-m109a7', force: 1, x: 2000, y: 200 });
    eng.assignTask(guns.id, { type: 'fireMission', target: { x: 2000, y: 3000 }, rounds: 2, smoke: true });
    eng.runFor(60);
    expect(eng.smoke.clouds.length).toBeGreaterThan(0);
    expect(eng.smoke.clouds[0].radius).toBe(75);
    // Mortars without smoke can't; howitzers can.
    const tank = eng.createEntity({ typeId: 'ru-t72b3', force: 2, x: 1000, y: 3500 });
    const bmp = eng.createEntity({ typeId: 'us-m2a3', force: 1, x: 1000, y: 1500 });
    bmp.roe = 'holdFire';
    eng.launch({ eventNumber: 1, shooterId: bmp.id, targetId: tank.id, weapon: eng.catalog.weapon('atgm-tow'), from: bmp.eye, to: tank.position, fireTime: eng.time, impactTime: eng.time + 10, range: 2000 });
    expect(tank.smokeLeft).toBe(1);
    const copy = engine();
    copy.loadScenario(eng.toScenario());
    expect(copy.smoke.clouds.length).toBe(eng.smoke.clouds.length);
    expect(copy.entities.get(tank.id)!.smokeLeft).toBe(1);
  });
});
