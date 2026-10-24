// The simulation engine (the "back-end"): owns terrain, entities, units and tactical
// graphics, advances simulated time and publishes events to the server and DIS gateway.

import { dist2d, rotateOffset } from '../shared/math.js';
import type {
  Catalog,
  CommandResult,
  Domain,
  EntityRecord,
  Reactions,
  ShotRecord,
  EntitySnapshot,
  ForceId,
  Formation,
  Graphic,
  GraphicKind,
  Plan,
  PlanStatement,
  Roe,
  ScenarioFile,
  SimEvent,
  SimEventKind,
  SimState,
  TaskSpec,
  SimulationRules,
  Environment,
  EnvironmentState,
  TerrainData,
  TerrainSpec,
  UnitSnapshot,
  UnitTemplate,
  Vec2,
  Vec3,
  WeaponDef,
} from '../shared/types.js';
import { CatalogIndex, DEFAULT_CATALOG } from './catalog.js';
import { applyBlast, applyDamage, type Detonation, effectivePk, resolveImpact, type Shot, updateCombat } from './combat.js';
import { Entity } from './entity.js';
import { DEFAULT_ENVIRONMENT, environmentAt, groundFactor, normalizeEnvironment, windVector } from './environment.js';
import { checkCallsForFire } from './fires.js';
import { decaySuppression, isPinned, updateMorale } from './morale.js';
import { stepMovement } from './movement.js';
import { PlanExecutor, type Taskable } from './plans.js';
import { Rng } from './rng.js';
import { SENSOR_INTERVAL, updateSensors } from './sensors.js';
import { Obstacles } from './obstacles.js';
import { Smoke } from './smoke.js';
import { burnFuel, updateResupply } from './supply.js';
import { SpatialIndex } from './spatial.js';
import { createTask, MountTask, type Task, type TaskStatus } from './tasks.js';
import { DEFAULT_TERRAIN, Terrain } from './terrain.js';
import { formationOffset, perMemberTask, Unit } from './units.js';

export const DEFAULT_DT = 0.1;
export const DEFAULT_RULES: Required<SimulationRules> = { suppression: true, morale: true, fuel: true };
const MAX_EVENTS = 1000;

type Listener<T> = (value: T) => void;

export interface EngineListeners {
  event: Listener<SimEvent>[];
  fire: Listener<Shot>[];
  detonation: Listener<Detonation>[];
  removed: Listener<Entity>[];
  reset: Listener<void>[];
  /** After every simulation step. */
  step: Listener<number>[];
}

export interface CreateEntityOptions {
  typeId: string;
  force: ForceId;
  x: number;
  y: number;
  heading?: number;
  name?: string;
  /** Altitude above ground for aircraft. */
  altitude?: number;
  id?: string;
}

export interface RemoteEntityUpdate {
  id: string;
  typeId: string;
  name: string;
  force: ForceId;
  position: Vec3;
  velocity: Vec3;
  heading: number;
  pitch: number;
  roll: number;
  destroyed: boolean;
  dis: { site: number; application: number; entity: number };
}

class EntityTaskable implements Taskable {
  constructor(readonly entity: Entity) {}
  get id() {
    return this.entity.id;
  }
  members() {
    return [this.entity];
  }
  reference() {
    return this.entity;
  }
  startTask(engine: Engine, spec: TaskSpec) {
    engine.setEntityTask(this.entity, createTask(spec));
  }
  taskStatus(): TaskStatus | 'none' {
    return this.entity.task?.status ?? 'none';
  }
  applySetting(engine: Engine, st: PlanStatement) {
    engine.applyEntitySetting(this.entity, st);
  }
}

export class Engine {
  readonly catalog: CatalogIndex;
  terrain: Terrain;
  terrainVersion = 1;
  time = 0;
  rng: Rng;
  scenarioName = 'Untitled';
  description = '';

  readonly entities = new Map<string, Entity>();
  readonly units = new Map<string, Unit>();
  /** Grid of entity positions for neighbourhood queries, rebuilt on demand each tick. */
  readonly spatial = new SpatialIndex();
  /** Minefields and obstacle lines (from graphics), lanes and route-cost overlays. */
  readonly obstacles = new Obstacles(this);
  /** Smoke clouds. */
  readonly smoke = new Smoke(this);
  readonly graphics = new Map<string, Graphic>();
  readonly listeners: EngineListeners = { event: [], fire: [], detonation: [], removed: [], reset: [], step: [] };

  private hostilities = new Set<string>(['1-2']);
  private losMemo = new Map<string, { ax: number; ay: number; az: number; bx: number; by: number; bz: number; v: number; visible: boolean }>();
  private shots: Shot[] = [];
  private events: SimEvent[] = [];
  private eventSeq = 0;
  private eventNumber = 0;
  private disCounter = 0;
  private counters = { E: 0, U: 0, G: 0 };
  private sensorDue = new Map<string, number>();
  private initialScenario: ScenarioFile | null = null;

  /** Optional model parts (see SimulationRules); all on unless a scenario turns them off. */
  rules: Required<SimulationRules> = { ...DEFAULT_RULES };
  /** Time of day and weather at the scenario's start (time 0). */
  environment: Required<Environment> = { ...DEFAULT_ENVIRONMENT };
  /** The environment now (clock and light), updated once a simulated second. */
  env: EnvironmentState = environmentAt(DEFAULT_ENVIRONMENT, 0, 0);
  /** Loads imported terrain datasets by name (set by the server from its terrains folder). */
  terrainLoader?: (name: string) => TerrainData;

  constructor(opts: { catalog?: Catalog; terrain?: Terrain; seed?: number; terrainLoader?: (name: string) => TerrainData } = {}) {
    this.terrainLoader = opts.terrainLoader;
    this.catalog = new CatalogIndex(opts.catalog ?? DEFAULT_CATALOG);
    this.terrain = opts.terrain ?? Terrain.generate();
    this.rng = new Rng(opts.seed ?? this.terrain.spec.seed);
  }

  // ------------------------------------------------------------ events

  on<K extends keyof EngineListeners>(kind: K, fn: EngineListeners[K][number]): () => void {
    const list = this.listeners[kind] as unknown[];
    list.push(fn);
    return () => {
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    };
  }

  log(kind: SimEventKind, text: string, entityId?: string, targetId?: string, extra: Partial<SimEvent> = {}): SimEvent {
    const ev: SimEvent = { seq: ++this.eventSeq, time: this.time, kind, text, entityId, targetId, ...extra };
    this.events.push(ev);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    for (const fn of this.listeners.event) fn(ev);
    return ev;
  }

  eventsSince(seq: number): SimEvent[] {
    return this.events.filter((e) => e.seq > seq);
  }

  nameOf(id: string): string {
    return this.entities.get(id)?.name ?? this.units.get(id)?.name ?? this.graphics.get(id)?.name ?? id;
  }

  nextEventNumber(): number {
    this.eventNumber = (this.eventNumber + 1) & 0xffff || 1;
    return this.eventNumber;
  }

  private nextId(prefix: 'E' | 'U' | 'G'): string {
    let id: string;
    do id = `${prefix}${++this.counters[prefix]}`;
    while (this.entities.has(id) || this.units.has(id) || this.graphics.has(id));
    return id;
  }

  private bumpCounter(id: string): void {
    const m = /^([EUG])(\d+)$/.exec(id);
    if (m) {
      const k = m[1] as 'E' | 'U' | 'G';
      this.counters[k] = Math.max(this.counters[k], Number(m[2]));
    }
  }

  // ------------------------------------------------------------ hostility

  isHostile(a: ForceId, b: ForceId): boolean {
    return a !== b && this.hostilities.has(`${Math.min(a, b)}-${Math.max(a, b)}`);
  }

