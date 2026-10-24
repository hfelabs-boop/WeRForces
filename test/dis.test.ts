import { describe, expect, it } from 'vitest';
import { DisGateway, type DisTransport } from '../src/dis/gateway.js';
import {
  ecefToGeodetic,
  eulerToHeadingPitchRoll,
  geodeticToEcef,
  headingPitchRollToEuler,
  LocalFrame,
} from '../src/dis/geodesy.js';
import {
  APPEARANCE_DEACTIVATED,
  decodeDetonation,
  decodeEntityState,
  decodeFire,
  decodeHeader,
  DETONATION_SIZE,
  encodeDetonation,
  encodeEntityState,
  encodeFire,
  ENTITY_STATE_SIZE,
  type EntityStatePdu,
  FIRE_SIZE,
  PDU_ENTITY_STATE,
  ALL_ENTITIES,
  decodeAcknowledge,
  decodeComment,
  decodeSignal,
  decodeStartResume,
  decodeTransmitter,
  encodeComment,
  encodeSignal,
  encodeStartResume,
  encodeStopFreeze,
  encodeTransmitter,
  PDU_START_RESUME,
  PDU_TRANSMITTER,
  TRANSMITTER_SIZE,
} from '../src/dis/pdu.js';
import { Engine } from '../src/sim/engine.js';
import { Terrain } from '../src/sim/terrain.js';

const DEG = Math.PI / 180;

describe('geodesy', () => {
  it('converts a known geodetic point to ECEF', () => {
    // Equator / prime meridian at sea level lies on the X axis at the semi-major axis.
    const p = geodeticToEcef({ lat: 0, lon: 0, alt: 0 });
    expect(p.x).toBeCloseTo(6378137, 3);
    expect(p.y).toBeCloseTo(0, 6);
    expect(p.z).toBeCloseTo(0, 6);
    const pole = geodeticToEcef({ lat: Math.PI / 2, lon: 0, alt: 0 });
    expect(pole.z).toBeCloseTo(6356752.314, 2);
  });

  it('round-trips geodetic <-> ECEF', () => {
    for (const [lat, lon, alt] of [
      [50.75, 9.9, 312],
      [-33.9, 151.2, 5],
      [71.2, -156.8, 9000],
    ]) {
      const g = ecefToGeodetic(geodeticToEcef({ lat: lat * DEG, lon: lon * DEG, alt }));
      expect(g.lat / DEG).toBeCloseTo(lat, 9);
      expect(g.lon / DEG).toBeCloseTo(lon, 9);
      expect(g.alt).toBeCloseTo(alt, 3);
    }
  });

  it('round-trips the local frame through ECEF to sub-millimetre', () => {
    const f = new LocalFrame(50.75, 9.9);
    const p = { x: 12345.6, y: 7890.1, z: 234.5 };
    const back = f.fromEcef(f.toEcef(p));
    expect(back.x).toBeCloseTo(p.x, 3);
    expect(back.y).toBeCloseTo(p.y, 3);
    expect(back.z).toBeCloseTo(p.z, 3);
  });

  it('round-trips heading/pitch/roll through DIS Euler angles', () => {
    const lat = 50.75 * DEG;
    const lon = 9.9 * DEG;
    for (const [h, p, r] of [
      [0, 0, 0],
      [90, 0, 0],
      [225, 10, -5],
      [359, -20, 30],
    ]) {
      const eu = headingPitchRollToEuler(lat, lon, h * DEG, p * DEG, r * DEG);
      const back = eulerToHeadingPitchRoll(lat, lon, eu);
      expect(((back.heading / DEG) % 360 + 360) % 360).toBeCloseTo(h, 6);
      expect(back.pitch / DEG).toBeCloseTo(p, 6);
      expect(back.roll / DEG).toBeCloseTo(r, 6);
    }
  });

  it('gives the textbook Euler angles for a level north-facing body at the equator', () => {
    // At lat 0, lon 0 north is +Z and down is -X, so psi = 0 and theta = -90 deg.
    const eu = headingPitchRollToEuler(0, 0, 0, 0, 0);
    expect(eu.theta / DEG).toBeCloseTo(-90, 6);
  });
});

