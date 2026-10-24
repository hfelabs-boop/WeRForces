// Cross-check of WeRForces' DIS 7 PDU codec against an independent implementation, the
// open-dis JavaScript library (test/interop/open-dis.ts; fetched by
// scripts/fetch-open-dis.mjs into vendor-test/). For every PDU type WeRForces sends or reads:
// encode with ours -> decode with theirs, and encode with theirs -> decode with ours, and
// compare every field, including the header (version 7, exercise, PDU status bits).
//
// open-dis' DIS 7 build is incomplete for some PDUs (Signal and Receiver lack the radio
// reference id, the Designator lacks the wavelength, Electromagnetic Emission flattens the
// systems, Data Query reads datum records instead of datum ids, and there is no IFF PDU).
// Those layouts did not change from DIS 6 apart from header byte 10 (PDU status, padding in
// DIS 6), so they are checked with open-dis' DIS 6 classes, and byte 10 separately.
//
// Skipped (with a warning) when vendor-test/ is missing; WERFORCES_INTEROP=1 makes that a failure.

import { describe, expect, it } from 'vitest';
import { ecefToGeodetic, enuToEcefVector, geodeticToEcef } from '../src/dis/geodesy.js';
import {
  type DataPdu,
  type DatumRecords,
  decodeActionRequest,
  decodeActionResponse,
  decodeAcknowledge,
  decodeCollision,
  decodeComment,
  decodeCreateEntity,
  decodeData,
  decodeDataQuery,
  decodeDesignator,
  decodeDetonation,
  decodeElectromagneticEmission,
  decodeEntityState,
  decodeEntityStateUpdate,
  decodeFire,
  decodeIff,
  decodeReceiver,
  decodeSignal,
  decodeStartResume,
  decodeStopFreeze,
  decodeTransmitter,
  disTimestamp,
  type ElectromagneticEmissionPdu,
  encodeActionRequest,
  encodeActionResponse,
  encodeAcknowledge,
  encodeCollision,
  encodeComment,
  encodeCreateEntity,
  encodeData,
  encodeDataQuery,
  encodeDesignator,
  encodeDetonation,
  encodeElectromagneticEmission,
  encodeEntityState,
  encodeEntityStateUpdate,
  encodeFire,
  encodeIff,
  encodeReceiver,
  encodeRemoveEntity,
  encodeSetData,
  encodeSignal,
  encodeStartResume,
  encodeStopFreeze,
  encodeTransmitter,
  type EntityId,
  type EntityStatePdu,
  LVC_CONSTRUCTIVE,
  PDU_ACKNOWLEDGE,
  PDU_ACTION_REQUEST,
  PDU_ACTION_RESPONSE,
  PDU_COLLISION,
  PDU_COMMENT,
  PDU_CREATE_ENTITY,
  PDU_DATA,
  PDU_DATA_QUERY,
  PDU_DESIGNATOR,
  PDU_DETONATION,
  PDU_ELECTROMAGNETIC_EMISSION,
  PDU_ENTITY_STATE,
  PDU_ENTITY_STATE_UPDATE,
  PDU_FIRE,
  PDU_IFF,
  PDU_RECEIVER,
  PDU_REMOVE_ENTITY,
  PDU_SET_DATA,
  PDU_SIGNAL,
  PDU_START_RESUME,
  PDU_STOP_FREEZE,
  PDU_TRANSMITTER,
  type PduHeader,
  RAI_ATTACHED,
  STATUS_AII_ACTIVE,
  STATUS_DTI_SHIFT,
  STATUS_FTI_EXPENDABLE,
  STATUS_ISM_INTERACTIVE,
  STATUS_LVC_SHIFT,
  STATUS_RAI_SHIFT,
  STATUS_TEI,
  type VariableParameter,
} from '../src/dis/pdu.js';
import type { DisEntityType, Vec3 } from '../src/shared/types.js';
import { chunkBytes, type DisNamespace, loadOpenDis, type OpenDisObject, theirDecode, theirDecodeWithLength, theirEncode, theirNew, toChunks } from './interop/open-dis.js';

const od = loadOpenDis();
const REQUIRED = process.env.WERFORCES_INTEROP === '1';
if (od.missing) console.warn(`[dis-interop] ${REQUIRED ? 'FAILING' : 'skipping'} the open-dis cross-check: ${od.missing}`);

// ------------------------------------------------------------ helpers

const f = Math.fround;
const f3 = (v: Vec3): Vec3 => ({ x: f(v.x), y: f(v.y), z: f(v.z) });
const vec = (o: OpenDisObject): Vec3 => ({ x: o.x, y: o.y, z: o.z });
const id7 = (o: OpenDisObject): EntityId => ({ site: o.siteID, application: o.applicationID, entity: o.entityID });
const id6 = (o: OpenDisObject): EntityId => ({ site: o.site, application: o.application, entity: o.entity });
const event7 = (o: OpenDisObject): EntityId => ({ site: o.simulationAddress.site, application: o.simulationAddress.application, entity: o.eventNumber });
const event6 = (o: OpenDisObject): EntityId => ({ site: o.site, application: o.application, entity: o.eventNumber });
const type7 = (o: OpenDisObject): DisEntityType => ({ kind: o.entityKind, domain: o.domain, country: o.country, category: o.category, subcategory: o.subcategory, specific: o.specific, extra: o.extra });
const type6 = (o: OpenDisObject): DisEntityType => ({ kind: o.entityKind, domain: o.domain, country: o.country, category: o.category, subcategory: o.subcategory, specific: o.spec, extra: o.extra });

function setId7(o: OpenDisObject, id: EntityId): void {
  o.siteID = id.site;
  o.applicationID = id.application;
  o.entityID = id.entity;
}
function setId6(o: OpenDisObject, id: EntityId): void {
  o.site = id.site;
  o.application = id.application;
  o.entity = id.entity;
}
function setEvent7(o: OpenDisObject, id: EntityId): void {
  o.simulationAddress.site = id.site;
  o.simulationAddress.application = id.application;
  o.eventNumber = id.entity;
}
function setEvent6(o: OpenDisObject, id: EntityId): void {
  o.site = id.site;
  o.application = id.application;
  o.eventNumber = id.entity;
}
function setType(o: OpenDisObject, t: DisEntityType, specificField = 'specific'): void {
  o.entityKind = t.kind;
  o.domain = t.domain;
  o.country = t.country;
  o.category = t.category;
  o.subcategory = t.subcategory;
  o[specificField] = t.specific;
  o.extra = t.extra;
}
function setVec(o: OpenDisObject, v: Vec3): void {
  o.x = v.x;
  o.y = v.y;
  o.z = v.z;
}

/** A DIS 7 header with every field non-trivial: absolute timestamp (LSB 1), constructive. */
function header(status = LVC_CONSTRUCTIVE << STATUS_LVC_SHIFT): PduHeader {
  return { protocolVersion: 7, exerciseId: 42, pduType: 0, protocolFamily: 0, timestamp: disTimestamp(new Date(Date.UTC(2026, 9, 24, 13, 47, 31, 250)), true), length: 0, status };
}

function setHeader7(o: OpenDisObject, h: PduHeader): void {
  o.protocolVersion = h.protocolVersion;
  o.exerciseID = h.exerciseId;
  o.timestamp = h.timestamp;
  o.pduStatus = h.status ?? 0;
}
/** DIS 6 classes read bytes 10-11 as one signed 16-bit "padding": the status byte is its high octet. */
function setHeader6(o: OpenDisObject, h: PduHeader): void {
  o.protocolVersion = h.protocolVersion;
  o.exerciseID = h.exerciseId;
  o.timestamp = h.timestamp;
  o.padding = ((h.status ?? 0) << 24) >> 16;
}

