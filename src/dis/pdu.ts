// Encoding and decoding of the DIS PDUs WeRForces exchanges (IEEE 1278.1-2012, DIS 7; the
// layouts are the same in DIS 6 apart from the PDU status byte). All fields are big-endian
// (network byte order). docs/reference/dis-conformance.md lists every PDU type, which fields
// are populated and the tests that cross-check them against an independent implementation.

import type { DisEntityType, Vec3 } from '../shared/types.js';
import type { EulerAngles } from './geodesy.js';

export const PDU_ENTITY_STATE = 1;
export const PDU_FIRE = 2;
export const PDU_DETONATION = 3;
export const PDU_COLLISION = 4;
export const PDU_DESIGNATOR = 24;
export const PDU_ENTITY_STATE_UPDATE = 67;
export const FAMILY_ENTITY_INFORMATION = 1;
export const FAMILY_WARFARE = 2;

export const ENTITY_STATE_SIZE = 144;
export const FIRE_SIZE = 96;
export const DETONATION_SIZE = 104;
export const COLLISION_SIZE = 60;
export const DESIGNATOR_SIZE = 88;
export const ENTITY_STATE_UPDATE_SIZE = 72;
export const VARIABLE_PARAMETER_SIZE = 16;
const HEADER_SIZE = 12;

export const DR_STATIC = 1;
export const DR_FPW = 2;
export const DR_RPW = 3;
export const DR_RVW = 4;
export const DR_FVW = 5;

// Appearance bits (platform, IEEE 1278.1 / SISO-REF-010).
export const APPEARANCE_MOBILITY_KILL = 1 << 1;
export const APPEARANCE_FIREPOWER_KILL = 1 << 2;
export const APPEARANCE_DAMAGE_SHIFT = 3;
export const APPEARANCE_DAMAGE_MASK = 0b11 << APPEARANCE_DAMAGE_SHIFT;
export const APPEARANCE_SMOKE_SHIFT = 5;
export const APPEARANCE_FLAMING = 1 << 15;
export const APPEARANCE_DEACTIVATED = 1 << 23;

// PDU status record (header byte 10, DIS 7 only; IEEE 1278.1-2012 6.2.67).
/** Transferred entity indicator (bit 0). */
export const STATUS_TEI = 1 << 0;
/** Live/virtual/constructive indicator (bits 1-2). */
export const STATUS_LVC_SHIFT = 1;
export const LVC_NO_STATEMENT = 0;
export const LVC_LIVE = 1;
export const LVC_VIRTUAL = 2;
export const LVC_CONSTRUCTIVE = 3;
/** Coupled extension indicator (bit 3). */
export const STATUS_CEI = 1 << 3;
/** Fire type indicator (bit 4, Fire PDU): 0 munition, 1 expendable. */
export const STATUS_FTI_EXPENDABLE = 1 << 4;
/** Detonation type indicator (bits 4-5, Detonation PDU): 0 munition, 1 expendable, 2 non-munition explosion. */
export const STATUS_DTI_SHIFT = 4;
/** Radio attached indicator (bits 4-5, Transmitter/Signal/Receiver): 0 no statement, 1 unattached, 2 attached. */
export const STATUS_RAI_SHIFT = 4;
export const RAI_UNATTACHED = 1;
export const RAI_ATTACHED = 2;
/** IFF simulation mode (bit 4, IFF PDU): 0 regeneration, 1 interactive. */
export const STATUS_ISM_INTERACTIVE = 1 << 4;
/** Active interrogation indicator (bit 5, IFF PDU). */
export const STATUS_AII_ACTIVE = 1 << 5;

export interface EntityId {
  site: number;
  application: number;
  entity: number;
}

export interface PduHeader {
  protocolVersion: number;
  exerciseId: number;
  pduType: number;
  protocolFamily: number;
  timestamp: number;
  length: number;
  /** PDU status bits (header byte 10). Written only for protocol version 7 and later (padding before). */
  status?: number;
}

export interface DeadReckoning {
  algorithm: number;
  /** The 15 "other parameters" octets (zero unless the algorithm uses them). */
  otherParameters?: Uint8Array;
  linearAcceleration: Vec3;
  angularVelocity: Vec3;
}

/**
 * A 16-octet variable parameter record (IEEE 1278.1-2012 6.2.94). Articulated and attached
 * parts are decoded field by field; other record types (separation, entity type, entity
 * association, …) keep the 15 octets after the record type as they are.
 */
export type VariableParameter =
  | {
      /** Record type 0. */
      kind: 'articulated';
      changeIndicator: number;
      partAttachedTo: number;
      /** Articulated part type class + metric (SISO-REF-010), e.g. 4096 + 11 = primary turret azimuth. */
      parameterType: number;
      /** 32-bit float; the 32 bits after it are padding. */
      value: number;
    }
  | {
      /** Record type 1. */
      kind: 'attached';
      detachedIndicator: number;
      partAttachedTo: number;
      /** Attached part station (SISO-REF-010). */
      parameterType: number;
      attachedType: DisEntityType;
    }
  | { kind: 'other'; recordType: number; data: Uint8Array };

export const VP_ARTICULATED_PART = 0;
export const VP_ATTACHED_PART = 1;

export interface EntityStatePdu {
  header: PduHeader;
  entityId: EntityId;
  forceId: number;
  entityType: DisEntityType;
  alternateEntityType: DisEntityType;
  linearVelocity: Vec3;
  location: Vec3;
  orientation: EulerAngles;
  appearance: number;
  deadReckoning: DeadReckoning;
  marking: string;
  /** Marking character set: 1 ASCII (the default). */
  markingCharacterSet?: number;
  capabilities: number;
  variableParameters?: VariableParameter[];
}

export interface BurstDescriptor {
  munition: DisEntityType;
  warhead: number;
  fuse: number;
  quantity: number;
  rate: number;
}

export interface FirePdu {
  header: PduHeader;
  firingEntityId: EntityId;
  targetEntityId: EntityId;
  munitionId: EntityId;
  eventId: EntityId;
  fireMissionIndex: number;
  location: Vec3;
  burst: BurstDescriptor;
  velocity: Vec3;
  range: number;
}

export interface DetonationPdu {
  header: PduHeader;
  firingEntityId: EntityId;
  targetEntityId: EntityId;
  munitionId: EntityId;
  eventId: EntityId;
  velocity: Vec3;
  location: Vec3;
  burst: BurstDescriptor;
  locationInEntity: Vec3;
  result: number;
  variableParameters?: VariableParameter[];
}

export const NO_ENTITY: EntityId = { site: 0, application: 0, entity: 0 };
export const ZERO3: Vec3 = { x: 0, y: 0, z: 0 };

/** One hour in DIS timestamp units: 2^31 - 1 units of 3600 s / (2^31 - 1), about 1.676 µs, each. */
const TIMESTAMP_UNITS_PER_HOUR = 0x7fffffff;

/**
 * DIS timestamp: time past the hour in the 31 most significant bits; the least significant
 * bit is 0 for relative time (the default) or 1 for absolute (UTC-synchronised) time.
 */