function samplePdu(): EntityStatePdu {
  return {
    header: { protocolVersion: 7, exerciseId: 3, pduType: 1, protocolFamily: 1, timestamp: 1234, length: 0 },
    entityId: { site: 10, application: 20, entity: 30 },
    forceId: 2,
    entityType: { kind: 1, domain: 1, country: 222, category: 1, subcategory: 2, specific: 6, extra: 0 },
    alternateEntityType: { kind: 1, domain: 1, country: 222, category: 1, subcategory: 2, specific: 6, extra: 0 },
    linearVelocity: { x: 1.5, y: -2.25, z: 0.5 },
    location: { x: 4000123.456, y: 700456.789, z: 4900789.012 },
    orientation: { psi: 0.5, theta: -0.25, phi: 0.125 },
    appearance: 3 << 3,
    deadReckoning: { algorithm: 2, linearAcceleration: { x: 0, y: 0, z: 0 }, angularVelocity: { x: 0, y: 0, z: 0 } },
    marking: 'T72 LEAD',
    capabilities: 0,
  };
}

describe('PDU encoding', () => {
  it('encodes the Entity State PDU with the IEEE 1278.1 layout', () => {
    const buf = encodeEntityState(samplePdu());
    expect(buf.byteLength).toBe(ENTITY_STATE_SIZE);
    const v = new DataView(buf.buffer);
    expect(v.getUint8(0)).toBe(7); // protocol version
    expect(v.getUint8(1)).toBe(3); // exercise
    expect(v.getUint8(2)).toBe(PDU_ENTITY_STATE);
    expect(v.getUint16(8)).toBe(144); // length
    expect(v.getUint16(12)).toBe(10); // site
    expect(v.getUint16(16)).toBe(30); // entity
    expect(v.getUint8(18)).toBe(2); // force
    expect(v.getUint16(22)).toBe(222); // country
    expect(v.getFloat32(36)).toBeCloseTo(1.5); // velocity x
    expect(v.getFloat64(48)).toBeCloseTo(4000123.456, 6); // location x
    expect(v.getFloat32(72)).toBeCloseTo(0.5); // psi
    expect(v.getUint32(84)).toBe(3 << 3); // appearance
    expect(v.getUint8(88)).toBe(2); // dead reckoning algorithm
    expect(v.getUint8(128)).toBe(1); // marking character set
    expect(String.fromCharCode(v.getUint8(129), v.getUint8(130), v.getUint8(131))).toBe('T72');
  });

  it('round-trips Entity State', () => {
    const pdu = samplePdu();
    const back = decodeEntityState(encodeEntityState(pdu));
    expect(back.entityId).toEqual(pdu.entityId);
    expect(back.entityType).toEqual(pdu.entityType);
    expect(back.location).toEqual(pdu.location);
    expect(back.marking).toBe('T72 LEAD');
    expect(back.orientation.psi).toBeCloseTo(0.5, 6);
    expect(back.appearance).toBe(pdu.appearance);
    expect(decodeHeader(encodeEntityState(pdu))?.exerciseId).toBe(3);
  });

  it('round-trips Fire and Detonation', () => {
    const header = { protocolVersion: 7, exerciseId: 1, pduType: 0, protocolFamily: 0, timestamp: 0, length: 0 };
    const burst = { munition: { kind: 2, domain: 9, country: 225, category: 1, subcategory: 2, specific: 0, extra: 0 }, warhead: 1000, fuse: 1000, quantity: 1, rate: 0 };
    const fire = encodeFire({
      header,
      firingEntityId: { site: 1, application: 2, entity: 3 },
      targetEntityId: { site: 4, application: 5, entity: 6 },
      munitionId: { site: 0, application: 0, entity: 0 },
      eventId: { site: 1, application: 2, entity: 99 },
      fireMissionIndex: 0,
      location: { x: 1, y: 2, z: 3 },
      burst,
      velocity: { x: 10, y: 20, z: 30 },
      range: 2500,
    });
    expect(fire.byteLength).toBe(FIRE_SIZE);
    const f = decodeFire(fire);
    expect(f.targetEntityId.entity).toBe(6);
    expect(f.burst.munition.country).toBe(225);
    expect(f.range).toBe(2500);

    const det = encodeDetonation({
      header,
      firingEntityId: { site: 1, application: 2, entity: 3 },
      targetEntityId: { site: 4, application: 5, entity: 6 },
      munitionId: { site: 0, application: 0, entity: 0 },
      eventId: { site: 1, application: 2, entity: 99 },
      velocity: { x: 0, y: 0, z: 0 },
      location: { x: 7, y: 8, z: 9 },
      burst,
      locationInEntity: { x: 0, y: 0, z: 0 },
      result: 1,
    });
    expect(det.byteLength).toBe(DETONATION_SIZE);
    const d = decodeDetonation(det);
    expect(d.location).toEqual({ x: 7, y: 8, z: 9 });
    expect(d.result).toBe(1);
    expect(d.eventId.entity).toBe(99);
  });
});

