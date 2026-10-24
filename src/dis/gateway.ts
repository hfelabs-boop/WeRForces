// DIS gateway: publishes locally simulated entities, fires and detonations over UDP
// and reflects entities from other DIS simulations into the engine as remote entities.

import dgram from 'node:dgram';
import { angleDiff } from '../shared/math.js';
import type { DisStatus, ForceId, Vec3 } from '../shared/types.js';
import type { Detonation, Shot } from '../sim/combat.js';
import type { Engine } from '../sim/engine.js';
import type { Entity } from '../sim/entity.js';
import { ecefToEnuVector, ecefToGeodetic, enuToEcefVector, eulerToHeadingPitchRoll, headingPitchRollToEuler, LocalFrame } from './geodesy.js';
import {
  APPEARANCE_DAMAGE_MASK,
  APPEARANCE_DAMAGE_SHIFT,
  APPEARANCE_DEACTIVATED,
  APPEARANCE_FIREPOWER_KILL,
  APPEARANCE_FLAMING,
  APPEARANCE_MOBILITY_KILL,
  APPEARANCE_SMOKE_SHIFT,
  decodeDetonation,
  decodeEntityState,
  decodeFire,
  decodeHeader,
  DETONATION_DETONATION,
  DETONATION_ENTITY_IMPACT,
  DETONATION_GROUND_IMPACT,
  disTimestamp,
  DR_FPW,
  DR_FVW,
  DR_RVW,
  DR_STATIC,
  encodeDetonation,
  encodeEntityState,
  encodeFire,
  type EntityId,
  type EntityStatePdu,
  NO_ENTITY,
  PDU_DETONATION,
  PDU_ENTITY_STATE,
  PDU_FIRE,
  type PduHeader,
  ZERO3,
} from './pdu.js';

export interface DisConfig {
  exerciseId: number;
  site: number;
  application: number;
  port: number;
  /** Destination address: broadcast, multicast group or unicast host. */
  address: string;
  bindAddress: string;
  protocolVersion: number;
  /** Seconds between heartbeat ESPDUs for unchanged entities. */
  heartbeat: number;
  /** Dead-reckoning position error threshold (m). */
  positionThreshold: number;
  /** Dead-reckoning orientation error threshold (rad). */
  orientationThreshold: number;
  /** Seconds without an update before a remote entity is removed. */
  timeout: number;
}

export const DEFAULT_DIS_CONFIG: DisConfig = {
  exerciseId: 1,
  site: 1,
  application: 3001,
  port: 3000,
  address: '255.255.255.255',
  bindAddress: '0.0.0.0',
  protocolVersion: 7,
  heartbeat: 5,
  positionThreshold: 1,
  orientationThreshold: (3 * Math.PI) / 180,
  timeout: 12,
};

/** Abstract datagram transport so the gateway can be tested without sockets. */
export interface DisTransport {
  send(buf: Uint8Array): void;
  onMessage(fn: (buf: Uint8Array) => void): void;
  close(): void;
}

export async function createUdpTransport(cfg: Pick<DisConfig, 'port' | 'address' | 'bindAddress'>): Promise<DisTransport> {
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  await new Promise<void>((resolve, reject) => {
    sock.once('error', reject);
    sock.bind(cfg.port, cfg.bindAddress, () => {
      sock.off('error', reject);
      resolve();
    });
  });
  sock.setBroadcast(true);
  const first = Number(cfg.address.split('.')[0]);
  if (first >= 224 && first <= 239) {
    sock.addMembership(cfg.address);
    sock.setMulticastLoopback(true);
  }
  let handler: (buf: Uint8Array) => void = () => {};
  sock.on('message', (msg) => handler(new Uint8Array(msg.buffer, msg.byteOffset, msg.byteLength)));
  sock.on('error', (err) => console.error('[dis] socket error:', err.message));
  return {
    send(buf) {
      sock.send(buf, cfg.port, cfg.address);
    },
    onMessage(fn) {
      handler = fn;
    },
    close() {
      sock.close();
    },
  };
}

interface PublishedState {
  wall: number;
  position: Vec3;
  velocity: Vec3;
  heading: number;
  pitch: number;
  roll: number;
  appearance: number;
}

interface RemoteTrack {
  wall: number;
  position: Vec3;
  velocity: Vec3;
  acceleration: Vec3;
  algorithm: number;
}

function remoteKey(id: EntityId): string {
  return `R${id.site}-${id.application}-${id.entity}`;
}

export class DisGateway {
  readonly config: DisConfig;
  private frame: LocalFrame;
  private published = new Map<string, PublishedState>();
  private remotes = new Map<string, RemoteTrack>();
  private unsubscribe: (() => void)[] = [];
  pdusSent = 0;
  pdusReceived = 0;
  private running = true;
  private timeScale = 1;