/** Their view of our header: version 7, exercise, type, family, timestamp, length, status, padding. */
function expectHeader7(t: OpenDisObject, h: PduHeader, type: number, family: number, length: number): void {
  expect({ v: t.protocolVersion, ex: t.exerciseID, type: t.pduType, family: t.protocolFamily, ts: t.timestamp, len: t.length, status: t.pduStatus, pad: t.padding }).toEqual({
    v: 7,
    ex: h.exerciseId,
    type,
    family,
    ts: h.timestamp,
    len: length,
    status: h.status,
    pad: 0,
  });
}
function expectHeader6(t: OpenDisObject, h: PduHeader, type: number, family: number, length: number): void {
  expect({ v: t.protocolVersion, ex: t.exerciseID, type: t.pduType, family: t.protocolFamily, ts: t.timestamp, len: t.pduLength, status: (t.padding >> 8) & 0xff, pad: t.padding & 0xff }).toEqual({
    v: 7,
    ex: h.exerciseId,
    type,
    family,
    ts: h.timestamp,
    len: length,
    status: h.status,
    pad: 0,
  });
}
/** Our view of their header. */
function expectOurHeader(h: PduHeader, sent: PduHeader, type: number, family: number, length: number): void {
  expect(h).toEqual({ protocolVersion: 7, exerciseId: sent.exerciseId, pduType: type, protocolFamily: family, timestamp: sent.timestamp, length, status: sent.status });
}

/** Their decoder must consume exactly the PDU (no field missing or extra). */
function decodeAll(ns: DisNamespace, name: string, buf: Uint8Array): OpenDisObject {
  const { pdu, consumed } = theirDecodeWithLength(ns, name, buf);
  expect(consumed, `${name} consumed`).toBe(buf.byteLength);
  return pdu;
}

const BIG = 2n ** 64n;
/** open-dis reads 64-bit fields as signed decimal strings. */
const u64 = (s: string): bigint => (BigInt(s) + BIG) % BIG;
const i64 = (v: bigint): string => BigInt.asIntN(64, v).toString();

function float32FromBits(bits: number): number {
  const dv = new DataView(new ArrayBuffer(4));
  dv.setUint32(0, bits);
  return dv.getFloat32(0);
}
function bitsOfFloat32(v: number): number {
  const dv = new DataView(new ArrayBuffer(4));
  dv.setFloat32(0, v);
  return dv.getUint32(0);
}
function typeFromU64(v: bigint): DisEntityType {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, v);
  return { kind: b[0], domain: b[1], country: (b[2] << 8) | b[3], category: b[4], subcategory: b[5], specific: b[6], extra: b[7] };
}
function u64FromType(t: DisEntityType): bigint {
  const b = Uint8Array.of(t.kind, t.domain, t.country >> 8, t.country & 0xff, t.category, t.subcategory, t.specific, t.extra);
  return new DataView(b.buffer).getBigUint64(0);
}

const T72: DisEntityType = { kind: 1, domain: 1, country: 222, category: 1, subcategory: 2, specific: 6, extra: 1 };
const M1A2: DisEntityType = { kind: 1, domain: 1, country: 225, category: 1, subcategory: 1, specific: 3, extra: 0 };
const ROUND: DisEntityType = { kind: 2, domain: 2, country: 225, category: 2, subcategory: 2, specific: 1, extra: 0 };
const FUEL_TANK: DisEntityType = { kind: 2, domain: 9, country: 225, category: 0, subcategory: 0, specific: 0, extra: 0 };
const NO: EntityId = { site: 0, application: 0, entity: 0 };
const A: EntityId = { site: 65001, application: 3001, entity: 65534 };
const B: EntityId = { site: 7, application: 300, entity: 2 };
const EV: EntityId = { site: 65001, application: 3001, entity: 40001 };
const ECEF: Vec3 = { x: 4_023_456.123456789, y: 702_123.987654321, z: 4_905_678.5 };

const TURRET: VariableParameter = { kind: 'articulated', changeIndicator: 3, partAttachedTo: 0, parameterType: 4096 + 11, value: -1.25 };
const GUN: VariableParameter = { kind: 'articulated', changeIndicator: 1, partAttachedTo: 4096, parameterType: 4416 + 13, value: 0.0625 };
const STATION: VariableParameter = { kind: 'attached', detachedIndicator: 0, partAttachedTo: 0, parameterType: 896, attachedType: FUEL_TANK };

function sampleEntityState(): EntityStatePdu {
  return {
    header: header(),
    entityId: A,
    forceId: 2,
    entityType: T72,
    alternateEntityType: M1A2,
    linearVelocity: { x: -12.5, y: 3.25, z: 0.125 },
    location: ECEF,
    orientation: { psi: 2.5, theta: -0.75, phi: 0.0625 },
    appearance: 0x80c0_8018,
    deadReckoning: {
      algorithm: 4,
      otherParameters: Uint8Array.from({ length: 15 }, (_, i) => i + 1),
      linearAcceleration: { x: 0.5, y: -0.25, z: 9.75 },
      angularVelocity: { x: 0.01, y: -0.02, z: 0.3 },
    },
    marking: 'ABCDEFGHIJK',
    markingCharacterSet: 1,
    capabilities: 0x0000_0102,
    variableParameters: [TURRET, GUN, STATION],
  };
}

/** Check one of our variable parameters against open-dis' generic 16-octet record, re-read with its articulated/attached part classes. */
function expectTheirVariableParameter(ns: DisNamespace, their: OpenDisObject, ours: VariableParameter): void {
  // Re-assemble the 16 octets open-dis read, and decode them with its field-aware classes.
  const b = new Uint8Array(16);
  const dv = new DataView(b.buffer);
  dv.setUint8(0, their.recordType);
  dv.setFloat64(1, their.variableParameterFields1);
  dv.setUint32(9, their.variableParameterFields2);
  dv.setUint16(13, their.variableParameterFields3);
  dv.setUint8(15, their.variableParameterFields4);
  if (ours.kind === 'articulated') {
    const p = theirDecode(ns, 'ArticulatedParts', b);
    const value = u64(p.parameterValue);
    expect({ type: p.recordType, change: p.changeIndicator, attached: p.partAttachedTo, param: p.parameterType, value: float32FromBits(Number(value >> 32n)), pad: Number(value & 0xffffffffn) }).toEqual({
      type: 0,
      change: ours.changeIndicator,
      attached: ours.partAttachedTo,
      param: ours.parameterType,
      value: f(ours.value),
      pad: 0,
    });
  } else if (ours.kind === 'attached') {
    const p = theirDecode(ns, 'AttachedParts', b);
    expect({ type: p.recordType, detached: p.detachedIndicator, attached: p.partAttachedTo, param: p.parameterType, store: typeFromU64(u64(p.parameterValue)) }).toEqual({
      type: 1,
      detached: ours.detachedIndicator,
      attached: ours.partAttachedTo,
      param: ours.parameterType,
      store: ours.attachedType,
    });
  }
}

/** open-dis' articulated or attached part record for one of our variable parameters. */
function theirVariableParameter(ns: DisNamespace, p: VariableParameter): OpenDisObject {
  if (p.kind === 'articulated') {
    const o = theirNew(ns, 'ArticulatedParts');
    Object.assign(o, { recordType: 0, changeIndicator: p.changeIndicator, partAttachedTo: p.partAttachedTo, parameterType: p.parameterType, parameterValue: i64(BigInt(bitsOfFloat32(p.value)) << 32n) });
    return o;
  }
  if (p.kind === 'attached') {
    const o = theirNew(ns, 'AttachedParts');
    Object.assign(o, { recordType: 1, detachedIndicator: p.detachedIndicator, partAttachedTo: p.partAttachedTo, parameterType: p.parameterType, parameterValue: i64(u64FromType(p.attachedType)) });
    return o;
  }
  throw new Error('not used');
}

