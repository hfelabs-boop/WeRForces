// Encoding and decoding of the DIS PDUs WeRForces exchanges (IEEE 1278.1):
// Entity State (type 1), Fire (type 2) and Detonation (type 3). All fields are
// big-endian (network byte order).

import type { DisEntityType, Vec3 } from '../shared/types.js';
import type { EulerAngles } from './geodesy.js';

export const PDU_ENTITY_STATE = 1;
export const PDU_FIRE = 2;
export const PDU_DETONATION = 3;
export const FAMILY_ENTITY_INFORMATION = 1;
export const FAMILY_WARFARE = 2;

export const ENTITY_STATE_SIZE = 144;
export const FIRE_SIZE = 96;
export const DETONATION_SIZE = 104;
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
}

export interface DeadReckoning {
  algorithm: number;
  linearAcceleration: Vec3;
  angularVelocity: Vec3;
}

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
  capabilities: number;
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
}

export const NO_ENTITY: EntityId = { site: 0, application: 0, entity: 0 };
export const ZERO3: Vec3 = { x: 0, y: 0, z: 0 };

/** DIS relative timestamp: units of 3600/2^31 s past the hour, LSB 0 = relative. */
export function disTimestamp(date = new Date()): number {
  const secondsPastHour = (date.getTime() / 1000) % 3600;
  const units = Math.floor((secondsPastHour / 3600) * 0x7fffffff);
  return (units << 1) >>> 0;
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
  header(h: PduHeader, length: number) {
    this.u8(h.protocolVersion);
    this.u8(h.exerciseId);
    this.u8(h.pduType);
    this.u8(h.protocolFamily);
    this.u32(h.timestamp);
    this.u16(length);
    this.u8(0); // PDU status (v7) / padding (v6)
    this.u8(0);
  }
}