  setHostilities(pairs: [ForceId, ForceId][]): void {
    this.hostilities = new Set(pairs.map(([a, b]) => `${Math.min(a, b)}-${Math.max(a, b)}`));
  }

  // ------------------------------------------------------------ object creation

  createEntity(opts: CreateEntityOptions): Entity {
    const type = this.catalog.type(opts.typeId);
    if (!this.terrain.inBounds(opts.x, opts.y)) throw new Error('position is outside the terrain');
    if (!this.canStand(type.domain, opts)) {
      throw new Error(`${type.name} cannot be placed ${type.domain === 'surface' ? 'on land' : 'in water'}`);
    }
    const id = opts.id ?? this.nextId('E');
    if (this.entities.has(id)) throw new Error(`duplicate entity id ${id}`);
    this.bumpCounter(id);
    const name = opts.name ?? `${type.name} ${id.replace(/^E/, '')}`;
    const e = new Entity(id, name, type, opts.force, { x: opts.x, y: opts.y }, opts.heading ?? 0);
    e.disNumber = ++this.disCounter;
    for (const w of type.weapons) e.ammo.set(w, this.catalog.weapon(w).ammo);
    if (type.reactions) e.reactions = { ...type.reactions };
    e.smokeLeft = type.smokeGrenades ?? 0;
    e.supplies = type.supply?.capacity ?? 0;
    this.spatial.invalidate();
    if (type.domain === 'air') {
      e.altitudeOverride = opts.altitude;
      e.z = this.terrain.surfaceHeight(e.x, e.y) + (opts.altitude ?? type.cruiseAltitude ?? 100);
      if ((type.minSpeed ?? 0) > 0) e.speed = type.cruiseSpeed;
    } else if (type.domain === 'surface') {
      e.z = this.terrain.surfaceHeight(e.x, e.y);
    } else {
      e.z = this.terrain.elevation(e.x, e.y);
    }
    this.entities.set(id, e);
    this.sensorDue.set(id, this.time + this.rng.range(0, SENSOR_INTERVAL));
    this.log('created', `${name} created`, id);
    return e;
  }

  /** Whether an entity of the domain can be placed at a point (land vs water). */
  canStand(domain: Domain, p: Vec2): boolean {
    if (!this.terrain.inBounds(p.x, p.y)) return false;
    if (domain === 'air') return true;
    return this.terrain.isWater(p.x, p.y) === (domain === 'surface');
  }

