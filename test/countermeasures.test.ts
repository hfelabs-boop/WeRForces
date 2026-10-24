// EW countermeasures and counter-UAS: GNSS denial and spoofing, counter-drone jammers and
// guns, emission control and direction finding, active protection, decoys, anti-radiation
// missiles, and their save/load, fog of war, REST and MCP.

import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp/tools.js';
import { ApiV1 } from '../src/server/apiV1.js';
import { executeCommand } from '../src/server/commands.js';
import { filterState } from '../src/server/fog.js';
import { SimRunner } from '../src/server/runner.js';
import { emitterSystems, EMITTER_JAMMER } from '../src/dis/emissions.js';
import { fireIndirect, resolveImpact, type Detonation, type Shot } from '../src/sim/combat.js';
import { Engine } from '../src/sim/engine.js';
import type { Entity } from '../src/sim/entity.js';
import { explainEntity } from '../src/sim/explain.js';
import { inertialDrift } from '../src/sim/models.js';
import { Terrain } from '../src/sim/terrain.js';
import type { EntityTypeDef, ScenarioFile, SimEvent } from '../src/shared/types.js';

const base = Terrain.generate({ size: 6000, seed: 9, towns: 2 });
const cols = 401;
const flat = new Terrain({ ...base.spec, size: 20000, cellSize: 50, seed: 4343 }, new Float32Array(cols * cols).fill(20), new Uint8Array(cols * cols), [], []);

/** A small radio-linked quadcopter that navigates by GNSS. */
const QUAD: EntityTypeDef = {
  id: 'test-quad',
  name: 'Test quadcopter',
  description: 'small drone',
  domain: 'air',
  symbol: 'uav',
  armor: 'drone',
  rcs: 0.01,
  dis: { kind: 1, domain: 2, country: 225, category: 50, subcategory: 9, specific: 0, extra: 0 },
  maxSpeed: 25,
  cruiseSpeed: 20,
  minSpeed: 0,
  acceleration: 4,
  turnRate: 90 * (Math.PI / 180),
  offroadFactor: 1,
  cruiseAltitude: 100,
  climbRate: 5,
  sensorHeight: 0,
  sensors: ['eye'],
  weapons: [],
  crew: 0,
  unmanned: { link: 'rf' },
  gnss: true,
};

function engine(seed?: number): Engine {
  const e = new Engine({ terrain: flat });
  e.newScenario('counter', flat.spec);
  e.setCustomCatalog({ entityTypes: [QUAD] });
  if (seed !== undefined) e.reseed(seed);
  return e;
}

function detonations(eng: Engine): Detonation[] {
  const out: Detonation[] = [];
  eng.on('detonation', (d) => out.push(d));
  return out;
}

/** A shot at a target arriving next tick, as a weapon would fire it. */
function shotAt(eng: Engine, shooter: Entity, target: Entity, weaponId: string): Shot {
  const weapon = eng.catalog.weapon(weaponId);
  const range = Math.hypot(target.x - shooter.x, target.y - shooter.y, target.z - shooter.z);
  return { eventNumber: eng.nextEventNumber(), shooterId: shooter.id, targetId: target.id, weapon, from: { ...shooter.position, z: shooter.z + 2 }, to: target.position, fireTime: eng.time, impactTime: eng.time + 0.05, range };
}