/** In-memory "network" connecting several gateways. */
function memoryNetwork() {
  const handlers: ((b: Uint8Array) => void)[] = [];
  const sent: Uint8Array[] = [];
  const make = (): DisTransport => {
    let mine: (b: Uint8Array) => void = () => {};
    handlers.push((b) => mine(b));
    return {
      send: (b) => {
        sent.push(b);
        for (const h of handlers) h(b);
      },
      onMessage: (fn) => {
        mine = fn;
      },
      close: () => {},
    };
  };
  return { make, sent };
}

describe('DIS gateway', () => {
  const terrain = Terrain.generate({ size: 6000, seed: 7, towns: 2 });

  it('publishes local entities and reflects them as remote entities in another engine', () => {
    let clock = 1000;
    const net = memoryNetwork();
    const a = new Engine({ terrain });
    const b = new Engine({ terrain });
    a.newScenario('A', terrain.spec);
    b.newScenario('B', terrain.spec);
    const ga = new DisGateway(a, net.make(), { site: 1, application: 1 }, () => clock);
    const gb = new DisGateway(b, net.make(), { site: 2, application: 1 }, () => clock);
    const town = terrain.towns[0];
    const tank = a.createEntity({ typeId: 'us-m1a2', force: 1, x: town.x, y: town.y, heading: 1.0, name: 'Alpha 1' });
    ga.update(true, 1);
    gb.update(true, 1);
    const remote = b.entities.get('R1-1-1');
    expect(remote).toBeDefined();
    expect(remote!.remote).toBe(true);
    expect(remote!.name).toBe('Alpha 1');
    expect(remote!.type.id).toBe('us-m1a2');
    expect(remote!.x).toBeCloseTo(tank.x, 2);
    expect(remote!.y).toBeCloseTo(tank.y, 2);
    expect(remote!.z).toBeCloseTo(tank.z, 2);
    expect(remote!.heading).toBeCloseTo(1.0, 4);
    // Own PDUs are ignored by the sender.
    expect(a.entities.size).toBe(1);

    // No change: nothing is resent until the heartbeat (radios have their own heartbeat).
    const states = () => net.sent.filter((b) => decodeHeader(b)!.pduType === PDU_ENTITY_STATE).length;
    const before = states();
    clock += 1;
    ga.update(true, 1);
    expect(states()).toBe(before);
    clock += 5;
    ga.update(true, 1);
    expect(states()).toBe(before + 1);

    // Deleting the entity deactivates it remotely.
    a.deleteObject(tank.id);
    const last = decodeEntityState(net.sent[net.sent.length - 1]);
    expect(last.appearance & APPEARANCE_DEACTIVATED).toBeTruthy();
    expect(b.entities.has('R1-1-1')).toBe(false);
  });

  it('sends a new state when the dead-reckoning error exceeds the threshold', () => {
    let clock = 0;
    const net = memoryNetwork();
    const a = new Engine({ terrain });
    a.newScenario('A', terrain.spec);
    const g = new DisGateway(a, net.make(), {}, () => clock);
    const e = a.createEntity({ typeId: 'us-m1a2', force: 1, x: terrain.towns[0].x, y: terrain.towns[0].y });
    g.update(true, 1);
    const states = () => net.sent.filter((b) => decodeHeader(b)!.pduType === PDU_ENTITY_STATE).length;
    const n = states();
    e.x += 0.5; // within 1 m threshold
    g.update(true, 1);
    expect(states()).toBe(n);
    e.x += 2; // beyond threshold
    g.update(true, 1);
    expect(states()).toBe(n + 1);
  });

  it('times out remote entities that stop sending', () => {
    let clock = 0;
    const net = memoryNetwork();
    const a = new Engine({ terrain });
    const b = new Engine({ terrain });
    a.newScenario('A', terrain.spec);
    b.newScenario('B', terrain.spec);
    const ga = new DisGateway(a, net.make(), { site: 1 }, () => clock);
    const gb = new DisGateway(b, net.make(), { site: 2 }, () => clock);
    a.createEntity({ typeId: 'us-m1a2', force: 1, x: terrain.towns[0].x, y: terrain.towns[0].y });
    ga.update(true, 1);
    expect(b.entities.size).toBe(1);
    clock += 13;
    gb.update(true, 1);
    expect(b.entities.size).toBe(0);
  });

  it('applies detonations from another simulation to local entities', () => {
    const clock = 0;
    const net = memoryNetwork();
    const a = new Engine({ terrain, seed: 1 });
    const b = new Engine({ terrain, seed: 1 });
    a.newScenario('A', terrain.spec);
    b.newScenario('B', terrain.spec);
    const ga = new DisGateway(a, net.make(), { site: 1 }, () => clock);
    const gb = new DisGateway(b, net.make(), { site: 2 }, () => clock);
    const t = terrain.towns[0];
    const victim = a.createEntity({ typeId: 'us-hmmwv', force: 1, x: t.x, y: t.y });
    const shooter = b.createEntity({ typeId: 'ru-t72b3', force: 2, x: t.x + 300, y: t.y });
    ga.update(true, 1);
    gb.update(true, 1);
    // Engine B shoots at the remote HMMWV until it is hit; A adjudicates the damage.
    const remoteVictim = b.entities.get('R1-3001-1')!;
    expect(remoteVictim).toBeDefined();
    let tries = 0;
    while (!victim.destroyed && tries++ < 50) {
      b.launch({ eventNumber: tries, shooterId: shooter.id, targetId: remoteVictim.id, weapon: b.catalog.weapon('gun-125mm'), from: shooter.position, to: remoteVictim.position, fireTime: b.time, impactTime: b.time, range: 300 });
      b.step(0.1);
    }
    expect(victim.destroyed).toBe(true);
  });
});