function expectOurVariableParameters(ours: VariableParameter[] | undefined, sent: VariableParameter[]): void {
  expect(ours).toEqual(sent.map((p) => (p.kind === 'articulated' ? { ...p, value: f(p.value) } : p)));
}

function theirVariableDatum(ns: DisNamespace, id: number, bytes: Uint8Array): OpenDisObject {
  const d = theirNew(ns, 'VariableDatum');
  d.variableDatumID = id;
  d.variableDatumLength = bytes.length * 8;
  d.variableDatumData = toChunks(ns, bytes);
  return d;
}

function theirFixedDatum(ns: DisNamespace, id: number, value: number): OpenDisObject {
  const d = theirNew(ns, 'FixedDatum');
  d.fixedDatumID = id;
  d.fixedDatumValue = value;
  return d;
}

/** Datums for the Set Data/Data/Action PDUs. open-dis does not pad variable datums to 64 bits, so these have whole 64-bit values except the last one. */
const DATUMS: DatumRecords = {
  fixed: [
    { id: 11200, value: 2 },
    { id: 36400, value: bitsOfFloat32(12.5) },
    { id: 0xfffffffe, value: 0x89abcdef },
  ],
  variable: [
    { id: 31200, data: Uint8Array.from({ length: 24 }, (_, i) => (i * 37) & 0xff) },
    { id: 13000, data: new TextEncoder().encode('\u0001T72 LEAD') },
  ],
};

/** Padding after the last variable datum's value, which open-dis does not read. */
const LAST_PAD = (8 - (DATUMS.variable[DATUMS.variable.length - 1].data.length % 8)) % 8;

function expectTheirDatums(t: OpenDisObject, d: DatumRecords): void {
  expect(t.numberOfFixedDatumRecords).toBe(d.fixed.length);
  expect(t.numberOfVariableDatumRecords).toBe(d.variable.length);
  expect(t.fixedDatums.map((x: OpenDisObject) => ({ id: x.fixedDatumID, value: x.fixedDatumValue }))).toEqual(d.fixed);
  expect(t.variableDatums.map((x: OpenDisObject) => ({ id: x.variableDatumID, bits: x.variableDatumLength, data: chunkBytes(x.variableDatumData) }))).toEqual(
    d.variable.map((v) => ({ id: v.id, bits: v.data.length * 8, data: v.data })),
  );
}

function setTheirDatums(ns: DisNamespace, t: OpenDisObject, d: DatumRecords): number {
  t.numberOfFixedDatumRecords = d.fixed.length;
  t.numberOfVariableDatumRecords = d.variable.length;
  t.fixedDatums = d.fixed.map((x) => theirFixedDatum(ns, x.id, x.value));
  t.variableDatums = d.variable.map((v) => theirVariableDatum(ns, v.id, v.data));
  return 8 + d.fixed.length * 8 + d.variable.reduce((n, v) => n + 8 + v.data.length, 0);
}

function expectOurDatums(ours: DatumRecords, d: DatumRecords): void {
  expect(ours.fixed).toEqual(d.fixed);
  expect(ours.variable).toEqual(d.variable.map((v) => ({ id: v.id, data: v.data, bits: v.data.length * 8 })));
}

// ------------------------------------------------------------ tests

describe.runIf(REQUIRED && od.missing)('open-dis cross-check prerequisites', () => {
  it('has the independent implementation', () => {
    throw new Error(od.missing);
  });
});