describe('GNSS denial and spoofing', () => {
  it('grows the navigation error with the time since denial, throws moves off, and recovers when the jamming stops', () => {
    const target = { x: 7000, y: 3000 };
    const run = (jam: boolean) => {
      const eng = engine();
      const quad = eng.createEntity({ typeId: 'test-quad', force: 1, x: 2000, y: 3000 });
      const pole = eng.createEntity({ typeId: 'ru-pole21', force: 2, x: 15000, y: 15000 });
      pole.jamming = jam;
      eng.runFor(1.05);
      eng.assignTask(quad.id, { type: 'moveTo', target });
      const errors: number[] = [];
      for (let k = 0; k < 4; k++) {
        eng.runFor(30);
        errors.push(eng.nav.errorSize(quad));
      }
      eng.runFor(300);
      return { eng, quad, pole, errors, miss: Math.hypot(quad.x - target.x, quad.y - target.y) };
    };
    const clear = run(false);
    expect(clear.quad.nav).toBeUndefined();
    expect(clear.miss).toBeLessThan(45);
    const jammed = run(true);
    const { eng, quad, pole, errors } = jammed;
    // Inertial drift at 1 m/s: error = t (1 + t / 300).
    for (let k = 1; k < errors.length; k++) expect(errors[k]).toBeGreaterThan(errors[k - 1]);
    const t = eng.time - quad.nav!.since;
    expect(eng.nav.errorSize(quad)).toBeCloseTo(inertialDrift.inertialError(t, 1), 6);
    expect(errors[1]).toBeCloseTo(inertialDrift.inertialError(61 - 1, 1), -1);
    // It stopped where it thought the destination was: off by the error it had when it got there.
    expect(jammed.miss).toBeGreaterThan(150);
    const snap = eng.snapshot().entities.find((e) => e.id === quad.id)!;
    expect(snap.gnss).toBe('denied');
    expect(snap.navError).toBeGreaterThan(150);
    const why = explainEntity(eng, quad, { omniscient: false }).movement.find((f) => f.code === 'gnssDenied');
    expect(why?.text).toMatch(/^GNSS denied: navigating by inertial for \d+ s, error ~/);
    expect(eng.alerts.open().some((a) => a.kind === 'gnssDenied' && a.objectId === quad.id)).toBe(true);
    // The jammer goes off: the fix is back at once, and the next move ends on target.
    pole.jamming = false;
    eng.runFor(2);
    expect(quad.nav).toBeUndefined();
    expect(eng.snapshot().entities.find((e) => e.id === quad.id)!.gnss).toBeUndefined();
    eng.assignTask(quad.id, { type: 'moveTo', target: { x: 9000, y: 6000 } });
    eng.runFor(400);
    expect(Math.hypot(quad.x - 9000, quad.y - 6000)).toBeLessThan(45);
  });

  it('a spoofer walks a navigator off toward itself, and only the spoofer\'s side is told', () => {
    const eng = engine();
    const quad = eng.createEntity({ typeId: 'test-quad', force: 1, x: 6000, y: 6000 });
    const spoofer = eng.createEntity({ typeId: 'ru-shipovnik', force: 2, x: 12000, y: 6000 });
    eng.runFor(1.05);
    expect(quad.nav?.spoofedBy).toBe(spoofer.id);
    eng.runFor(60);
    expect(eng.nav.errorSize(quad)).toBeCloseTo(inertialDrift.spoofOffset(eng.time - quad.nav!.since), 6);
    // It thinks it is further from the spoofer (east of it is +x... the spoofer is east, so it believes it is west).
    expect(eng.nav.error(quad)!.x).toBeLessThan(-250);
    const full = eng.snapshot();
    expect(full.entities.find((e) => e.id === quad.id)!.gnss).toBe('spoofed');
    const blue = filterState(eng, full, 1).entities.find((e) => e.id === quad.id)!;
    expect(blue.gnss).toBeUndefined();
    expect(blue.navError).toBeUndefined();
    expect(explainEntity(eng, quad, { omniscient: false }).movement.some((f) => f.code.startsWith('gnss'))).toBe(false);
    expect(explainEntity(eng, quad, { omniscient: true }).movement.some((f) => f.code === 'gnssSpoofed')).toBe(true);
    // Hovering where it thinks the start point is, it drifts toward the spoofer.
    eng.assignTask(quad.id, { type: 'moveTo', target: { x: 6000, y: 6000 } });
    eng.runFor(60);
    expect(quad.x).toBeGreaterThan(6300);
  });

  it('GNSS-guided rounds miss by far more when they fly into a GNSS jammer\'s reach', () => {
    const miss = (jam: boolean) => {
      const eng = engine(5);
      const gun = eng.createEntity({ typeId: 'us-m109a7-excalibur', force: 1, x: 2000, y: 2000 });
      const pole = eng.createEntity({ typeId: 'ru-pole21', force: 2, x: 11000, y: 2000 });
      pole.jamming = jam;
      eng.runFor(1);
      const w = eng.catalog.weapon('how-155mm-excalibur');
      const dets = detonations(eng);
      const aim = { x: 10000, y: 2000 };
      for (let k = 0; k < 30; k++) {
        gun.ammo.set(w.id, 10);
        fireIndirect(eng, gun, w, aim);
        eng.runFor(1);
      }
      eng.runFor(40);
      expect(dets).toHaveLength(30);
      return dets.reduce((s, d) => s + Math.hypot(d.location.x - aim.x, d.location.y - aim.y), 0) / dets.length;
    };
    const clear = miss(false);
    const jammed = miss(true);
    expect(clear).toBeLessThan(12);
    // 8 km at 300 m/s: 27 s without satellites at 3 m/s drift, about 87 m one-sigma.
    expect(jammed).toBeGreaterThan(60);
    // And against an entity, the kill chance falls with the miss.
    const eng = engine();
    const hq = eng.createEntity({ typeId: 'ru-brdm2', force: 2, x: 10000, y: 2000 });
    const gun = eng.createEntity({ typeId: 'us-m109a7-excalibur', force: 1, x: 2000, y: 2000 });
    eng.createEntity({ typeId: 'ru-pole21', force: 2, x: 11000, y: 2000 });
    eng.runFor(1);
    const shot = shotAt(eng, gun, hq, 'how-155mm-excalibur');
    shot.impactTime = shot.fireTime + 27;
    expect(eng.nav.munitionError(shot)).toBeCloseTo(inertialDrift.inertialError(27, 3), 6);
    expect(eng.nav.munitionFactor(shot, hq)).toBeLessThan(0.15);
  });
});

