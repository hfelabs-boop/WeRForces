import { describe, expect, it } from 'vitest';
import type { Detonation } from '../src/sim/combat.js';
import { Engine } from '../src/sim/engine.js';
import { explainEntity } from '../src/sim/explain.js';
import { sizeFactor } from '../src/sim/sensors.js';
import { Terrain } from '../src/sim/terrain.js';
import { SwarmAttackTask } from '../src/sim/unmannedTasks.js';
import { ApiV1 } from '../src/server/apiV1.js';
import { executeCommand } from '../src/server/commands.js';
import { checkCommand, filterState } from '../src/server/fog.js';
import { SimRunner } from '../src/server/runner.js';
import { createMcpServer } from '../src/mcp/tools.js';
import { generateBattle } from '../src/sim/wizard.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const base = Terrain.generate({ size: 6000, seed: 9, towns: 2 });
const cols = 241;
const flat = new Terrain({ ...base.spec, size: 12000, cellSize: 50, seed: 4242 }, new Float32Array(cols * cols).fill(20), new Uint8Array(cols * cols), [], []);

function engine(seed?: number, terrain = flat): Engine {
  const e = new Engine({ terrain });
  e.newScenario('unmanned', terrain.spec);
  if (seed !== undefined) e.reseed(seed);
  return e;
}

/** A counter-drone jammer for tests (the catalog's jammers do radios and radars). */
function withDroneJammer(eng: Engine, range = 3000): void {
  eng.setCustomCatalog({ entityTypes: [{ ...eng.catalog.type('ru-r330zh'), id: 'test-cuas', name: 'Drone jammer', jammer: { range, datalink: true } }] });
}

