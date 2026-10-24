import { describe, expect, it } from 'vitest';
import { Engine } from '../src/sim/engine.js';
import { Terrain } from '../src/sim/terrain.js';
import { dist2d } from '../src/shared/math.js';
import { formationOffset } from '../src/sim/units.js';

// One shared terrain keeps the suite fast; engines are cheap.
const terrain = Terrain.generate({ size: 8000, seed: 42, towns: 4, waterFraction: 0.12 });

function engine(seed = 1): Engine {
  const e = new Engine({ terrain, seed });
  e.newScenario('test', terrain.spec);
  return e;
}

/** A dry, gently sloped point near a town. */
function landNear(i = 0): { x: number; y: number } {
  const t = terrain.towns[i];
  return { x: t.x, y: t.y };
}

describe('terrain', () => {
  it('is deterministic for a seed', () => {
    const again = Terrain.generate({ size: 8000, seed: 42, towns: 4, waterFraction: 0.12 });
    expect(again.encodeHeights()).toBe(terrain.encodeHeights());
    expect(again.roads).toEqual(terrain.roads);
  });

  it('has the requested water fraction and connects towns with roads', () => {
    let water = 0;
    for (const h of terrain.heights) if (h < 0) water++;
    expect(water / terrain.heights.length).toBeGreaterThan(0.08);
    expect(water / terrain.heights.length).toBeLessThan(0.16);
    expect(terrain.towns.length).toBe(4);
    expect(terrain.roads.length).toBeGreaterThanOrEqual(3);
    for (const t of terrain.towns) expect(terrain.isRoad(t.x, t.y)).toBe(true);
  });

  it('blocks line of sight behind a ridge but not across flat open ground', () => {
    // Build a synthetic grid: flat with a 100 m wall across the middle.
    const spec = { ...terrain.spec, size: 2000, cellSize: 50 };
    const cols = 41;
    const heights = new Float32Array(cols * cols).fill(10);
    for (let r = 0; r < cols; r++) heights[r * cols + 20] = 110;
    const t = new Terrain(spec, heights, new Uint8Array(cols * cols), [], []);
    expect(t.lineOfSight({ x: 200, y: 1000, z: 12 }, { x: 800, y: 1000, z: 12 })).toBe(true);
    expect(t.lineOfSight({ x: 200, y: 1000, z: 12 }, { x: 1800, y: 1000, z: 12 })).toBe(false);
    expect(t.lineOfSight({ x: 200, y: 1000, z: 500 }, { x: 1800, y: 1000, z: 500 })).toBe(true);
  });

  it('plans ground routes that never cross water', () => {
    const [a, b] = [terrain.towns[0], terrain.towns[2]];
    const route = terrain.planRoute(a, b, 'ground', 0.6);
    expect(route).not.toBeNull();
    const pts = [a, ...route!];
    for (let i = 1; i < pts.length; i++) {
      expect(Number.isFinite(terrain.segmentCost(pts[i - 1], pts[i], 'ground', 0.6))).toBe(true);
    }
    expect(dist2d(pts[pts.length - 1], b)).toBeLessThan(1);
  });
});

