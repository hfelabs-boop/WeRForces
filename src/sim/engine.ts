// The simulation engine (the "back-end"): owns terrain, entities, units and tactical
// graphics, advances simulated time and publishes events to the server and DIS gateway.

import { dist2d, rotateOffset } from '../shared/math.js';
import type {
  Catalog,
  CommandResult,
  Domain,
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
  TerrainSpec,
  UnitSnapshot,
  UnitTemplate,
  Vec2,
  Vec3,
  WeaponDef,
} from '../shared/types.js';
import { CatalogIndex, DEFAULT_CATALOG } from './catalog.js';
import { applyDamage, type Detonation, effectivePk, resolveImpact, type Shot, updateCombat } from './combat.js';
import { Entity } from './entity.js';
import { stepMovement } from './movement.js';
import { PlanExecutor, type Taskable } from './plans.js';
import { Rng } from './rng.js';
import { SENSOR_INTERVAL, updateSensors } from './sensors.js';
import { createTask, type Task, type TaskStatus } from './tasks.js';
import { DEFAULT_TERRAIN, Terrain } from './terrain.js';
import { formationOffset, Unit } from './units.js';

export const DEFAULT_DT = 0.1;
const MAX_EVENTS = 1000;

type Listener<T> = (value: T) => void;

export interface EngineListeners {
  event: Listener<SimEvent>[];
  fire: Listener<Shot>[];
  detonation: Listener<Detonation>[];
  removed: Listener<Entity>[];
  reset: Listener<void>[];
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
  readonly graphics = new Map<string, Graphic>();
  readonly listeners: EngineListeners = { event: [], fire: [], detonation: [], removed: [], reset: [] };

  private hostilities = new Set<string>(['1-2']);
  private shots: Shot[] = [];
  private events: SimEvent[] = [];
  private eventSeq = 0;
  private eventNumber = 0;
  private disCounter = 0;
  private counters = { E: 0, U: 0, G: 0 };
  private sensorDue = new Map<string, number>();
  private initialScenario: ScenarioFile | null = null;