describe('counter-UAS', () => {
  it('a counter-drone jammer cuts a drone\'s datalink and GNSS within its reach only', () => {
    const eng = engine();
    eng.createEntity({ typeId: 'ru-silok', force: 2, x: 8000, y: 8000 });
    const near = eng.createEntity({ typeId: 'test-quad', force: 1, x: 8000, y: 4500 });
    const far = eng.createEntity({ typeId: 'test-quad', force: 1, x: 8000, y: 3500 });
    const team = eng.createEntity({ typeId: 'us-dronebuster-team', force: 1, x: 3000, y: 3000 });
    const red = eng.createEntity({ typeId: 'test-quad', force: 2, x: 3000, y: 3800 });
    eng.runFor(1.05);
    expect(eng.ew.datalinkJammed(near)).toBe(true);
    expect(eng.ew.gnssJammed(near)).toBe(true);
    expect(eng.ew.datalinkJammed(far)).toBe(false);
    // A handheld drone gun reaches 1 km.
    expect(eng.ew.datalinkJammed(red)).toBe(true);
    team.x = 3000;
    team.y = 1500;
    eng.runFor(1);
    expect(eng.ew.datalinkJammed(red)).toBe(false);
    // DIS: the counter-drone jammer radiates on the datalink and GNSS bands.
    const silok = [...eng.entities.values()].find((e) => e.type.id === 'ru-silok')!;
    const sys = emitterSystems(eng, silok).find((s) => s.function === EMITTER_JAMMER)!;
    expect(sys.beams.map((b) => Math.round(b.frequency / 1e8) / 10)).toEqual([4.1, 1.4]);
  });

  it('gun air defence kills small drones at short range, not beyond its guns', () => {
    for (const typeId of ['ru-tunguska', 'us-mshorad']) {
      const eng = engine(3);
      const force = typeId.startsWith('ru') ? 2 : 1;
      const enemy = force === 1 ? 2 : 1;
      eng.createEntity({ typeId, force, x: 10000, y: 10000 });
      const close = [0, 1, 2].map((k) => eng.createEntity({ typeId: 'test-quad', force: enemy, x: 10000 + 1500 * Math.sin(k * 2), y: 10000 + 1500 * Math.cos(k * 2) }));
      const away = eng.createEntity({ typeId: 'test-quad', force: enemy, x: 10000, y: 16000 });
      const events: SimEvent[] = [];
      eng.on('event', (e) => events.push(e));
      eng.runFor(120);
      expect(close.every((d) => d.destroyed)).toBe(true);
      expect(away.destroyed).toBe(false);
      const gun = typeId === 'ru-tunguska' ? 'gun-30mm-2a38' : 'gun-30mm-xm914';
      expect(events.some((e) => e.kind === 'detonation' && e.weaponId === gun && e.hit)).toBe(true);
    }
  });

  it('interceptors kill drones; rifles barely do', () => {
    const eng = engine(4);
    const coyote = eng.createEntity({ typeId: 'us-coyote', force: 1, x: 10000, y: 10000 });
    const quad = eng.createEntity({ typeId: 'test-quad', force: 2, x: 10000, y: 13000 });
    eng.runFor(90);
    expect(quad.destroyed).toBe(true);
    expect(coyote.ammo.get('coyote')).toBeLessThan(12);
    expect(eng.catalog.weapon('rifle-556').pk.drone).toBeUndefined();
    expect(eng.catalog.weapon('stinger').pk.drone).toBe(0.5);
  });
});