export function disTimestamp(date = new Date(), absolute = false): number {
  const secondsPastHour = (date.getTime() / 1000) % 3600;
  const units = Math.floor((secondsPastHour / 3600) * TIMESTAMP_UNITS_PER_HOUR);
  return ((units << 1) | (absolute ? 1 : 0)) >>> 0;
}

/** Seconds past the hour, and whether it is absolute time, from a DIS timestamp. */
export function timestampSeconds(timestamp: number): { secondsPastHour: number; absolute: boolean } {
  return { secondsPastHour: ((timestamp >>> 1) / TIMESTAMP_UNITS_PER_HOUR) * 3600, absolute: (timestamp & 1) === 1 };
}

class Writer {
  readonly view: DataView;
  off = 0;
  constructor(readonly buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  u8(v: number) {
    this.view.setUint8(this.off, v & 0xff);
    this.off += 1;
  }
  u16(v: number) {
    this.view.setUint16(this.off, v & 0xffff);
    this.off += 2;
  }
  u32(v: number) {
    this.view.setUint32(this.off, v >>> 0);
    this.off += 4;
  }
  f32(v: number) {
    this.view.setFloat32(this.off, v);
    this.off += 4;
  }
  f64(v: number) {
    this.view.setFloat64(this.off, v);
    this.off += 8;
  }
  /** `n` octets: the bytes of `b`, cut or zero-padded to fit. */
  bytes(b: Uint8Array, n = b.length) {
    this.buf.set(b.subarray(0, Math.min(n, b.length)), this.off);
    this.off += n;
  }
  vec32(v: Vec3) {
    this.f32(v.x);
    this.f32(v.y);
    this.f32(v.z);
  }
  vec64(v: Vec3) {
    this.f64(v.x);
    this.f64(v.y);
    this.f64(v.z);
  }
  id(e: EntityId) {
    this.u16(e.site);
    this.u16(e.application);
    this.u16(e.entity);
  }
  type(t: DisEntityType) {
    this.u8(t.kind);
    this.u8(t.domain);
    this.u16(t.country);
    this.u8(t.category);
    this.u8(t.subcategory);
    this.u8(t.specific);
    this.u8(t.extra);
  }
  burst(b: BurstDescriptor) {
    this.type(b.munition);
    this.u16(b.warhead);
    this.u16(b.fuse);
    this.u16(b.quantity);
    this.u16(b.rate);
  }
  euler(o: EulerAngles) {
    this.f32(o.psi);
    this.f32(o.theta);
    this.f32(o.phi);
  }
  header(h: PduHeader, length: number) {
    this.u8(h.protocolVersion);
    this.u8(h.exerciseId);
    this.u8(h.pduType);
    this.u8(h.protocolFamily);
    this.u32(h.timestamp);
    this.u16(length);
    this.u8(h.protocolVersion >= 7 ? (h.status ?? 0) : 0); // PDU status (v7) / padding (v6)
    this.u8(0);
  }
  variableParameter(p: VariableParameter) {
    const start = this.off;
    if (p.kind === 'articulated') {
      this.u8(VP_ARTICULATED_PART);
      this.u8(p.changeIndicator);
      this.u16(p.partAttachedTo);
      this.u32(p.parameterType);
      this.f32(p.value);
    } else if (p.kind === 'attached') {
      this.u8(VP_ATTACHED_PART);
      this.u8(p.detachedIndicator);
      this.u16(p.partAttachedTo);
      this.u32(p.parameterType);
      this.type(p.attachedType);
    } else {
      this.u8(p.recordType);
      this.bytes(p.data, VARIABLE_PARAMETER_SIZE - 1);
    }
    this.off = start + VARIABLE_PARAMETER_SIZE;
  }
}

class Reader {
  readonly view: DataView;
  off = 0;
  constructor(readonly buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  get remaining() {
    return this.buf.byteLength - this.off;
  }
  u8() {
    return this.view.getUint8(this.off++);
  }
  u16() {
    const v = this.view.getUint16(this.off);
    this.off += 2;
    return v;
  }
  u32() {
    const v = this.view.getUint32(this.off);
    this.off += 4;
    return v;
  }
  f32() {
    const v = this.view.getFloat32(this.off);
    this.off += 4;
    return v;
  }
  f64() {
    const v = this.view.getFloat64(this.off);
    this.off += 8;
    return v;
  }
  bytes(n: number): Uint8Array {
    if (n > this.remaining) throw new RangeError('PDU too short');
    const b = this.buf.slice(this.off, this.off + n);
    this.off += n;
    return b;
  }
  vec32(): Vec3 {
    return { x: this.f32(), y: this.f32(), z: this.f32() };
  }
  vec64(): Vec3 {
    return { x: this.f64(), y: this.f64(), z: this.f64() };
  }
  id(): EntityId {
    return { site: this.u16(), application: this.u16(), entity: this.u16() };
  }
  type(): DisEntityType {
    return { kind: this.u8(), domain: this.u8(), country: this.u16(), category: this.u8(), subcategory: this.u8(), specific: this.u8(), extra: this.u8() };
  }
  burst(): BurstDescriptor {
    return { munition: this.type(), warhead: this.u16(), fuse: this.u16(), quantity: this.u16(), rate: this.u16() };
  }
  euler(): EulerAngles {
    return { psi: this.f32(), theta: this.f32(), phi: this.f32() };
  }
  header(): PduHeader {
    const protocolVersion = this.u8();
    const exerciseId = this.u8();
    const pduType = this.u8();
    const protocolFamily = this.u8();
    const timestamp = this.u32();
    const length = this.u16();
    const status = this.u8();
    this.skip(1);
    return { protocolVersion, exerciseId, pduType, protocolFamily, timestamp, length, status };
  }
  variableParameter(): VariableParameter {
    const start = this.off;
    const recordType = this.u8();
    let p: VariableParameter;
    if (recordType === VP_ARTICULATED_PART) {
      p = { kind: 'articulated', changeIndicator: this.u8(), partAttachedTo: this.u16(), parameterType: this.u32(), value: this.f32() };
    } else if (recordType === VP_ATTACHED_PART) {
      p = { kind: 'attached', detachedIndicator: this.u8(), partAttachedTo: this.u16(), parameterType: this.u32(), attachedType: this.type() };
    } else {
      p = { kind: 'other', recordType, data: this.bytes(VARIABLE_PARAMETER_SIZE - 1) };
    }
    this.off = start + VARIABLE_PARAMETER_SIZE;
    return p;
  }
  /** Up to `count` variable parameter records, as many as the buffer holds. */
  variableParameters(count: number): VariableParameter[] {
    const out: VariableParameter[] = [];
    for (let i = 0; i < count && this.remaining >= VARIABLE_PARAMETER_SIZE; i++) out.push(this.variableParameter());
    return out;
  }
  skip(n: number) {
    this.off += n;
  }
}

function need(buf: Uint8Array, size: number, name: string): void {
  if (buf.byteLength < size) throw new Error(`${name} PDU too short`);
}

export function decodeHeader(buf: Uint8Array): PduHeader | null {
  if (buf.byteLength < HEADER_SIZE) return null;
  return new Reader(buf).header();
}

function encodeMarking(w: Writer, marking: string, characterSet = 1) {
  w.u8(characterSet); // 1 = ASCII
  for (let i = 0; i < 11; i++) {
    const c = i < marking.length ? marking.charCodeAt(i) : 0;
    w.u8(c < 128 ? c : 63);
  }
}

function decodeMarking(r: Reader): { characterSet: number; marking: string } {
  const characterSet = r.u8();
  const end = r.off + 11;
  let marking = '';
  for (let i = 0; i < 11; i++) {
    const c = r.u8();
    if (c === 0) break;
    marking += String.fromCharCode(c);
  }
  r.off = end;
  return { characterSet, marking };
}

export function encodeEntityState(p: EntityStatePdu): Uint8Array {
  const vps = p.variableParameters ?? [];
  const size = ENTITY_STATE_SIZE + vps.length * VARIABLE_PARAMETER_SIZE;
  const buf = new Uint8Array(size);
  const w = new Writer(buf);
  w.header({ ...p.header, pduType: PDU_ENTITY_STATE, protocolFamily: FAMILY_ENTITY_INFORMATION }, size);
  w.id(p.entityId);
  w.u8(p.forceId);
  w.u8(vps.length);
  w.type(p.entityType);
  w.type(p.alternateEntityType);
  w.vec32(p.linearVelocity);
  w.vec64(p.location);
  w.euler(p.orientation);
  w.u32(p.appearance);
  w.u8(p.deadReckoning.algorithm);
  w.bytes(p.deadReckoning.otherParameters ?? new Uint8Array(15), 15);
  w.vec32(p.deadReckoning.linearAcceleration);
  w.vec32(p.deadReckoning.angularVelocity);
  encodeMarking(w, p.marking, p.markingCharacterSet);
  w.u32(p.capabilities);
  for (const vp of vps) w.variableParameter(vp);
  return buf;
}

export function decodeEntityState(buf: Uint8Array): EntityStatePdu {
  need(buf, ENTITY_STATE_SIZE, 'Entity State');
  const r = new Reader(buf);
  const header = r.header();
  const entityId = r.id();
  const forceId = r.u8();
  const vpCount = r.u8();
  const entityType = r.type();
  const alternateEntityType = r.type();
  const linearVelocity = r.vec32();
  const location = r.vec64();
  const orientation = r.euler();
  const appearance = r.u32();
  const algorithm = r.u8();
  const otherParameters = r.bytes(15);
  const linearAcceleration = r.vec32();
  const angularVelocity = r.vec32();
  const { characterSet, marking } = decodeMarking(r);
  const capabilities = r.u32();
  return {
    header,
    entityId,
    forceId,
    entityType,
    alternateEntityType,
    linearVelocity,
    location,
    orientation,
    appearance,
    deadReckoning: { algorithm, otherParameters, linearAcceleration, angularVelocity },
    marking,
    markingCharacterSet: characterSet,
    capabilities,
    variableParameters: r.variableParameters(vpCount),
  };
}

export function encodeFire(p: FirePdu): Uint8Array {
  const buf = new Uint8Array(FIRE_SIZE);
  const w = new Writer(buf);
  w.header({ ...p.header, pduType: PDU_FIRE, protocolFamily: FAMILY_WARFARE }, FIRE_SIZE);
  w.id(p.firingEntityId);
  w.id(p.targetEntityId);
  w.id(p.munitionId);
  w.id(p.eventId);
  w.u32(p.fireMissionIndex);
  w.vec64(p.location);
  w.burst(p.burst);
  w.vec32(p.velocity);
  w.f32(p.range);
  return buf;
}

export function decodeFire(buf: Uint8Array): FirePdu {
  need(buf, FIRE_SIZE, 'Fire');
  const r = new Reader(buf);
  return {
    header: r.header(),
    firingEntityId: r.id(),
    targetEntityId: r.id(),
    munitionId: r.id(),
    eventId: r.id(),
    fireMissionIndex: r.u32(),
    location: r.vec64(),
    burst: r.burst(),
    velocity: r.vec32(),
    range: r.f32(),
  };
}

export function encodeDetonation(p: DetonationPdu): Uint8Array {
  const vps = p.variableParameters ?? [];
  const size = DETONATION_SIZE + vps.length * VARIABLE_PARAMETER_SIZE;
  const buf = new Uint8Array(size);
  const w = new Writer(buf);
  w.header({ ...p.header, pduType: PDU_DETONATION, protocolFamily: FAMILY_WARFARE }, size);
  w.id(p.firingEntityId);
  w.id(p.targetEntityId);
  w.id(p.munitionId);
  w.id(p.eventId);
  w.vec32(p.velocity);
  w.vec64(p.location);
  w.burst(p.burst);
  w.vec32(p.locationInEntity);
  w.u8(p.result);
  w.u8(vps.length);
  w.u16(0); // padding
  for (const vp of vps) w.variableParameter(vp);
  return buf;
}

export function decodeDetonation(buf: Uint8Array): DetonationPdu {
  need(buf, DETONATION_SIZE, 'Detonation');
  const r = new Reader(buf);
  const header = r.header();
  const firingEntityId = r.id();
  const targetEntityId = r.id();
  const munitionId = r.id();
  const eventId = r.id();
  const velocity = r.vec32();
  const location = r.vec64();
  const burst = r.burst();
  const locationInEntity = r.vec32();
  const result = r.u8();
  const vpCount = r.u8();
  r.skip(2);
  return { header, firingEntityId, targetEntityId, munitionId, eventId, velocity, location, burst, locationInEntity, result, variableParameters: r.variableParameters(vpCount) };
}

// Detonation result enumeration (subset).
export const DETONATION_ENTITY_IMPACT = 1;
export const DETONATION_GROUND_IMPACT = 3;
export const DETONATION_DETONATION = 5;

// ---------------------------------------------------------------- entity information: collision, entity state update

export interface CollisionPdu {
  header: PduHeader;
  issuingEntityId: EntityId;
  collidingEntityId: EntityId;
  eventId: EntityId;
  /** 0 inelastic, 1 elastic (SISO-REF-010). */
  collisionType: number;
  /** Velocity of the issuing entity (ECEF, m/s). */
  velocity: Vec3;
  /** Mass of the issuing entity (kg). */
  mass: number;
  /** Collision location relative to the issuing entity (entity coordinates, m). */
  location: Vec3;
}

export function encodeCollision(p: CollisionPdu): Uint8Array {
  const buf = new Uint8Array(COLLISION_SIZE);
  const w = new Writer(buf);
  w.header({ ...p.header, pduType: PDU_COLLISION, protocolFamily: FAMILY_ENTITY_INFORMATION }, COLLISION_SIZE);
  w.id(p.issuingEntityId);
  w.id(p.collidingEntityId);
  w.id(p.eventId);
  w.u8(p.collisionType);
  w.u8(0);
  w.vec32(p.velocity);
  w.f32(p.mass);
  w.vec32(p.location);
  return buf;
}

export function decodeCollision(buf: Uint8Array): CollisionPdu {
  need(buf, COLLISION_SIZE, 'Collision');
  const r = new Reader(buf);
  const header = r.header();
  const issuingEntityId = r.id();
  const collidingEntityId = r.id();
  const eventId = r.id();
  const collisionType = r.u8();
  r.skip(1);
  return { header, issuingEntityId, collidingEntityId, eventId, collisionType, velocity: r.vec32(), mass: r.f32(), location: r.vec32() };
}

export interface EntityStateUpdatePdu {
  header: PduHeader;
  entityId: EntityId;
  linearVelocity: Vec3;
  location: Vec3;
  orientation: EulerAngles;
  appearance: number;
  variableParameters?: VariableParameter[];
}

export function encodeEntityStateUpdate(p: EntityStateUpdatePdu): Uint8Array {
  const vps = p.variableParameters ?? [];
  const size = ENTITY_STATE_UPDATE_SIZE + vps.length * VARIABLE_PARAMETER_SIZE;
  const buf = new Uint8Array(size);
  const w = new Writer(buf);
  w.header({ ...p.header, pduType: PDU_ENTITY_STATE_UPDATE, protocolFamily: FAMILY_ENTITY_INFORMATION }, size);
  w.id(p.entityId);
  w.u8(0); // padding
  w.u8(vps.length);
  w.vec32(p.linearVelocity);
  w.vec64(p.location);
  w.euler(p.orientation);
  w.u32(p.appearance);
  for (const vp of vps) w.variableParameter(vp);
  return buf;
}

export function decodeEntityStateUpdate(buf: Uint8Array): EntityStateUpdatePdu {
  need(buf, ENTITY_STATE_UPDATE_SIZE, 'Entity State Update');
  const r = new Reader(buf);
  const header = r.header();
  const entityId = r.id();
  r.skip(1);
  const vpCount = r.u8();
  return { header, entityId, linearVelocity: r.vec32(), location: r.vec64(), orientation: r.euler(), appearance: r.u32(), variableParameters: r.variableParameters(vpCount) };
}

// ---------------------------------------------------------------- warfare: designator

export interface DesignatorPdu {
  header: PduHeader;
  designatingEntityId: EntityId;
  /** Designator system name (SISO-REF-010). */
  codeName: number;
  designatedEntityId: EntityId;
  /** Laser code (SISO-REF-010 designator code). */
  designatorCode: number;
  /** Watts. */
  power: number;
  /** Micrometres. */
  wavelength: number;
  /** Spot relative to the designated entity (entity coordinates, m). */
  spotWrtDesignated: Vec3;
  /** Spot location (ECEF, m). */
  spotLocation: Vec3;
  deadReckoningAlgorithm: number;
  linearAcceleration: Vec3;
}

export function encodeDesignator(p: DesignatorPdu): Uint8Array {
  const buf = new Uint8Array(DESIGNATOR_SIZE);
  const w = new Writer(buf);
  w.header({ ...p.header, pduType: PDU_DESIGNATOR, protocolFamily: FAMILY_WARFARE }, DESIGNATOR_SIZE);
  w.id(p.designatingEntityId);
  w.u16(p.codeName);
  w.id(p.designatedEntityId);
  w.u16(p.designatorCode);
  w.f32(p.power);
  w.f32(p.wavelength);
  w.vec32(p.spotWrtDesignated);
  w.vec64(p.spotLocation);
  w.u8(p.deadReckoningAlgorithm);
  w.u8(0);
  w.u16(0);
  w.vec32(p.linearAcceleration);
  return buf;
}

export function decodeDesignator(buf: Uint8Array): DesignatorPdu {
  need(buf, DESIGNATOR_SIZE, 'Designator');
  const r = new Reader(buf);
  const header = r.header();
  const designatingEntityId = r.id();
  const codeName = r.u16();
  const designatedEntityId = r.id();
  const designatorCode = r.u16();
  const power = r.f32();
  const wavelength = r.f32();
  const spotWrtDesignated = r.vec32();
  const spotLocation = r.vec64();
  const deadReckoningAlgorithm = r.u8();
  r.skip(3);
  return { header, designatingEntityId, codeName, designatedEntityId, designatorCode, power, wavelength, spotWrtDesignated, spotLocation, deadReckoningAlgorithm, linearAcceleration: r.vec32() };
}

// ---------------------------------------------------------------- simulation management

export const PDU_CREATE_ENTITY = 11;
export const PDU_REMOVE_ENTITY = 12;
export const PDU_START_RESUME = 13;
export const PDU_STOP_FREEZE = 14;
export const PDU_ACKNOWLEDGE = 15;
export const PDU_ACTION_REQUEST = 16;
export const PDU_ACTION_RESPONSE = 17;
export const PDU_DATA_QUERY = 18;
export const PDU_SET_DATA = 19;
export const PDU_DATA = 20;
export const PDU_COMMENT = 22;
export const FAMILY_SIMULATION_MANAGEMENT = 5;
export const CREATE_ENTITY_SIZE = 28;
export const REMOVE_ENTITY_SIZE = 28;
export const START_RESUME_SIZE = 44;
export const STOP_FREEZE_SIZE = 40;
export const ACKNOWLEDGE_SIZE = 32;
/** Addresses every simulation (site, application and entity all 0xFFFF). */
export const ALL_ENTITIES: EntityId = { site: 0xffff, application: 0xffff, entity: 0xffff };
/** Acknowledge flag values. */
export const ACK_CREATE_ENTITY = 1;
export const ACK_REMOVE_ENTITY = 2;
export const ACK_START_RESUME = 3;
export const ACK_STOP_FREEZE = 4;
/** Acknowledge response flag values. */
export const RESPONSE_ABLE_TO_COMPLY = 1;
export const RESPONSE_UNABLE_TO_COMPLY = 2;
/** Action Response request status "request rejected" (SISO-REF-010). */
export const ACTION_REQUEST_REJECTED = 5;
/** Datum ID used for free-text Comment PDUs. */
export const DATUM_TEXT = 0;

/** DIS clock time: whole hours since 1970 and a timestamp within the hour. */
export interface ClockTime {
  hour: number;
  timePastHour: number;
}

export function clockTime(date = new Date()): ClockTime {
  return { hour: Math.floor(date.getTime() / 3600000), timePastHour: disTimestamp(date) };
}

export interface SimanHeader {
  header: PduHeader;
  originatingId: EntityId;
  receivingId: EntityId;
}

/** Create Entity and Remove Entity PDUs. */
export interface CreateEntityPdu extends SimanHeader {
  requestId: number;
}

export type RemoveEntityPdu = CreateEntityPdu;

export interface StartResumePdu extends SimanHeader {
  realWorldTime: ClockTime;
  simulationTime: ClockTime;
  requestId: number;
}

export interface StopFreezePdu extends SimanHeader {
  realWorldTime: ClockTime;
  /** 0 other, 1 recess, 2 termination, 3 system failure, 4 security violation, 5 entity reconstitution, 6 stop for reset, 7 stop for restart, 8 abort training return to tactical operations. */
  reason: number;
  frozenBehavior: number;
  requestId: number;
}

export interface AcknowledgePdu extends SimanHeader {
  acknowledgeFlag: number;
  /** 0 other, 1 able to comply, 2 unable to comply, 3 pending operator action. */
  responseFlag: number;
  requestId: number;
}

export interface CommentPdu extends SimanHeader {
  /** Variable datum records: id and value (text). */
  texts: { datumId: number; text: string }[];
}

/** Fixed datum record: a datum id (SISO-REF-010 variable record type) and a 32-bit value. */
export interface FixedDatum {
  id: number;
  /** The 32 bits as an unsigned integer (float32Bits / bitsFloat32 convert float values). */
  value: number;
}

/** Variable datum record: a datum id and a value of any length (padded to 64 bits on the wire). */
export interface VariableDatum {
  id: number;
  data: Uint8Array;
  /** Value length in bits (defaults to the byte length × 8). */
  bits?: number;
}

export interface DatumRecords {
  fixed: FixedDatum[];
  variable: VariableDatum[];
}

/** Data and Set Data PDUs. */
export interface DataPdu extends SimanHeader, DatumRecords {
  requestId: number;
}

export interface ActionRequestPdu extends SimanHeader, DatumRecords {
  requestId: number;
  /** SISO-REF-010 action id. */
  actionId: number;
}

export interface ActionResponsePdu extends SimanHeader, DatumRecords {
  requestId: number;
  /** 0 other, 1 pending, 2 executing, 3 partially complete, 4 complete, 5 request rejected, … */
  requestStatus: number;
}

export interface DataQueryPdu extends SimanHeader {
  requestId: number;
  /** 0 = answer once; otherwise how often the data is wanted (DIS timestamp units). */
  timeInterval: number;
  /** Datum ids, 32 bits each: a query carries ids only, no values. */
  fixedIds: number[];
  variableIds: number[];
}

/** The 32 bits of a float32, for a fixed datum value. */
export function float32Bits(v: number): number {
  const view = new DataView(new ArrayBuffer(4));
  view.setFloat32(0, v);
  return view.getUint32(0);
}

/** A fixed datum value read as a float32. */
export function bitsFloat32(bits: number): number {
  const view = new DataView(new ArrayBuffer(4));
  view.setUint32(0, bits >>> 0);
  return view.getFloat32(0);
}

function simanHead(w: Writer, p: SimanHeader, type: number, length: number) {
  w.header({ ...p.header, pduType: type, protocolFamily: FAMILY_SIMULATION_MANAGEMENT }, length);
  w.id(p.originatingId);
  w.id(p.receivingId);
}

function readSimanHead(r: Reader): SimanHeader {
  return { header: r.header(), originatingId: r.id(), receivingId: r.id() };
}

function padded64(bytes: number): number {
  return Math.ceil(bytes / 8) * 8;
}

function datumRecordsSize(d: DatumRecords): number {
  return 8 + d.fixed.length * 8 + d.variable.reduce((n, v) => n + 8 + padded64(v.data.length), 0);
}

function writeDatumRecords(w: Writer, d: DatumRecords) {
  w.u32(d.fixed.length);
  w.u32(d.variable.length);
  for (const f of d.fixed) {
    w.u32(f.id);
    w.u32(f.value);
  }
  for (const v of d.variable) {
    w.u32(v.id);
    w.u32(v.bits ?? v.data.length * 8);
    w.bytes(v.data, padded64(v.data.length));
  }
}

function readDatumRecords(r: Reader): DatumRecords {
  const nFixed = r.u32();
  const nVariable = r.u32();
  const fixed: FixedDatum[] = [];
  for (let i = 0; i < nFixed && r.remaining >= 8; i++) fixed.push({ id: r.u32(), value: r.u32() });
  const variable: VariableDatum[] = [];
  for (let i = 0; i < nVariable && r.remaining >= 8; i++) {
    const id = r.u32();
    const bits = r.u32();
    const bytes = Math.ceil(bits / 8);
    if (bytes > r.remaining) break;
    variable.push({ id, data: r.bytes(bytes), bits });
    r.off = Math.min(r.buf.byteLength, r.off + padded64(bytes) - bytes); // padding to 64 bits
  }
  return { fixed, variable };
}

function encodeRequestOnly(p: CreateEntityPdu, type: number): Uint8Array {
  const buf = new Uint8Array(CREATE_ENTITY_SIZE);
  const w = new Writer(buf);
  simanHead(w, p, type, CREATE_ENTITY_SIZE);
  w.u32(p.requestId);
  return buf;
}

export function encodeCreateEntity(p: CreateEntityPdu): Uint8Array {
  return encodeRequestOnly(p, PDU_CREATE_ENTITY);
}

export function encodeRemoveEntity(p: RemoveEntityPdu): Uint8Array {
  return encodeRequestOnly(p, PDU_REMOVE_ENTITY);
}

/** Decodes a Create Entity or a Remove Entity PDU (same layout). */
export function decodeCreateEntity(buf: Uint8Array): CreateEntityPdu {
  need(buf, CREATE_ENTITY_SIZE, 'Create/Remove Entity');
  const r = new Reader(buf);
  return { ...readSimanHead(r), requestId: r.u32() };
}

export const decodeRemoveEntity = decodeCreateEntity;

export function encodeStartResume(p: StartResumePdu): Uint8Array {
  const buf = new Uint8Array(START_RESUME_SIZE);
  const w = new Writer(buf);
  simanHead(w, p, PDU_START_RESUME, START_RESUME_SIZE);
  w.u32(p.realWorldTime.hour);
  w.u32(p.realWorldTime.timePastHour);
  w.u32(p.simulationTime.hour);
  w.u32(p.simulationTime.timePastHour);
  w.u32(p.requestId);
  return buf;
}

export function decodeStartResume(buf: Uint8Array): StartResumePdu {
  need(buf, START_RESUME_SIZE, 'Start/Resume');
  const r = new Reader(buf);
  const h = readSimanHead(r);
  return { ...h, realWorldTime: { hour: r.u32(), timePastHour: r.u32() }, simulationTime: { hour: r.u32(), timePastHour: r.u32() }, requestId: r.u32() };
}

export function encodeStopFreeze(p: StopFreezePdu): Uint8Array {
  const buf = new Uint8Array(STOP_FREEZE_SIZE);
  const w = new Writer(buf);
  simanHead(w, p, PDU_STOP_FREEZE, STOP_FREEZE_SIZE);
  w.u32(p.realWorldTime.hour);
  w.u32(p.realWorldTime.timePastHour);
  w.u8(p.reason);
  w.u8(p.frozenBehavior);
  w.u16(0);
  w.u32(p.requestId);
  return buf;
}

export function decodeStopFreeze(buf: Uint8Array): StopFreezePdu {
  need(buf, STOP_FREEZE_SIZE, 'Stop/Freeze');
  const r = new Reader(buf);
  const h = readSimanHead(r);
  const realWorldTime = { hour: r.u32(), timePastHour: r.u32() };
  const reason = r.u8();
  const frozenBehavior = r.u8();
  r.skip(2);
  return { ...h, realWorldTime, reason, frozenBehavior, requestId: r.u32() };
}

export function encodeAcknowledge(p: AcknowledgePdu): Uint8Array {
  const buf = new Uint8Array(ACKNOWLEDGE_SIZE);
  const w = new Writer(buf);
  simanHead(w, p, PDU_ACKNOWLEDGE, ACKNOWLEDGE_SIZE);
  w.u16(p.acknowledgeFlag);
  w.u16(p.responseFlag);
  w.u32(p.requestId);
  return buf;
}

export function decodeAcknowledge(buf: Uint8Array): AcknowledgePdu {
  need(buf, ACKNOWLEDGE_SIZE, 'Acknowledge');
  const r = new Reader(buf);
  const h = readSimanHead(r);
  return { ...h, acknowledgeFlag: r.u16(), responseFlag: r.u16(), requestId: r.u32() };
}

/** Simulation management PDU with one or two 32-bit fields and then datum records. */
function encodeWithDatums(p: SimanHeader & DatumRecords, type: number, fields: number[]): Uint8Array {
  const size = 24 + 4 * fields.length + datumRecordsSize(p);
  const buf = new Uint8Array(size);
  const w = new Writer(buf);
  simanHead(w, p, type, size);
  for (const f of fields) w.u32(f);
  writeDatumRecords(w, p);
  return buf;
}

export function encodeComment(p: CommentPdu): Uint8Array {
  const variable = p.texts.map((t) => ({ id: t.datumId, data: new TextEncoder().encode(t.text) }));
  return encodeWithDatums({ ...p, fixed: [], variable }, PDU_COMMENT, []);
}

export function decodeComment(buf: Uint8Array): CommentPdu {
  const r = new Reader(buf);
  const h = readSimanHead(r);
  const { variable } = readDatumRecords(r);
  return { ...h, texts: variable.map((v) => ({ datumId: v.id, text: new TextDecoder().decode(v.data) })) };
}

/** Data PDU (20), or with `type` PDU_SET_DATA a Set Data PDU (19): same layout. */
export function encodeData(p: DataPdu, type: typeof PDU_DATA | typeof PDU_SET_DATA = PDU_DATA): Uint8Array {
  return encodeWithDatums(p, type, [p.requestId, 0]); // request id, 32 bits of padding
}

export function encodeSetData(p: DataPdu): Uint8Array {
  return encodeData(p, PDU_SET_DATA);
}

/** Decodes a Data or a Set Data PDU. */
export function decodeData(buf: Uint8Array): DataPdu {
  const r = new Reader(buf);
  const h = readSimanHead(r);
  const requestId = r.u32();
  r.skip(4);
  return { ...h, requestId, ...readDatumRecords(r) };
}

export const decodeSetData = decodeData;

export function encodeActionRequest(p: ActionRequestPdu): Uint8Array {
  return encodeWithDatums(p, PDU_ACTION_REQUEST, [p.requestId, p.actionId]);
}

export function decodeActionRequest(buf: Uint8Array): ActionRequestPdu {
  const r = new Reader(buf);
  const h = readSimanHead(r);
  const requestId = r.u32();
  const actionId = r.u32();
  return { ...h, requestId, actionId, ...readDatumRecords(r) };
}

export function encodeActionResponse(p: ActionResponsePdu): Uint8Array {
  return encodeWithDatums(p, PDU_ACTION_RESPONSE, [p.requestId, p.requestStatus]);
}

export function decodeActionResponse(buf: Uint8Array): ActionResponsePdu {
  const r = new Reader(buf);
  const h = readSimanHead(r);
  const requestId = r.u32();
  const requestStatus = r.u32();
  return { ...h, requestId, requestStatus, ...readDatumRecords(r) };
}

export function encodeDataQuery(p: DataQueryPdu): Uint8Array {
  const size = 40 + 4 * (p.fixedIds.length + p.variableIds.length);
  const buf = new Uint8Array(size);
  const w = new Writer(buf);
  simanHead(w, p, PDU_DATA_QUERY, size);
  w.u32(p.requestId);
  w.u32(p.timeInterval);
  w.u32(p.fixedIds.length);
  w.u32(p.variableIds.length);
  for (const id of p.fixedIds) w.u32(id);
  for (const id of p.variableIds) w.u32(id);
  return buf;
}

export function decodeDataQuery(buf: Uint8Array): DataQueryPdu {
  const r = new Reader(buf);
  const h = readSimanHead(r);
  const requestId = r.u32();
  const timeInterval = r.u32();
  const nFixed = r.u32();
  const nVariable = r.u32();
  const fixedIds: number[] = [];
  const variableIds: number[] = [];
  for (let i = 0; i < nFixed && r.remaining >= 4; i++) fixedIds.push(r.u32());
  for (let i = 0; i < nVariable && r.remaining >= 4; i++) variableIds.push(r.u32());
  return { ...h, requestId, timeInterval, fixedIds, variableIds };
}

// ---------------------------------------------------------------- radio communications

export const PDU_TRANSMITTER = 25;
export const PDU_SIGNAL = 26;
export const PDU_RECEIVER = 27;
export const FAMILY_RADIO = 4;
export const TRANSMITTER_SIZE = 104;
export const RECEIVER_SIZE = 36;
export const TRANSMIT_OFF = 0;
export const TRANSMIT_ON_IDLE = 1;
export const TRANSMIT_ON_TRANSMITTING = 2;
export const RECEIVER_OFF = 0;
export const RECEIVER_ON_IDLE = 1;
export const RECEIVER_ON_RECEIVING = 2;
/** Signal encoding classes (top two bits of the encoding scheme). */
export const ENCODING_AUDIO = 0;
export const ENCODING_RAW_BINARY = 1;
export const ENCODING_APPLICATION = 2;

/**
 * Radio type (IEEE 1278.1-2012 6.2.71): kind (7 = radio), domain, country, category,
 * subcategory, specific, extra. DIS 6 named the last four octets nomenclature version
 * (8 bits) and nomenclature (16 bits); the layout is the same.
 */
export type RadioType = DisEntityType;

export interface TransmitterPdu {
  header: PduHeader;
  /** The entity the radio is on. */
  radioReferenceId: EntityId;
  radioNumber: number;
  radioType: RadioType;
  transmitState: number;
  inputSource: number;
  antennaLocation: Vec3;
  relativeAntennaLocation: Vec3;
  /** Hz. */
  frequency: number;
  bandwidth: number;
  /** dBm. */
  power: number;
  modulation: { spreadSpectrum: number; majorModulation: number; detail: number; radioSystem: number };
  cryptoSystem: number;
  cryptoKeyId: number;
}

export interface SignalPdu {
  header: PduHeader;
  radioReferenceId: EntityId;
  radioNumber: number;
  /** Encoding class (top 2 bits) and type or message count (low 14 bits). */
  encodingScheme: number;
  tdlType: number;
  sampleRate: number;
  samples: number;
  data: Uint8Array;
  /** Data length in bits (defaults to the byte length × 8). */
  dataBits?: number;
}

export interface ReceiverPdu {
  header: PduHeader;
  radioReferenceId: EntityId;
  radioNumber: number;
  receiverState: number;
  receivedPower: number;
  transmitterEntityId: EntityId;
  transmitterRadioId: number;
}

export function encodeTransmitter(p: TransmitterPdu): Uint8Array {
  const buf = new Uint8Array(TRANSMITTER_SIZE);
  const w = new Writer(buf);
  w.header({ ...p.header, pduType: PDU_TRANSMITTER, protocolFamily: FAMILY_RADIO }, TRANSMITTER_SIZE);
  w.id(p.radioReferenceId);
  w.u16(p.radioNumber);
  w.type(p.radioType);
  w.u8(p.transmitState);
  w.u8(p.inputSource);
  w.u16(0); // variable transmitter parameter count
  w.vec64(p.antennaLocation);
  w.vec32(p.relativeAntennaLocation);
  w.u16(0); // antenna pattern type: omnidirectional
  w.u16(0); // antenna pattern length
  w.view.setBigUint64(w.off, BigInt(Math.round(p.frequency)));
  w.off += 8;
  w.f32(p.bandwidth);
  w.f32(p.power);
  w.u16(p.modulation.spreadSpectrum);
  w.u16(p.modulation.majorModulation);
  w.u16(p.modulation.detail);
  w.u16(p.modulation.radioSystem);
  w.u16(p.cryptoSystem);
  w.u16(p.cryptoKeyId);
  w.u8(0); // modulation parameter count
  w.u8(0);
  w.u16(0);
  return buf;
}

export function decodeTransmitter(buf: Uint8Array): TransmitterPdu {
  need(buf, TRANSMITTER_SIZE, 'Transmitter');
  const r = new Reader(buf);
  const header = r.header();
  const radioReferenceId = r.id();
  const radioNumber = r.u16();
  const radioType = r.type();
  const transmitState = r.u8();
  const inputSource = r.u8();
  r.skip(2);
  const antennaLocation = r.vec64();
  const relativeAntennaLocation = r.vec32();
  r.skip(4);
  const frequency = Number(r.view.getBigUint64(r.off));
  r.skip(8);
  const bandwidth = r.f32();
  const power = r.f32();
  const modulation = { spreadSpectrum: r.u16(), majorModulation: r.u16(), detail: r.u16(), radioSystem: r.u16() };
  return { header, radioReferenceId, radioNumber, radioType, transmitState, inputSource, antennaLocation, relativeAntennaLocation, frequency, bandwidth, power, modulation, cryptoSystem: r.u16(), cryptoKeyId: r.u16() };
}

export function encodeSignal(p: SignalPdu): Uint8Array {
  const padded = Math.ceil(p.data.length / 4) * 4;
  const size = 32 + padded;
  const buf = new Uint8Array(size);
  const w = new Writer(buf);
  w.header({ ...p.header, pduType: PDU_SIGNAL, protocolFamily: FAMILY_RADIO }, size);
  w.id(p.radioReferenceId);
  w.u16(p.radioNumber);
  w.u16(p.encodingScheme);
  w.u16(p.tdlType);
  w.u32(p.sampleRate);
  w.u16(p.dataBits ?? p.data.length * 8);
  w.u16(p.samples);
  w.bytes(p.data);
  return buf;
}

export function decodeSignal(buf: Uint8Array): SignalPdu {
  need(buf, 32, 'Signal');
  const r = new Reader(buf);
  const header = r.header();
  const radioReferenceId = r.id();
  const radioNumber = r.u16();
  const encodingScheme = r.u16();
  const tdlType = r.u16();
  const sampleRate = r.u32();
  const dataBits = r.u16();
  const samples = r.u16();
  const bytes = Math.min(Math.ceil(dataBits / 8), r.remaining);
  return { header, radioReferenceId, radioNumber, encodingScheme, tdlType, sampleRate, samples, dataBits, data: r.bytes(bytes) };
}

export function encodeReceiver(p: ReceiverPdu): Uint8Array {
  const buf = new Uint8Array(RECEIVER_SIZE);
  const w = new Writer(buf);
  w.header({ ...p.header, pduType: PDU_RECEIVER, protocolFamily: FAMILY_RADIO }, RECEIVER_SIZE);
  w.id(p.radioReferenceId);
  w.u16(p.radioNumber);
  w.u16(p.receiverState);
  w.u16(0);
  w.f32(p.receivedPower);
  w.id(p.transmitterEntityId);
  w.u16(p.transmitterRadioId);
  return buf;
}

export function decodeReceiver(buf: Uint8Array): ReceiverPdu {
  need(buf, RECEIVER_SIZE, 'Receiver');
  const r = new Reader(buf);
  const header = r.header();
  const radioReferenceId = r.id();
  const radioNumber = r.u16();
  const receiverState = r.u16();
  r.skip(2);
  return { header, radioReferenceId, radioNumber, receiverState, receivedPower: r.f32(), transmitterEntityId: r.id(), transmitterRadioId: r.u16() };
}

// ---------------------------------------------------------------- distributed emission regeneration

export const PDU_ELECTROMAGNETIC_EMISSION = 23;
export const PDU_IFF = 28;
export const FAMILY_DISTRIBUTED_EMISSION = 6;
export const EE_HEADER_SIZE = 28;
export const EE_SYSTEM_SIZE = 20;
export const EE_BEAM_SIZE = 52;
export const EE_TARGET_SIZE = 8;
export const IFF_LAYER1_SIZE = 60;
/** EE state update indicator. */
export const EE_HEARTBEAT_UPDATE = 0;
export const EE_CHANGED_DATA_UPDATE = 1;

export interface TrackJamTarget {
  entityId: EntityId;
  emitterNumber: number;
  beamNumber: number;
}

export interface EmissionBeam {
  /** Beam id number, unique within the emitter system. */
  beamId: number;
  beamParameterIndex: number;
  /** Fundamental parameters: centre frequency (Hz), bandwidth (Hz), effective radiated power (dBm), pulse repetition frequency (Hz), pulse width (µs). */
  frequency: number;
  frequencyRange: number;
  erp: number;
  prf: number;
  pulseWidth: number;
  /** Beam data (radians, entity coordinates): azimuth centre and half-angle sweep, elevation centre and half-angle sweep; sweep sync (%). */
  azimuthCenter: number;
  azimuthSweep: number;
  elevationCenter: number;
  elevationSweep: number;
  sweepSync: number;
  /** SISO-REF-010 beam function: 1 search, 4 tracking, 12 jamming, … */
  beamFunction: number;
  highDensityTrackJam: number;
  /** Beam status (DIS 7): 0 active, 1 deactivated. */
  beamStatus: number;
  /** Jamming technique record (kind, category, subcategory, specific octets) as one 32-bit value. */
  jammingTechnique: number;
  targets: TrackJamTarget[];
}

export interface EmitterSystem {
  /** SISO-REF-010 emitter name (0 when not mapped). */
  name: number;
  /** SISO-REF-010 emitter system function: 2 early warning/surveillance, 4 fire control, 42 jammer, … */
  function: number;
  /** Emitter number, unique on the entity. */
  number: number;
  /** Emitter location relative to the entity (entity coordinates, m). */
  location: Vec3;
  beams: EmissionBeam[];
}

export interface ElectromagneticEmissionPdu {
  header: PduHeader;
  emittingEntityId: EntityId;
  eventId: EntityId;
  stateUpdateIndicator: number;
  systems: EmitterSystem[];
}

function beamSize(b: EmissionBeam): number {
  return EE_BEAM_SIZE + b.targets.length * EE_TARGET_SIZE;
}

function systemSize(s: EmitterSystem): number {
  return EE_SYSTEM_SIZE + s.beams.reduce((n, b) => n + beamSize(b), 0);
}

export function encodeElectromagneticEmission(p: ElectromagneticEmissionPdu): Uint8Array {
  const size = EE_HEADER_SIZE + p.systems.reduce((n, s) => n + systemSize(s), 0);
  const buf = new Uint8Array(size);
  const w = new Writer(buf);
  w.header({ ...p.header, pduType: PDU_ELECTROMAGNETIC_EMISSION, protocolFamily: FAMILY_DISTRIBUTED_EMISSION }, size);
  w.id(p.emittingEntityId);
  w.id(p.eventId);
  w.u8(p.stateUpdateIndicator);
  w.u8(p.systems.length);
  w.u16(0);
  for (const s of p.systems) {
    w.u8(systemSize(s) / 4); // system data length in 32-bit words
    w.u8(s.beams.length);
    w.u16(0);
    w.u16(s.name);
    w.u8(s.function);
    w.u8(s.number);
    w.vec32(s.location);
    for (const b of s.beams) {
      w.u8(beamSize(b) / 4); // beam data length in 32-bit words
      w.u8(b.beamId);
      w.u16(b.beamParameterIndex);
      w.f32(b.frequency);
      w.f32(b.frequencyRange);
      w.f32(b.erp);
      w.f32(b.prf);
      w.f32(b.pulseWidth);
      w.f32(b.azimuthCenter);
      w.f32(b.azimuthSweep);
      w.f32(b.elevationCenter);
      w.f32(b.elevationSweep);
      w.f32(b.sweepSync);
      w.u8(b.beamFunction);
      w.u8(b.targets.length);
      w.u8(b.highDensityTrackJam);
      w.u8(b.beamStatus);
      w.u32(b.jammingTechnique);
      for (const t of b.targets) {
        w.id(t.entityId);
        w.u8(t.emitterNumber);
        w.u8(t.beamNumber);
      }
    }
  }
  return buf;
}

function readBeam(r: Reader): EmissionBeam {
  const start = r.off;
  const words = r.u8();
  const beamId = r.u8();
  const beamParameterIndex = r.u16();
  const frequency = r.f32();
  const frequencyRange = r.f32();
  const erp = r.f32();
  const prf = r.f32();
  const pulseWidth = r.f32();
  const azimuthCenter = r.f32();
  const azimuthSweep = r.f32();
  const elevationCenter = r.f32();
  const elevationSweep = r.f32();
  const sweepSync = r.f32();
  const beamFunction = r.u8();
  const nTargets = r.u8();
  const highDensityTrackJam = r.u8();
  const beamStatus = r.u8();
  const jammingTechnique = r.u32();
  const targets: TrackJamTarget[] = [];
  for (let k = 0; k < nTargets; k++) targets.push({ entityId: r.id(), emitterNumber: r.u8(), beamNumber: r.u8() });
  // Honour the stated length, so that a beam carrying more data is skipped correctly.
  if (words * 4 >= EE_BEAM_SIZE) r.off = start + words * 4;
  return { beamId, beamParameterIndex, frequency, frequencyRange, erp, prf, pulseWidth, azimuthCenter, azimuthSweep, elevationCenter, elevationSweep, sweepSync, beamFunction, highDensityTrackJam, beamStatus, jammingTechnique, targets };
}

export function decodeElectromagneticEmission(buf: Uint8Array): ElectromagneticEmissionPdu {
  need(buf, EE_HEADER_SIZE, 'Electromagnetic Emission');
  const r = new Reader(buf);
  const header = r.header();
  const emittingEntityId = r.id();
  const eventId = r.id();
  const stateUpdateIndicator = r.u8();
  const nSystems = r.u8();
  r.skip(2);
  const systems: EmitterSystem[] = [];
  for (let i = 0; i < nSystems; i++) {
    const start = r.off;
    const words = r.u8();
    const nBeams = r.u8();
    r.skip(2);
    const s: EmitterSystem = { name: r.u16(), function: r.u8(), number: r.u8(), location: r.vec32(), beams: [] };
    for (let j = 0; j < nBeams; j++) s.beams.push(readBeam(r));
    systems.push(s);
    if (words * 4 >= EE_SYSTEM_SIZE) r.off = start + words * 4;
  }
  return { header, emittingEntityId, eventId, stateUpdateIndicator, systems };
}

/** IFF PDU, layer 1 (basic system data). Layers 2 and up, if present, are not decoded. */
export interface IffPdu {
  header: PduHeader;
  emittingEntityId: EntityId;
  eventId: EntityId;
  /** Antenna location relative to the entity (entity coordinates, m). */
  location: Vec3;
  /** System id: SISO-REF-010 system type, system name, system mode, and change/options bits. */
  system: { type: number; name: number; mode: number; changeOptions: number };
  systemDesignator: number;
  systemSpecificData: number;
  /** Fundamental operational data: system status, data field 1, information layers, data field 2, and parameters 1-6 (modes 1, 2, 3/A, 4, C, 5/S). */
  operational: { systemStatus: number; dataField1: number; informationLayers: number; dataField2: number; parameters: number[] };
}

export function encodeIff(p: IffPdu): Uint8Array {
  const buf = new Uint8Array(IFF_LAYER1_SIZE);
  const w = new Writer(buf);
  w.header({ ...p.header, pduType: PDU_IFF, protocolFamily: FAMILY_DISTRIBUTED_EMISSION }, IFF_LAYER1_SIZE);
  w.id(p.emittingEntityId);
  w.id(p.eventId);
  w.vec32(p.location);
  w.u16(p.system.type);
  w.u16(p.system.name);
  w.u8(p.system.mode);
  w.u8(p.system.changeOptions);
  w.u8(p.systemDesignator);
  w.u8(p.systemSpecificData);
  const o = p.operational;
  w.u8(o.systemStatus);
  w.u8(o.dataField1);
  w.u8(o.informationLayers);
  w.u8(o.dataField2);
  for (let i = 0; i < 6; i++) w.u16(o.parameters[i] ?? 0);
  return buf;
}

export function decodeIff(buf: Uint8Array): IffPdu {
  need(buf, IFF_LAYER1_SIZE, 'IFF');
  const r = new Reader(buf);
  return {
    header: r.header(),
    emittingEntityId: r.id(),
    eventId: r.id(),
    location: r.vec32(),
    system: { type: r.u16(), name: r.u16(), mode: r.u8(), changeOptions: r.u8() },
    systemDesignator: r.u8(),
    systemSpecificData: r.u8(),
    operational: { systemStatus: r.u8(), dataField1: r.u8(), informationLayers: r.u8(), dataField2: r.u8(), parameters: [r.u16(), r.u16(), r.u16(), r.u16(), r.u16(), r.u16()] },
  };
}
