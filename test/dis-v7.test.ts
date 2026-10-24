// DIS 7 PDUs added in v0.6: Electromagnetic Emission for radars and jammers, Entity State
// Update, Collision, Designator, IFF, and the simulation management requests (Create/Remove
// Entity, Data Query, Set Data, Action Request). Byte layouts are cross-checked against an
// independent implementation in dis-interop.test.ts; these tests cover the gateway behaviour.

import { describe, expect, it } from 'vitest';
import { decodeAcknowledge, decodeActionResponse, decodeData, decodeElectromagneticEmission, decodeEntityState, decodeHeader, decodeReceiver, decodeTransmitter, EE_CHANGED_DATA_UPDATE, EE_HEARTBEAT_UPDATE, encodeActionRequest, encodeCollision, encodeCreateEntity, encodeDataQuery, encodeDesignator, encodeElectromagneticEmission, encodeEntityStateUpdate, encodeIff, encodeRemoveEntity, encodeSetData, type EntityId, PDU_ACKNOWLEDGE, PDU_ACTION_RESPONSE, PDU_DATA, PDU_ELECTROMAGNETIC_EMISSION, PDU_ENTITY_STATE, PDU_RECEIVER, PDU_TRANSMITTER, type PduHeader } from '../src/dis/pdu.js';
import { DATUM_ENTITIES, DATUM_ENTITY_MARKING, DATUM_ENTITY_TYPE, DATUM_FORCE_ID, DATUM_GEOCENTRIC, DATUM_LATITUDE, DATUM_SPEED } from '../src/dis/datums.js';
import { BEAM_JAMMING, BEAM_SEARCH, BEAM_TRACKING, EMITTER_FIRE_CONTROL, EMITTER_JAMMER, EMITTER_SURVEILLANCE } from '../src/dis/emissions.js';
import { DisGateway } from '../src/dis/gateway.js';
import { LocalFrame } from '../src/dis/geodesy.js';
import { Engine } from '../src/sim/engine.js';
import { Terrain } from '../src/sim/terrain.js';
import { memoryNetwork } from './interop/memory-network.js';

const terrain = Terrain.generate({ size: 6000, seed: 7, towns: 2 });
const HEADER: PduHeader = { protocolVersion: 7, exerciseId: 1, pduType: 0, protocolFamily: 0, timestamp: 0, length: 0 };
const MANAGER: EntityId = { site: 50, application: 1, entity: 0 };

function setup(config: Partial<ConstructorParameters<typeof DisGateway>[2]> = {}) {
  const clock = { t: 1000 };
  const net = memoryNetwork();
  const engine = new Engine({ terrain });
  engine.newScenario('A', terrain.spec);
  const gateway = new DisGateway(engine, net.make(), { site: 1, application: 1, ...config }, () => clock.t);
  const manager = net.make();
  const log: string[] = [];
  engine.on('event', (ev) => log.push(ev.text));
  const ofType = (type: number) => net.sent.filter((b) => decodeHeader(b)!.pduType === type);
  return { clock, net, engine, gateway, manager, log, ofType };
}