describe('emission control and direction finding', () => {
  it('radio silence hides a unit from direction finding and delays its orders', () => {
    const eng = engine();
    const blue = eng.createUnitFromTemplate('us-scout-section', 1, 3000, 3000);
    eng.setRoe(blue.id, 'holdFire');
    const df = eng.createEntity({ typeId: 'ru-r381t', force: 2, x: 3000, y: 12000 });
    eng.runFor(1);
    // An order is acknowledged on the radio: the DF station hears it.
    expect(eng.issueOrder(blue.id, { task: { type: 'wait', duration: 5 } })).toBe(0);
    eng.runFor(2);
    const c = eng.df.contact(2, blue.leader!.id);
    expect(c?.bands).toContain('radio');
    expect(eng.snapshot().entities.find((e) => e.id === blue.leader!.id)!.emitting).toEqual(['radio']);
    // Radio silence: nothing more to hear; the old fix times out.
    expect(executeCommand(new SimRunner(eng, 0.1, 20, 0), { cmd: 'setEmcon', targetId: blue.id, radioSilence: true }).ok).toBe(true);
    expect(blue.memberList.every((m) => m.radioSilent)).toBe(true);
    expect(eng.issueOrder(blue.id, { task: { type: 'wait', duration: 5 } })).toBe(60);
    eng.runFor(40);
    expect(eng.df.contact(2, blue.leader!.id)).toBeUndefined();
    expect(eng.snapshot().entities.find((e) => e.id === blue.leader!.id)!.emcon).toEqual({ radioSilence: true });
    expect(explainEntity(eng, blue.leader!, { omniscient: false }).movement.some((f) => f.code === 'radioSilence')).toBe(true);
    // The order still arrives, late, and is not acknowledged on the air.
    eng.runFor(25);
    expect(eng.pendingOrders).toHaveLength(0);
    expect(eng.df.contact(2, blue.leader!.id)).toBeUndefined();
    // Lifted: the next order is heard again.
    eng.setEmcon(blue.id, { radioSilence: false });
    eng.issueOrder(blue.id, { task: { type: 'wait', duration: 5 } });
    eng.runFor(2);
    expect(eng.df.contact(2, blue.leader!.id)).toBeDefined();
    expect(df.alive).toBe(true);
  });

  it('two stations cross bearings into a far better fix than one', () => {
    const trial = (stations: number, seed: number) => {
      const eng = engine(seed);
      const sam = eng.createEntity({ typeId: 'ru-sa8', force: 2, x: 10000, y: 14000 });
      sam.roe = 'holdFire';
      eng.createEntity({ typeId: 'us-prophet', force: 1, x: 4000, y: 2000 });
      if (stations > 1) eng.createEntity({ typeId: 'us-prophet', force: 1, x: 16000, y: 2000 });
      eng.runFor(1.05);
      const c = eng.df.contact(1, sam.id)!;
      expect(c.stations).toBe(stations);
      expect(c.bands).toEqual(['radar']);
      return { miss: Math.hypot(c.x - sam.x, c.y - sam.y), major: c.major, minor: c.minor };
    };
    const one = Array.from({ length: 12 }, (_, k) => trial(1, 100 + k));
    const two = Array.from({ length: 12 }, (_, k) => trial(2, 100 + k));
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    // One station: a 13 km range from signal strength is good to 35 %; across it, 1.5° is 350 m.
    expect(mean(one.map((t) => t.major))).toBeGreaterThan(5000);
    expect(mean(two.map((t) => t.major))).toBeLessThan(mean(one.map((t) => t.major)) / 3);
    expect(mean(two.map((t) => t.miss))).toBeLessThan(mean(one.map((t) => t.miss)) / 3);
    expect(mean(two.map((t) => t.miss))).toBeLessThan(800);
  });

  it('radar off: no emission, no detection, no EE PDU; DF station silent cannot report', () => {
    const eng = engine();
    const sam = eng.createEntity({ typeId: 'ru-sa8', force: 2, x: 10000, y: 10000 });
    const heli = eng.createEntity({ typeId: 'us-ah64', force: 1, x: 10000, y: 16000, altitude: 200 });
    heli.roe = 'holdFire';
    sam.roe = 'holdFire';
    const df = eng.createEntity({ typeId: 'us-prophet', force: 1, x: 4000, y: 4000 });
    eng.runFor(3);
    expect(sam.contacts.has(heli.id)).toBe(true);
    expect(emitterSystems(eng, sam)).toHaveLength(1);
    eng.setEmcon(sam.id, { radarOff: true });
    sam.contacts.clear();
    eng.runFor(40);
    expect(sam.contacts.has(heli.id)).toBe(false);
    expect(emitterSystems(eng, sam)).toHaveLength(0);
    expect(eng.df.contact(1, sam.id)).toBeUndefined();
    expect(explainEntity(eng, sam, { omniscient: true }).sensing.some((f) => f.code === 'radarOff')).toBe(true);
    // Radar back on, but the DF station keeps radio silence: its bearings go nowhere.
    eng.setEmcon(sam.id, { radarOff: false });
    eng.setEmcon(df.id, { radioSilence: true });
    eng.runFor(3);
    expect(eng.df.contact(1, sam.id)).toBeUndefined();
    eng.setEmcon(df.id, { radioSilence: false });
    eng.runFor(2);
    expect(eng.df.contact(1, sam.id)).toBeDefined();
  });

  it('DF stations call for fire on a good fix of a ground emitter', () => {
    const eng = engine(2);
    const jammer = eng.createEntity({ typeId: 'ru-krasukha', force: 2, x: 9000, y: 12000 });
    // Two stations 10 km apart, 9 km from the jammer: bearings cross at 60°.
    eng.createEntity({ typeId: 'us-prophet', force: 1, x: 4000, y: 3000 });
    eng.createEntity({ typeId: 'us-prophet', force: 1, x: 14000, y: 3000 });
    eng.createUnitFromTemplate('us-paladin-platoon', 1, 6000, 1000);
    const events: SimEvent[] = [];
    eng.on('event', (e) => events.push(e));
    eng.runFor(3);
    const c = eng.df.contact(1, jammer.id)!;
    expect(c.stations).toBe(2);
    expect(c.major).toBeLessThan(1000);
    expect(events.some((e) => e.kind === 'task' && /called for fire on a jammer emitter located by direction finding/.test(e.text))).toBe(true);
    eng.runFor(120);
    expect(events.some((e) => e.kind === 'detonation' && e.weaponId === 'how-155mm')).toBe(true);
  });
});