describe('DIS radio and simulation management', () => {
  const terrain = Terrain.generate({ size: 6000, seed: 7, towns: 2 });

  it('round-trips the radio and simulation management PDUs', () => {
    const header = { protocolVersion: 7, exerciseId: 1, pduType: 0, protocolFamily: 0, timestamp: 0, length: 0 };
    const tx = decodeTransmitter(
      encodeTransmitter({
        header,
        radioReferenceId: { site: 1, application: 2, entity: 3 },
        radioNumber: 1,
        radioType: { kind: 7, domain: 1, country: 225, category: 0, subcategory: 0, specific: 0, extra: 0 },
        transmitState: 2,
        inputSource: 1,
        antennaLocation: { x: 4e6, y: 7e5, z: 4.9e6 },
        relativeAntennaLocation: { x: 0, y: 0, z: 3 },
        frequency: 30_025_000,
        bandwidth: 25000,
        power: 40,
        modulation: { spreadSpectrum: 0, majorModulation: 1, detail: 2, radioSystem: 1 },
        cryptoSystem: 0,
        cryptoKeyId: 0,
      }),
    );
    expect(tx.header.length).toBe(TRANSMITTER_SIZE);
    expect(tx.frequency).toBe(30_025_000);
    expect(tx.antennaLocation.z).toBe(4.9e6);
    expect(tx.transmitState).toBe(2);
    const sig = decodeSignal(encodeSignal({ header, radioReferenceId: { site: 1, application: 2, entity: 3 }, radioNumber: 1, encodingScheme: (1 << 14) | 1, tdlType: 0, sampleRate: 0, samples: 1, data: new TextEncoder().encode('hello net') }));
    expect(sig.header.length % 4).toBe(0);
    expect(new TextDecoder().decode(sig.data)).toBe('hello net');
    const sr = decodeStartResume(encodeStartResume({ header, originatingId: { site: 9, application: 9, entity: 0 }, receivingId: ALL_ENTITIES, realWorldTime: { hour: 5, timePastHour: 6 }, simulationTime: { hour: 0, timePastHour: 8 }, requestId: 42 }));
    expect(sr.header.length).toBe(44);
    expect(sr.requestId).toBe(42);
    expect(sr.receivingId).toEqual(ALL_ENTITIES);
    const c = decodeComment(encodeComment({ header, originatingId: { site: 9, application: 9, entity: 0 }, receivingId: ALL_ENTITIES, texts: [{ datumId: 0, text: 'Phase 2 begins' }] }));
    expect(c.texts[0].text).toBe('Phase 2 begins');
    expect(c.header.length % 8).toBe(0);
  });

  it('leaders have radios; radio messages go out as Signal PDUs and come in as radio events', () => {
    let clock = 0;
    const net = memoryNetwork();
    const a = new Engine({ terrain });
    const b = new Engine({ terrain });
    a.newScenario('A', terrain.spec);
    b.newScenario('B', terrain.spec);
    const ga = new DisGateway(a, net.make(), { site: 1, application: 1 }, () => clock);
    const gb = new DisGateway(b, net.make(), { site: 2, application: 1 }, () => clock);
    const town = terrain.towns[0];
    const platoon = a.createUnitFromTemplate('us-tank-platoon', 1, town.x, town.y);
    ga.update(true, 1);
    gb.update(true, 1);
    // One radio: the platoon leader's.
    const txs = net.sent.filter((p) => decodeHeader(p)!.pduType === PDU_TRANSMITTER).map(decodeTransmitter);
    expect(txs).toHaveLength(1);
    expect(txs[0].radioReferenceId.entity).toBe(platoon.leader!.disNumber);
    expect(txs[0].frequency).toBe(30_000_000);
    expect(ga.status().radios).toBe(1);
    expect(gb.status().remoteRadios).toBe(1);
    const heard: string[] = [];
    b.on('event', (ev) => ev.kind === 'radio' && heard.push(ev.text));
    a.radio(platoon.leader!, 'US Tank Platoon: contact, T-72B3 at 2000 3000');
    expect(heard).toEqual(['US Tank Pla (DIS radio): US Tank Platoon: contact, T-72B3 at 2000 3000']);
    // Keyed up while sending, then back to idle.
    const states = net.sent.filter((p) => decodeHeader(p)!.pduType === PDU_TRANSMITTER).map((p) => decodeTransmitter(p).transmitState);
    expect(states.slice(-2)).toEqual([2, 1]);
  });

  it('a simulation manager can start and freeze the simulation, and is acknowledged', () => {
    const net = memoryNetwork();
    const a = new Engine({ terrain });
    a.newScenario('A', terrain.spec);
    const g = new DisGateway(a, net.make(), { site: 1, application: 1 });
    let running = false;
    g.control = { setRunning: (r) => (running = r) };
    const manager = net.make();
    const header = { protocolVersion: 7, exerciseId: 1, pduType: 0, protocolFamily: 0, timestamp: 0, length: 0 };
    const now = { hour: 0, timePastHour: 0 };
    manager.send(encodeStartResume({ header, originatingId: { site: 50, application: 1, entity: 0 }, receivingId: ALL_ENTITIES, realWorldTime: now, simulationTime: now, requestId: 7 }));
    expect(running).toBe(true);
    const ack = decodeAcknowledge(net.sent.at(-1)!);
    expect(ack.acknowledgeFlag).toBe(3);
    expect(ack.responseFlag).toBe(1);
    expect(ack.requestId).toBe(7);
    expect(ack.receivingId).toEqual({ site: 50, application: 1, entity: 0 });
    // Addressed to another application: ignored.
    manager.send(encodeStopFreeze({ header, originatingId: { site: 50, application: 1, entity: 0 }, receivingId: { site: 1, application: 99, entity: 0 }, realWorldTime: now, reason: 1, frozenBehavior: 0, requestId: 8 }));
    expect(running).toBe(true);
    manager.send(encodeStopFreeze({ header, originatingId: { site: 50, application: 1, entity: 0 }, receivingId: { site: 1, application: 1, entity: 0 }, realWorldTime: now, reason: 1, frozenBehavior: 0, requestId: 9 }));
    expect(running).toBe(false);
    // Acting as manager: run/pause is announced.
    const lead = new DisGateway(a, net.make(), { site: 1, application: 2, announceRunState: true });
    lead.update(false, 1);
    lead.update(true, 1);
    expect(net.sent.some((p) => decodeHeader(p)!.pduType === PDU_START_RESUME)).toBe(true);
    // Comments are logged.
    const log: string[] = [];
    a.on('event', (ev) => log.push(ev.text));
    manager.send(encodeComment({ header, originatingId: { site: 50, application: 1, entity: 0 }, receivingId: ALL_ENTITIES, texts: [{ datumId: 0, text: 'ENDEX in 5 minutes' }] }));
    expect(log).toContain('DIS comment from 50:1: ENDEX in 5 minutes');
  });
});