  constructor(opts: { catalog?: Catalog; terrain?: Terrain; seed?: number } = {}) {
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
    if (type.domain === 'air') {
      e.altitudeOverride = opts.altitude;
      e.z = this.terrain.surfaceHeight(e.x, e.y) + (opts.altitude ?? type.cruiseAltitude ?? 100);
      if ((type.minSpeed ?? 0) > 0) e.speed = type.cruiseSpeed;
    } else if (type.domain === 'surface') {
      e.z = 0;
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
    if ((kind === 'route' || kind === 'phaseLine') && points.length < 2) throw new Error(`a ${kind} needs at least two points`);
    const gid = id ?? this.nextId('G');
    this.bumpCounter(gid);
    const label = { route: 'Route', area: 'Area', point: 'Point', phaseLine: 'PL' }[kind];
    const g: Graphic = { id: gid, kind, name: name ?? `${label} ${gid.slice(1)}`, points: points.map((p) => ({ x: p.x, y: p.y })), force };
    this.graphics.set(gid, g);
    return g;
  }

  deleteObject(id: string): void {
    const e = this.entities.get(id);
    if (e) {
      e.task?.cancel(e);
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
    if (this.graphics.delete(id)) return;
    throw new Error(`unknown object ${id}`);
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
      case 'moveTo':
      case 'orbit': {
        const p = spec.type === 'moveTo' ? spec.target : spec.center;
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
    this.log('fire', `${shooter?.name ?? shot.shooterId} fired ${shot.weapon.name} at ${target?.name ?? 'target'} (${Math.round(shot.range)} m)`, shot.shooterId, shot.targetId, {
      from: shot.from,
      to: shot.to,
      weaponId: shot.weapon.id,
    });
    for (const fn of this.listeners.fire) fn(shot);
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
    const target = shot.targetId ? this.entities.get(shot.targetId) : undefined;
    const tname = target?.name ?? 'target';
    const text =
      det.outcome === 'kill'
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

  private afterDamage(target: Entity, outcome: string, byId?: string): void {
    if (outcome === 'kill') {
      target.task?.cancel(target);
      target.task = null;
      target.plan = null;
      target.steer = null;
      target.contacts.clear();
      const by = byId ? this.nameOf(byId) : 'unknown';
      this.log('destroyed', `${target.name} destroyed by ${by}`, target.id, byId);
    } else if (outcome === 'mobility' || outcome === 'firepower') {
      this.log('damaged', `${target.name} suffered a ${outcome} kill`, target.id, byId);
    }
  }

  /** Damage a local entity from a detonation reported by another simulation. */
  applyExternalDetonation(targetId: string, munition: { kind: number; domain: number; country: number; category: number; subcategory: number }, location: Vec3, shooterId?: string): void {
    const target = this.entities.get(targetId);
    if (!target || target.remote || target.destroyed) return;
    if (dist2d(target, location) > 30) return;
    // Use a catalog weapon with the same munition type when we know it.
    const w = this.catalog.catalog.weapons.find(
      (x) =>
        x.munition.kind === munition.kind &&
        x.munition.domain === munition.domain &&
        x.munition.country === munition.country &&
        x.munition.category === munition.category &&
        x.munition.subcategory === munition.subcategory,
    );
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
    for (const u of this.units.values()) u.update(this);
    for (const u of this.units.values()) u.plan?.update(this, u);

    for (const e of this.entities.values()) {
      if (e.remote || e.destroyed) continue;
      if (e.plan) e.plan.update(this, new EntityTaskable(e));
      const task = e.task;
      if (task && task.status === 'running') {
        const status = task.update({ engine: this, entity: e, dt });
        if (status !== 'running') {
          if (status === 'failed') this.log('task', `${e.name}: ${task.describe(this)} failed${task.message ? `: ${task.message}` : ''}`, e.id);
          if (e.task === task) e.steer = null;
        }
      } else if (!task || task.status !== 'running') {
        e.steer = null;
      }
    }

    for (const e of this.entities.values()) stepMovement(e, this.terrain, dt);

    for (const e of this.entities.values()) {
      if (e.remote) continue;
      const due = this.sensorDue.get(e.id) ?? 0;
      if (this.time >= due) {
        this.sensorDue.set(e.id, due + SENSOR_INTERVAL);
        updateSensors(this, e);
      }
    }
    for (const e of this.entities.values()) updateCombat(this, e);
    this.processImpacts();
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
    const spec = { ...DEFAULT_TERRAIN, ...s.terrain, origin: { ...DEFAULT_TERRAIN.origin, ...s.terrain?.origin } };
    this.clear();
    if (JSON.stringify(spec) !== JSON.stringify(this.terrain.spec)) {
      this.terrain = Terrain.generate(spec);
      this.terrainVersion++;
    }
    this.rng = new Rng(spec.seed);
    this.events = [];
    this.scenarioName = s.name;
    this.description = s.description ?? '';
    this.time = s.startTime ?? 0;
    this.setHostilities(s.hostilities ?? [[1, 2]]);
    for (const g of s.graphics ?? []) this.addGraphic(g.kind, g.points, g.name, g.force, g.id);
    for (const r of s.entities ?? []) {
      const e = this.createEntity({ id: r.id, typeId: r.typeId, force: r.force, x: r.x, y: r.y, heading: r.heading, name: r.name, altitude: r.altitude });
      if (r.roe) e.roe = r.roe;
    }
    for (const u of s.units ?? []) this.groupUnit(u.memberIds, u.name, u.formation, u.spacing, u.echelon, u.id);
    // Tasks and plans last, since they can reference any object.
    for (const r of s.entities ?? []) {
      if (r.plan) this.assignPlan(r.id, r.plan);
      else if (r.task) this.assignTask(r.id, r.task);
    }
    for (const u of s.units ?? []) {
      if (u.plan) this.assignPlan(u.id, u.plan);
      else if (u.task) this.assignTask(u.id, u.task);
    }
    this.initialScenario = JSON.parse(JSON.stringify(s));
    for (const fn of this.listeners.reset) fn();
    this.log('info', `scenario "${s.name}" loaded`);
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

  /** Serialize the current state (positions, tasking and graphics) as a scenario. */
  toScenario(): ScenarioFile {
    const local = [...this.entities.values()].filter((e) => !e.remote && !e.destroyed);
    return {
      format: 'werforces-scenario',
      version: 1,
      name: this.scenarioName,
      description: this.description,
      terrain: this.terrain.spec,
      startTime: Math.round(this.time * 10) / 10,
      hostilities: [...this.hostilities].map((k) => k.split('-').map(Number) as [ForceId, ForceId]),
      entities: local.map((e) => ({
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
      })),
      units: [...this.units.values()].map((u) => ({
        id: u.id,
        name: u.name,
        force: u.force,
        memberIds: u.memberList.filter((m) => !m.destroyed).map((m) => m.id),
        formation: u.formation,
        spacing: u.spacing,
        echelon: u.echelon,
        plan: u.assignedPlan,
        task: u.assignedTask,
      })).filter((u) => u.memberIds.length > 0),
      graphics: [...this.graphics.values()],
    };
  }

  // ------------------------------------------------------------ snapshots

  snapshotEntity(e: Entity): EntitySnapshot {
    const running = e.task && e.task.status === 'running';
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
    };
  }

  snapshot(): SimState {
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
      };
    });
    return {
      time: this.time,
      running: false,
      timeScale: 1,
      scenarioName: this.scenarioName,
      entities: [...this.entities.values()].map((e) => this.snapshotEntity(e)),
      units,
      graphics: [...this.graphics.values()],
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