describe('active protection and decoys', () => {
  it('defeats incoming ATGMs from its arc until the charges run out', () => {
    const eng = engine();
    const tank0 = eng.catalog.type('us-m1a2-sepv3');
    eng.setCustomCatalog({ entityTypes: [QUAD, { ...tank0, id: 'test-aps', aps: { name: 'Test APS', charges: 3, pk: 1, arc: 180 } }] });
    const tank = eng.createEntity({ typeId: 'test-aps', force: 1, x: 5000, y: 5000, heading: 0 });
    tank.roe = 'holdFire';
    const front = eng.createEntity({ typeId: 'ru-bmp2', force: 2, x: 5000, y: 5150 });
    const rear = eng.createEntity({ typeId: 'ru-bmp2', force: 2, x: 5000, y: 4850 });
    front.roe = rear.roe = 'holdFire';
    const dets = detonations(eng);
    const fireAt = (from: Entity, weapon: string) => {
      eng.launch(shotAt(eng, from, tank, weapon));
      eng.runFor(0.2);
      return dets[dets.length - 1];
    };
    // A cannon round is not something it can stop; nor a rocket from behind its arc.
    expect(fireAt(front, 'gun-30mm-2a42').intercepted).toBeUndefined();
    expect(fireAt(rear, 'rpg7').intercepted).toBeUndefined();
    tank.destroyed = tank.mobilityKill = tank.firepowerKill = false;
    expect(tank.apsLeft).toBe(3);
    for (let k = 0; k < 3; k++) expect(fireAt(front, 'rpg7').intercepted).toBe(true);
    expect(tank.apsLeft).toBe(0);
    expect(tank.alive).toBe(true);
    expect(fireAt(front, 'rpg7').intercepted).toBeUndefined();
    expect(eng.eventsSince(0).some((e) => e.text === `${tank.name}: Test APS defeated an incoming RPG-7 (0 charges left)`)).toBe(true);
    expect(eng.alerts.open().some((a) => a.kind === 'apsSpent' && a.objectId === tank.id)).toBe(true);
    expect(eng.eventsSince(0).some((e) => e.kind === 'detonation' && /intercepted short of/.test(e.text))).toBe(true);
    const snap = eng.snapshot().entities.find((e) => e.id === tank.id)!;
    expect(snap.aps).toEqual({ left: 0, charges: 3 });
  });

  it('Trophy usually stops an RPG; the plain M1A2 has none', () => {
    const eng = engine(8);
    const sep = eng.createEntity({ typeId: 'us-m1a2-sepv3', force: 1, x: 5000, y: 5000 });
    const plain = eng.createEntity({ typeId: 'us-m1a2', force: 1, x: 6000, y: 5000 });
    const rpg = eng.createEntity({ typeId: 'ru-rifleman', force: 2, x: 5000, y: 5150 });
    sep.roe = plain.roe = rpg.roe = 'holdFire';
    let stopped = 0;
    for (let k = 0; k < 8; k++) {
      sep.destroyed = sep.mobilityKill = sep.firepowerKill = false;
      const d = resolveImpact(eng, shotAt(eng, rpg, sep, 'rpg7'));
      if (d.intercepted) stopped++;
    }
    expect(sep.apsLeft).toBe(0);
    expect(stopped).toBeGreaterThanOrEqual(6);
    expect(plain.apsLeft).toBe(0);
    expect(resolveImpact(eng, shotAt(eng, rpg, plain, 'rpg7')).intercepted).toBeUndefined();
  });

  it('flares and chaff cut a guided missile\'s kill chance while they last', () => {
    const kills = (typeId: string) => {
      const eng = engine(11);
      const heli = eng.createEntity({ typeId, force: 1, x: 5000, y: 5000, altitude: 100 });
      const team = eng.createEntity({ typeId: 'ru-sa8', force: 2, x: 5000, y: 8000 });
      heli.roe = team.roe = 'holdFire';
      let n = 0;
      for (let k = 0; k < 200; k++) {
        heli.destroyed = false;
        heli.decoysLeft = 1;
        const shot = shotAt(eng, team, heli, 'sam-osa');
        eng.launch(shot);
        expect(!!shot.decoyed).toBe(typeId === 'us-ah64e');
        if (resolveImpact(eng, shot).outcome === 'kill') n++;
      }
      return n;
    };
    const plain = kills('us-ah64');
    const decoyed = kills('us-ah64e');
    expect(plain).toBeGreaterThan(70);
    expect(decoyed).toBeLessThan(plain * 0.55);
    // Salvos run out.
    const eng = engine();
    const heli = eng.createEntity({ typeId: 'us-ah64e', force: 1, x: 5000, y: 5000 });
    const sam = eng.createEntity({ typeId: 'ru-sa8', force: 2, x: 5000, y: 8000 });
    heli.decoysLeft = 1;
    const a = shotAt(eng, sam, heli, 'sam-osa');
    const b = shotAt(eng, sam, heli, 'sam-osa');
    eng.launch(a);
    eng.launch(b);
    expect(a.decoyed).toBe(true);
    expect(b.decoyed).toBeUndefined();
    expect(heli.decoysLeft).toBe(0);
  });
});