  constructor(
    readonly engine: Engine,
    readonly transport: DisTransport,
    config: Partial<DisConfig> = {},
    private readonly now: () => number = () => Date.now() / 1000,
  ) {
    this.config = { ...DEFAULT_DIS_CONFIG, ...config };
    this.frame = this.makeFrame();
    transport.onMessage((buf) => this.receive(buf));
    this.unsubscribe.push(
      engine.on('fire', (s) => this.sendFire(s)),
      engine.on('detonation', (d) => this.sendDetonation(d)),
      engine.on('removed', (e) => this.sendRemoval(e)),
      engine.on('reset', () => {
        this.frame = this.makeFrame();
        this.published.clear();
        this.remotes.clear();
      }),
    );
  }

  private makeFrame(): LocalFrame {
    const o = this.engine.terrain.spec.origin;
    return new LocalFrame(o.lat, o.lon);
  }

  close(): void {
    for (const u of this.unsubscribe) u();
    this.transport.close();
  }

  status(): DisStatus {
    return {
      enabled: true,
      exerciseId: this.config.exerciseId,
      site: this.config.site,
      application: this.config.application,
      port: this.config.port,
      address: this.config.address,
      pdusSent: this.pdusSent,
      pdusReceived: this.pdusReceived,
      remoteEntities: this.remotes.size,
    };
  }

  private header(): PduHeader {
    return {
      protocolVersion: this.config.protocolVersion,
      exerciseId: this.config.exerciseId,
      pduType: 0,
      protocolFamily: 0,
      timestamp: disTimestamp(),
      length: 0,
    };
  }

  private send(buf: Uint8Array): void {
    this.transport.send(buf);
    this.pdusSent++;
  }

  localId(e: Entity): EntityId {
    if (e.remoteDis) return e.remoteDis;
    return { site: this.config.site, application: this.config.application, entity: e.disNumber };
  }

  // ------------------------------------------------------------ outgoing

  static appearanceOf(e: Entity): number {
    let a = 0;
    const damage = e.destroyed ? 3 : e.mobilityKill || e.firepowerKill ? 2 : 0;
    a |= damage << APPEARANCE_DAMAGE_SHIFT;
    if (e.domain === 'ground') {
      if (e.mobilityKill) a |= APPEARANCE_MOBILITY_KILL;
      if (e.firepowerKill) a |= APPEARANCE_FIREPOWER_KILL;
    }
    if (e.destroyed) {
      a |= 2 << APPEARANCE_SMOKE_SHIFT; // engine smoke
      a |= APPEARANCE_FLAMING;
    }
    return a;
  }

  buildEntityState(e: Entity, apparentVelocity: Vec3, appearance: number): EntityStatePdu {
    const geo = this.frame.toGeodetic(e.position);
    const moving = Math.hypot(apparentVelocity.x, apparentVelocity.y, apparentVelocity.z) > 0.01;
    return {
      header: this.header(),
      entityId: this.localId(e),
      forceId: e.force,
      entityType: e.type.dis,
      alternateEntityType: e.type.dis,
      linearVelocity: enuToEcefVector(geo.lat, geo.lon, apparentVelocity),
      location: this.frame.toEcef(e.position),
      orientation: headingPitchRollToEuler(geo.lat, geo.lon, e.heading, e.pitch, e.roll),
      appearance,
      deadReckoning: { algorithm: moving ? DR_FPW : DR_STATIC, linearAcceleration: ZERO3, angularVelocity: ZERO3 },
      marking: e.name.slice(0, 11),
      capabilities: 0,
    };
  }