describe('DIS Electromagnetic Emission', () => {
  it('is sent for radars and switched-on jammers, on change and on a 10 s heartbeat, and once more with no beams when they stop', () => {
    const { clock, engine, gateway, ofType } = setup();
    const t = terrain.towns[0];
    const f16 = engine.createEntity({ typeId: 'us-f16', force: 1, x: t.x, y: t.y });
    const sa8 = engine.createEntity({ typeId: 'ru-sa8', force: 2, x: t.x + 200, y: t.y });
    const jammer = engine.createEntity({ typeId: 'ru-krasukha', force: 2, x: t.x + 250, y: t.y });
    engine.createEntity({ typeId: 'us-m1a2', force: 1, x: t.x, y: t.y + 100 }); // no emitter
    gateway.update(true, 1);
    const ee = () => ofType(PDU_ELECTROMAGNETIC_EMISSION).map(decodeElectromagneticEmission);
    const first = ee();
    expect(first.map((p) => p.emittingEntityId.entity).sort()).toEqual([f16.disNumber, sa8.disNumber, jammer.disNumber].sort());
    expect(first.every((p) => p.stateUpdateIndicator === EE_CHANGED_DATA_UPDATE && p.header.status === 6)).toBe(true);
    const of = (e: { disNumber: number }) => first.find((p) => p.emittingEntityId.entity === e.disNumber)!.systems;
    expect(of(f16)).toMatchObject([{ name: 1890, function: EMITTER_FIRE_CONTROL, number: 1, beams: [{ beamFunction: BEAM_TRACKING, frequency: Math.fround(9.5e9) }] }]);
    expect(of(sa8)).toMatchObject([{ name: 19260, function: EMITTER_SURVEILLANCE, beams: [{ beamFunction: BEAM_SEARCH, azimuthSweep: Math.fround(Math.PI) }] }]);
    expect(of(jammer)).toMatchObject([{ name: 19053, function: EMITTER_JAMMER, beams: [{ beamFunction: BEAM_JAMMING, frequency: Math.fround(10e9) }] }]);
    expect(of(f16)[0].location.z).toBeCloseTo(-f16.type.sensorHeight, 5);
    // Event numbers count up.
    expect(new Set(first.map((p) => p.eventId.entity)).size).toBe(3);

    // Nothing changes: quiet until the heartbeat.
    clock.t += 5;
    gateway.update(true, 1);
    expect(ee()).toHaveLength(3);
    clock.t += 5;
    gateway.update(true, 1);
    expect(ee().slice(3).map((p) => p.stateUpdateIndicator)).toEqual([EE_HEARTBEAT_UPDATE, EE_HEARTBEAT_UPDATE, EE_HEARTBEAT_UPDATE]);

    // The jammer is switched off: one PDU with its system and no beams, then silence.
    jammer.jamming = false;
    clock.t += 1;
    gateway.update(true, 1);
    const off = ee().at(-1)!;
    expect(off.emittingEntityId.entity).toBe(jammer.disNumber);
    expect(off.stateUpdateIndicator).toBe(EE_CHANGED_DATA_UPDATE);
    expect(off.systems).toMatchObject([{ function: EMITTER_JAMMER, beams: [] }]);
    const n = ee().length;
    clock.t += 1;
    gateway.update(true, 1);
    expect(ee()).toHaveLength(n);

    // Deleting a radar platform turns its emitter off too.
    engine.deleteObject(f16.id);
    expect(ee().at(-1)!).toMatchObject({ emittingEntityId: { entity: f16.disNumber }, systems: [{ beams: [] }] });
  });

  it('can be turned off', () => {
    const { engine, gateway, ofType } = setup({ emissions: false });
    engine.createEntity({ typeId: 'ru-sa8', force: 2, x: terrain.towns[0].x, y: terrain.towns[0].y });
    gateway.update(true, 1);
    expect(ofType(PDU_ELECTROMAGNETIC_EMISSION)).toHaveLength(0);
  });
});

describe('DIS 7 PDU status', () => {
  it('marks PDUs as constructive, and radio PDUs as attached; DIS 6 sends padding', () => {
    for (const [version, es, radio] of [
      [7, 0b0000_0110, 0b0010_0110],
      [6, 0, 0],
    ]) {
      const { engine, gateway, ofType } = setup({ protocolVersion: version });
      engine.createEntity({ typeId: 'us-m1a2', force: 1, x: terrain.towns[0].x, y: terrain.towns[0].y });
      gateway.update(true, 1);
      expect(decodeEntityState(ofType(PDU_ENTITY_STATE)[0]).header.status).toBe(es);
      expect(decodeTransmitter(ofType(PDU_TRANSMITTER)[0]).header.status).toBe(radio);
      expect(decodeReceiver(ofType(PDU_RECEIVER)[0]).header.status).toBe(radio);
    }
  });
});