describe('anti-radiation missiles', () => {
  it('home on an emitting radar, and lose it when it falls silent', () => {
    const trial = (shutDown: boolean, seed: number) => {
      const eng = engine(seed);
      const sead = eng.createEntity({ typeId: 'us-f16cj', force: 1, x: 3000, y: 10000, heading: -Math.PI / 2, altitude: 3000 });
      const sam = eng.createEntity({ typeId: 'ru-sa8', force: 2, x: 14000, y: 10000 });
      sam.roe = 'holdFire';
      let fired = false;
      eng.on('fire', (s) => {
        if (s.weapon.id === 'agm88') fired = true;
      });
      const texts: string[] = [];
      eng.on('event', (e) => texts.push(e.text));
      for (let k = 0; k < 50 && !fired; k++) eng.runFor(0.1);
      expect(fired).toBe(true);
      if (shutDown) eng.setEmcon(sam.id, { radarOff: true });
      eng.runFor(30);
      if (shutDown) expect(texts.some((t) => /AGM-88 HARM anti-radiation missile lost its emitter and burst at/.test(t))).toBe(true);
      return sam.destroyed || sam.firepowerKill || sam.mobilityKill;
    };
    const on = Array.from({ length: 8 }, (_, k) => trial(false, 20 + k)).filter(Boolean).length;
    const off = Array.from({ length: 8 }, (_, k) => trial(true, 20 + k)).filter(Boolean).length;
    expect(on).toBeGreaterThanOrEqual(6);
    expect(off).toBeLessThanOrEqual(2);
  });

  it('is never fired at a target that does not radiate', () => {
    const eng = engine();
    eng.createEntity({ typeId: 'us-f16cj', force: 1, x: 3000, y: 10000, altitude: 3000 });
    const sam = eng.createEntity({ typeId: 'ru-sa8', force: 2, x: 14000, y: 10000 });
    sam.roe = 'holdFire';
    sam.radarOff = true;
    const fired: string[] = [];
    eng.on('fire', (s) => fired.push(s.weapon.id));
    eng.runFor(20);
    expect(fired).not.toContain('agm88');
  });
});