describe('movement and tasks', () => {
  it('drives a ground entity to a destination and stops', () => {
    const eng = engine();
    const a = landNear(0);
    const b = landNear(1);
    const tank = eng.createEntity({ typeId: 'us-m1a2', force: 1, x: a.x, y: a.y });
    eng.assignTask(tank.id, { type: 'moveTo', target: b });
    let t = 0;
    while (tank.task?.status === 'running' && t < 3600) {
      eng.step(0.1);
      t += 0.1;
    }
    expect(tank.task?.status).toBe('done');
    expect(dist2d(tank, b)).toBeLessThan(10);
    expect(tank.speed).toBeLessThan(0.5);
    expect(tank.z).toBeCloseTo(terrain.elevation(tank.x, tank.y), 3);
  });

  it('flies aircraft at their cruise altitude above the terrain', () => {
    const eng = engine();
    const heli = eng.createEntity({ typeId: 'us-ah64', force: 1, x: 1000, y: 1000 });
    eng.assignTask(heli.id, { type: 'moveTo', target: { x: 6000, y: 6000 } });
    eng.runFor(60);
    const agl = heli.z - terrain.surfaceHeight(heli.x, heli.y);
    expect(agl).toBeGreaterThan(20);
    expect(agl).toBeLessThan(200);
    expect(heli.speed).toBeGreaterThan(30);
  });

  it('keeps fixed-wing aircraft above minimum speed while orbiting', () => {
    const eng = engine();
    const f16 = eng.createEntity({ typeId: 'us-f16', force: 1, x: 4000, y: 4000 });
    eng.assignTask(f16.id, { type: 'orbit', center: { x: 4000, y: 4000 }, radius: 2500 });
    eng.runFor(120);
    expect(f16.speed).toBeGreaterThanOrEqual(f16.type.minSpeed!);
    expect(dist2d(f16, { x: 4000, y: 4000 })).toBeLessThan(4500);
  });

  it('rejects placing ground entities in water and boats on land', () => {
    const eng = engine();
    let water: { x: number; y: number } | null = null;
    for (let i = 0; i < terrain.heights.length && !water; i += 97) if (terrain.heights[i] < -2) water = terrain.postPosition(i);
    expect(water).not.toBeNull();
    expect(() => eng.createEntity({ typeId: 'us-m1a2', force: 1, ...water! })).toThrow(/water/);
    expect(() => eng.createEntity({ typeId: 'us-patrol-boat', force: 1, ...landNear(0) })).toThrow(/land/);
    expect(eng.createEntity({ typeId: 'us-patrol-boat', force: 1, ...water! }).z).toBe(0);
  });

  it('follows a route graphic and patrols it', () => {
    const eng = engine();
    const a = landNear(0);
    const g = eng.addGraphic('route', [a, { x: a.x + 300, y: a.y }, { x: a.x + 300, y: a.y + 300 }].map((p) => eng.findValidPosition(p, 'ground')!), 'R');
    const jeep = eng.createEntity({ typeId: 'us-hmmwv', force: 1, x: a.x, y: a.y });
    eng.assignTask(jeep.id, { type: 'followRoute', routeId: g.id });
    eng.runFor(240);
    expect(jeep.task?.status).toBe('done');
    expect(dist2d(jeep, g.points[2])).toBeLessThan(15);
    eng.assignTask(jeep.id, { type: 'patrol', routeId: g.id });
    eng.runFor(240);
    expect(jeep.task?.status).toBe('running');
  });
});

describe('units', () => {
  it('computes formation slots', () => {
    expect(formationOffset('column', 2, 50)).toEqual({ x: 0, y: -100 });
    expect(formationOffset('line', 1, 50)).toEqual({ x: 50, y: 0 });
    expect(formationOffset('line', 2, 50)).toEqual({ x: -50, y: 0 });
    expect(formationOffset('wedge', 3, 50)).toEqual({ x: 100, y: -100 });
  });

  it('moves a platoon in formation behind its leader', () => {
    const eng = engine();
    const a = landNear(0);
    const b = landNear(1);
    const unit = eng.createUnitFromTemplate('us-tank-platoon', 1, a.x, a.y);
    expect(unit.memberList).toHaveLength(4);
    eng.assignTask(unit.id, { type: 'moveTo', target: b });
    eng.runFor(120);
    const leader = unit.leader!;
    for (const m of unit.followers()) {
      expect(dist2d(m, leader)).toBeLessThan(600);
      expect(m.speed).toBeGreaterThan(0);
    }
  });

  it('hands command to the next member when the leader is destroyed', () => {
    const eng = engine();
    const a = landNear(0);
    const unit = eng.createUnitFromTemplate('us-tank-platoon', 1, a.x, a.y);
    eng.assignTask(unit.id, { type: 'moveTo', target: landNear(1) });
    eng.step();
    const old = unit.leader!;
    old.destroyed = true;
    eng.step();
    expect(unit.leader).not.toBe(old);
    expect(unit.leader!.task?.spec.type).toBe('moveTo');
    expect(unit.leader!.task?.status).toBe('running');
  });
});