describe('DIS simulation management requests', () => {
  it('answers a Data Query about one of its entities with a Data PDU', () => {
    const { engine, gateway, manager, ofType } = setup();
    const t = terrain.towns[0];
    const tank = engine.createEntity({ typeId: 'us-m1a2', force: 1, x: t.x, y: t.y, name: 'Alpha 1' });
    const about = { site: 1, application: 1, entity: tank.disNumber };
    manager.send(encodeDataQuery({ header: HEADER, originatingId: MANAGER, receivingId: about, requestId: 77, timeInterval: 0, fixedIds: [DATUM_FORCE_ID, DATUM_SPEED, 99999], variableIds: [DATUM_ENTITY_TYPE, DATUM_ENTITY_MARKING, DATUM_GEOCENTRIC, DATUM_LATITUDE] }));
    const data = decodeData(ofType(PDU_DATA).at(-1)!);
    expect(data.originatingId).toEqual(about);
    expect(data.receivingId).toEqual(MANAGER);
    expect(data.requestId).toBe(77);
    expect(data.fixed).toEqual([
      { id: DATUM_FORCE_ID, value: 1 },
      { id: DATUM_SPEED, value: 0 },
    ]);
    expect(data.variable.map((v) => v.id)).toEqual([DATUM_ENTITY_TYPE, DATUM_ENTITY_MARKING, DATUM_GEOCENTRIC, DATUM_LATITUDE]);
    const [type, marking, ecef, lat] = data.variable.map((v) => new DataView(v.data.buffer, v.data.byteOffset, v.data.byteLength));
    expect([type.getUint8(0), type.getUint8(1), type.getUint16(2)]).toEqual([tank.type.dis.kind, tank.type.dis.domain, tank.type.dis.country]);
    expect(new TextDecoder().decode(data.variable[1].data)).toBe('\u0001Alpha 1\0\0\0\0');
    expect(marking.byteLength).toBe(12);
    const frame = new LocalFrame(terrain.spec.origin.lat, terrain.spec.origin.lon);
    const p = frame.toEcef(tank.position);
    expect([ecef.getFloat64(0), ecef.getFloat64(8), ecef.getFloat64(16)]).toEqual([p.x, p.y, p.z]);
    expect(lat.getFloat64(0)).toBeCloseTo((frame.toGeodetic(tank.position).lat * 180) / Math.PI, 9);

    // No ids: the default set. Addressed to the application: the entity count.
    manager.send(encodeDataQuery({ header: HEADER, originatingId: MANAGER, receivingId: about, requestId: 78, timeInterval: 0, fixedIds: [], variableIds: [] }));
    expect(decodeData(ofType(PDU_DATA).at(-1)!).fixed.length + decodeData(ofType(PDU_DATA).at(-1)!).variable.length).toBe(8);
    manager.send(encodeDataQuery({ header: HEADER, originatingId: MANAGER, receivingId: { site: 0xffff, application: 0xffff, entity: 0xffff }, requestId: 79, timeInterval: 0, fixedIds: [DATUM_ENTITIES], variableIds: [] }));
    expect(decodeData(ofType(PDU_DATA).at(-1)!)).toMatchObject({ requestId: 79, originatingId: { site: 1, application: 1, entity: 0 }, fixed: [{ id: DATUM_ENTITIES, value: 1 }] });
    // Addressed to another application: no answer.
    const n = ofType(PDU_DATA).length;
    manager.send(encodeDataQuery({ header: HEADER, originatingId: MANAGER, receivingId: { site: 1, application: 2, entity: 1 }, requestId: 80, timeInterval: 0, fixedIds: [DATUM_FORCE_ID], variableIds: [] }));
    expect(ofType(PDU_DATA)).toHaveLength(n);
  });

  it('does not apply Set Data (answers with the current values) and rejects Action Requests', () => {
    const { engine, manager, log, ofType } = setup();
    const tank = engine.createEntity({ typeId: 'us-m1a2', force: 1, x: terrain.towns[0].x, y: terrain.towns[0].y });
    const about = { site: 1, application: 1, entity: tank.disNumber };
    manager.send(encodeSetData({ header: HEADER, originatingId: MANAGER, receivingId: about, requestId: 5, fixed: [{ id: DATUM_FORCE_ID, value: 2 }], variable: [] }));
    expect(tank.force).toBe(1);
    expect(decodeData(ofType(PDU_DATA).at(-1)!)).toMatchObject({ requestId: 5, fixed: [{ id: DATUM_FORCE_ID, value: 1 }] });
    expect(log.some((l) => /set data from 50:1 .* ignored \(1 datums\)/.test(l))).toBe(true);
    manager.send(encodeActionRequest({ header: HEADER, originatingId: MANAGER, receivingId: about, requestId: 6, actionId: 3, fixed: [], variable: [] }));
    const res = decodeActionResponse(ofType(PDU_ACTION_RESPONSE).at(-1)!);
    expect(res).toMatchObject({ requestId: 6, requestStatus: 5, originatingId: about, receivingId: MANAGER });
  });

  it('refuses Create Entity, and removes an entity on Remove Entity unless simulation management is ignored', () => {
    for (const obey of [true, false]) {
      const { engine, manager, ofType } = setup({ obeySimulationManager: obey });
      const tank = engine.createEntity({ typeId: 'us-m1a2', force: 1, x: terrain.towns[0].x, y: terrain.towns[0].y });
      manager.send(encodeCreateEntity({ header: HEADER, originatingId: MANAGER, receivingId: { site: 1, application: 1, entity: 0 }, requestId: 1 }));
      expect(decodeAcknowledge(ofType(PDU_ACKNOWLEDGE).at(-1)!)).toMatchObject({ acknowledgeFlag: 1, responseFlag: 2, requestId: 1, receivingId: MANAGER });
      manager.send(encodeRemoveEntity({ header: HEADER, originatingId: MANAGER, receivingId: { site: 1, application: 1, entity: tank.disNumber }, requestId: 2 }));
      expect(decodeAcknowledge(ofType(PDU_ACKNOWLEDGE).at(-1)!)).toMatchObject({ acknowledgeFlag: 2, responseFlag: obey ? 1 : 2, requestId: 2 });
      expect(engine.entities.has(tank.id)).toBe(!obey);
    }
  });
});