describe.skipIf(!od.lib)(`DIS 7 cross-check against open-dis ${od.lib?.version ?? ''}`, () => {
  const dis7 = od.lib?.dis7 as DisNamespace;
  const dis6 = od.lib?.dis6 as DisNamespace;

  describe('entity information', () => {
    it('Entity State: ours -> open-dis, every field including dead reckoning, marking and variable parameters', () => {
      const p = sampleEntityState();
      const buf = encodeEntityState(p);
      expect(buf.byteLength).toBe(144 + 3 * 16);
      const t = decodeAll(dis7, 'EntityStatePdu', buf);
      expectHeader7(t, p.header, PDU_ENTITY_STATE, 1, 192);
      expect(id7(t.entityID)).toEqual(p.entityId);
      expect(t.forceId).toBe(p.forceId);
      expect(t.numberOfVariableParameters).toBe(3);
      expect(type7(t.entityType)).toEqual(p.entityType);
      expect(type7(t.alternativeEntityType)).toEqual(p.alternateEntityType);
      expect(vec(t.entityLinearVelocity)).toEqual(f3(p.linearVelocity));
      expect(vec(t.entityLocation)).toEqual(p.location);
      expect({ psi: t.entityOrientation.psi, theta: t.entityOrientation.theta, phi: t.entityOrientation.phi }).toEqual({ psi: f(2.5), theta: f(-0.75), phi: f(0.0625) });
      expect(t.entityAppearance).toBe(p.appearance);
      const dr = t.deadReckoningParameters;
      expect(dr.deadReckoningAlgorithm).toBe(4);
      expect([...dr.parameters]).toEqual([...p.deadReckoning.otherParameters!]);
      expect(vec(dr.entityLinearAcceleration)).toEqual(f3(p.deadReckoning.linearAcceleration));
      expect(vec(dr.entityAngularVelocity)).toEqual(f3(p.deadReckoning.angularVelocity));
      expect(t.marking.characterSet).toBe(1);
      expect(t.marking.getMarking()).toBe('ABCDEFGHIJK');
      expect(t.capabilities).toBe(p.capabilities);
      p.variableParameters!.forEach((vp, i) => expectTheirVariableParameter(dis7, t.variableParameters[i], vp));
    });

    it('Entity State: ours -> open-dis, short marking is NUL-padded, no variable parameters', () => {
      const p = { ...sampleEntityState(), marking: 'T72', variableParameters: [] };
      const buf = encodeEntityState(p);
      const t = decodeAll(dis7, 'EntityStatePdu', buf);
      expect(t.length).toBe(144);
      expect(t.marking.getMarking()).toBe('T72');
      expect([...t.marking.characters]).toEqual([84, 55, 50, 0, 0, 0, 0, 0, 0, 0, 0]);
      expect(t.numberOfVariableParameters).toBe(0);
    });

    it('Entity State: open-dis -> ours, every field', () => {
      const p = sampleEntityState();
      const t = theirNew(dis7, 'EntityStatePdu');
      setHeader7(t, p.header);
      setId7(t.entityID, p.entityId);
      t.forceId = p.forceId;
      setType(t.entityType, p.entityType);
      setType(t.alternativeEntityType, p.alternateEntityType);
      setVec(t.entityLinearVelocity, p.linearVelocity);
      setVec(t.entityLocation, p.location);
      Object.assign(t.entityOrientation, p.orientation);
      t.entityAppearance = p.appearance;
      const dr = t.deadReckoningParameters;
      dr.deadReckoningAlgorithm = 4;
      dr.parameters = [...p.deadReckoning.otherParameters!];
      setVec(dr.entityLinearAcceleration, p.deadReckoning.linearAcceleration);
      setVec(dr.entityAngularVelocity, p.deadReckoning.angularVelocity);
      t.marking.characterSet = 1;
      t.marking.setMarking('ABCDEFGHIJK');
      t.capabilities = p.capabilities;
      t.variableParameters = p.variableParameters!.map((vp) => theirVariableParameter(dis7, vp));
      t.numberOfVariableParameters = 3;
      const ours = decodeEntityState(theirEncode(dis7, t, 192));
      expectOurHeader(ours.header, p.header, PDU_ENTITY_STATE, 1, 192);
      expect(ours.entityId).toEqual(p.entityId);
      expect(ours.forceId).toBe(2);
      expect(ours.entityType).toEqual(T72);
      expect(ours.alternateEntityType).toEqual(M1A2);
      expect(ours.linearVelocity).toEqual(f3(p.linearVelocity));
      expect(ours.location).toEqual(p.location);
      expect(ours.orientation).toEqual({ psi: f(2.5), theta: f(-0.75), phi: f(0.0625) });
      expect(ours.appearance).toBe(p.appearance);
      expect(ours.deadReckoning).toEqual({ algorithm: 4, otherParameters: p.deadReckoning.otherParameters, linearAcceleration: f3(p.deadReckoning.linearAcceleration), angularVelocity: f3(p.deadReckoning.angularVelocity) });
      expect(ours.marking).toBe('ABCDEFGHIJK');
      expect(ours.markingCharacterSet).toBe(1);
      expect(ours.capabilities).toBe(p.capabilities);
      expectOurVariableParameters(ours.variableParameters, p.variableParameters!);
    });

    it('Entity State Update: both directions', () => {
      const p = { header: header(), entityId: B, linearVelocity: { x: 1, y: -2, z: 3.5 }, location: ECEF, orientation: { psi: -3, theta: 0.5, phi: 1.5 }, appearance: 0x0080_0000, variableParameters: [TURRET] };
      const buf = encodeEntityStateUpdate(p);
      const t = decodeAll(dis7, 'EntityStateUpdatePdu', buf);
      expectHeader7(t, p.header, PDU_ENTITY_STATE_UPDATE, 1, 88);
      expect(id7(t.entityID)).toEqual(B);
      expect(t.padding1).toBe(0);
      expect(t.numberOfVariableParameters).toBe(1);
      expect(vec(t.entityLinearVelocity)).toEqual(f3(p.linearVelocity));
      expect(vec(t.entityLocation)).toEqual(ECEF);
      expect(t.entityOrientation.psi).toBe(f(-3));
      expect(t.entityOrientation.phi).toBe(f(1.5));
      expect(t.entityAppearance).toBe(p.appearance);
      expectTheirVariableParameter(dis7, t.variableParameters[0], TURRET);

      t.variableParameters = [theirVariableParameter(dis7, GUN)];
      t.entityAppearance = 0x18;
      const ours = decodeEntityStateUpdate(theirEncode(dis7, t, 88));
      expectOurHeader(ours.header, p.header, PDU_ENTITY_STATE_UPDATE, 1, 88);
      expect(ours.entityId).toEqual(B);
      expect(ours.linearVelocity).toEqual(f3(p.linearVelocity));
      expect(ours.location).toEqual(ECEF);
      expect(ours.orientation).toEqual({ psi: f(-3), theta: f(0.5), phi: f(1.5) });
      expect(ours.appearance).toBe(0x18);
      expectOurVariableParameters(ours.variableParameters, [GUN]);
    });

    it('Collision: both directions', () => {
      const p = { header: header(), issuingEntityId: A, collidingEntityId: B, eventId: EV, collisionType: 1, velocity: { x: 5.5, y: -1, z: 0 }, mass: 62000, location: { x: 3.25, y: -1.5, z: -0.75 } };
      const buf = encodeCollision(p);
      const t = decodeAll(dis7, 'CollisionPdu', buf);
      expectHeader7(t, p.header, PDU_COLLISION, 1, 60);
      expect(id7(t.issuingEntityID)).toEqual(A);
      expect(id7(t.collidingEntityID)).toEqual(B);
      expect(event7(t.eventID)).toEqual(EV);
      expect(t.collisionType).toBe(1);
      expect(vec(t.velocity)).toEqual(f3(p.velocity));
      expect(t.mass).toBe(62000);
      expect(vec(t.location)).toEqual(f3(p.location));

      t.collisionType = 0;
      t.mass = 1234.5;
      const ours = decodeCollision(theirEncode(dis7, t, 60));
      expectOurHeader(ours.header, p.header, PDU_COLLISION, 1, 60);
      expect(ours).toMatchObject({ issuingEntityId: A, collidingEntityId: B, eventId: EV, collisionType: 0, velocity: f3(p.velocity), mass: 1234.5, location: f3(p.location) });
    });
  });

  describe('warfare', () => {
    const burst = { munition: ROUND, warhead: 5000, fuse: 1000, quantity: 3, rate: 600 };

    it('Fire: both directions', () => {
      const p = { header: header(), firingEntityId: A, targetEntityId: B, munitionId: { site: 1, application: 2, entity: 3 }, eventId: EV, fireMissionIndex: 0xfedc_ba98, location: ECEF, burst, velocity: { x: 1500, y: -20, z: 7 }, range: 2345.5 };
      const buf = encodeFire(p);
      const t = decodeAll(dis7, 'FirePdu', buf);
      expectHeader7(t, p.header, PDU_FIRE, 2, 96);
      expect(id7(t.firingEntityID)).toEqual(A);
      expect(id7(t.targetEntityID)).toEqual(B);
      expect(id7(t.munitionExpendibleID)).toEqual(p.munitionId);
      expect(event7(t.eventID)).toEqual(EV);
      expect(t.fireMissionIndex).toBe(p.fireMissionIndex);
      expect(vec(t.locationInWorldCoordinates)).toEqual(ECEF);
      expect(type7(t.descriptor.munitionType)).toEqual(ROUND);
      expect([t.descriptor.warhead, t.descriptor.fuse, t.descriptor.quantity, t.descriptor.rate]).toEqual([5000, 1000, 3, 600]);
      expect(vec(t.velocity)).toEqual(f3(p.velocity));
      expect(t.range).toBe(2345.5);

      t.pduStatus = (LVC_CONSTRUCTIVE << STATUS_LVC_SHIFT) | STATUS_FTI_EXPENDABLE;
      const ours = decodeFire(theirEncode(dis7, t, 96));
      expectOurHeader(ours.header, { ...p.header, status: 6 | STATUS_FTI_EXPENDABLE }, PDU_FIRE, 2, 96);
      expect(ours).toMatchObject({ firingEntityId: A, targetEntityId: B, munitionId: p.munitionId, eventId: EV, fireMissionIndex: p.fireMissionIndex, location: ECEF, burst, velocity: f3(p.velocity), range: 2345.5 });
    });

    it('Detonation: both directions, with variable parameters', () => {
      const status = (LVC_CONSTRUCTIVE << STATUS_LVC_SHIFT) | (2 << STATUS_DTI_SHIFT);
      const p = { header: header(status), firingEntityId: A, targetEntityId: B, munitionId: NO, eventId: EV, velocity: { x: -300, y: 2, z: -50 }, location: ECEF, burst, locationInEntity: { x: 1, y: 0.5, z: -1.25 }, result: 1, variableParameters: [TURRET, STATION] };
      const buf = encodeDetonation(p);
      const t = decodeAll(dis7, 'DetonationPdu', buf);
      expectHeader7(t, p.header, PDU_DETONATION, 2, 136);
      expect(id7(t.firingEntityID)).toEqual(A);
      expect(id7(t.targetEntityID)).toEqual(B);
      expect(id7(t.explodingEntityID)).toEqual(NO);
      expect(event7(t.eventID)).toEqual(EV);
      expect(vec(t.velocity)).toEqual(f3(p.velocity));
      expect(vec(t.locationInWorldCoordinates)).toEqual(ECEF);
      expect(type7(t.descriptor.munitionType)).toEqual(ROUND);
      expect(t.descriptor.quantity).toBe(3);
      expect(vec(t.locationOfEntityCoordinates)).toEqual(f3(p.locationInEntity));
      expect(t.detonationResult).toBe(1);
      expect(t.numberOfVariableParameters).toBe(2);
      expect(t.pad).toBe(0);
      expectTheirVariableParameter(dis7, t.variableParameters[0], TURRET);
      expectTheirVariableParameter(dis7, t.variableParameters[1], STATION);

      t.detonationResult = 3;
      t.variableParameters = [theirVariableParameter(dis7, GUN)];
      t.numberOfVariableParameters = 1;
      const ours = decodeDetonation(theirEncode(dis7, t, 120));
      expectOurHeader(ours.header, p.header, PDU_DETONATION, 2, 120);
      expect(ours).toMatchObject({ firingEntityId: A, targetEntityId: B, munitionId: NO, eventId: EV, velocity: f3(p.velocity), location: ECEF, burst, locationInEntity: f3(p.locationInEntity), result: 3 });
      expectOurVariableParameters(ours.variableParameters, [GUN]);
    });

    it('Designator: both directions (DIS 6 classes; open-dis DIS 7 omits the wavelength)', () => {
      const p = { header: header(), designatingEntityId: A, codeName: 1234, designatedEntityId: B, designatorCode: 1688, power: 120.5, wavelength: 1.064, spotWrtDesignated: { x: 0.5, y: -0.25, z: -1 }, spotLocation: ECEF, deadReckoningAlgorithm: 2, linearAcceleration: { x: 0, y: 0.5, z: -0.125 } };
      const buf = encodeDesignator(p);
      const t = decodeAll(dis6, 'DesignatorPdu', buf);
      expectHeader6(t, p.header, PDU_DESIGNATOR, 2, 88);
      expect(id6(t.designatingEntityID)).toEqual(A);
      expect(t.codeName).toBe(1234);
      expect(id6(t.designatedEntityID)).toEqual(B);
      expect(t.designatorCode).toBe(1688);
      expect(t.designatorPower).toBe(f(120.5));
      expect(t.designatorWavelength).toBe(f(1.064));
      expect(vec(t.designatorSpotWrtDesignated)).toEqual(f3(p.spotWrtDesignated));
      expect(vec(t.designatorSpotLocation)).toEqual(ECEF);
      expect(t.deadReckoningAlgorithm).toBe(2);
      expect([t.padding1, t.padding2]).toEqual([0, 0]);
      expect(vec(t.entityLinearAcceleration)).toEqual(f3(p.linearAcceleration));

      t.designatorCode = 1111;
      t.designatorPower = 0;
      const ours = decodeDesignator(theirEncode(dis6, t, 88));
      expectOurHeader(ours.header, p.header, PDU_DESIGNATOR, 2, 88);
      expect(ours).toMatchObject({ designatingEntityId: A, codeName: 1234, designatedEntityId: B, designatorCode: 1111, power: 0, wavelength: f(1.064), spotWrtDesignated: f3(p.spotWrtDesignated), spotLocation: ECEF, deadReckoningAlgorithm: 2, linearAcceleration: f3(p.linearAcceleration) });
    });
  });

  describe('simulation management', () => {
    const NOW = { hour: 497_413, timePastHour: disTimestamp(new Date(Date.UTC(2026, 9, 24, 13, 5, 0))) };
    const SIM = { hour: 2, timePastHour: 0x1234_5678 };
    const siman = { header: header(), originatingId: A, receivingId: { site: 0xffff, application: 0xffff, entity: 0xffff } };

    function expectTheirSiman(t: OpenDisObject, type: number, length: number): void {
      expectHeader7(t, siman.header, type, 5, length);
      expect(id7(t.originatingEntityID)).toEqual(A);
      expect(id7(t.receivingEntityID)).toEqual(siman.receivingId);
    }
    function setTheirSiman(t: OpenDisObject): void {
      setHeader7(t, siman.header);
      setId7(t.originatingEntityID, B);
      setId7(t.receivingEntityID, A);
    }
    function expectOurSiman(ours: { header: PduHeader; originatingId: EntityId; receivingId: EntityId }, type: number, length: number): void {
      expectOurHeader(ours.header, siman.header, type, 5, length);
      expect(ours.originatingId).toEqual(B);
      expect(ours.receivingId).toEqual(A);
    }

    it('Create Entity and Remove Entity: both directions', () => {
      for (const [type, encode, name] of [
        [PDU_CREATE_ENTITY, encodeCreateEntity, 'CreateEntityPdu'],
        [PDU_REMOVE_ENTITY, encodeRemoveEntity, 'RemoveEntityPdu'],
      ] as const) {
        const t = decodeAll(dis7, name, encode({ ...siman, requestId: 0xdead_beef }));
        expectTheirSiman(t, type, 28);
        expect(t.requestID).toBe(0xdead_beef);
        setTheirSiman(t);
        t.requestID = 77;
        const ours = decodeCreateEntity(theirEncode(dis7, t, 28));
        expectOurSiman(ours, type, 28);
        expect(ours.requestId).toBe(77);
      }
    });

    it('Start/Resume: both directions', () => {
      const t = decodeAll(dis7, 'StartResumePdu', encodeStartResume({ ...siman, realWorldTime: NOW, simulationTime: SIM, requestId: 9 }));
      expectTheirSiman(t, PDU_START_RESUME, 44);
      expect([t.realWorldTime.hour, t.realWorldTime.timePastHour.timestamp]).toEqual([NOW.hour, NOW.timePastHour]);
      expect([t.simulationTime.hour, t.simulationTime.timePastHour.timestamp]).toEqual([SIM.hour, SIM.timePastHour]);
      expect(t.requestID).toBe(9);
      setTheirSiman(t);
      t.simulationTime.hour = 5;
      const ours = decodeStartResume(theirEncode(dis7, t, 44));
      expectOurSiman(ours, PDU_START_RESUME, 44);
      expect(ours).toMatchObject({ realWorldTime: NOW, simulationTime: { ...SIM, hour: 5 }, requestId: 9 });
    });

    it('Stop/Freeze: both directions', () => {
      const t = decodeAll(dis7, 'StopFreezePdu', encodeStopFreeze({ ...siman, realWorldTime: NOW, reason: 6, frozenBehavior: 3, requestId: 10 }));
      expectTheirSiman(t, PDU_STOP_FREEZE, 40);
      expect([t.realWorldTime.hour, t.realWorldTime.timePastHour.timestamp, t.reason, t.frozenBehavior, t.padding1, t.requestID]).toEqual([NOW.hour, NOW.timePastHour, 6, 3, 0, 10]);
      setTheirSiman(t);
      t.reason = 1;
      const ours = decodeStopFreeze(theirEncode(dis7, t, 40));
      expectOurSiman(ours, PDU_STOP_FREEZE, 40);
      expect(ours).toMatchObject({ realWorldTime: NOW, reason: 1, frozenBehavior: 3, requestId: 10 });
    });

    it('Acknowledge: both directions', () => {
      const t = decodeAll(dis7, 'AcknowledgePdu', encodeAcknowledge({ ...siman, acknowledgeFlag: 4, responseFlag: 2, requestId: 11 }));
      expectTheirSiman(t, PDU_ACKNOWLEDGE, 32);
      expect([t.acknowledgeFlag, t.responseFlag, t.requestID]).toEqual([4, 2, 11]);
      setTheirSiman(t);
      t.acknowledgeFlag = 3;
      t.responseFlag = 1;
      const ours = decodeAcknowledge(theirEncode(dis7, t, 32));
      expectOurSiman(ours, PDU_ACKNOWLEDGE, 32);
      expect(ours).toMatchObject({ acknowledgeFlag: 3, responseFlag: 1, requestId: 11 });
    });

    it('Comment: both directions', () => {
      const text = 'Bookmark: H-hour'; // 16 octets, a whole number of 64-bit words
      const buf = encodeComment({ ...siman, texts: [{ datumId: 0, text }] });
      const t = decodeAll(dis7, 'CommentPdu', buf);
      expectTheirSiman(t, PDU_COMMENT, 56);
      expect(t.numberOfFixedDatumRecords).toBe(0);
      expect(t.numberOfVariableDatumRecords).toBe(1);
      expect(t.variableDatums[0].variableDatumID).toBe(0);
      expect(t.variableDatums[0].variableDatumLength).toBe(128);
      expect(new TextDecoder().decode(chunkBytes(t.variableDatums[0].variableDatumData))).toBe(text);

      setTheirSiman(t);
      t.variableDatums = [theirVariableDatum(dis7, 0, new TextEncoder().encode('ENDEX in 5'))];
      const ours = decodeComment(theirEncode(dis7, t, 24 + 8 + 8 + 10));
      expectOurSiman(ours, PDU_COMMENT, 50);
      expect(ours.texts).toEqual([{ datumId: 0, text: 'ENDEX in 5' }]);
    });

    it('Set Data and Data: both directions, fixed and variable datums', () => {
      for (const [type, encode, name] of [
        [PDU_SET_DATA, encodeSetData, 'SetDataPdu'],
        [PDU_DATA, encodeData, 'DataPdu'],
      ] as const) {
        const p: DataPdu = { ...siman, requestId: 0x0102_0304, ...DATUMS };
        const buf = encode(p);
        const length = 32 + 8 + 24 + 8 + 24 + 8 + 16;
        expect(buf.byteLength).toBe(length);
        const t = decodeAll(dis7, name, buf.subarray(0, length - LAST_PAD)); // open-dis does not read the last datum's padding
        expectTheirSiman(t, type, length);
        expect([t.requestID, t.padding1]).toEqual([0x0102_0304, 0]);
        expectTheirDatums(t, DATUMS);

        setTheirSiman(t);
        t.requestID = 5;
        const n = setTheirDatums(dis7, t, DATUMS);
        const ours = decodeData(theirEncode(dis7, t, 32 + n));
        expectOurSiman(ours, type, 32 + n);
        expect(ours.requestId).toBe(5);
        expectOurDatums(ours, DATUMS);
      }
    });

    it('Action Request and Action Response: both directions', () => {
      const req = encodeActionRequest({ ...siman, requestId: 21, actionId: 0xabcd, ...DATUMS });
      const t = decodeAll(dis7, 'ActionRequestPdu', req.subarray(0, req.byteLength - LAST_PAD));
      expectTheirSiman(t, PDU_ACTION_REQUEST, req.byteLength);
      expect([t.requestID, t.actionID]).toEqual([21, 0xabcd]);
      expectTheirDatums(t, DATUMS);
      setTheirSiman(t);
      t.actionID = 7;
      const ours = decodeActionRequest(theirEncode(dis7, t, 32 + setTheirDatums(dis7, t, DATUMS)));
      expectOurSiman(ours, PDU_ACTION_REQUEST, ours.header.length);
      expect([ours.requestId, ours.actionId]).toEqual([21, 7]);
      expectOurDatums(ours, DATUMS);

      const res = encodeActionResponse({ ...siman, requestId: 21, requestStatus: 5, fixed: [], variable: [] });
      const r = decodeAll(dis7, 'ActionResponsePdu', res);
      expectTheirSiman(r, PDU_ACTION_RESPONSE, 40);
      expect([r.requestID, r.requestStatus, r.numberOfFixedDatumRecords, r.numberOfVariableDatumRecords]).toEqual([21, 5, 0, 0]);
      setTheirSiman(r);
      r.requestStatus = 4;
      const back = decodeActionResponse(theirEncode(dis7, r, 32 + setTheirDatums(dis7, r, DATUMS)));
      expectOurSiman(back, PDU_ACTION_RESPONSE, back.header.length);
      expect(back.requestStatus).toBe(4);
      expectOurDatums(back, DATUMS);
    });

    it('Data Query: both directions (DIS 6 classes; open-dis DIS 7 reads datum records instead of datum ids)', () => {
      const p = { ...siman, requestId: 31, timeInterval: 0x0100_0000, fixedIds: [11200, 33000, 36400], variableIds: [11000, 13000, 31200, 32000] };
      const buf = encodeDataQuery(p);
      const t = decodeAll(dis6, 'DataQueryPdu', buf);
      expectHeader6(t, p.header, PDU_DATA_QUERY, 5, 68);
      expect(id6(t.originatingEntityID)).toEqual(A);
      expect(id6(t.receivingEntityID)).toEqual(siman.receivingId);
      expect([t.requestID, t.timeInterval, t.numberOfFixedDatumRecords, t.numberOfVariableDatumRecords]).toEqual([31, 0x0100_0000, 3, 4]);
      expect(t.fixedDatums.map((d: OpenDisObject) => d.wrapper)).toEqual(p.fixedIds);
      expect(t.variableDatums.map((d: OpenDisObject) => d.wrapper)).toEqual(p.variableIds);

      setHeader6(t, p.header);
      setId6(t.originatingEntityID, B);
      setId6(t.receivingEntityID, A);
      t.timeInterval = 0;
      t.fixedDatums = t.fixedDatums.slice(0, 1);
      t.numberOfFixedDatumRecords = 1;
      const ours = decodeDataQuery(theirEncode(dis6, t, 60));
      expectOurHeader(ours.header, p.header, PDU_DATA_QUERY, 5, 60);
      expect(ours).toMatchObject({ originatingId: B, receivingId: A, requestId: 31, timeInterval: 0, fixedIds: [11200], variableIds: p.variableIds });
    });
  });

  describe('radio communications', () => {
    const status = (LVC_CONSTRUCTIVE << STATUS_LVC_SHIFT) | (RAI_ATTACHED << STATUS_RAI_SHIFT);
    const radioType = { kind: 7, domain: 1, country: 225, category: 3, subcategory: 4, specific: 5, extra: 6 };

    it('Transmitter: both directions, 64-bit frequency', () => {
      const p = {
        header: header(status),
        radioReferenceId: A,
        radioNumber: 3,
        radioType,
        transmitState: 2,
        inputSource: 7,
        antennaLocation: ECEF,
        relativeAntennaLocation: { x: 0.5, y: 0, z: -3 },
        frequency: 9_876_543_210_123,
        bandwidth: 25_000,
        power: 40.5,
        modulation: { spreadSpectrum: 0, majorModulation: 1, detail: 2, radioSystem: 1 },
        cryptoSystem: 4,
        cryptoKeyId: 0x8001,
      };
      const buf = encodeTransmitter(p);
      const t = decodeAll(dis7, 'TransmitterPdu', buf);
      expectHeader7(t, p.header, PDU_TRANSMITTER, 4, 104);
      expect(id7(t.radioReferenceID)).toEqual(A);
      expect(t.radioNumber).toBe(3);
      expect(type7(t.radioEntityType)).toEqual(radioType);
      expect([t.transmitState, t.inputSource, t.variableTransmitterParameterCount]).toEqual([2, 7, 0]);
      expect(vec(t.antennaLocation)).toEqual(ECEF);
      expect(vec(t.relativeAntennaLocation)).toEqual(f3(p.relativeAntennaLocation));
      expect([t.antennaPatternType, t.antennaPatternCount]).toEqual([0, 0]);
      expect(u64(t.frequency)).toBe(9_876_543_210_123n);
      expect(t.transmitFrequencyBandwidth).toBe(25_000);
      expect(t.power).toBe(40.5);
      const m = t.modulationType;
      expect([m.spreadSpectrum, m.majorModulation, m.detail, m.radioSystem]).toEqual([0, 1, 2, 1]);
      expect([t.cryptoSystem, t.cryptoKeyId, t.modulationParameterCount]).toEqual([4, 0x8001, 0]);

      t.frequency = '30025000';
      t.transmitState = 0;
      const ours = decodeTransmitter(theirEncode(dis7, t, 104));
      expectOurHeader(ours.header, p.header, PDU_TRANSMITTER, 4, 104);
      expect(ours).toMatchObject({ ...p, header: ours.header, frequency: 30_025_000, transmitState: 0, relativeAntennaLocation: f3(p.relativeAntennaLocation) });
    });

    it('Signal: both directions (DIS 6 classes; open-dis DIS 7 omits the radio reference id)', () => {
      const data = new TextEncoder().encode('contact, 3 T-72'); // 15 octets: padded to 16
      const p = { header: header(status), radioReferenceId: A, radioNumber: 1, encodingScheme: (1 << 14) | 1, tdlType: 0, sampleRate: 0, samples: 1, data };
      const buf = encodeSignal(p);
      expect(buf.byteLength).toBe(48);
      const t = theirDecode(dis6, 'SignalPdu', buf);
      expectHeader6(t, p.header, PDU_SIGNAL, 4, 48);
      expect(id6(t.entityId)).toEqual(A);
      expect([t.radioId, t.encodingScheme, t.tdlType, t.sampleRate, t.dataLength, t.samples]).toEqual([1, (1 << 14) | 1, 0, 0, 120, 1]);
      expect(chunkBytes(t.data)).toEqual(data);

      // open-dis' DIS 6 Signal encoder writes `samples` octets of data (it should write dataLength / 8).
      setHeader6(t, p.header);
      t.encodingScheme = (2 << 14) | 5;
      t.tdlType = 100;
      t.sampleRate = 8000;
      t.samples = 16;
      t.data = toChunks(dis6, new TextEncoder().encode('sixteen octets!!'));
      t.dataLength = 128;
      const ours = decodeSignal(theirEncode(dis6, t, 48));
      expectOurHeader(ours.header, p.header, PDU_SIGNAL, 4, 48);
      expect(ours).toMatchObject({ radioReferenceId: A, radioNumber: 1, encodingScheme: (2 << 14) | 5, tdlType: 100, sampleRate: 8000, samples: 16, dataBits: 128 });
      expect(new TextDecoder().decode(ours.data)).toBe('sixteen octets!!');
    });

    it('Receiver: both directions (DIS 6 classes; open-dis DIS 7 omits the radio reference id)', () => {
      const p = { header: header(status), radioReferenceId: A, radioNumber: 2, receiverState: 2, receivedPower: -87.25, transmitterEntityId: B, transmitterRadioId: 4 };
      const t = decodeAll(dis6, 'ReceiverPdu', encodeReceiver(p));
      expectHeader6(t, p.header, PDU_RECEIVER, 4, 36);
      expect(id6(t.entityId)).toEqual(A);
      expect([t.radioId, t.receiverState, t.padding1, t.receivedPower, t.transmitterRadioId]).toEqual([2, 2, 0, -87.25, 4]);
      expect(id6(t.transmitterEntityId)).toEqual(B);
      t.receiverState = 1;
      t.receivedPower = 0;
      const ours = decodeReceiver(theirEncode(dis6, t, 36));
      expectOurHeader(ours.header, p.header, PDU_RECEIVER, 4, 36);
      expect(ours).toMatchObject({ radioReferenceId: A, radioNumber: 2, receiverState: 1, receivedPower: 0, transmitterEntityId: B, transmitterRadioId: 4 });
    });
  });

  describe('distributed emission regeneration', () => {
    function sampleEmission(): ElectromagneticEmissionPdu {
      const beam = {
        beamId: 1,
        beamParameterIndex: 7,
        frequency: 9.5e9,
        frequencyRange: 5e8,
        erp: 80,
        prf: 3000,
        pulseWidth: 1.5,
        azimuthCenter: 0.25,
        azimuthSweep: Math.PI / 3,
        elevationCenter: -0.1,
        elevationSweep: 0.5,
        sweepSync: 12.5,
        beamFunction: 4,
        highDensityTrackJam: 0,
        beamStatus: 0,
        jammingTechnique: 0x0102_0304,
        targets: [{ entityId: B, emitterNumber: 0, beamNumber: 0 }],
      };
      return {
        header: header(),
        emittingEntityId: A,
        eventId: EV,
        stateUpdateIndicator: 1,
        systems: [
          { name: 1890, function: 4, number: 1, location: { x: 4, y: 0, z: -1 }, beams: [beam, { ...beam, beamId: 2, beamFunction: 1, targets: [] }] },
          { name: 0, function: 42, number: 2, location: { x: 0, y: 0, z: -2.5 }, beams: [] },
        ],
      };
    }

    it('Electromagnetic Emission: both directions (DIS 6 classes; open-dis DIS 7 flattens the emitter systems)', () => {
      const p = sampleEmission();
      const buf = encodeElectromagneticEmission(p);
      expect(buf.byteLength).toBe(28 + 20 + 60 + 52 + 20);
      const t = decodeAll(dis6, 'ElectronicEmissionsPdu', buf);
      expectHeader6(t, p.header, PDU_ELECTROMAGNETIC_EMISSION, 6, 180);
      expect(id6(t.emittingEntityID)).toEqual(A);
      expect(event6(t.eventID)).toEqual(EV);
      expect([t.stateUpdateIndicator, t.numberOfSystems, t.paddingForEmissionsPdu]).toEqual([1, 2, 0]);
      const theirSystems = t.systems.map((s: OpenDisObject) => ({
        words: s.systemDataLength,
        name: s.emitterSystem.emitterName,
        function: s.emitterSystem.function,
        number: s.emitterSystem.emitterIdNumber,
        location: vec(s.location),
        beams: s.beamDataRecords.map((b: OpenDisObject) => {
          const fp = b.fundamentalParameterData;
          return {
            words: b.beamDataLength,
            beamId: b.beamIDNumber,
            beamParameterIndex: b.beamParameterIndex,
            frequency: fp.frequency,
            frequencyRange: fp.frequencyRange,
            erp: fp.effectiveRadiatedPower,
            prf: fp.pulseRepetitionFrequency,
            pulseWidth: fp.pulseWidth,
            azimuthCenter: fp.beamAzimuthCenter,
            azimuthSweep: fp.beamAzimuthSweep,
            elevationCenter: fp.beamElevationCenter,
            elevationSweep: fp.beamElevationSweep,
            sweepSync: fp.beamSweepSync,
            beamFunction: b.beamFunction,
            highDensityTrackJam: b.highDensityTrackJam,
            beamStatus: b.pad4,
            jammingTechnique: b.jammingModeSequence,
            targets: b.trackJamTargets.map((x: OpenDisObject) => ({ entityId: id6(x.trackJam), emitterNumber: x.emitterID, beamNumber: x.beamID })),
          };
        }),
      }));
      const f32Beam = (b: ElectromagneticEmissionPdu['systems'][0]['beams'][0]) => ({
        ...b,
        words: (52 + 8 * b.targets.length) / 4,
        frequency: f(b.frequency),
        frequencyRange: f(b.frequencyRange),
        pulseWidth: f(b.pulseWidth),
        azimuthCenter: f(b.azimuthCenter),
        azimuthSweep: f(b.azimuthSweep),
        elevationCenter: f(b.elevationCenter),
        elevationSweep: f(b.elevationSweep),
      });
      expect(theirSystems).toEqual(
        p.systems.map((s) => ({ ...s, words: (20 + s.beams.reduce((n, b) => n + 52 + 8 * b.targets.length, 0)) / 4, location: f3(s.location), beams: s.beams.map(f32Beam) })),
      );

      // Back: drop the second beam's target-free twin and the jammer, change values.
      setHeader6(t, p.header);
      t.stateUpdateIndicator = 0;
      t.systems = t.systems.slice(0, 1);
      t.numberOfSystems = 1;
      const sys = t.systems[0];
      sys.beamDataRecords = sys.beamDataRecords.slice(0, 1);
      sys.numberOfBeams = 1;
      sys.systemDataLength = (20 + 60) / 4;
      sys.beamDataRecords[0].fundamentalParameterData.effectiveRadiatedPower = 66;
      const ours = decodeElectromagneticEmission(theirEncode(dis6, t, 28 + 80));
      expectOurHeader(ours.header, p.header, PDU_ELECTROMAGNETIC_EMISSION, 6, 108);
      expect(ours.emittingEntityId).toEqual(A);
      expect(ours.eventId).toEqual(EV);
      expect(ours.stateUpdateIndicator).toBe(0);
      const { words: _w, ...beam } = f32Beam(p.systems[0].beams[0]);
      expect(ours.systems).toEqual([{ ...p.systems[0], location: f3(p.systems[0].location), beams: [{ ...beam, erp: 66 }] }]);
    });

    it('IFF (layer 1): both directions (DIS 6 IFF/ATC/NAVAIDS layer 1 classes; open-dis DIS 7 has no IFF PDU)', () => {
      const status = (LVC_CONSTRUCTIVE << STATUS_LVC_SHIFT) | STATUS_ISM_INTERACTIVE | STATUS_AII_ACTIVE;
      const p = {
        header: header(status),
        emittingEntityId: A,
        eventId: EV,
        location: { x: 0, y: 0, z: -2 },
        system: { type: 1, name: 2, mode: 3, changeOptions: 0x81 },
        systemDesignator: 4,
        systemSpecificData: 5,
        operational: { systemStatus: 0x0f, dataField1: 6, informationLayers: 0x02, dataField2: 7, parameters: [0x1001, 0x2002, 0x3003, 0x4004, 0x5005, 0x6006] },
      };
      const t = decodeAll(dis6, 'IffAtcNavAidsLayer1Pdu', encodeIff(p));
      expectHeader6(t, p.header, PDU_IFF, 6, 60);
      expect(id6(t.emittingEntityId)).toEqual(A);
      expect(event6(t.eventID)).toEqual(EV);
      expect(vec(t.location)).toEqual(p.location);
      expect([t.systemID.systemType, t.systemID.systemName, t.systemID.systemMode, t.systemID.changeOptions]).toEqual([1, 2, 3, 0x81]);
      expect(t.pad2).toBe((4 << 8) | 5); // DIS 7 system designator and system specific data
      const fd = t.fundamentalParameters;
      expect([fd.systemStatus, fd.alternateParameter4, fd.informationLayers, fd.modifier]).toEqual([0x0f, 6, 0x02, 7]);
      expect([fd.parameter1, fd.parameter2, fd.parameter3, fd.parameter4, fd.parameter5, fd.parameter6]).toEqual(p.operational.parameters);

      fd.parameter3 = 0x7777;
      t.systemID.systemMode = 1;
      const ours = decodeIff(theirEncode(dis6, t, 60));
      expectOurHeader(ours.header, p.header, PDU_IFF, 6, 60);
      expect(ours).toMatchObject({ ...p, header: ours.header, system: { ...p.system, mode: 1 }, operational: { ...p.operational, parameters: [0x1001, 0x2002, 0x7777, 0x4004, 0x5005, 0x6006] } });
    });
  });

  describe('header and records', () => {
    it('PDU status bits are where the standard puts them; DIS 6 PDUs get padding instead', () => {
      // TEI bit 0, LVC bits 1-2, CEI bit 3, type-specific bits 4-5 (IEEE 1278.1-2012 6.2.67).
      const status = STATUS_TEI | (LVC_CONSTRUCTIVE << STATUS_LVC_SHIFT) | (RAI_ATTACHED << STATUS_RAI_SHIFT);
      expect(status).toBe(0b0010_0111);
      const buf = encodeReceiver({ header: header(status), radioReferenceId: A, radioNumber: 1, receiverState: 1, receivedPower: 0, transmitterEntityId: NO, transmitterRadioId: 0 });
      expect(buf[10]).toBe(0b0010_0111);
      const v6 = encodeReceiver({ header: { ...header(status), protocolVersion: 6 }, radioReferenceId: A, radioNumber: 1, receiverState: 1, receivedPower: 0, transmitterEntityId: NO, transmitterRadioId: 0 });
      const t = theirDecode(dis6, 'ReceiverPdu', v6);
      expect([t.protocolVersion, t.padding]).toEqual([6, 0]);
    });

    it('Geodesy agrees with open-dis (WGS-84 geodetic <-> ECEF, ENU vectors)', () => {
      for (const [lat, lon, alt] of [
        [50.75, 9.9, 312],
        [-33.9, 151.2, 5],
        [71.2, -156.8, 9000],
        [0.001, 179.999, -50],
      ]) {
        const DEG = Math.PI / 180;
        const ours = geodeticToEcef({ lat: lat * DEG, lon: lon * DEG, alt });
        const rc = new dis7.RangeCoordinates(lat, lon, alt);
        const theirs = rc.latLonAltDegreesToECEF(lat, lon, alt);
        expect(ours.x).toBeCloseTo(theirs.x, 3);
        expect(ours.y).toBeCloseTo(theirs.y, 3);
        expect(ours.z).toBeCloseTo(theirs.z, 3);
        const back = new dis7.CoordinateConversion().convertDisToLatLongInDegrees(ours);
        const g = ecefToGeodetic(ours);
        expect(g.lat / DEG).toBeCloseTo(back.latitude, 6);
        expect(g.lon / DEG).toBeCloseTo(back.longitude, 6);
        expect(g.alt).toBeCloseTo(back.altitude, 1);
        // A local east-north-up vector rotated into ECEF, back through open-dis' ECEF -> ENU at the
        // point (its ENU -> ECEF passes degrees to sin/cos, so it is not used).
        const enu = { x: 120, y: -45, z: 7 };
        const v = enuToEcefVector(lat * DEG, lon * DEG, enu);
        const local = rc.ECEFtoENU(theirs.x + v.x, theirs.y + v.y, theirs.z + v.z);
        expect(local.x).toBeCloseTo(enu.x, 6);
        expect(local.y).toBeCloseTo(enu.y, 6);
        expect(local.z).toBeCloseTo(enu.z, 6);
      }
    });
  });
});