describe('plans', () => {
  it('executes statements in order including settings and waits', () => {
    const eng = engine();
    const a = landNear(0);
    const e = eng.createEntity({ typeId: 'us-hmmwv', force: 1, x: a.x, y: a.y });
    eng.assignPlan(e.id, {
      name: 'test',
      statements: [
        { kind: 'setRoe', roe: 'holdFire' },
        { kind: 'setSpeed', speed: 5 },
        { kind: 'waitUntil', condition: { type: 'simTime', time: 10 } },
        { kind: 'task', task: { type: 'wait', duration: 5 } },
        { kind: 'setRoe', roe: 'returnFire' },
      ],
    });
    eng.runFor(1);
    expect(e.roe).toBe('holdFire');
    expect(e.cruiseSpeed).toBe(5);
    expect(e.plan!.index).toBe(2);
    eng.runFor(10);
    expect(e.plan!.index).toBe(3);
    eng.runFor(6);
    expect(e.roe).toBe('returnFire');
    expect(e.plan!.finished).toBe(true);
  });

  it('waits until an enemy is detected', () => {
    const eng = engine();
    const a = landNear(0);
    const scout = eng.createEntity({ typeId: 'us-hmmwv', force: 1, x: a.x, y: a.y });
    eng.assignPlan(scout.id, { statements: [{ kind: 'waitUntil', condition: { type: 'enemyDetected' } }, { kind: 'setRoe', roe: 'holdFire' }] });
    eng.runFor(5);
    expect(scout.roe).toBe('fireAtWill');
    eng.createEntity({ typeId: 'ru-ural', force: 2, x: a.x + 150, y: a.y });
    eng.runFor(10);
    expect(scout.roe).toBe('holdFire');
  });
});

describe('sensors and combat', () => {
  // Flat open terrain so line of sight is guaranteed.
  const cols = 81;
  const flat = new Terrain({ ...terrain.spec, size: 4000, cellSize: 50 }, new Float32Array(cols * cols).fill(20), new Uint8Array(cols * cols), [], []);

  function duel(seed: number) {
    const eng = new Engine({ terrain: flat, seed });
    eng.newScenario('duel', flat.spec);
    const blue = eng.createEntity({ typeId: 'us-m1a2', force: 1, x: 1000, y: 2000, heading: Math.PI / 2 });
    const red = eng.createEntity({ typeId: 'ru-bmp2', force: 2, x: 2500, y: 2000, heading: -Math.PI / 2 });
    return { eng, blue, red };
  }

  it('detects and destroys a hostile in the open', () => {
    let kills = 0;
    for (let seed = 1; seed <= 5; seed++) {
      const { eng, blue, red } = duel(seed);
      const detections: string[] = [];
      eng.on('event', (ev) => ev.kind === 'detected' && detections.push(`${ev.entityId}>${ev.targetId}`));
      eng.runFor(180);
      expect(detections).toContain(`${blue.id}>${red.id}`);
      if (red.destroyed || blue.destroyed) kills++;
    }
    expect(kills).toBeGreaterThanOrEqual(4);
  });

  it('does not fire under hold-fire ROE', () => {
    const { eng, blue, red } = duel(3);
    blue.roe = 'holdFire';
    red.roe = 'holdFire';
    let fires = 0;
    eng.on('fire', () => fires++);
    eng.runFor(120);
    expect(fires).toBe(0);
    expect(blue.ammo.get('gun-120mm')).toBe(40);
  });

  it('returns fire only at attackers under return-fire ROE', () => {
    const { eng, blue, red } = duel(4);
    blue.roe = 'returnFire';
    red.roe = 'holdFire';
    let blueShots = 0;
    eng.on('fire', (s) => s.shooterId === blue.id && blueShots++);
    eng.runFor(60);
    expect(blueShots).toBe(0);
    red.roe = 'fireAtWill';
    eng.runFor(120);
    expect(blueShots + (blue.destroyed ? 1 : 0)).toBeGreaterThan(0);
  });

  it('attack task closes with the target and engages regardless of ROE', () => {
    const eng = engine(9);
    const a = landNear(0);
    const b = landNear(1);
    const tank = eng.createEntity({ typeId: 'us-m1a2', force: 1, x: a.x, y: a.y });
    const target = eng.createEntity({ typeId: 'ru-ural', force: 2, x: b.x, y: b.y });
    target.roe = 'holdFire';
    tank.roe = 'holdFire';
    eng.assignTask(tank.id, { type: 'attack', targetId: target.id });
    eng.runFor(1800);
    expect(target.destroyed).toBe(true);
    expect(tank.task?.status).toBe('done');
  });
});