class Reader {
  readonly view: DataView;
  off = 0;
  constructor(buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
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
  skip(n: number) {
    this.off += n;
  }
}

export function decodeHeader(buf: Uint8Array): PduHeader | null {
  if (buf.byteLength < HEADER_SIZE) return null;
  const r = new Reader(buf);
  const h: PduHeader = {
    protocolVersion: r.u8(),
    exerciseId: r.u8(),
    pduType: r.u8(),
    protocolFamily: r.u8(),
    timestamp: r.u32(),
    length: r.u16(),
  };
  return h;
}

function encodeMarking(w: Writer, marking: string) {
  w.u8(1); // ASCII character set
  for (let i = 0; i < 11; i++) {
    const c = i < marking.length ? marking.charCodeAt(i) : 0;
    w.u8(c < 128 ? c : 63);
  }
}

export function encodeEntityState(p: EntityStatePdu): Uint8Array {
  const buf = new Uint8Array(ENTITY_STATE_SIZE);
  const w = new Writer(buf);
  w.header({ ...p.header, pduType: PDU_ENTITY_STATE, protocolFamily: FAMILY_ENTITY_INFORMATION }, ENTITY_STATE_SIZE);
  w.id(p.entityId);
  w.u8(p.forceId);
  w.u8(0); // number of variable parameter records
  w.type(p.entityType);
  w.type(p.alternateEntityType);
  w.vec32(p.linearVelocity);
  w.vec64(p.location);
  w.f32(p.orientation.psi);
  w.f32(p.orientation.theta);
  w.f32(p.orientation.phi);
  w.u32(p.appearance);
  w.u8(p.deadReckoning.algorithm);
  for (let i = 0; i < 15; i++) w.u8(0); // other DR parameters
  w.vec32(p.deadReckoning.linearAcceleration);
  w.vec32(p.deadReckoning.angularVelocity);
  encodeMarking(w, p.marking);
  w.u32(p.capabilities);
  return buf;
}

export function decodeEntityState(buf: Uint8Array): EntityStatePdu {
  if (buf.byteLength < ENTITY_STATE_SIZE) throw new Error('Entity State PDU too short');
  const r = new Reader(buf);
  const header = decodeHeader(buf)!;
  r.skip(HEADER_SIZE);
  const entityId = r.id();
  const forceId = r.u8();
  r.u8(); // variable parameter count; records follow the fixed part and are ignored
  const entityType = r.type();
  const alternateEntityType = r.type();
  const linearVelocity = r.vec32();
  const location = r.vec64();
  const orientation = { psi: r.f32(), theta: r.f32(), phi: r.f32() };
  const appearance = r.u32();
  const algorithm = r.u8();
  r.skip(15);
  const linearAcceleration = r.vec32();
  const angularVelocity = r.vec32();
  r.u8(); // marking character set
  let marking = '';
  for (let i = 0; i < 11; i++) {
    const c = r.u8();
    if (c === 0) {
      r.skip(10 - i);
      break;
    }
    marking += String.fromCharCode(c);
  }
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
    deadReckoning: { algorithm, linearAcceleration, angularVelocity },
    marking,
    capabilities,
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
  if (buf.byteLength < FIRE_SIZE) throw new Error('Fire PDU too short');
  const r = new Reader(buf);
  const header = decodeHeader(buf)!;
  r.skip(HEADER_SIZE);
  return {
    header,
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
  const buf = new Uint8Array(DETONATION_SIZE);
  const w = new Writer(buf);
  w.header({ ...p.header, pduType: PDU_DETONATION, protocolFamily: FAMILY_WARFARE }, DETONATION_SIZE);
  w.id(p.firingEntityId);
  w.id(p.targetEntityId);
  w.id(p.munitionId);
  w.id(p.eventId);
  w.vec32(p.velocity);
  w.vec64(p.location);
  w.burst(p.burst);
  w.vec32(p.locationInEntity);
  w.u8(p.result);
  w.u8(0); // number of variable parameters
  w.u16(0); // padding
  return buf;
}

export function decodeDetonation(buf: Uint8Array): DetonationPdu {
  if (buf.byteLength < DETONATION_SIZE) throw new Error('Detonation PDU too short');
  const r = new Reader(buf);
  const header = decodeHeader(buf)!;
  r.skip(HEADER_SIZE);
  return {
    header,
    firingEntityId: r.id(),
    targetEntityId: r.id(),
    munitionId: r.id(),
    eventId: r.id(),
    velocity: r.vec32(),
    location: r.vec64(),
    burst: r.burst(),
    locationInEntity: r.vec32(),
    result: r.u8(),
  };
}

// Detonation result enumeration (subset).
export const DETONATION_ENTITY_IMPACT = 1;
export const DETONATION_GROUND_IMPACT = 3;
export const DETONATION_DETONATION = 5;

// ---------------------------------------------------------------- simulation management

export const PDU_START_RESUME = 13;
export const PDU_STOP_FREEZE = 14;
export const PDU_ACKNOWLEDGE = 15;
export const PDU_COMMENT = 22;
export const FAMILY_SIMULATION_MANAGEMENT = 5;
export const START_RESUME_SIZE = 44;
export const STOP_FREEZE_SIZE = 40;
export const ACKNOWLEDGE_SIZE = 32;
/** Addresses every simulation (site, application and entity all 0xFFFF). */
export const ALL_ENTITIES: EntityId = { site: 0xffff, application: 0xffff, entity: 0xffff };
/** Acknowledge flag values. */
export const ACK_START_RESUME = 3;
export const ACK_STOP_FREEZE = 4;
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

function simanHead(w: Writer, p: SimanHeader, type: number, length: number) {
  w.header({ ...p.header, pduType: type, protocolFamily: FAMILY_SIMULATION_MANAGEMENT }, length);
  w.id(p.originatingId);
  w.id(p.receivingId);
}

function readSimanHead(r: Reader): SimanHeader {
  const header = { protocolVersion: r.u8(), exerciseId: r.u8(), pduType: r.u8(), protocolFamily: r.u8(), timestamp: r.u32(), length: r.u16() };
  r.skip(2);
  return { header, originatingId: r.id(), receivingId: r.id() };
}

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
  const r = new Reader(buf);
  const h = readSimanHead(r);
  return { ...h, acknowledgeFlag: r.u16(), responseFlag: r.u16(), requestId: r.u32() };
}

export function encodeComment(p: CommentPdu): Uint8Array {
  const data = p.texts.map((t) => ({ id: t.datumId, bytes: new TextEncoder().encode(t.text) }));
  // Each variable datum: id, length in bits, value padded to a 64-bit boundary.
  const size = 12 + 12 + 8 + data.reduce((n, d) => n + 8 + Math.ceil(d.bytes.length / 8) * 8, 0);
  const buf = new Uint8Array(size);
  const w = new Writer(buf);
  simanHead(w, p, PDU_COMMENT, size);
  w.u32(0); // fixed datum records
  w.u32(data.length);
  for (const d of data) {
    w.u32(d.id);
    w.u32(d.bytes.length * 8);
    buf.set(d.bytes, w.off);
    w.off += Math.ceil(d.bytes.length / 8) * 8;
  }
  return buf;
}

export function decodeComment(buf: Uint8Array): CommentPdu {
  const r = new Reader(buf);
  const h = readSimanHead(r);
  const fixed = r.u32();
  const variable = r.u32();
  r.skip(fixed * 8);
  const texts: CommentPdu['texts'] = [];
  for (let i = 0; i < variable && r.off + 8 <= buf.byteLength; i++) {
    const datumId = r.u32();
    const bits = r.u32();
    const bytes = Math.ceil(bits / 8);
    if (r.off + bytes > buf.byteLength) break;
    texts.push({ datumId, text: new TextDecoder().decode(buf.subarray(r.off, r.off + bytes)) });
    r.skip(Math.ceil(bytes / 8) * 8);
  }
  return { ...h, texts };
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

export interface RadioType {
  kind: number;
  domain: number;
  country: number;
  category: number;
  nomenclatureVersion: number;
  nomenclature: number;
}

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
  w.u8(p.radioType.kind);
  w.u8(p.radioType.domain);
  w.u16(p.radioType.country);
  w.u8(p.radioType.category);
  w.u8(p.radioType.nomenclatureVersion);
  w.u16(p.radioType.nomenclature);
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
  const r = new Reader(buf);
  const header = { protocolVersion: r.u8(), exerciseId: r.u8(), pduType: r.u8(), protocolFamily: r.u8(), timestamp: r.u32(), length: r.u16() };
  r.skip(2);
  const radioReferenceId = r.id();
  const radioNumber = r.u16();
  const radioType = { kind: r.u8(), domain: r.u8(), country: r.u16(), category: r.u8(), nomenclatureVersion: r.u8(), nomenclature: r.u16() };
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
  buf.set(p.data, w.off);
  return buf;
}

export function decodeSignal(buf: Uint8Array): SignalPdu {
  const r = new Reader(buf);
  const header = { protocolVersion: r.u8(), exerciseId: r.u8(), pduType: r.u8(), protocolFamily: r.u8(), timestamp: r.u32(), length: r.u16() };
  r.skip(2);
  const radioReferenceId = r.id();
  const radioNumber = r.u16();
  const encodingScheme = r.u16();
  const tdlType = r.u16();
  const sampleRate = r.u32();
  const dataBits = r.u16();
  const samples = r.u16();
  const bytes = Math.min(Math.ceil(dataBits / 8), buf.byteLength - r.off);
  return { header, radioReferenceId, radioNumber, encodingScheme, tdlType, sampleRate, samples, dataBits, data: buf.slice(r.off, r.off + bytes) };
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
  const r = new Reader(buf);
  const header = { protocolVersion: r.u8(), exerciseId: r.u8(), pduType: r.u8(), protocolFamily: r.u8(), timestamp: r.u32(), length: r.u16() };
  r.skip(2);
  const radioReferenceId = r.id();
  const radioNumber = r.u16();
  const receiverState = r.u16();
  r.skip(2);
  return { header, radioReferenceId, radioNumber, receiverState, receivedPower: r.f32(), transmitterEntityId: r.id(), transmitterRadioId: r.u16() };
}