describe('DIS entity information and warfare PDUs received', () => {
  it('Entity State Update moves a known remote entity; Collision, Designator, EE and IFF are handled', () => {
    const { clock, net, engine: b, gateway: gb, log } = setup({ site: 2 });
    const a = new Engine({ terrain });
    a.newScenario('A', terrain.spec);
    const ga = new DisGateway(a, net.make(), { site: 1, application: 1 }, () => clock.t);
    const t = terrain.towns[0];
    const tank = a.createEntity({ typeId: 'us-m1a2', force: 1, x: t.x, y: t.y, name: 'Alpha 1' });
    const mine = b.createEntity({ typeId: 'ru-t72b3', force: 2, x: t.x + 500, y: t.y, name: 'Red 1' });
    ga.update(true, 1);
    const id = { site: 1, application: 1, entity: tank.disNumber };
    const remote = b.entities.get(`R1-1-${tank.disNumber}`)!;
    expect(remote).toBeDefined();
    const es = decodeEntityState(net.sent.find((p) => decodeHeader(p)!.pduType === PDU_ENTITY_STATE)!);
    const frame = new LocalFrame(terrain.spec.origin.lat, terrain.spec.origin.lon);
    const moved = frame.toEcef({ x: t.x + 50, y: t.y + 20, z: tank.z });
    const sender = net.make();
    sender.send(encodeEntityStateUpdate({ header: HEADER, entityId: id, linearVelocity: { x: 0, y: 0, z: 0 }, location: moved, orientation: es.orientation, appearance: 2 << 3 }));
    expect(remote.x).toBeCloseTo(t.x + 50, 2);
    expect(remote.y).toBeCloseTo(t.y + 20, 2);
    expect(remote.mobilityKill).toBe(false);
    // An update for an entity never seen in an Entity State is ignored.
    sender.send(encodeEntityStateUpdate({ header: HEADER, entityId: { ...id, entity: 999 }, linearVelocity: { x: 0, y: 0, z: 0 }, location: moved, orientation: es.orientation, appearance: 0 }));
    expect(b.entities.has('R1-1-999')).toBe(false);

    const ours = { site: 2, application: 1, entity: mine.disNumber };
    sender.send(encodeCollision({ header: HEADER, issuingEntityId: id, collidingEntityId: ours, eventId: { site: 1, application: 1, entity: 1 }, collisionType: 0, velocity: { x: 0, y: 0, z: 0 }, mass: 60000, location: { x: 0, y: 0, z: 0 } }));
    expect(log).toContain('Alpha 1 collided with Red 1 (DIS)');

    const laser = { header: HEADER, designatingEntityId: id, codeName: 0, designatedEntityId: ours, designatorCode: 1688, power: 100, wavelength: 1.064, spotWrtDesignated: { x: 0, y: 0, z: 0 }, spotLocation: moved, deadReckoningAlgorithm: 1, linearAcceleration: { x: 0, y: 0, z: 0 } };
    sender.send(encodeDesignator(laser));
    sender.send(encodeDesignator(laser));
    expect(log.filter((l) => l === 'Alpha 1 is lasing Red 1 (DIS designator, code 1688)')).toHaveLength(1);
    sender.send(encodeDesignator({ ...laser, designatedEntityId: { site: 0, application: 0, entity: 0 } }));
    expect(log).toContain('Alpha 1 is lasing a spot (DIS designator, code 1688)');

    const before = gb.status().pdusReceived;
    sender.send(encodeElectromagneticEmission({ header: HEADER, emittingEntityId: id, eventId: id, stateUpdateIndicator: 0, systems: [] }));
    sender.send(encodeIff({ header: HEADER, emittingEntityId: id, eventId: id, location: { x: 0, y: 0, z: 0 }, system: { type: 1, name: 1, mode: 1, changeOptions: 0 }, systemDesignator: 0, systemSpecificData: 0, operational: { systemStatus: 1, dataField1: 0, informationLayers: 2, dataField2: 0, parameters: [0, 0, 0, 0, 0, 0] } }));
    expect(gb.status().pdusReceived).toBe(before + 2);
    // A truncated PDU is dropped without harm.
    sender.send(encodeIff({ header: HEADER, emittingEntityId: id, eventId: id, location: { x: 0, y: 0, z: 0 }, system: { type: 1, name: 1, mode: 1, changeOptions: 0 }, systemDesignator: 0, systemSpecificData: 0, operational: { systemStatus: 1, dataField1: 0, informationLayers: 2, dataField2: 0, parameters: [] } }).subarray(0, 40));
    expect(gb.status().pdusReceived).toBe(before + 2);
  });
});