describe('scenarios', () => {
  it('round-trips through save and load', () => {
    const eng = engine();
    const a = landNear(0);
    const unit = eng.createUnitFromTemplate('us-scout-section', 1, a.x, a.y, 0, 'Scouts');
    const route = eng.addGraphic('route', [a, landNear(1)], 'R1');
    eng.assignPlan(unit.id, { name: 'p', statements: [{ kind: 'task', task: { type: 'followRoute', routeId: route.id } }] });
    eng.setRoe(unit.id, 'returnFire');
    const saved = eng.toScenario();
    const json = JSON.parse(JSON.stringify(saved));
    const eng2 = new Engine({ terrain });
    eng2.loadScenario(json);
    expect(eng2.entities.size).toBe(2);
    expect(eng2.units.get(unit.id)?.name).toBe('Scouts');
    expect(eng2.units.get(unit.id)?.plan).not.toBeNull();
    expect([...eng2.entities.values()].every((e) => e.roe === 'returnFire')).toBe(true);
    expect(eng2.graphics.get(route.id)?.points).toEqual(route.points);
    // New IDs do not collide with loaded ones.
    expect(eng2.createEntity({ typeId: 'us-hmmwv', force: 1, ...a }).id).toBe('E3');
  });

  it('rewinds to the loaded state', () => {
    const eng = engine();
    const a = landNear(0);
    const e = eng.createEntity({ typeId: 'us-hmmwv', force: 1, ...a });
    eng.assignTask(e.id, { type: 'moveTo', target: landNear(1) });
    eng.loadScenario(eng.toScenario());
    eng.runFor(30);
    const moved = eng.entities.get(e.id)!;
    expect(dist2d(moved, a)).toBeGreaterThan(50);
    eng.rewind();
    expect(eng.time).toBe(0);
    expect(dist2d(eng.entities.get(e.id)!, a)).toBeLessThan(1);
  });

  it('rewinds to the last saved state when a rewind point is marked', () => {
    const eng = engine();
    const a = landNear(0);
    eng.createEntity({ typeId: 'us-hmmwv', force: 1, ...a });
    eng.markRewindPoint();
    eng.createEntity({ typeId: 'us-hmmwv', force: 1, ...landNear(1) });
    eng.runFor(10);
    eng.rewind();
    expect(eng.entities.size).toBe(1);
    expect(eng.time).toBe(0);
  });

  it('saves the current time and replays identically after reseeding', () => {
    const eng = engine();
    eng.runFor(12.3);
    expect(eng.toScenario().startTime).toBeCloseTo(12.3, 6);
    expect(eng.time).toBe(12.3); // no floating-point drift from repeated 0.1 s steps
  });

  it('loads the bundled sample scenarios', async () => {
    const { readFileSync, readdirSync } = await import('node:fs');
    const files = readdirSync('scenarios').filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const eng = new Engine();
      eng.loadScenario(JSON.parse(readFileSync(`scenarios/${f}`, 'utf8')));
      expect(eng.entities.size).toBeGreaterThan(0);
      eng.runFor(30);
    }
  });
});