describe('unmanned systems: datalink', () => {
  it('loses the link out of radio range: it turns for home, and cannot be flown further out', () => {
    const eng = engine();
    const team = eng.createUnitFromTemplate('us-uas-team', 1, 2000, 1000);
    const op = [...eng.entities.values()].find((e) => e.type.groundControl)!;
    const quad = team.leader!;
    expect(quad.uxs!.controllerId).toBe(op.id);
    eng.runFor(1);
    expect(quad.uxs!.up).toBe(true);
    expect(eng.snapshot().entities.find((e) => e.id === quad.id)!.link).toMatchObject({ mode: 'rf', up: true, controllerId: op.id, hops: 1, autonomy: 'remote', lostLink: 'return' });
    eng.assignTask(team.id, { type: 'moveTo', target: { x: 2000, y: 11500 } });
    let lostAt: { x: number; y: number } | undefined;
    for (let t = 0; t < 1200 && !lostAt; t++) {
      eng.runFor(1);
      if (!quad.uxs!.up) lostAt = { x: quad.x, y: quad.y };
    }
    expect(lostAt).toBeDefined();
    expect(quad.uxs!.reason).toBe('range');
    // 8 km from its operator (at 80 m height).
    expect(Math.hypot(lostAt!.x - op.x, lostAt!.y - op.y)).toBeGreaterThan(7900);
    expect(eng.eventsSince(0).some((e) => /lost the datalink \(out of radio range/.test(e.text))).toBe(true);
    expect(eng.alerts.open().find((a) => a.kind === 'linkLost')?.objectId).toBe(team.id);
    expect(explainEntity(eng, quad, { omniscient: true }).movement.find((f) => f.code === 'linkLost')?.text).toMatch(/returns to its operator/);
    // Lost-link behaviour "return": it heads back until it links up again, carries on with its
    // move, and so stays at the edge of its radio range.
    let furthest = 0;
    for (let t = 0; t < 120; t++) {
      eng.runFor(1);
      furthest = Math.max(furthest, quad.y);
    }
    expect(furthest).toBeLessThan(lostAt!.y + 100);
    expect(eng.eventsSince(0).some((e) => e.entityId === team.id && /datalink back/.test(e.text))).toBe(true);
    expect(quad.task?.spec.type).toBe('moveTo');
  });

  it('each lost-link behaviour: hover, land, continue, return; autonomy keeps tasks going', () => {
    const eng = engine();
    withDroneJammer(eng, 3000);
    const op = eng.createEntity({ typeId: 'us-uas-operator', force: 1, x: 2000, y: 1000 });
    const mk = (lostLink: 'hover' | 'land' | 'continue' | 'return', x: number, autonomy?: 'remote' | 'supervised' | 'autonomous') => {
      const q = eng.createEntity({ typeId: 'us-quadcopter', force: 1, x, y: 1500 });
      eng.unmanned.setControl(q, { controllerId: op.id, lostLink, autonomy });
      eng.assignTask(q.id, { type: 'moveTo', target: { x, y: 9000 } });
      return q;
    };
    const hover = mk('hover', 1000);
    const land = mk('land', 1500);
    const cont = mk('continue', 2000);
    const ret = mk('return', 2500);
    const auto = mk('hover', 3000, 'autonomous');
    // The jammer sits across their path, 5 km out.
    eng.createEntity({ typeId: 'test-cuas', force: 2, x: 2000, y: 7000 });
    eng.runFor(360);
    for (const q of [hover, land, cont, ret, auto]) expect(eng.eventsSince(0).some((e) => e.entityId === q.id && /datalink lost \(jammed by Drone jammer/.test(e.text))).toBe(true);
    const y = { hover: hover.y, ret: ret.y };
    eng.runFor(60);
    // Hover: holds where the link went (still in the jamming).
    expect(Math.abs(hover.y - y.hover)).toBeLessThan(20);
    expect(hover.uxs!.up).toBe(false);
    // Land: on the ground.
    expect(land.z - eng.terrain.surfaceHeight(land.x, land.y)).toBeLessThan(2);
    // Continue: flies on with its task, blind, into the jamming.
    expect(cont.y).toBeGreaterThan(hover.y + 500);
    // Return: back out of the jammer's reach, linked again, and so it turns back to its task.
    expect(eng.eventsSince(0).some((e) => e.entityId === ret.id && /datalink back/.test(e.text))).toBe(true);
    // Autonomous: carries on with its move whatever the link.
    expect(auto.y).toBeGreaterThan(hover.y + 500);
    // A remote drone without its link sees nothing and does not fire.
    expect(eng.unmanned.sees(hover)).toBe(false);
    expect(eng.unmanned.fireMode(hover)).toBe('none');
    expect(eng.unmanned.fireMode(auto)).toBe('free');
    // Orders to it wait for the link.
    eng.issueOrder(hover.id, { task: { type: 'moveTo', target: { x: 1000, y: 1500 } } });
    expect(eng.pendingOrders.find((o) => o.targetId === hover.id)?.waitLink).toBe(true);
    eng.runFor(5);
    expect(eng.pendingOrders.some((o) => o.targetId === hover.id)).toBe(true);
  });

  it('a fibre-optic drone ignores jamming but cannot fly past its cable', () => {
    const eng = engine();
    withDroneJammer(eng, 6000);
    const team = eng.createUnitFromTemplate('ru-fpv-fiber-team', 2, 6000, 500);
    const rf = eng.createUnitFromTemplate('ru-fpv-team', 2, 7000, 500);
    eng.createEntity({ typeId: 'test-cuas', force: 1, x: 6500, y: 4000 });
    eng.runFor(2);
    expect(team.leader!.uxs!.up).toBe(true);
    expect(rf.leader!.uxs!.up).toBe(false);
    expect(rf.leader!.uxs!.reason).toBe('jammed');
    eng.assignTask(team.leader!.id, { type: 'moveTo', target: { x: 6000, y: 11800 } });
    eng.runFor(700);
    const lead = team.memberList[0];
    expect(lead.uxs!.up).toBe(false);
    expect(lead.uxs!.reason).toBe('tether');
    expect(lead.uxs!.tetherCut).toBe(true);
    expect(lead.y).toBeLessThan(11000);
    expect(eng.eventsSince(0).some((e) => /fibre-optic cable ran out/.test(e.text))).toBe(true);
  });

  it('relays through a mesh of own drones, and loses it when the relays go', () => {
    const eng = engine();
    const op = eng.createEntity({ typeId: 'us-uas-operator', force: 1, x: 1000, y: 1000 });
    // Swarm drones reach 3 km each: the far one is 7.5 km out.
    const relays = [2500, 5000].map((d) => eng.createEntity({ typeId: 'us-swarm-drone', force: 1, x: 1000, y: 1000 + d }));
    const far = eng.createEntity({ typeId: 'us-swarm-drone', force: 1, x: 1000, y: 8500 });
    eng.runFor(1);
    expect(far.uxs!.up).toBe(true);
    expect(far.uxs!.hops).toBe(3);
    expect(far.uxs!.rootId).toBe(op.id);
    expect(explainEntity(eng, far, { omniscient: true }).movement.find((f) => f.code === 'datalink')?.text).toMatch(/through 2 relaying drones/);
    relays[1].destroyed = true;
    eng.runFor(1);
    expect(far.uxs!.up).toBe(false);
    expect(far.uxs!.reason).toBe('range');
    // An autonomous swarm drone carries on by itself.
    expect(explainEntity(eng, far, { omniscient: true }).movement.find((f) => f.code === 'linkLost')?.text).toMatch(/carries on by itself/);
  });

  it('needs an operator: none, or the one it had killed', () => {
    const eng = engine();
    const q = eng.createEntity({ typeId: 'ru-quadcopter', force: 2, x: 3000, y: 3000 });
    eng.runFor(1);
    expect(q.uxs!.reason).toBe('noController');
    const op = eng.createEntity({ typeId: 'ru-uas-operator', force: 2, x: 3000, y: 2500 });
    eng.runFor(1);
    expect(q.uxs!.up).toBe(true);
    eng.unmanned.setControl(q, { controllerId: op.id });
    op.destroyed = true;
    eng.runFor(1);
    expect(q.uxs!.reason).toBe('controllerLost');
  });

  it('the MQ-9 flies on a satellite link: no ground station needed, jammable only close in', () => {
    const eng = engine();
    withDroneJammer(eng, 5000);
    const mq9 = eng.createEntity({ typeId: 'us-mq9', force: 1, x: 2000, y: 2000 });
    eng.runFor(1);
    expect(mq9.uxs!.up).toBe(true);
    // Anti-jam 0.8: a 5 km jammer has to be within 1 km.
    eng.createEntity({ typeId: 'test-cuas', force: 2, x: 2000, y: 4000 });
    eng.runFor(1);
    expect(mq9.uxs!.up).toBe(true);
  });
});

describe('unmanned systems: one-way attack', () => {
  /** Kill rates of drones striking an M1A2 head-on, over many runs. */
  function strikes(type: string, n: number): { kills: number; aspects: string[] } {
    let kills = 0;
    const aspects: string[] = [];
    for (let i = 0; i < n; i++) {
      const eng = engine(100 + i);
      const force = type.startsWith('ru') ? 2 : 1;
      eng.createEntity({ typeId: force === 2 ? 'ru-uas-operator' : 'us-uas-operator', force, x: 6000, y: 1000 });
      const drone = eng.createEntity({ typeId: type, force, x: 6000, y: 1200 });
      // The tank faces the drone and holds fire.
      const tank = eng.createEntity({ typeId: 'us-m1a2', force: force === 1 ? 2 : 1, x: 6000, y: 5000, heading: Math.PI });
      tank.roe = 'holdFire';
      eng.assignTask(drone.id, { type: 'strike', targetId: tank.id });
      const dets: Detonation[] = [];
      eng.on('detonation', (d) => dets.push(d));
      eng.runFor(250);
      expect(dets).toHaveLength(1);
      expect(drone.uxs!.expended).toBe(true);
      if (dets[0].aspect) aspects.push(dets[0].aspect);
      if (tank.destroyed) kills++;
    }
    return { kills, aspects };
  }

  it('flies into the target and its warhead meets the armour of the face it strikes; loitering munitions attack the top', () => {
    const fpv = strikes('ru-fpv', 30);
    // Front armour (700 mm) against a 500 mm RPG-type warhead: rarely through.
    expect(new Set(fpv.aspects)).toEqual(new Set(['front']));
    expect(fpv.kills).toBeLessThan(8);
    const lm = strikes('us-switchblade600', 30);
    expect(new Set(lm.aspects)).toEqual(new Set(['top']));
    // A 750 mm top-attack warhead on 60 mm of roof.
    expect(lm.kills).toBeGreaterThan(16);
  });

  it('active protection fires at a drone diving in, but Trophy does not cover the roof against top attack', () => {
    const run = (type: string, n: number) => {
      let intercepted = 0;
      for (let i = 0; i < n; i++) {
        const eng = engine(300 + i);
        eng.createEntity({ typeId: 'us-uas-operator', force: 2, x: 6000, y: 1000 });
        const drone = eng.createEntity({ typeId: type, force: 2, x: 6000, y: 1200 });
        const tank = eng.createEntity({ typeId: 'us-m1a2-sepv3', force: 1, x: 6000, y: 4000, heading: Math.PI });
        tank.roe = 'holdFire';
        eng.assignTask(drone.id, { type: 'strike', targetId: tank.id });
        const dets: Detonation[] = [];
        eng.on('detonation', (d) => dets.push(d));
        eng.runFor(200);
        if (dets[0]?.intercepted) intercepted++;
      }
      return intercepted;
    };
    expect(run('us-fpv', 10)).toBeGreaterThanOrEqual(7);
    expect(run('us-switchblade600', 5)).toBe(0);
  });

  it('a spent drone leaves the map without counting as a loss; the kill is credited to it', () => {
    const eng = engine(7);
    const team = eng.createUnitFromTemplate('us-switchblade-section', 1, 3000, 1000);
    const bmp = eng.createEntity({ typeId: 'ru-bmp2', force: 2, x: 3000, y: 6000 });
    bmp.roe = 'holdFire';
    eng.assignTask(team.leader!.id, { type: 'attack', targetId: bmp.id });
    eng.runFor(300);
    const fired = eng.eventsSince(0).find((e) => e.kind === 'fire' && e.targetId === bmp.id);
    expect(fired?.text).toMatch(/Switchblade 600 warhead/);
    expect(eng.alerts.open().some((a) => a.kind === 'losses' && a.objectId === team.id)).toBe(false);
    expect(eng.snapshot().entities.find((e) => e.id === fired!.entityId)!.expended).toBe(true);
    if (bmp.destroyed) expect(eng.eventsSince(0).find((e) => e.kind === 'destroyed' && e.entityId === bmp.id)?.targetId).toBe(fired!.entityId);
  });

  it('loiters over an area and attacks what it finds, preferred kinds first', () => {
    const eng = engine(3);
    const op = eng.createEntity({ typeId: 'ru-uas-operator', force: 2, x: 6000, y: 500 });
    const lancet = eng.createEntity({ typeId: 'ru-lancet3', force: 2, x: 6000, y: 1000 });
    const area = eng.addGraphic('area', [{ x: 4000, y: 6000 }, { x: 8000, y: 6000 }, { x: 8000, y: 9000 }, { x: 4000, y: 9000 }], 'NAI 1', 2);
    const truck = eng.createEntity({ typeId: 'us-hemtt', force: 1, x: 5000, y: 7000 });
    const gun = eng.createEntity({ typeId: 'us-m109a7', force: 1, x: 7000, y: 8000 });
    for (const e of [truck, gun]) e.roe = 'holdFire';
    eng.assignTask(lancet.id, { type: 'loiter', areaId: area.id, attack: true, prefer: ['artillery', 'any'] });
    eng.runFor(900);
    expect(op.alive).toBe(true);
    const fire = eng.eventsSince(0).find((e) => e.kind === 'fire' && e.entityId === lancet.id);
    expect(fire?.targetId).toBe(gun.id);
  });
});

describe('unmanned systems: swarms', () => {
  it('a swarm search shares the area out and covers it', () => {
    const eng = engine();
    const swarm = eng.createUnitFromTemplate('us-drone-swarm', 1, 2000, 2000);
    const area = eng.addGraphic('area', [{ x: 3000, y: 4000 }, { x: 9000, y: 4000 }, { x: 9000, y: 8000 }, { x: 3000, y: 8000 }], 'NAI 2', 1);
    eng.assignTask(swarm.id, { type: 'swarmSearch', areaId: area.id });
    const n = swarm.alive().length;
    expect(swarm.alive().every((m) => m.task?.spec.type === 'swarmSearch')).toBe(true);
    // Each member has its own share: no two start on the same track.
    const firsts = swarm.alive().map((m) => JSON.stringify(m.task!.remainingPath.at(-1) ?? null));
    expect(new Set(firsts).size).toBe(n);
    const cell = 250;
    const seen = new Set<string>();
    let done = -1;
    for (let t = 0; t < 1200 && done < 0; t++) {
      eng.runFor(1);
      for (const m of swarm.alive()) {
        // The camera sees round the drone; count the ground within 200 m.
        for (let dx = -200; dx <= 200; dx += cell / 2) for (let dy = -200; dy <= 200; dy += cell / 2) seen.add(`${Math.floor((m.x + dx) / cell)},${Math.floor((m.y + dy) / cell)}`);
      }
      if (swarm.taskStatus() === 'done') done = eng.time;
    }
    expect(done).toBeGreaterThan(0);
    let missed = 0;
    let total = 0;
    for (let x = 3000 + cell / 2; x < 9000; x += cell) {
      for (let y = 4000 + cell / 2; y < 8000; y += cell) {
        total++;
        if (!seen.has(`${Math.floor(x / cell)},${Math.floor(y / cell)}`)) missed++;
      }
    }
    expect(missed / total).toBeLessThan(0.03);
    // Sixteen drones do it in a fraction of the time one would take (24 km² at 250 m spacing and 20 m/s: about 80 min).
    expect(done).toBeLessThan(900);
    expect(eng.eventsSince(0).some((e) => e.entityId === swarm.id && /finished searching NAI 2/.test(e.text))).toBe(true);
  });

  it('a swarm attack spreads its members over distinct targets, then doubles up', () => {
    const eng = engine(11);
    const swarm = eng.createUnitFromTemplate('us-drone-swarm', 1, 6000, 2000);
    const targets = [0, 1, 2, 3, 4, 5].map((i) => eng.createEntity({ typeId: 'ru-bmp2', force: 2, x: 4500 + i * 600, y: 5000 }));
    for (const t of targets) t.roe = 'holdFire';
    eng.assignTask(swarm.id, { type: 'swarmAttack', targetIds: targets.map((t) => t.id) });
    const assigned = swarm.alive().map((m) => (m.task as SwarmAttackTask).s.assignedId);
    const counts = targets.map((t) => assigned.filter((a) => a === t.id).length);
    // 16 drones on 6 targets: every target gets 2 or 3.
    expect(Math.min(...counts)).toBeGreaterThanOrEqual(2);
    expect(Math.max(...counts)).toBeLessThanOrEqual(3);
    eng.runFor(300);
    const hitAt = new Set(eng.eventsSince(0).filter((e) => e.kind === 'fire' && swarm.memberList.some((m) => m.id === e.entityId)).map((e) => e.targetId));
    expect(hitAt.size).toBe(6);
    expect(targets.filter((t) => t.destroyed).length).toBeGreaterThanOrEqual(4);
  });

  it('flocking keeps a moving swarm spread out', () => {
    const eng = engine();
    const swarm = eng.createUnitFromTemplate('ru-fpv-swarm', 2, 6000, 2000);
    eng.assignTask(swarm.id, { type: 'moveTo', target: { x: 6000, y: 9000 } });
    let closest = Infinity;
    for (let t = 0; t < 120; t++) {
      eng.runFor(1);
      if (t < 20) continue;
      const m = swarm.alive();
      for (let i = 0; i < m.length; i++) for (let j = i + 1; j < m.length; j++) closest = Math.min(closest, Math.hypot(m[i].x - m[j].x, m[i].y - m[j].y));
    }
    expect(closest).toBeGreaterThan(5);
  });
});

describe('unmanned systems: ground robots and detection', () => {
  it('a legged robot climbs a slope a tracked UGV cannot', () => {
    const n = 121;
    const h = new Float32Array(n * n);
    // A 39° escarpment (slope 0.8) right across the map between y = 2 km and 2.6 km.
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) h[r * n + c] = 20 + Math.max(0, Math.min(500, (r * 50 - 2000) * 0.8));
    const cliff = new Terrain({ ...base.spec, size: 6000, cellSize: 50, seed: 77 }, h, new Uint8Array(n * n), [], []);
    const eng = engine(undefined, cliff);
    const op = eng.createEntity({ typeId: 'us-uas-operator', force: 1, x: 3000, y: 1500 });
    const dog = eng.createEntity({ typeId: 'us-robot-dog', force: 1, x: 2900, y: 1600 });
    const ugv = eng.createEntity({ typeId: 'us-themis', force: 1, x: 3100, y: 1600 });
    for (const e of [dog, ugv]) eng.unmanned.setControl(e, { controllerId: op.id, lostLink: 'continue' });
    expect(eng.terrain.mobilityFactor(3000, 2250, 'ground', 0.7)).toBe(0);
    expect(eng.terrain.mobilityFactor(3000, 2250, dog.moveDomain, dog.type.offroadFactor)).toBeGreaterThan(0);
    eng.assignTask(dog.id, { type: 'moveTo', target: { x: 2900, y: 2800 } });
    eng.assignTask(ugv.id, { type: 'moveTo', target: { x: 3100, y: 2800 } });
    expect(ugv.task?.status).toBe('failed');
    eng.runFor(1500);
    expect(dog.y).toBeGreaterThan(2750);
    expect(dog.z).toBeGreaterThan(400);
  });

  it('small drones are seen only close in', () => {
    const cat = new Engine().catalog;
    expect(sizeFactor(cat.type('us-fpv'))).toBeCloseTo(0.1, 5);
    expect(sizeFactor(cat.type('us-m1a2'))).toBe(1);
    const spotted = (typeId: string, d: number) => {
      const eng = engine(5);
      const obs = eng.createEntity({ typeId: 'ru-rifleman', force: 2, x: 6000, y: 6000 });
      const target = eng.createEntity({ typeId, force: 1, x: 6000, y: 6000 + d, altitude: 50 });
      obs.roe = 'holdFire';
      eng.runFor(60);
      return obs.contacts.has(target.id);
    };
    // Binoculars (3 km): a helicopter at 1 km is seen; a 0.4 m quadcopter (to 400 m) is not, until close.
    expect(spotted('us-uh60', 1000)).toBe(true);
    expect(spotted('us-quadcopter', 1000)).toBe(false);
    expect(spotted('us-quadcopter', 150)).toBe(true);
    const eng = engine(5);
    const obs = eng.createEntity({ typeId: 'ru-rifleman', force: 2, x: 6000, y: 6000 });
    eng.createEntity({ typeId: 'us-quadcopter', force: 1, x: 6000, y: 7000, altitude: 50 });
    eng.runFor(5);
    const why = explainEntity(eng, obs, { omniscient: true }).sensing.find((f) => f.code === 'beyondSensorRange');
    expect(why?.text).toMatch(/0\.4 m across/);
  });
});

describe('unmanned systems: spotting, orders and saving', () => {
  it('a recon drone calls for fire through its operator', () => {
    const eng = engine();
    const team = eng.createUnitFromTemplate('us-raven-team', 1, 2000, 1000);
    eng.createUnitFromTemplate('us-mortar-section', 1, 2500, 1000);
    const t72 = eng.createEntity({ typeId: 'ru-t72b3', force: 2, x: 2000, y: 4500 });
    t72.roe = 'holdFire';
    eng.assignTask(team.id, { type: 'orbit', center: { x: 2000, y: 4000 }, radius: 600 });
    eng.runFor(240);
    const call = eng.eventsSince(0).find((e) => e.kind === 'radio' && /fire mission/.test(e.text));
    expect(call?.text).toMatch(/^US Raven Team Operator \(US Raven Team Lead\): fire mission, T-72B3/);
  });

  it('checks tasks: unknown areas and targets, strikes by drones without a warhead', () => {
    const eng = engine();
    const swarm = eng.createUnitFromTemplate('us-drone-swarm', 1, 2000, 2000);
    expect(() => eng.assignTask(swarm.id, { type: 'swarmSearch', areaId: 'G999' })).toThrow(/unknown area/);
    expect(() => eng.assignTask(swarm.id, { type: 'strike', targetId: 'E999' })).toThrow(/unknown entity/);
    const q = eng.createEntity({ typeId: 'us-quadcopter', force: 1, x: 2000, y: 2000 });
    const t = eng.createEntity({ typeId: 'ru-t72b3', force: 2, x: 2000, y: 3000 });
    eng.assignTask(q.id, { type: 'strike', targetId: t.id });
    eng.runFor(1);
    expect(q.task?.status).toBe('failed');
    expect(q.task?.message).toMatch(/not a one-way attack drone/);
  });

  it('saves and loads mid-flight: link state, lost-link behaviour and the strike carry on exactly', () => {
    const run = (split: boolean) => {
      const eng = engine(21);
      withDroneJammer(eng, 2500);
      const team = eng.createUnitFromTemplate('ru-fpv-team', 2, 6000, 1000);
      const ifv = eng.createEntity({ typeId: 'us-m2a3', force: 1, x: 5500, y: 5000 });
      ifv.roe = 'holdFire';
      eng.createEntity({ typeId: 'test-cuas', force: 1, x: 9000, y: 1500 });
      eng.assignTask(team.memberList[0].id, { type: 'strike', targetId: ifv.id });
      eng.assignTask(team.memberList[3].id, { type: 'moveTo', target: { x: 8000, y: 2500 } });
      eng.runFor(60.3);
      let e = eng;
      if (split) {
        const saved = JSON.parse(JSON.stringify(eng.toScenario()));
        expect(saved.entities.find((r: { id: string }) => r.id === team.memberList[3].id).state.uxs).toMatchObject({ linkUp: false, reason: 'jammed' });
        e = engine();
        e.loadScenario(saved);
      }
      e.runFor(120);
      return e.snapshot().entities;
    };
    const straight = run(false);
    const resumed = run(true);
    // Checkpoints keep positions to 0.1 m and speeds to 0.01 m/s, so allow a metre or two.
    expect(resumed.map((x) => `${x.id} ${x.damage} ${x.link?.up ?? '-'} ${x.link?.reason ?? ''} ${x.expended ?? ''}`)).toEqual(straight.map((x) => `${x.id} ${x.damage} ${x.link?.up ?? '-'} ${x.link?.reason ?? ''} ${x.expended ?? ''}`));
    resumed.forEach((x, i) => expect(Math.hypot(x.x - straight[i].x, x.y - straight[i].y, x.z - straight[i].z)).toBeLessThan(3));
    expect(straight.some((x) => x.expended)).toBe(true);
    expect(straight.some((x) => x.link?.reason === 'jammed' && x.agl < 2)).toBe(true);
  });
});

describe('unmanned systems: interfaces', () => {
  it('REST, typed orders and MCP give drone tasks and control settings; players see no enemy link', async () => {
    const eng = engine();
    const runner = new SimRunner(eng, 0.1, 20, 0);
    const api = new ApiV1({ runner, integrations: {} as never, scenarioDir: '/tmp' });
    const call = async (method: string, path: string, body?: unknown) => {
      const [p, q] = path.split('?');
      const r = await api.dispatch({ method, path: p, query: new URLSearchParams(q ?? ''), body, baseUrl: '' });
      return { status: r.status ?? 200, json: r.json as any };
    };
    const swarm = eng.createUnitFromTemplate('us-drone-swarm', 1, 3000, 2000);
    swarm.name = 'Hornets';
    const sb = eng.createUnitFromTemplate('us-switchblade-section', 1, 5000, 2000);
    sb.name = 'Blades';
    const area = eng.addGraphic('area', [{ x: 2000, y: 6000 }, { x: 6000, y: 6000 }, { x: 6000, y: 8000 }, { x: 2000, y: 8000 }], 'NAI DRONE', 1);
    const t72 = eng.createEntity({ typeId: 'ru-t72b3', force: 2, x: 4000, y: 7000 });
    eng.runFor(1);
    // REST tasks.
    let r = await call('POST', `/api/v1/units/${swarm.id}/task`, { type: 'swarmSearch', areaId: area.id, attack: true, prefer: ['armored', 'any'] });
    expect(r.status).toBe(200);
    expect(swarm.alive().every((m) => m.task?.spec.type === 'swarmSearch')).toBe(true);
    expect((await call('POST', `/api/v1/units/${swarm.id}/task`, { type: 'swarmAttack', targetIds: 'E1' })).status).toBe(400);
    expect((await call('POST', `/api/v1/units/${swarm.id}/task`, { type: 'loiter', center: { x: 4000, y: 7000 }, radius: 10 })).status).toBe(400);
    r = await call('POST', `/api/v1/entities/${sb.leader!.id}/task`, { type: 'strike', targetId: t72.id });
    expect(r.json.task).toMatch(/^Strike T-72B3/);
    // Control settings.
    r = await call('PATCH', `/api/v1/entities/${sb.leader!.id}`, { lostLink: 'land', autonomy: 'autonomous' });
    expect(r.json.link).toMatchObject({ up: true, lostLink: 'land', autonomy: 'autonomous' });
    expect((await call('PATCH', `/api/v1/entities/${sb.leader!.id}`, { lostLink: 'fly away' })).status).toBe(400);
    expect((await call('PATCH', `/api/v1/entities/${t72.id}`, { autonomy: 'remote' })).status).toBe(400);
    r = await call('PATCH', `/api/v1/units/${sb.id}`, { controllerId: null });
    expect(sb.memberList.every((m) => m.uxs!.controllerId === undefined)).toBe(true);
    // Typed orders.
    r = await call('POST', '/api/v1/orders', { text: 'Blades loiter over NAI DRONE and attack', dryRun: true });
    expect(r.json.commands[0].task).toEqual({ type: 'loiter', areaId: area.id, attack: true });
    r = await call('POST', '/api/v1/orders', { text: 'Hornets swarm attack NAI DRONE', dryRun: true });
    expect(r.json.commands[0].task).toEqual({ type: 'swarmAttack', areaId: area.id });
    r = await call('POST', '/api/v1/orders', { text: 'Hornets swarm search NAI DRONE and attack', dryRun: true });
    expect(r.json.commands[0].task).toEqual({ type: 'swarmSearch', areaId: area.id, attack: true });
    r = await call('POST', '/api/v1/orders', { text: `Blades strike ${t72.id}` });
    expect(r.status).toBe(200);
    expect(sb.alive().every((m) => m.task?.spec.type === 'strike')).toBe(true);
    // MCP.
    const server = createMcpServer(async (method, path, body) => call(method, path, body));
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(b);
    let res = (await client.callTool({ name: 'assign_task', arguments: { targetId: swarm.id, type: 'swarmAttack', targetIds: [t72.id] } })) as { content: { text: string }[]; isError?: boolean };
    expect(res.isError).toBeFalsy();
    expect(swarm.alive().every((m) => m.task?.spec.type === 'swarmAttack')).toBe(true);
    res = (await client.callTool({ name: 'set_drone_control', arguments: { id: swarm.id, lostLink: 'return' } })) as { content: { text: string }[]; isError?: boolean };
    expect(res.content[0].text).toMatch(/lost link: return/);
    await client.close();
    // Fog of war: Red sees a contact, not its link; Red cannot set Blue's drones.
    const red = filterState(eng, eng.snapshot(), 2);
    for (const e of red.entities.filter((x) => x.force === 1)) expect(e.link).toBeUndefined();
    expect(() => checkCommand(eng, { kind: 'player', force: 2 }, { cmd: 'setUnmanned', id: swarm.id, autonomy: 'remote' })).toThrow(/not under your command/);
    // Undoable like any edit.
    expect(executeCommand(runner, { cmd: 'setUnmanned', id: sb.id, autonomy: 'remote' }).ok).toBe(true);
    expect(eng.units.get(sb.id)!.memberList[1].uxs!.autonomy).toBe('remote');
    expect(executeCommand(runner, { cmd: 'undo' }).ok).toBe(true);
    expect(eng.units.get(sb.id)!.memberList[1].uxs!.autonomy).toBeUndefined();
    // Save and load keep the settings.
    const copy = engine();
    copy.loadScenario(JSON.parse(JSON.stringify(eng.toScenario())));
    expect(copy.entities.get(swarm.leader!.id)!.uxs!.lostLink).toBe('return');
  });

  it('a quick battle with drones gives each side recon UAVs and loitering munitions with their operators', () => {
    const eng = new Engine({ terrain: Terrain.generate({ size: 10000, seed: 5, towns: 3 }) });
    const res = generateBattle(eng, { seed: 4, mission: 'attack', blue: { support: ['drones', 'artillery'] }, red: { support: ['drones'] } });
    expect(res.description).toMatch(/with drones/);
    const types = [...eng.entities.values()].map((e) => e.type.id);
    for (const t of ['us-raven', 'us-switchblade600', 'us-uas-operator', 'ru-orlan10', 'ru-lancet3', 'ru-uas-operator']) expect(types).toContain(t);
    expect(eng.sync.get(1)!.phases[0].orders.some((o) => o.task?.type === 'loiter')).toBe(true);
    eng.runFor(2);
    const drones = [...eng.entities.values()].filter((e) => e.uxs);
    expect(drones.filter((e) => e.uxs!.up).length).toBeGreaterThan(drones.length / 2);
    expect(drones.filter((e) => e.type.id === 'ru-lancet3').every((e) => e.task?.spec.type === 'loiter')).toBe(true);
  });
});