describe('saving and loading countermeasure state', () => {
  it('keeps EMCON, APS charges, decoys, navigation error and DF bearings, and resumes exactly', () => {
    const build = () => {
      const eng = engine(7);
      const quad = eng.createEntity({ typeId: 'test-quad', force: 1, x: 2000, y: 3000, id: 'Q1' });
      eng.createEntity({ typeId: 'ru-pole21', force: 2, x: 15000, y: 15000, id: 'J1' });
      const tank = eng.createEntity({ typeId: 'us-m1a2-sepv3', force: 1, x: 3000, y: 2000, id: 'T1' });
      const heli = eng.createEntity({ typeId: 'ru-mi24p', force: 2, x: 9000, y: 9000, id: 'H1' });
      const sam = eng.createEntity({ typeId: 'ru-sa8', force: 2, x: 12000, y: 12000, id: 'S1' });
      eng.createUnitFromTemplate('us-df-team', 1, 8000, 2000, Math.PI / 2);
      sam.roe = heli.roe = tank.roe = 'holdFire';
      eng.setEmcon(tank.id, { radioSilence: true });
      eng.setEmcon(heli.id, { radarOff: true });
      tank.apsLeft = 5;
      heli.decoysLeft = 3;
      eng.assignTask(quad.id, { type: 'moveTo', target: { x: 9000, y: 3000 } });
      eng.runFor(40);
      return eng;
    };
    const a = build();
    const cp = JSON.parse(JSON.stringify(a.toScenario())) as ScenarioFile;
    const rec = (id: string) => cp.entities.find((e) => e.id === id)!.state!;
    expect(rec('T1')).toMatchObject({ radioSilence: true, apsLeft: 5 });
    expect(rec('H1')).toMatchObject({ radarOff: true, decoysLeft: 3 });
    expect(rec('Q1').nav).toMatchObject({ since: expect.any(Number), dir: expect.any(Number) });
    expect(cp.df?.length).toBeGreaterThan(0);
    const b = new Engine({ terrain: flat });
    b.loadScenario(cp);
    const q = b.entities.get('Q1')!;
    expect(q.nav).toEqual(a.entities.get('Q1')!.nav);
    expect(b.entities.get('T1')!.radioSilent).toBe(true);
    expect(b.entities.get('T1')!.apsLeft).toBe(5);
    expect(b.entities.get('H1')!.radarOff).toBe(true);
    expect(b.entities.get('H1')!.decoysLeft).toBe(3);
    expect(b.df.contacts()).toEqual(a.df.contacts());
    // Both carry on alike (checkpoints keep positions to 0.1 m, so moving entities differ by a hair).
    const go = (eng: Engine) => {
      const ev: string[] = [];
      eng.on('event', (e) => ev.push(`${e.time.toFixed(1)} ${e.text}`));
      eng.runFor(60);
      return ev;
    };
    const evA = go(a);
    const evB = go(b);
    expect(evB).toEqual(evA);
    expect(evB.some((t) => /GNSS jammed/.test(t))).toBe(false);
    expect(b.nav.errorSize(q)).toBeCloseTo(a.nav.errorSize(a.entities.get('Q1')!), 9);
    expect(Math.hypot(q.x - a.entities.get('Q1')!.x, q.y - a.entities.get('Q1')!.y)).toBeLessThan(1);
    expect(b.df.contacts().map((c) => c.id).sort()).toEqual(a.df.contacts().map((c) => c.id).sort());
  });

  it('keeps emission control set while authoring (time 0)', () => {
    const eng = engine();
    const sam = eng.createEntity({ typeId: 'ru-sa8', force: 2, x: 12000, y: 12000 });
    eng.setEmcon(sam.id, { radarOff: true, radioSilence: true });
    const s = eng.toScenario();
    expect(s.entities[0].state).toMatchObject({ radarOff: true, radioSilence: true });
  });
});