  /**
   * Called after every simulation step. Publishes entity state when the dead-reckoned
   * position or orientation drifts past threshold, the appearance changes, or the
   * heartbeat expires; and extrapolates/times out remote entities.
   */
  update(running: boolean, timeScale: number): void {
    const wall = this.now();
    const pausedChanged = running !== this.running || timeScale !== this.timeScale;
    this.running = running;
    this.timeScale = timeScale;
    for (const e of this.engine.entities.values()) {
      if (e.remote) continue;
      // Passengers are not separate entities on the network while mounted.
      if (e.embarkedIn) {
        if (this.published.has(e.id)) this.sendRemoval(e);
        continue;
      }
      const v = e.velocity;
      const scale = running ? timeScale : 0;
      const apparent = { x: v.x * scale, y: v.y * scale, z: v.z * scale };
      const appearance = DisGateway.appearanceOf(e);
      const last = this.published.get(e.id);
      let due = !last || pausedChanged;
      if (last && !due) {
        const dt = wall - last.wall;
        const px = last.position.x + last.velocity.x * dt;
        const py = last.position.y + last.velocity.y * dt;
        const pz = last.position.z + last.velocity.z * dt;
        const err = Math.hypot(e.x - px, e.y - py, e.z - pz);
        const rot = Math.max(Math.abs(angleDiff(last.heading, e.heading)), Math.abs(e.pitch - last.pitch), Math.abs(e.roll - last.roll));
        due = dt >= this.config.heartbeat || err > this.config.positionThreshold || rot > this.config.orientationThreshold || appearance !== last.appearance;
      }
      if (!due) continue;
      this.send(encodeEntityState(this.buildEntityState(e, apparent, appearance)));
      this.published.set(e.id, { wall, position: e.position, velocity: apparent, heading: e.heading, pitch: e.pitch, roll: e.roll, appearance });
    }

    for (const [id, track] of this.remotes) {
      const e = this.engine.entities.get(id);
      const dt = wall - track.wall;
      if (!e || dt > this.config.timeout) {
        this.remotes.delete(id);
        if (e) {
          this.engine.log('deleted', `remote entity ${e.name} timed out`, id);
          this.engine.deleteObject(id);
        }
        continue;
      }
      if (track.algorithm === DR_STATIC || e.destroyed) continue;
      const accel = track.algorithm === DR_FVW || track.algorithm === DR_RVW ? 0.5 * dt * dt : 0;
      e.x = track.position.x + track.velocity.x * dt + track.acceleration.x * accel;
      e.y = track.position.y + track.velocity.y * dt + track.acceleration.y * accel;
      e.z = track.position.z + track.velocity.z * dt + track.acceleration.z * accel;
    }
  }

  private sendRemoval(e: Entity): void {
    if (e.remote) {
      this.remotes.delete(e.id);
      return;
    }
    if (!this.published.has(e.id)) return;
    this.published.delete(e.id);
    const pdu = this.buildEntityState(e, ZERO3, DisGateway.appearanceOf(e) | APPEARANCE_DEACTIVATED);
    pdu.deadReckoning.algorithm = DR_STATIC;
    this.send(encodeEntityState(pdu));
  }

  private entityIdFor(id: string | undefined): EntityId {
    const e = id ? this.engine.entities.get(id) : undefined;
    return e ? this.localId(e) : NO_ENTITY;
  }

  private burstFor(shot: Shot) {
    return {
      munition: shot.weapon.munition,
      warhead: shot.weapon.guided ? 1000 : 5000, // HE / kinetic
      fuse: 1000, // contact
      quantity: 1,
      rate: 0,
    };
  }

  private sendFire(shot: Shot): void {
    const from = this.frame.toGeodetic(shot.from);
    const dir = { x: shot.to.x - shot.from.x, y: shot.to.y - shot.from.y, z: shot.to.z - shot.from.z };
    const len = Math.hypot(dir.x, dir.y, dir.z) || 1;
    const vel = { x: (dir.x / len) * shot.weapon.projectileSpeed, y: (dir.y / len) * shot.weapon.projectileSpeed, z: (dir.z / len) * shot.weapon.projectileSpeed };
    this.send(
      encodeFire({
        header: this.header(),
        firingEntityId: this.entityIdFor(shot.shooterId),
        targetEntityId: this.entityIdFor(shot.targetId),
        munitionId: NO_ENTITY,
        eventId: { site: this.config.site, application: this.config.application, entity: shot.eventNumber },
        fireMissionIndex: 0,
        location: this.frame.toEcef(shot.from),
        burst: this.burstFor(shot),
        velocity: enuToEcefVector(from.lat, from.lon, vel),
        range: shot.range,
      }),
    );
  }

  private sendDetonation(det: Detonation): void {
    const shot = det.shot;
    const target = shot.targetId ? this.engine.entities.get(shot.targetId) : undefined;
    // Area-effect rounds burst on the ground; receivers work out their own blast damage.
    const area = !!det.effects;
    const result = det.hit && !area ? DETONATION_ENTITY_IMPACT : target?.domain === 'air' ? DETONATION_DETONATION : DETONATION_GROUND_IMPACT;
    this.send(
      encodeDetonation({
        header: this.header(),
        firingEntityId: this.entityIdFor(shot.shooterId),
        targetEntityId: det.hit && !area ? this.entityIdFor(shot.targetId) : NO_ENTITY,
        munitionId: NO_ENTITY,
        eventId: { site: this.config.site, application: this.config.application, entity: shot.eventNumber },
        velocity: ZERO3,
        location: this.frame.toEcef(det.location),
        burst: this.burstFor(shot),
        locationInEntity: ZERO3,
        result,
      }),
    );
  }

  // ------------------------------------------------------------ incoming