  /** Nearest point to `p` (within `maxRadius` m) where the domain can be placed. */
  findValidPosition(p: Vec2, domain: Domain, maxRadius = 400): Vec2 | null {
    if (this.canStand(domain, p)) return { x: p.x, y: p.y };
    for (let r = 10; r <= maxRadius; r += 10) {
      const n = Math.max(8, Math.round((2 * Math.PI * r) / 10));
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        const q = { x: p.x + Math.sin(a) * r, y: p.y + Math.cos(a) * r };
        if (this.canStand(domain, q)) return q;
      }
    }
    return null;
  }

  createUnitFromTemplate(templateId: string, force: ForceId, x: number, y: number, heading = 0, name?: string): Unit {
    const tpl = this.catalog.templates.get(templateId);
    if (!tpl) throw new Error(`unknown unit template: ${templateId}`);
    const members: Entity[] = [];
    // Place the leader at the point and followers at their formation slots.
    for (let k = 0; k < tpl.members.length; k++) {
      const off = k === 0 ? { x: 0, y: 0 } : rotateSlot(tpl.formation, k, tpl.spacing, heading);
      const slot = { x: clampTo(x + off.x, this.terrain.spec.size), y: clampTo(y + off.y, this.terrain.spec.size) };
      const domain = this.catalog.type(tpl.members[k]).domain;
      // Followers whose slot is unusable (e.g. in a lake) are placed at the nearest valid spot.
      const p = k === 0 ? slot : (this.findValidPosition(slot, domain) ?? this.findValidPosition({ x, y }, domain) ?? slot);
      members.push(this.createEntity({ typeId: tpl.members[k], force, x: p.x, y: p.y, heading }));
    }
    const unit = this.groupUnit(members.map((m) => m.id), name ?? tpl.name, tpl.formation, tpl.spacing, tpl.echelon);
    members.forEach((m, i) => (m.name = `${unit.name} ${i === 0 ? 'Lead' : i + 1}`));
    return unit;
  }

  groupUnit(
    entityIds: string[],
    name?: string,
    formation: Formation = 'column',
    spacing = 50,
    echelon: UnitTemplate['echelon'] = 'section',
    id?: string,
  ): Unit {
    const members = entityIds.map((eid) => {
      const e = this.entities.get(eid);
      if (!e) throw new Error(`unknown entity ${eid}`);
      if (e.remote) throw new Error(`cannot group remote entity ${eid}`);
      return e;
    });
    if (members.length === 0) throw new Error('a unit needs at least one member');
    const force = members[0].force;
    if (members.some((m) => m.force !== force)) throw new Error('unit members must share a force');
    for (const m of members) if (m.unit) this.removeFromUnit(m);
    const uid = id ?? this.nextId('U');
    this.bumpCounter(uid);
    const unit = new Unit(uid, name ?? `Unit ${uid.slice(1)}`, force, members, formation, spacing, echelon);
    this.units.set(uid, unit);
    unit.formUp(this);
    this.log('created', `${unit.name} formed with ${members.length} members`, uid);
    return unit;
  }

  private removeFromUnit(e: Entity): void {
    const unit = e.unit;
    if (!unit) return;
    const i = unit.memberList.indexOf(e);
    if (i >= 0) unit.memberList.splice(i, 1);
    e.unit = null;
    if (unit.memberList.length === 0) this.units.delete(unit.id);
    else if (unit.leader === e) unit.update(this);
  }

  addGraphic(kind: GraphicKind, points: Vec2[], name?: string, force: ForceId = 1, id?: string): Graphic {
    if (points.length === 0) throw new Error('a graphic needs at least one point');
    if (kind === 'area' && points.length < 3) throw new Error('an area needs at least three points');
    if ((kind === 'route' || kind === 'phaseLine' || kind === 'obstacle') && points.length < 2) throw new Error(`a ${kind} needs at least two points`);
    if (kind === 'minefield' && points.length < 3) throw new Error('a minefield needs at least three points');
    const gid = id ?? this.nextId('G');
    this.bumpCounter(gid);
    const label = { route: 'Route', area: 'Area', point: 'Point', phaseLine: 'PL', minefield: 'MF', obstacle: 'OBST' }[kind];
    const g: Graphic = { id: gid, kind, name: name ?? `${label} ${gid.slice(1)}`, points: points.map((p) => ({ x: p.x, y: p.y })), force };
    this.graphics.set(gid, g);
    if (kind === 'minefield' || kind === 'obstacle') this.obstacles.changed();
    return g;
  }

  deleteObject(id: string): void {
    const e = this.entities.get(id);
    if (e) {
      e.task?.cancel(e);
      // Passengers of a deleted carrier get out where it was.
      if (!e.remote) this.dismountAll(e, true);
      this.removeFromUnit(e);
      this.entities.delete(id);
      this.sensorDue.delete(id);
      for (const other of this.entities.values()) other.contacts.delete(id);
      for (const fn of this.listeners.removed) fn(e);
      this.log('deleted', `${e.name} deleted`, id);
      return;
    }
    const u = this.units.get(id);
    if (u) {
      for (const m of [...u.memberList]) this.deleteObject(m.id);
      this.units.delete(id);
      return;
    }
    if (this.graphics.delete(id)) {
      this.obstacles.changed();
      return;
    }
    throw new Error(`unknown object ${id}`);
  }

  // ------------------------------------------------------------ mounted infantry

  /** Living entities riding in a carrier. */
  passengersOf(carrierId: string): Entity[] {
    const out: Entity[] = [];
    for (const e of this.entities.values()) if (e.embarkedIn === carrierId && !e.destroyed) out.push(e);
    return out;
  }

  /**
   * Seats left in a carrier, counting passengers and infantry already on their way to
   * board it (other than `boarding`).
   */
  freeSeats(carrier: Entity, boarding?: Entity): number {
    let used = 0;
    for (const e of this.entities.values()) {
      if (e === boarding || e.destroyed) continue;
      if (e.embarkedIn === carrier.id) used++;
      else if (e.task instanceof MountTask && e.task.status === 'running' && e.task.carrier === carrier.id) used++;
    }
    return (carrier.type.capacity ?? 0) - used;
  }

  /** Board a passenger into a carrier now. */
  embark(p: Entity, c: Entity): void {
    if (p.domain !== 'lifeform') throw new Error(`${p.name} is not dismounted infantry`);
    if (p.remote || c.remote) throw new Error('remote entities cannot mount or carry passengers');
    if (p.destroyed || c.destroyed) throw new Error('destroyed entities cannot mount or carry passengers');
    if (p.embarkedIn) throw new Error(`${p.name} is already mounted`);
    if (p === c || p.force !== c.force) throw new Error(`${p.name} cannot mount ${c.name}`);
    if (this.freeSeats(c, p) <= 0) throw new Error(`${c.name} has no free seats`);
    p.embarkedIn = c.id;
    p.plan = null;
    p.steer = null;
    p.speed = 0;
    p.halted = false;
    p.engagingId = undefined;
    p.attackTargetId = undefined;
    p.contacts.clear();
    this.syncPassenger(p, c);
    this.spatial.invalidate();
    this.log('task', `${p.name} mounted ${c.name}`, p.id, c.id);
  }

  private syncPassenger(p: Entity, c: Entity): void {
    p.x = c.x;
    p.y = c.y;
    p.z = c.z;
    p.heading = c.heading;
  }

  /**
   * Let all passengers out around the carrier, in a line behind it. With `bailOut`
   * (carrier hit or deleted) they leave wherever it is, moving or not.
   */
  dismountAll(c: Entity, bailOut = false): Entity[] {
    const list = this.passengersOf(c.id);
    list.forEach((p, k) => {
      const off = rotateOffset({ x: (k - (list.length - 1) / 2) * 4, y: -8 - (k % 2) * 3 }, c.heading);
      const at = this.findValidPosition({ x: c.x + off.x, y: c.y + off.y }, 'lifeform') ?? { x: c.x, y: c.y };
      p.embarkedIn = undefined;
      p.x = at.x;
      p.y = at.y;
      p.z = this.terrain.elevation(at.x, at.y);
      p.speed = 0;
      p.heading = c.heading;
      p.steer = null;
      // Orders given while riding (e.g. the squad's plan) start now; idle soldiers fall in on their leader.
      if (p.task?.status !== 'running') this.setEntityTask(p, null);
      if (p.unit && p.unit.leader !== p && !p.unit.leader?.embarkedIn) p.unit.formUp(this);
    });
    if (list.length) {
      this.spatial.invalidate();
      this.log('task', `${list.length} passenger${list.length > 1 ? 's' : ''} ${bailOut ? 'bailed out of' : 'dismounted from'} ${c.name}`, c.id);
    }
    return list;
  }

  /** Instantly put infantry (an entity or a unit) into a carrier (an entity or a unit's members). */
  embarkNow(passengerId: string, carrierId: string): number {
    const pu = this.units.get(passengerId);
    const people = pu ? pu.alive().filter((m) => !m.embarkedIn) : [this.entities.get(passengerId)];
    const cu = this.units.get(carrierId);
    const carriers = cu ? cu.alive() : [this.entities.get(carrierId)];
    if (people.some((p) => !p)) throw new Error(`unknown entity or unit ${passengerId}`);
    if (carriers.some((c) => !c)) throw new Error(`unknown entity or unit ${carrierId}`);
    let n = 0;
    for (const p of people as Entity[]) {
      const c = (carriers as Entity[]).find((x) => x !== p && x.force === p.force && this.freeSeats(x, p) > 0);
      if (!c) {
        if (n === 0) throw new Error('no free seats');
        break;
      }
      this.setEntityTask(p, null);
      this.embark(p, c);
      n++;
    }
    return n;
  }

  // ------------------------------------------------------------ tasking

  setEntityTask(e: Entity, task: Task | null): void {
    if (e.task && e.task !== task) {
      e.task.cancel(e);
      // A superseded task counts as finished so plans waiting on it move on.
      if (e.task.status === 'running') e.task.status = 'done';
    }
    e.task = task;
    e.steer = null;
  }

  private resolveTarget(id: string): Entity | Unit {
    const target = this.entities.get(id) ?? this.units.get(id);
    if (!target) throw new Error(`unknown entity or unit ${id}`);
    if (target instanceof Entity && target.remote) throw new Error('remote entities cannot be tasked');
    if (target instanceof Entity && target.destroyed) throw new Error(`${target.name} is destroyed`);
    return target;
  }

  /** Assign a task directly; replaces any running plan on the target. */
  assignTask(targetId: string, spec: TaskSpec): void {
    const t = this.resolveTarget(targetId);
    this.validateTask(spec);
    t.plan = null;
    t.assignedPlan = undefined;
    t.assignedTask = spec;
    if (t instanceof Unit) t.startTask(this, spec);
    else this.setEntityTask(t, createTask(spec));
    this.log('task', `${t.name}: ${createTask(spec).describe(this)}`, t.id);
  }

  assignPlan(targetId: string, plan: Plan): void {
    const t = this.resolveTarget(targetId);
    for (const st of plan.statements) if (st.kind === 'task') this.validateTask(st.task);
    t.plan = new PlanExecutor(plan);
    t.assignedPlan = plan;
    t.assignedTask = undefined;
    if (t instanceof Unit) {
      t.taskSpec = null;
      if (t.leader) this.setEntityTask(t.leader, null);
    } else {
      this.setEntityTask(t, null);
    }
    this.log('task', `${t.name}: plan ${plan.name ?? ''} assigned (${plan.statements.length} steps)`.replace('  ', ' '), t.id);
  }

  stop(targetId: string): void {
    const t = this.resolveTarget(targetId);
    t.plan = null;
    t.assignedPlan = undefined;
    t.assignedTask = undefined;
    if (t instanceof Unit) {
      t.taskSpec = null;
      if (t.leader) this.setEntityTask(t.leader, null);
      t.formUp(this);
    } else {
      this.setEntityTask(t, null);
    }
  }

  /** Configure automatic reactions on an entity or a unit (and its members). */
  setReactions(targetId: string, reactions: Reactions): void {
    const t = this.resolveTarget(targetId);
    const r: Reactions = {};
    if (reactions.onContact) r.onContact = reactions.onContact;
    if (reactions.callForFire) r.callForFire = true;
    if (reactions.withdrawBelow !== undefined && reactions.withdrawBelow > 0) {
      r.withdrawBelow = Math.min(1, reactions.withdrawBelow);
      // Fall back to where we are now unless told otherwise.
      const here = t instanceof Unit ? t.centroid() : { x: t.x, y: t.y };
      r.withdrawTo = reactions.withdrawTo ?? { x: Math.round(here.x), y: Math.round(here.y) };
    }
    if (t instanceof Unit) {
      t.reactions = r;
      t.withdrawn = false;
      for (const m of t.memberList) m.reactions = { onContact: r.onContact, callForFire: r.callForFire };
    } else {
      t.reactions = r;
      t.withdrawn = false;
    }
  }

  /** True when the entity's on-contact reaction should hold it in place this tick. */
  private shouldHalt(e: Entity): boolean {
    if (e.reactions.onContact !== 'halt' || e.firepowerKill) return false;
    for (const c of e.contacts.values()) {
      if (this.time - c.lastSeen > 3) continue;
      const t = this.entities.get(c.id);
      if (!t || !t.alive || !this.isHostile(e.force, t.force)) continue;
      const range = Math.hypot(t.x - e.x, t.y - e.y);
      for (const wid of e.type.weapons) {
        const w = this.catalog.weapon(wid);
        if (!w.indirect && (e.ammo.get(wid) ?? 0) > 0 && w.targets.includes(t.domain) && range <= w.maxRange) return true;
      }
    }
    return false;
  }

  /** Withdraw reactions: units below their strength threshold, entities that lost their weapons. */
  private checkWithdrawals(): void {
    for (const u of this.units.values()) {
      const r = u.reactions;
      if (u.withdrawn || !r.withdrawBelow || !r.withdrawTo || !u.leader) continue;
      const alive = u.alive().length;
      if (alive / u.memberList.length >= r.withdrawBelow) continue;
      u.withdrawn = true;
      u.plan = null;
      for (const m of u.memberList) m.roe = 'returnFire';
      u.startTask(this, { type: 'moveTo', target: r.withdrawTo });
      this.log('task', `${u.name}: strength ${alive}/${u.memberList.length}, withdrawing`, u.id);
    }
    for (const e of this.entities.values()) {
      const r = e.reactions;
      if (e.unit || e.withdrawn || e.remote || !e.alive || !r.withdrawBelow || !r.withdrawTo || !e.firepowerKill || e.mobilityKill) continue;
      e.withdrawn = true;
      e.plan = null;
      e.roe = 'returnFire';
      this.setEntityTask(e, createTask({ type: 'moveTo', target: r.withdrawTo }));
      this.log('task', `${e.name}: weapons out of action, withdrawing`, e.id);
    }
  }

  setRoe(targetId: string, roe: Roe): void {
    const t = this.resolveTarget(targetId);
    const members = t instanceof Unit ? t.memberList : [t];
    for (const m of members) m.roe = roe;
  }

  applyEntitySetting(e: Entity, st: PlanStatement): void {
    switch (st.kind) {
      case 'setRoe':
        e.roe = st.roe;
        break;
      case 'setSpeed':
        e.speedOverride = st.speed > 0 ? st.speed : undefined;
        break;
      case 'setAltitude':
        if (e.domain === 'air') e.altitudeOverride = st.altitude;
        break;
      case 'setReactions':
        // Plan steps change only the reactions they name.
        this.setReactions(e.id, { ...e.reactions, ...st.reactions });
        break;
      default:
        break;
    }
  }

  private validateTask(spec: TaskSpec): void {
    switch (spec.type) {
      case 'followRoute':
      case 'patrol': {
        const g = this.graphics.get(spec.routeId);
        if (!g || (g.kind !== 'route' && g.kind !== 'phaseLine')) throw new Error(`unknown route ${spec.routeId}`);
        break;
      }
      case 'follow':
      case 'attack':
        if (!this.entities.has(spec.targetId)) throw new Error(`unknown entity ${spec.targetId}`);
        break;
      case 'mount':
        if (!this.entities.has(spec.carrierId) && !this.units.has(spec.carrierId)) throw new Error(`unknown carrier ${spec.carrierId}`);
        break;
      case 'moveTo':
      case 'orbit':
      case 'fireMission': {
        const p = spec.type === 'orbit' ? spec.center : spec.target;
        if (!this.terrain.inBounds(p.x, p.y)) throw new Error('destination is outside the terrain');
        break;
      }
      default:
        break;
    }
  }

  // ------------------------------------------------------------ munitions

  launch(shot: Shot): void {
    this.shots.push(shot);
    const shooter = this.entities.get(shot.shooterId);
    const target = shot.targetId ? this.entities.get(shot.targetId) : undefined;
    // A vehicle with smoke grenades screens itself when a missile is fired at it.
    if (target && !target.remote && target.alive && shot.weapon.guided && target.smokeLeft > 0) {
      target.smokeLeft--;
      const d = Math.hypot(shot.from.x - target.x, shot.from.y - target.y) || 1;
      this.smoke.add({ x: target.x + ((shot.from.x - target.x) / d) * 30, y: target.y + ((shot.from.y - target.y) / d) * 30 }, 25, 45);
      this.log('info', `${target.name} fired smoke grenades`, target.id);
    }
    const at = target?.name ?? (shot.targetId ? 'target' : `(${Math.round(shot.to.x)}, ${Math.round(shot.to.y)})`);
    this.log('fire', `${shooter?.name ?? shot.shooterId} fired ${shot.weapon.name} at ${at} (${Math.round(shot.range)} m)`, shot.shooterId, shot.targetId, {
      from: shot.from,
      to: shot.to,
      weaponId: shot.weapon.id,
      indirect: shot.weapon.indirect || undefined,
    });
    for (const fn of this.listeners.fire) fn(shot);
  }

  /**
   * Line of sight from an entity's eyes to a target's centre of mass, reusing the last
   * answer while neither has moved (the result is the same; only the work is saved).
   */
  losCached(from: Entity, to: Entity): boolean {
    const key = `${from.id}>${to.id}`;
    const c = this.losMemo.get(key);
    const v = this.terrainVersion * 1e6 + this.smoke.version;
    if (c && c.ax === from.x && c.ay === from.y && c.az === from.z && c.bx === to.x && c.by === to.y && c.bz === to.z && c.v === v) return c.visible;
    const visible = this.lineOfSight(from.eye, { x: to.x, y: to.y, z: to.z + 1.5 });
    if (this.losMemo.size > 200_000) this.losMemo.clear();
    this.losMemo.set(key, { ax: from.x, ay: from.y, az: from.z, bx: to.x, by: to.y, bz: to.z, v, visible });
    return visible;
  }

  /** Line of sight through terrain, canopy and smoke (radar sees through smoke). */
  lineOfSight(a: Vec3, b: Vec3, radar = false): boolean {
    return this.terrain.lineOfSight(a, b) && (radar || !this.smoke.blocks(a, b));
  }

  /** A route for a domain, avoiding obstacles and the minefields `force` knows about. */
  planRoute(from: Vec2, to: Vec2, domain: Domain, offroadFactor: number, force?: ForceId): Vec2[] | null {
    const overlay = this.obstacles.overlay(force, domain);
    const route = this.terrain.planRoute(from, to, domain, offroadFactor, overlay);
    return route && overlay && domain !== 'lifeform' ? this.obstacles.threadLanes(route, from) : route;
  }

  /** An entity set off a mine. */
  mineStrike(e: Entity, field: Graphic): void {
    const roll = this.rng.next();
    const armor = e.type.armor;
    // Kill / mobility-kill chances by armour; the rest of the time the blast does no lasting harm.
    const [kill, mobility] = armor === 'lifeform' ? [0.5, 0] : armor === 'armored' ? [0.1, 0.75] : armor === 'light' ? [0.3, 0.6] : [0.6, 0.35];
    let outcome = 'noEffect';
    if (roll < kill) {
      e.destroyed = true;
      outcome = 'kill';
    } else if (roll < kill + mobility) {
      if (e.mobilityKill) e.destroyed = true;
      e.mobilityKill = true;
      outcome = e.destroyed ? 'kill' : 'mobility';
    }
    e.underFireUntil = this.time + 15;
    this.log('detonation', `${e.name} struck a mine in ${field.name}${outcome === 'noEffect' ? ', no damage' : ''}`, e.id, undefined, { to: e.position, hit: outcome !== 'noEffect' });
    this.obstacles.reveal(field, e.force);
    if (outcome !== 'noEffect') this.afterDamage(e, outcome, undefined, `a mine in ${field.name}`);
  }

  /** Munitions currently in flight. */
  get shotsInFlight(): readonly Shot[] {
    return this.shots;
  }

  hasShotInFlight(shooterId: string, targetId: string, weapon: WeaponDef): boolean {
    return this.shots.some((s) => s.shooterId === shooterId && s.targetId === targetId && (weapon.guided || s.weapon.id === weapon.id));
  }

  private processImpacts(): void {
    if (this.shots.length === 0) return;
    const due = this.shots.filter((s) => s.impactTime <= this.time);
    if (due.length === 0) return;
    this.shots = this.shots.filter((s) => s.impactTime > this.time);
    for (const shot of due) this.reportDetonation(resolveImpact(this, shot));
  }

  private reportDetonation(det: Detonation): void {
    const shot = det.shot;
    if (det.smoke) {
      this.log('detonation', `${shot.weapon.name} smoke at (${Math.round(det.location.x)}, ${Math.round(det.location.y)})`, shot.shooterId, undefined, { to: det.location, hit: false, weaponId: shot.weapon.id });
      for (const fn of this.listeners.detonation) fn(det);
      return;
    }
    if (det.effects) {
      const names = det.effects.map((f) => `${this.nameOf(f.entityId)}${f.outcome === 'kill' ? ' destroyed' : ` ${f.outcome} kill`}`);
      const at = `(${Math.round(det.location.x)}, ${Math.round(det.location.y)})`;
      this.log('detonation', `${shot.weapon.name} impact at ${at}: ${names.length ? names.join(', ') : 'no effect'}`, shot.shooterId, det.effects[0]?.entityId, {
        to: det.location,
        hit: det.hit,
        weaponId: shot.weapon.id,
        radius: shot.weapon.blastRadius,
      });
      for (const fn of this.listeners.detonation) fn(det);
      for (const f of det.effects) this.afterDamage(this.entities.get(f.entityId)!, f.outcome, shot.shooterId);
      return;
    }
    const target = shot.targetId ? this.entities.get(shot.targetId) : undefined;
    const tname = target?.name ?? 'target';
    const text = det.guidanceLost
      ? `${shot.weapon.name} lost guidance and missed ${tname}`
      : det.outcome === 'kill'
        ? `${shot.weapon.name} destroyed ${tname}`
        : det.outcome === 'mobility'
          ? `${shot.weapon.name} hit ${tname}: mobility kill`
          : det.outcome === 'firepower'
            ? `${shot.weapon.name} hit ${tname}: firepower kill`
            : det.hit
              ? `${shot.weapon.name} hit ${tname}`
              : `${shot.weapon.name} missed ${tname}`;
    this.log('detonation', text, shot.shooterId, shot.targetId, { to: det.location, hit: det.hit, weaponId: shot.weapon.id });
    for (const fn of this.listeners.detonation) fn(det);
    if (target) this.afterDamage(target, det.outcome, shot.shooterId);
  }

  afterDamage(target: Entity, outcome: string, byId?: string, cause?: string): void {
    if ((outcome === 'kill' || outcome === 'mobility') && !target.remote) {
      // Passengers of a knocked-out carrier: some die with it, the rest bail out.
      if (outcome === 'kill') {
        for (const p of this.passengersOf(target.id)) {
          if (!this.rng.chance(0.5)) continue;
          p.destroyed = true;
          p.embarkedIn = undefined;
          this.log('destroyed', `${p.name} killed inside ${target.name}`, p.id, byId);
        }
      }
      this.dismountAll(target, true);
    }
    if (outcome === 'kill') {
      target.task?.cancel(target);
      target.task = null;
      target.plan = null;
      target.steer = null;
      target.contacts.clear();
      const by = byId ? this.nameOf(byId) : (cause ?? 'unknown');
      this.log('destroyed', `${target.name} destroyed by ${by}`, target.id, byId);
    } else if (outcome === 'mobility' || outcome === 'firepower') {
      this.log('damaged', `${target.name} suffered a ${outcome} kill`, target.id, byId);
    }
  }

  /** Turn optional model parts on or off. */
  setRules(rules: SimulationRules): void {
    for (const k of Object.keys(DEFAULT_RULES) as (keyof SimulationRules)[]) if (typeof rules[k] === 'boolean') this.rules[k] = rules[k]!;
    if (!this.rules.suppression) for (const e of this.entities.values()) e.suppression = 0;
  }

  /** Change the time of day and weather. `time` is the time of day at the scenario's start. */
  setEnvironment(env: Environment): void {
    this.environment = normalizeEnvironment(env, this.environment);
    this.updateEnvironment();
  }

  private updateEnvironment(): void {
    this.env = environmentAt(this.environment, this.terrain.spec.origin.lat, this.time);
  }

  /** Give an entity a task without changing what was assigned to it (internal behaviours). */
  assignTaskInternal(e: Entity, spec: TaskSpec): void {
    this.setEntityTask(e, createTask(spec));
  }

  /** Catalog weapon with a given DIS munition type, if any. */
  weaponForMunition(munition: { kind: number; domain: number; country: number; category: number; subcategory: number }): WeaponDef | undefined {
    return this.catalog.catalog.weapons.find(
      (x) =>
        x.munition.kind === munition.kind &&
        x.munition.domain === munition.domain &&
        x.munition.country === munition.country &&
        x.munition.category === munition.category &&
        x.munition.subcategory === munition.subcategory,
    );
  }

  /**
   * Area damage from a detonation another simulation reported at a location (no target
   * entity), when the munition is a known area-effect round. Returns false otherwise.
   */
  applyExternalAreaDetonation(munition: { kind: number; domain: number; country: number; category: number; subcategory: number }, location: Vec3, shooterId?: string): boolean {
    const w = this.weaponForMunition(munition);
    if (!w?.blastRadius) return false;
    this.spatial.invalidate();
    const effects = applyBlast(this, w, location, shooterId);
    const names = effects.map((f) => `${this.nameOf(f.entityId)}${f.outcome === 'kill' ? ' destroyed' : ` ${f.outcome} kill`}`);
    this.log('detonation', `external ${w.name} impact: ${names.length ? names.join(', ') : 'no effect'}`, shooterId, effects[0]?.entityId, { to: location, hit: effects.length > 0 });
    for (const f of effects) this.afterDamage(this.entities.get(f.entityId)!, f.outcome, shooterId);
    return true;
  }

  /** Damage a local entity from a detonation reported by another simulation. */
  applyExternalDetonation(targetId: string, munition: { kind: number; domain: number; country: number; category: number; subcategory: number }, location: Vec3, shooterId?: string): void {
    const target = this.entities.get(targetId);
    if (!target || target.remote || target.destroyed) return;
    if (dist2d(target, location) > 30) return;
    // Use a catalog weapon with the same munition type when we know it.
    const w = this.weaponForMunition(munition);
    const pk = w ? effectivePk(this, undefined, target, w, 0) : 0.3;
    if (shooterId) target.attackers.set(shooterId, this.time);
    target.underFireUntil = this.time + 15;
    const outcome = applyDamage(this, target, pk);
    this.log('detonation', `external detonation on ${target.name}: ${outcome}`, shooterId, target.id, { to: location, hit: true });
    this.afterDamage(target, outcome, shooterId);
  }

  // ------------------------------------------------------------ remote entities (DIS)

  upsertRemote(u: RemoteEntityUpdate): Entity {
    let e = this.entities.get(u.id);
    if (!e) {
      const type = this.catalog.type(u.typeId);
      e = new Entity(u.id, u.name, type, u.force, u.position, u.heading);
      e.remote = true;
      e.remoteDis = u.dis;
      this.entities.set(u.id, e);
      this.log('created', `remote entity ${u.name} joined`, u.id);
    }
    e.name = u.name || e.name;
    e.x = u.position.x;
    e.y = u.position.y;
    e.z = u.position.z;
    e.heading = u.heading;
    e.pitch = u.pitch;
    e.roll = u.roll;
    e.remoteVelocity = u.velocity;
    e.speed = Math.hypot(u.velocity.x, u.velocity.y);
    e.remoteLastUpdate = this.time;
    if (u.destroyed && !e.destroyed) {
      e.destroyed = true;
      this.log('destroyed', `remote entity ${e.name} destroyed`, e.id);
    }
    return e;
  }

  // ------------------------------------------------------------ simulation loop

  step(dt = DEFAULT_DT): void {
    // Round so repeated 0.1 s steps don't accumulate floating-point noise (900.0000000001).
    this.time = Math.round((this.time + dt) * 1e6) / 1e6;
    this.spatial.invalidate();
    decaySuppression(this, dt);
    for (const u of this.units.values()) u.update(this);
    for (const u of this.units.values()) u.plan?.update(this, u);

    this.checkWithdrawals();

    for (const e of this.entities.values()) {
      if (e.remote || e.destroyed || e.embarkedIn) continue;
      if (e.plan) e.plan.update(this, new EntityTaskable(e));
      const task = e.task;
      const halt = this.shouldHalt(e);
      if (halt !== e.halted) {
        e.halted = halt;
        if (!e.unit || e.unit.leader === e) this.log('task', `${e.name}: ${halt ? 'halted on contact' : 'resuming'}`, e.id);
      }
      const pinned = isPinned(this, e);
      if (pinned !== e.pinned) {
        e.pinned = pinned;
        if (!e.unit || e.unit.leader === e) this.log('info', `${e.name}: ${pinned ? 'pinned down' : 'moving again'}`, e.id);
      }
      if (halt || pinned) {
        // Stop and fight; the task keeps its progress and resumes afterwards.
        e.steer = { x: e.x, y: e.y, speed: 0, arrive: true };
      } else if (task && task.status === 'running') {
        const status = task.update({ engine: this, entity: e, dt });
        if (status !== 'running') {
          if (status === 'failed') this.log('task', `${e.name}: ${task.describe(this)} failed${task.message ? `: ${task.message}` : ''}`, e.id);
          if (e.task === task) e.steer = null;
        }
      } else if (!task || task.status !== 'running') {
        e.steer = null;
      }
    }

    const ground = groundFactor(this.env);
    let hasObstacles = false;
    // Out of fuel, vehicles stop where they are.
    if (this.rules.fuel) for (const e of this.entities.values()) if (e.fuel <= 0 && e.domain !== 'air' && !e.remote) e.steer = null;
    for (const g of this.graphics.values()) if (g.kind === 'minefield' || g.kind === 'obstacle') hasObstacles = true;
    for (const e of this.entities.values()) {
      if (!e.embarkedIn) {
        if (hasObstacles && !e.remote && !e.destroyed && (e.domain === 'ground' || e.domain === 'lifeform')) {
          const prev = { x: e.x, y: e.y };
          stepMovement(e, this.terrain, dt, ground);
          this.obstacles.afterMove(e, prev);
        } else {
          stepMovement(e, this.terrain, dt, ground);
        }
        continue;
      }
      const c = this.entities.get(e.embarkedIn);
      if (c) this.syncPassenger(e, c);
      else e.embarkedIn = undefined;
    }
    if (this.rules.fuel) for (const e of this.entities.values()) if (e.type.endurance) burnFuel(this, e, dt);

    for (const e of this.entities.values()) {
      if (e.remote) continue;
      const due = this.sensorDue.get(e.id) ?? 0;
      if (this.time >= due) {
        this.sensorDue.set(e.id, due + SENSOR_INTERVAL);
        updateSensors(this, e);
      }
    }
    if (Math.round(this.time * 10) % 10 === 0) {
      this.updateEnvironment();
      this.smoke.expire(windVector(this.env));
      checkCallsForFire(this);
      updateMorale(this);
      updateResupply(this);
    }
    for (const e of this.entities.values()) updateCombat(this, e);
    this.processImpacts();
    for (const fn of this.listeners.step) fn(this.time);
  }

  /** Advance the simulation by `seconds` of simulated time in fixed steps. */
  runFor(seconds: number, dt = DEFAULT_DT): void {
    const steps = Math.round(seconds / dt);
    for (let i = 0; i < steps; i++) this.step(dt);
  }

  // ------------------------------------------------------------ scenarios

  private clear(): void {
    for (const e of [...this.entities.values()]) for (const fn of this.listeners.removed) fn(e);
    this.entities.clear();
    this.units.clear();
    this.graphics.clear();
    this.shots = [];
    this.sensorDue.clear();
    this.losMemo.clear();
    this.smoke.clear();
    this.obstacles.changed();
    this.counters = { E: 0, U: 0, G: 0 };
    this.disCounter = 0;
    this.time = 0;
  }

  newScenario(name = 'Untitled', terrain: Partial<TerrainSpec> = {}): void {
    this.loadScenario({
      format: 'werforces-scenario',
      version: 1,
      name,
      terrain: { ...DEFAULT_TERRAIN, ...terrain, origin: { ...DEFAULT_TERRAIN.origin, ...terrain.origin } },
      entities: [],
      units: [],
      graphics: [],
    });
  }

  loadScenario(s: ScenarioFile): void {
    if (s.format !== 'werforces-scenario') throw new Error('not a WeRForces scenario file');
    if (s.version !== 1) throw new Error(`unsupported scenario version ${s.version}`);
    let spec: TerrainSpec = { ...DEFAULT_TERRAIN, ...s.terrain, origin: { ...DEFAULT_TERRAIN.origin, ...s.terrain?.origin } };
    let terrain: Terrain | null = null;
    if (spec.dataset) {
      // Real-world terrain: everything but the dataset name comes from the dataset.
      if (this.terrain.spec.dataset !== spec.dataset) {
        if (!this.terrainLoader) throw new Error(`terrain dataset "${spec.dataset}" cannot be loaded here`);
        terrain = Terrain.fromData(this.terrainLoader(spec.dataset));
        spec = terrain.spec;
      } else {
        spec = this.terrain.spec;
      }
    } else if (JSON.stringify(spec) !== JSON.stringify(this.terrain.spec)) {
      terrain = Terrain.generate(spec);
    }
    this.clear();
    if (terrain) {
      this.terrain = terrain;
      this.terrainVersion++;
    }
    this.rng = new Rng(spec.seed);
    this.rules = { ...DEFAULT_RULES };
    this.setRules(s.rules ?? {});
    this.environment = normalizeEnvironment(s.environment);
    this.events = [];
    this.scenarioName = s.name;
    this.description = s.description ?? '';
    this.time = s.startTime ?? 0;
    this.updateEnvironment();
    this.setHostilities(s.hostilities ?? [[1, 2]]);
    for (const g of s.graphics ?? []) this.addGraphic(g.kind, g.points, g.name, g.force, g.id);
    for (const r of s.entities ?? []) {
      const e = this.createEntity({ id: r.id, typeId: r.typeId, force: r.force, x: r.x, y: r.y, heading: r.heading, name: r.name, altitude: r.altitude });
      if (r.roe) e.roe = r.roe;
      if (r.reactions) e.reactions = { ...r.reactions };
      if (r.state) this.restoreEntityState(e, r);
    }
    for (const u of s.units ?? []) {
      const unit = this.groupUnit(u.memberIds, u.name, u.formation, u.spacing, u.echelon, u.id);
      if (u.reactions) unit.reactions = { ...u.reactions };
      unit.withdrawn = !!u.state?.withdrawn;
      if (u.state?.morale !== undefined) unit.morale = u.state.morale;
      if (u.state?.moraleState) unit.moraleState = u.state.moraleState;
      if (u.state?.lossesSeen !== undefined) unit.lossesSeen = u.state.lossesSeen;
      const leader = u.state?.leaderId ? this.entities.get(u.state.leaderId) : undefined;
      if (leader && unit.memberList.includes(leader)) {
        unit.leader = leader;
        if (leader.alive) unit.formUp(this);
      }
    }
    // Tasks and plans last, since they can reference any object. Checkpoints resume them part-way.
    for (const r of s.entities ?? []) {
      const e = this.entities.get(r.id)!;
      if (e.destroyed || e.embarkedIn) continue;
      if (r.plan) {
        this.assignPlan(r.id, r.plan);
        if (r.state?.planIndex !== undefined) e.plan!.resume(r.state.planIndex, r.state.taskState);
      } else if (r.task && !r.state?.taskDone) {
        this.assignTask(r.id, r.state?.taskState ?? r.task);
        e.assignedTask = r.task;
      } else if (r.task) {
        e.assignedTask = r.task;
      }
    }
    const records = new Map((s.entities ?? []).map((r) => [r.id, r]));
    for (const u of s.units ?? []) {
      const unit = this.units.get(u.id)!;
      if (!unit.leader) continue;
      if (u.plan) {
        this.assignPlan(u.id, u.plan);
        if (u.state?.planIndex !== undefined) unit.plan!.resume(u.state.planIndex, u.state.taskState);
      } else if (u.task && !u.state?.taskDone) {
        this.assignTask(u.id, u.state?.taskState ?? u.task);
        unit.assignedTask = u.task;
        if (u.state && perMemberTask(u.task)) {
          // Each member resumes its own part (e.g. rounds left to fire); finished members stay idle.
          for (const m of unit.alive()) {
            const st = records.get(m.id)?.state?.taskState;
            this.setEntityTask(m, st && st.type === u.task.type ? createTask(st) : null);
          }
        }
      } else if (u.task) {
        unit.assignedTask = u.task;
      }
    }
    if (s.smoke) this.smoke.restore(s.smoke);
    for (const r of s.shots ?? []) {
      const weapon = this.catalog.weapons.get(r.weaponId);
      if (weapon) this.shots.push({ ...r, weapon });
    }
    for (const r of s.entities ?? []) if (r.state?.sensorDue !== undefined) this.sensorDue.set(r.id, r.state.sensorDue);
    if (s.rngState !== undefined) this.rng.state = s.rngState;
    this.initialScenario = JSON.parse(JSON.stringify(s));
    for (const fn of this.listeners.reset) fn();
    this.log('info', `scenario "${s.name}" loaded`);
  }

  private restoreEntityState(e: Entity, r: EntityRecord): void {
    const st = r.state!;
    e.destroyed = !!st.destroyed;
    e.mobilityKill = !!st.mobilityKill;
    e.firepowerKill = !!st.firepowerKill;
    if (st.z !== undefined) e.z = st.z;
    if (st.speed !== undefined) e.speed = st.speed;
    for (const [k, v] of Object.entries(st.ammo ?? {})) if (e.ammo.has(k)) e.ammo.set(k, v);
    for (const [k, v] of Object.entries(st.weaponReadyAt ?? {})) e.weaponReadyAt.set(k, v);
    for (const c of st.contacts ?? []) e.contacts.set(c.id, { ...c });
    for (const [k, v] of Object.entries(st.attackers ?? {})) e.attackers.set(k, v);
    if (st.underFireUntil !== undefined) e.underFireUntil = st.underFireUntil;
    if (st.lastFiredAt !== undefined) e.lastFiredAt = st.lastFiredAt;
    e.speedOverride = st.speedOverride;
    if (st.altitudeOverride !== undefined) e.altitudeOverride = st.altitudeOverride;
    e.withdrawn = !!st.withdrawn;
    if (st.embarkedIn) e.embarkedIn = st.embarkedIn;
    if (st.callForFireAt !== undefined) e.callForFireAt = st.callForFireAt;
    if (st.smokeLeft !== undefined) e.smokeLeft = st.smokeLeft;
    if (st.suppression !== undefined) e.suppression = st.suppression;
    if (st.morale !== undefined) e.morale = st.morale;
    if (st.moraleState) e.moraleState = st.moraleState;
    if (st.fuel !== undefined) e.fuel = st.fuel;
    if (st.supplies !== undefined) e.supplies = st.supplies;
  }

  private authoredState(e: Entity): EntityRecord['state'] {
    const st = { destroyed: e.destroyed || undefined, mobilityKill: e.mobilityKill || undefined, firepowerKill: e.firepowerKill || undefined, embarkedIn: e.embarkedIn };
    return Object.values(st).some((v) => v !== undefined) ? st : undefined;
  }

  private entityRecord(e: Entity): EntityRecord {
    const finite = (v: number) => (Number.isFinite(v) ? v : undefined);
    const map = (m: Map<string, number>) => (m.size ? Object.fromEntries(m) : undefined);
    const ownTask = e.task && e.task.status === 'running' && !(e.unit && e.unit.leader !== e && e.task.spec.type === 'formation') && !(e.unit && e.unit.leaderTask === e.task);
    return {
      id: e.id,
      name: e.name,
      typeId: e.type.id,
      force: e.force,
      x: Math.round(e.x * 10) / 10,
      y: Math.round(e.y * 10) / 10,
      heading: Math.round(e.heading * 1000) / 1000,
      altitude: e.domain === 'air' ? Math.round(e.z - this.terrain.surfaceHeight(e.x, e.y)) : undefined,
      roe: e.roe,
      plan: e.assignedPlan,
      task: e.assignedTask,
      reactions: Object.keys(e.reactions).length ? e.reactions : undefined,
      // At time 0 (scenario authoring) only damage and embarkation are worth keeping.
      state: this.time === 0 ? this.authoredState(e) : {
        destroyed: e.destroyed || undefined,
        mobilityKill: e.mobilityKill || undefined,
        firepowerKill: e.firepowerKill || undefined,
        speed: e.speed ? Math.round(e.speed * 100) / 100 : undefined,
        z: e.domain === 'air' ? Math.round(e.z * 10) / 10 : undefined,
        ammo: map(e.ammo),
        weaponReadyAt: map(e.weaponReadyAt),
        contacts: e.contacts.size ? [...e.contacts.values()].map((c) => ({ ...c })) : undefined,
        attackers: map(e.attackers),
        underFireUntil: finite(e.underFireUntil),
        lastFiredAt: finite(e.lastFiredAt),
        sensorDue: this.sensorDue.get(e.id),
        speedOverride: e.speedOverride,
        altitudeOverride: e.altitudeOverride,
        planIndex: e.plan ? e.plan.index : undefined,
        taskState: ownTask ? e.task!.resumeSpec() : undefined,
        withdrawn: e.withdrawn || undefined,
        embarkedIn: e.embarkedIn,
        taskDone: (!!e.assignedTask && !(e.task && e.task.status === 'running')) || undefined,
        callForFireAt: finite(e.callForFireAt),
        smokeLeft: e.smokeLeft !== (e.type.smokeGrenades ?? 0) ? e.smokeLeft : undefined,
        suppression: e.suppression || undefined,
        morale: e.morale < 1 ? e.morale : undefined,
        moraleState: e.moraleState !== 'steady' ? e.moraleState : undefined,
        fuel: e.fuel < 1 ? e.fuel : undefined,
        supplies: e.type.supply && e.supplies !== e.type.supply.capacity ? e.supplies : undefined,
      },
    };
  }

  /**
   * Replace the random number generator. Loading a scenario seeds it from the terrain
   * seed, so runs are repeatable; reseed after loading to get a different replication
   * (e.g. for Monte Carlo analysis).
   */
  reseed(seed: number): void {
    this.rng = new Rng(seed);
  }

  /** Make the current state the point that rewind() returns to (done when a scenario is saved). */
  markRewindPoint(): void {
    this.initialScenario = JSON.parse(JSON.stringify(this.toScenario()));
  }

  /** Restore the scenario as it was last loaded or saved (VR-Forces "rewind"). */
  rewind(): void {
    if (this.initialScenario) this.loadScenario(this.initialScenario);
  }

  /**
   * Serialize the current state as a scenario. It is a full checkpoint: damage, ammunition,
   * contacts, plan/task progress, munitions in flight and the random number state are kept,
   * so loading it continues the run. Route planning restarts from current positions.
   */
  toScenario(): ScenarioFile {
    const local = [...this.entities.values()].filter((e) => !e.remote);
    return {
      format: 'werforces-scenario',
      version: 1,
      name: this.scenarioName,
      description: this.description,
      terrain: this.terrain.spec,
      startTime: Math.round(this.time * 1e6) / 1e6,
      hostilities: [...this.hostilities].map((k) => k.split('-').map(Number) as [ForceId, ForceId]),
      entities: local.map((e) => this.entityRecord(e)),
      units: [...this.units.values()].map((u) => ({
        id: u.id,
        name: u.name,
        force: u.force,
        memberIds: u.memberList.map((m) => m.id),
        formation: u.formation,
        spacing: u.spacing,
        echelon: u.echelon,
        plan: u.assignedPlan,
        task: u.assignedTask,
        reactions: Object.keys(u.reactions).length ? u.reactions : undefined,
        state: this.time === 0 ? undefined : {
          planIndex: u.plan ? u.plan.index : undefined,
          taskState: u.taskSpec && u.leaderTask?.status === 'running' ? u.leaderTask.resumeSpec() : undefined,
          leaderId: u.leader?.id,
          withdrawn: u.withdrawn || undefined,
          taskDone: (!!u.assignedTask && u.taskStatus() !== 'running') || undefined,
          morale: u.morale < 1 ? u.morale : undefined,
          moraleState: u.moraleState !== 'steady' ? u.moraleState : undefined,
          lossesSeen: u.lossesSeen || undefined,
        },
      })),
      graphics: [...this.graphics.values()],
      shots: this.shots.length === 0 ? undefined : this.shots.map((sh) => ({
        eventNumber: sh.eventNumber,
        shooterId: sh.shooterId,
        targetId: sh.targetId,
        weaponId: sh.weapon.id,
        from: sh.from,
        to: sh.to,
        fireTime: sh.fireTime,
        impactTime: sh.impactTime,
        range: sh.range,
      })),
      rngState: this.time === 0 ? undefined : this.rng.state,
      rules: Object.values(this.rules).every((v) => v) ? undefined : { ...this.rules },
      environment: JSON.stringify(this.environment) === JSON.stringify(DEFAULT_ENVIRONMENT) ? undefined : { ...this.environment },
      smoke: this.smoke.clouds.length ? this.smoke.clouds.map((c) => ({ ...c })) : undefined,
    };
  }

  // ------------------------------------------------------------ snapshots

  snapshotEntity(e: Entity, passengers?: Map<string, string[]>): EntitySnapshot {
    const running = e.task && e.task.status === 'running';
    const riders = (e.type.capacity ?? 0) > 0 ? (passengers ? passengers.get(e.id) : this.passengersOf(e.id).map((p) => p.id)) : undefined;
    return {
      id: e.id,
      name: e.name,
      typeId: e.type.id,
      force: e.force,
      domain: e.domain,
      symbol: e.type.symbol,
      x: e.x,
      y: e.y,
      z: e.z,
      agl: e.z - this.terrain.surfaceHeight(e.x, e.y),
      heading: e.heading,
      pitch: e.pitch,
      speed: e.speed,
      damage: e.damage,
      remote: e.remote,
      unitId: e.unit?.id,
      isLeader: e.unit ? e.unit.leader === e : undefined,
      roe: e.roe,
      task: running ? e.task!.describe(this) : undefined,
      plan: e.plan?.describe(this),
      ammo: e.type.weapons.map((w) => ({ weapon: w, rounds: e.ammo.get(w) ?? 0 })),
      contacts: [...e.contacts.keys()],
      engagingId: e.engagingId,
      reactions: Object.keys(e.reactions).length ? e.reactions : undefined,
      halted: e.halted || undefined,
      withdrawn: e.withdrawn || undefined,
      embarkedIn: e.embarkedIn,
      passengers: riders?.length ? riders : undefined,
      suppression: e.suppression ? Math.round(e.suppression * 100) / 100 : undefined,
      pinned: e.pinned || undefined,
      morale: e.unit || !this.rules.morale ? undefined : Math.round(e.morale * 100) / 100,
      moraleState: e.unit || !this.rules.morale || e.moraleState === 'steady' ? undefined : e.moraleState,
      fuel: e.type.endurance && this.rules.fuel ? Math.round(e.fuel * 1000) / 1000 : undefined,
      supplies: e.type.supply ? Math.round(e.supplies * 100) / 100 : undefined,
    };
  }

  snapshot(): SimState {
    const passengers = new Map<string, string[]>();
    for (const e of this.entities.values()) {
      if (!e.embarkedIn || e.destroyed) continue;
      const list = passengers.get(e.embarkedIn);
      if (list) list.push(e.id);
      else passengers.set(e.embarkedIn, [e.id]);
    }
    const units: UnitSnapshot[] = [...this.units.values()].map((u) => {
      const c = u.centroid();
      const leaderTask = u.leader?.task;
      return {
        id: u.id,
        name: u.name,
        force: u.force,
        echelon: u.echelon,
        formation: u.formation,
        leaderId: u.leader?.id,
        memberIds: u.memberList.map((m) => m.id),
        x: c.x,
        y: c.y,
        task: u.taskSpec && leaderTask && leaderTask.status === 'running' ? leaderTask.describe(this) : undefined,
        plan: u.plan?.describe(this),
        reactions: Object.keys(u.reactions).length ? u.reactions : undefined,
        withdrawn: u.withdrawn || undefined,
        morale: this.rules.morale ? Math.round(u.morale * 100) / 100 : undefined,
        moraleState: this.rules.morale ? u.moraleState : undefined,
      };
    });
    return {
      time: this.time,
      running: false,
      timeScale: 1,
      scenarioName: this.scenarioName,
      entities: [...this.entities.values()].map((e) => this.snapshotEntity(e, passengers)),
      units,
      graphics: [...this.graphics.values()],
      smoke: this.smoke.clouds.length ? this.smoke.clouds : undefined,
      environment: this.env,
    };
  }

  /** Planned path for an entity's current move, for display. */
  plannedPath(id: string): Vec2[] {
    const task = this.entities.get(id)?.task;
    return task && task.status === 'running' ? task.remainingPath : [];
  }

  /** Execute a command and report success/failure instead of throwing. */
  safely(fn: () => string | void): CommandResult {
    try {
      const id = fn();
      return { ok: true, id: id || undefined };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

function rotateSlot(formation: Formation, k: number, spacing: number, heading: number): Vec2 {
  return rotateOffset(formationOffset(formation, k, spacing), heading);
}

function clampTo(v: number, size: number): number {
  return Math.min(Math.max(v, 0), size);
}