describe('fog of war, REST and MCP', () => {
  it('DF contacts belong to the force that found them; EMCON is set over REST and MCP', async () => {
    const eng = engine();
    const runner = new SimRunner(eng, 0.1, 20, 0);
    const sam = eng.createEntity({ typeId: 'ru-sa8', force: 2, x: 10000, y: 14000 });
    sam.roe = 'holdFire';
    eng.createEntity({ typeId: 'us-prophet', force: 1, x: 4000, y: 2000 });
    const tank = eng.createUnitFromTemplate('us-tank-platoon', 1, 3000, 3000);
    eng.runFor(2);
    const full = eng.snapshot();
    expect(full.dfContacts?.map((c) => c.id)).toEqual([sam.id]);
    expect(filterState(eng, full, 1).dfContacts?.map((c) => c.id)).toEqual([sam.id]);
    expect(filterState(eng, full, 2).dfContacts).toBeUndefined();
    // Red does not see Blue's EMCON (its view of a Blue contact carries none).
    eng.setEmcon(tank.id, { radioSilence: true });
    const api = new ApiV1({ runner, integrations: {} as never, scenarioDir: '/tmp' });
    const call = async (method: string, path: string, body?: unknown, force?: 1 | 2) => {
      const [p, q] = path.split('?');
      const r = await api.dispatch({ method, path: p, query: new URLSearchParams(q ?? ''), body, baseUrl: '', role: force ? { kind: 'player', force } : undefined });
      return { status: r.status ?? 200, json: r.json as any };
    };
    expect((await call('GET', '/api/v1/df-contacts', undefined, 1)).json).toHaveLength(1);
    expect((await call('GET', '/api/v1/df-contacts', undefined, 2)).json).toHaveLength(0);
    const dc = (await call('GET', '/api/v1/df-contacts')).json[0];
    expect(dc).toMatchObject({ id: sam.id, force: 1, bands: ['radar'], stations: 1 });
    expect(dc.lat).toBeTypeOf('number');
    let r = await call('PATCH', `/api/v1/units/${tank.id}`, { emcon: { radioSilence: false, radarOff: true } }, 1);
    expect(r.status).toBe(200);
    expect(tank.leader!.radioSilent).toBe(false);
    expect(tank.leader!.radarOff).toBe(true);
    // Red cannot set Blue's EMCON.
    r = await call('PATCH', `/api/v1/entities/${tank.leader!.id}`, { emcon: { radioSilence: true } }, 2);
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(tank.leader!.radioSilent).toBe(false);
    r = await call('PATCH', `/api/v1/entities/${sam.id}`, { emcon: { radarOff: 'yes' } });
    expect(r.status).toBe(400);
    const server = createMcpServer(async (method, path, body) => call(method, path, body));
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(b);
    const res = (await client.callTool({ name: 'set_emcon', arguments: { id: sam.id, radarOff: true } })) as { content: { text: string }[]; isError?: boolean };
    expect(res.isError).toBeFalsy();
    expect(sam.radarOff).toBe(true);
    const unitRes = (await client.callTool({ name: 'set_emcon', arguments: { id: tank.id, radioSilence: true } })) as { content: { text: string }[]; isError?: boolean };
    expect(unitRes.isError).toBeFalsy();
    expect(tank.memberList.every((m) => m.radioSilent)).toBe(true);
    const list = (await client.callTool({ name: 'get_df_contacts', arguments: {} })) as { content: { text: string }[] };
    expect(JSON.parse(list.content[0].text)[0].id).toBe(sam.id);
    await client.close();
  });
});