  receive(buf: Uint8Array): void {
    const h = decodeHeader(buf);
    if (!h || h.exerciseId !== this.config.exerciseId || h.protocolVersion < 4 || h.protocolVersion > 7) return;
    try {
      if (h.pduType === PDU_ENTITY_STATE) this.receiveEntityState(buf);
      else if (h.pduType === PDU_FIRE) this.receiveFire(buf);
      else if (h.pduType === PDU_DETONATION) this.receiveDetonation(buf);
      else return;
    } catch {
      return; // malformed PDU
    }
  }

  private isOwn(id: EntityId): boolean {
    return id.site === this.config.site && id.application === this.config.application;
  }

  private resolveEntity(id: EntityId): string | undefined {
    if (this.isOwn(id)) {
      for (const e of this.engine.entities.values()) if (!e.remote && e.disNumber === id.entity) return e.id;
      return undefined;
    }
    const key = remoteKey(id);
    return this.engine.entities.has(key) ? key : undefined;
  }

  private receiveEntityState(buf: Uint8Array): void {
    const pdu = decodeEntityState(buf);
    if (this.isOwn(pdu.entityId)) return;
    this.pdusReceived++;
    const id = remoteKey(pdu.entityId);
    if (pdu.appearance & APPEARANCE_DEACTIVATED) {
      this.remotes.delete(id);
      if (this.engine.entities.has(id)) this.engine.deleteObject(id);
      return;
    }
    const geo = ecefToGeodetic(pdu.location);
    const position = this.frame.fromGeodetic(geo);
    const velocity = ecefToEnuVector(geo.lat, geo.lon, pdu.linearVelocity);
    const acceleration = ecefToEnuVector(geo.lat, geo.lon, pdu.deadReckoning.linearAcceleration);
    const hpr = eulerToHeadingPitchRoll(geo.lat, geo.lon, pdu.orientation);
    const type = this.engine.catalog.matchDisType(pdu.entityType);
    const force = (pdu.forceId <= 3 ? pdu.forceId : 0) as ForceId;
    const damage = (pdu.appearance & APPEARANCE_DAMAGE_MASK) >> APPEARANCE_DAMAGE_SHIFT;
    const e = this.engine.upsertRemote({
      id,
      typeId: type.id,
      name: pdu.marking || `${type.name} (${pdu.entityId.site}:${pdu.entityId.application}:${pdu.entityId.entity})`,
      force,
      position,
      velocity,
      heading: hpr.heading,
      pitch: hpr.pitch,
      roll: hpr.roll,
      destroyed: damage === 3,
      dis: pdu.entityId,
    });
    e.mobilityKill = (pdu.appearance & APPEARANCE_MOBILITY_KILL) !== 0;
    e.firepowerKill = (pdu.appearance & APPEARANCE_FIREPOWER_KILL) !== 0;
    this.remotes.set(id, { wall: this.now(), position, velocity, acceleration, algorithm: pdu.deadReckoning.algorithm });
  }

  private receiveFire(buf: Uint8Array): void {
    const pdu = decodeFire(buf);
    if (this.isOwn(pdu.firingEntityId)) return;
    this.pdusReceived++;
    const shooterId = this.resolveEntity(pdu.firingEntityId);
    const targetId = this.resolveEntity(pdu.targetEntityId);
    const from = this.frame.fromEcef(pdu.location);
    const target = targetId ? this.engine.entities.get(targetId) : undefined;
    const to = target ? target.position : from;
    if (target && !target.remote) {
      if (shooterId) target.attackers.set(shooterId, this.engine.time);
      target.underFireUntil = this.engine.time + 15;
    }
    const shooter = shooterId ? this.engine.entities.get(shooterId) : undefined;
    if (shooter) shooter.lastFiredAt = this.engine.time;
    this.engine.log('fire', `${shooter?.name ?? 'remote entity'} fired at ${target?.name ?? 'unknown target'} (DIS)`, shooterId, targetId, { from, to });
  }

  private receiveDetonation(buf: Uint8Array): void {
    const pdu = decodeDetonation(buf);
    if (this.isOwn(pdu.firingEntityId)) return;
    this.pdusReceived++;
    const location = this.frame.fromEcef(pdu.location);
    const shooterId = this.resolveEntity(pdu.firingEntityId);
    const targetId = this.resolveEntity(pdu.targetEntityId);
    if (targetId && !this.engine.entities.get(targetId)!.remote) {
      this.engine.applyExternalDetonation(targetId, pdu.burst.munition, location, shooterId);
      return;
    }
    if (!targetId && this.engine.applyExternalAreaDetonation(pdu.burst.munition, location, shooterId)) return;
    this.engine.log('detonation', 'remote detonation (DIS)', shooterId, targetId, { to: location, hit: pdu.result === DETONATION_ENTITY_IMPACT });
  }
}
