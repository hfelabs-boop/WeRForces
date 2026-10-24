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
  PendingOrder,
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
import { FORCE_NAMES } from '../shared/types.js';
import { CatalogIndex, DEFAULT_CATALOG, mergeCatalog } from './catalog.js';
import { type CatalogSection, validateCatalogExtension } from './catalogEdit.js';
import { applyBlast, applyDamage, type Detonation, effectivePk, resolveImpact, type Shot, updateCombat } from './combat.js';
import { Entity } from './entity.js';
import { DEFAULT_ENVIRONMENT, environmentAt, groundFactor, normalizeEnvironment, windVector } from './environment.js';
import { checkCallsForFire } from './fires.js';
import { decaySuppression, isPinned, updateMorale } from './morale.js';
import { stepMovement } from './movement.js';
import { describeStatement, PlanExecutor, planTasks, type Taskable } from './plans.js';
import { DEFAULT_MODELS, type Models } from './models.js';
import { Rng } from './rng.js';
import { SENSOR_INTERVAL, updateSensors } from './sensors.js';
import { Obstacles } from './obstacles.js';
import { Smoke } from './smoke.js';
import { ThreatMap } from './threats.js';
import { burnFuel, updateResupply } from './supply.js';
import { SpatialIndex } from './spatial.js';
import { createTask, ManualTask, MountTask, type Task, type TaskStatus } from './tasks.js';
import { DEFAULT_TERRAIN, Terrain } from './terrain.js';
import { formationOffset, perMemberTask, splitOrder, Unit } from './units.js';
import { Alerts } from './alerts.js';
import { TravelCache } from './eta.js';
import { SyncPlans } from './sync.js';
import { Life } from './life.js';
import { Ew, JAMMED_ORDER_DELAY } from './ew.js';
import { Aggregation } from './aggregate.js';
import { Navigation } from './navigation.js';
import { checkDfCallsForFire, DirectionFinding, emissions, RADIO_HEARD_FOR, updateAntiRadiation } from './emcon.js';
import { releaseDecoys } from './protection.js';

export const DEFAULT_DT = 0.1;
export const DEFAULT_RULES: Required<SimulationRules> = { suppression: true, morale: true, fuel: true, orderDelay: false };

/** Seconds for an order to reach and be acted on, by echelon (rules.orderDelay). */
const ORDER_DELAY: Record<UnitTemplate['echelon'] | 'entity', number> = { entity: 5, team: 10, flight: 10, section: 15, platoon: 30, company: 60, group: 60 };
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
  /** No "created" event (background civilians). */
  quiet?: boolean;
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
  catalog: CatalogIndex;
  /** The catalog the engine was made with (defaults plus any --catalog extension). */
  readonly baseCatalog: Catalog;
  /** Entries added or changed in the catalog editor, saved with the scenario. */
  customCatalog: Partial<Catalog> = {};
  /** Bumped when the catalog changes, so clients fetch it again. */
  catalogVersion = 0;
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
  readonly threats = new ThreatMap(this);
  readonly graphics = new Map<string, Graphic>();
  readonly listeners: EngineListeners = { event: [], fire: [], detonation: [], removed: [], reset: [], step: [] };
  /** Things the operator should look at (idle, broken, out of fuel...). Read-only toward the simulation. */
  readonly alerts: Alerts = new Alerts(this);
  private readonly travel = new TravelCache(this);
  /** Global plans: a synchronization matrix per force. */
  readonly sync = new SyncPlans(this);
  /** Pattern of life: civilian traffic and pedestrians. */
  readonly life = new Life(this);
  /** Electronic warfare: who is jammed. */
  readonly ew = new Ew(this);
  /** Navigation of GNSS navigators under jamming and spoofing. */
  readonly nav = new Navigation(this);
  /** Direction finding: enemy emitters each force has located. */
  readonly df = new DirectionFinding(this);
  /** Hit/kill, ballistic and radar models in use (see models.ts). */
  models: Models = { ...DEFAULT_MODELS };
  /** Aggregate-level units: units simulated as one object, and the policy for splitting them up. */
  readonly aggregates = new Aggregation(this);

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
  /** Orders on their way down the chain of command (rules.orderDelay). */
  pendingOrders: PendingOrder[] = [];
  /** Time of day and weather at the scenario's start (time 0). */
  environment: Required<Environment> = { ...DEFAULT_ENVIRONMENT };
  /** The environment now (clock and light), updated once a simulated second. */
  env: EnvironmentState = environmentAt(DEFAULT_ENVIRONMENT, 0, 0);
  /** Loads imported terrain datasets by name (set by the server from its terrains folder). */
  terrainLoader?: (name: string) => TerrainData;

  constructor(opts: { catalog?: Catalog; terrain?: Terrain; seed?: number; terrainLoader?: (name: string) => TerrainData } = {}) {
    this.terrainLoader = opts.terrainLoader;
    this.baseCatalog = opts.catalog ?? DEFAULT_CATALOG;
    this.catalog = new CatalogIndex(this.baseCatalog);
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
    return this.findEntity(id)?.name ?? this.units.get(id)?.name ?? this.graphics.get(id)?.name ?? id;
  }

  /** An entity, including a member hidden inside an aggregated unit. */
  findEntity(id: string): Entity | undefined {
    return this.entities.get(id) ?? this.aggregates.member(id);
  }

  /** Take an entity out of the entity-level simulation (its unit is being aggregated). It keeps its state. */
  detachEntity(e: Entity): void {
    this.setEntityTask(e, null);
    e.plan = null;
    e.steer = null;
    e.halted = false;
    e.pinned = false;
    e.engagingId = undefined;
    e.attackTargetId = undefined;
    e.contacts.clear();
    e.speed = 0;
    this.entities.delete(e.id);
    this.sensorDue.delete(e.id);
    for (const other of this.entities.values()) other.contacts.delete(e.id);
    this.spatial.invalidate();
    for (const fn of this.listeners.removed) fn(e);
  }

  /** Put an entity taken out by detachEntity back; `k` staggers its sensor scans. */
  attachEntity(e: Entity, k: number): void {
    this.entities.set(e.id, e);
    this.sensorDue.set(e.id, this.time + ((k * 0.37) % 1));
    this.spatial.invalidate();
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
    e.apsLeft = type.aps?.charges ?? 0;
    e.decoysLeft = type.decoys?.salvos ?? 0;
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
    if (!opts.quiet) this.log('created', `${name} created`, id);
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
    // A headquarters keeps close together; the template's spacing is for its subordinate units.
    const spacing = tpl.subunits?.length ? Math.min(tpl.spacing, 80) : tpl.spacing;
    // Place the leader at the point and followers at their formation slots.
    for (let k = 0; k < tpl.members.length; k++) {
      const off = k === 0 ? { x: 0, y: 0 } : rotateSlot(tpl.formation, k, spacing, heading);
      const slot = { x: clampTo(x + off.x, this.terrain.spec.size), y: clampTo(y + off.y, this.terrain.spec.size) };
      const domain = this.catalog.type(tpl.members[k]).domain;
      // Followers whose slot is unusable (e.g. in a lake) are placed at the nearest valid spot.
      const p = k === 0 ? slot : (this.findValidPosition(slot, domain) ?? this.findValidPosition({ x, y }, domain) ?? slot);
      members.push(this.createEntity({ typeId: tpl.members[k], force, x: p.x, y: p.y, heading }));
    }
    const unit = this.groupUnit(members.map((m) => m.id), name ?? tpl.name, tpl.formation, spacing, tpl.echelon);
    members.forEach((m, i) => (m.name = `${unit.name} ${i === 0 ? 'Lead' : i + 1}`));
    if (tpl.subunits?.length) {
      // The members are the HQ, set back behind the subordinate units' formation.
      const back = rotateOffset({ x: 0, y: -tpl.spacing * 0.6 }, heading);
      for (const m of members) {
        const p = this.findValidPosition({ x: clampTo(m.x + back.x, this.terrain.spec.size), y: clampTo(m.y + back.y, this.terrain.spec.size) }, m.domain);
        if (p) {
          m.x = p.x;
          m.y = p.y;
        }
      }
      for (const m of members) m.name = `${unit.name} HQ${members.length > 1 ? ` ${members.indexOf(m) + 1}` : ''}`;
      tpl.subunits.forEach((sid, k) => {
        const off = rotateSlot(tpl.formation, k, tpl.spacing, heading);
        const echelon = this.catalog.templates.get(sid)!.echelon;
        const nth = `${k + 1}${k === 0 ? 'st' : k === 1 ? 'nd' : k === 2 ? 'rd' : 'th'}`;
        // Named after the company, so two companies' platoons are told apart.
        const sub = this.createUnitFromTemplate(sid, force, clampTo(x + off.x, this.terrain.spec.size), clampTo(y + off.y, this.terrain.spec.size), heading, `${unit.name} ${nth} ${echelon[0].toUpperCase()}${echelon.slice(1)}`);
        sub.parentId = unit.id;
      });
    }
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
    if (unit.memberList.length === 0) this.dropUnit(unit.id);
    else if (unit.leader === e) unit.update(this);
  }

  /** Remove a unit; its subordinates become independent. */
  private dropUnit(id: string): void {
    this.units.delete(id);
    for (const u of this.units.values()) if (u.parentId === id) u.parentId = undefined;
    this.pendingOrders = this.pendingOrders.filter((o) => o.targetId !== id);
  }

  /** Subordinate units of a unit. */
  subordinatesOf(unit: Unit): Unit[] {
    const out: Unit[] = [];
    for (const u of this.units.values()) if (u.parentId === unit.id) out.push(u);
    return out;
  }

  /** Put a unit under a superior unit of the same force (null: independent). */
  setSuperior(unitId: string, superiorId: string | null): void {
    const u = this.units.get(unitId);
    if (!u) throw new Error(`unknown unit ${unitId}`);
    if (superiorId === null) {
      u.parentId = undefined;
      return;
    }
    const sup = this.units.get(superiorId);
    if (!sup) throw new Error(`unknown unit ${superiorId}`);
    if (sup.force !== u.force) throw new Error('a superior must be of the same force');
    for (let p: Unit | undefined = sup; p; p = p.parentId ? this.units.get(p.parentId) : undefined) {
      if (p === u) throw new Error(`${sup.name} is under ${u.name} already`);
    }
    u.parentId = sup.id;
    this.log('info', `${u.name} placed under ${sup.name}`, u.id, sup.id);
  }

  // ------------------------------------------------------------ orders

  /**
   * Give an entity or unit an order, as a player or API client does. With rules.orderDelay
   * on it arrives after a delay that depends on the echelon; orders to a unit with
   * subordinates pass on down the chain, each level adding its own delay.
   */
  issueOrder(targetId: string, order: { task?: TaskSpec; plan?: Plan }): number {
    const t = this.resolveTarget(targetId);
    if (order.task) this.validateTask(order.task);
    if (order.plan) for (const t of planTasks(order.plan.statements)) this.validateTask(t);
    // A new order replaces one still on its way.
    this.pendingOrders = this.pendingOrders.filter((o) => o.targetId !== targetId);
    const base = this.rules.orderDelay ? ORDER_DELAY[t instanceof Unit ? t.echelon : 'entity'] : 0;
    // A jammed radio: the order gets through late (by relay or runner).
    const lead = t instanceof Unit ? t.leader : t;
    const jam = lead && this.ew.radioJammed(lead) ? JAMMED_ORDER_DELAY : 0;
    if (base <= 0 && !jam) {
      if (order.plan) this.assignPlan(targetId, order.plan);
      else if (order.task) this.assignTask(targetId, order.task);
      // Acknowledging it goes out on the radio (direction finders hear it).
      if (lead && !lead.remote) lead.lastTransmitAt = this.time;
      return 0;
    }
    const delay = (base > 0 ? Math.round(base * (0.8 + 0.4 * this.rng.next())) : 0) + jam;
    this.pendingOrders.push({ targetId, task: order.task, plan: order.plan, due: Math.round((this.time + delay) * 10) / 10 });
    this.log('task', `Order to ${t.name}: ${this.describeOrder(order)} (arrives in ${delay} s${jam ? (this.ew.radioSilent(lead!) ? ', radio silence' : ', radio jammed') : ''})`, t.id);
    return delay;
  }

  /** A radio message from an entity (DIS gateways send it as a Signal PDU). */
  /** Codewords a force has received: "force|WORD" -> time. */
  readonly codewords = new Map<string, number>();

  /** Send a codeword to a force: plans waiting for it go on. `from` names the sender in the log. */
  sendCodeword(force: ForceId, codeword: string, from?: string): void {
    const word = codeword.trim().toUpperCase();
    const key = `${force}|${word}`;
    if (!this.codewords.has(key)) this.codewords.set(key, this.time);
    const sender = from ? this.entities.get(from) ?? this.units.get(from)?.leader : undefined;
    const speaker = sender && !sender.remote && sender.alive ? sender : undefined;
    const text = `${from ? `${this.nameOf(from)}: ` : ''}codeword ${word}`;
    if (speaker) this.radio(speaker, text);
    else this.log('info', `${FORCE_NAMES[force]} ${text}`, undefined);
  }

  hasCodeword(force: ForceId, codeword: string): boolean {
    return this.codewords.has(`${force}|${codeword.trim().toUpperCase()}`);
  }

  radio(from: Entity, text: string, aboutId?: string): void {
    if (from.remote || !from.alive) return;
    // A jammed radio gets nothing out.
    if (this.ew.radioJammed(from)) return;
    from.lastTransmitAt = this.time;
    this.log('radio', text, from.id, aboutId);
  }

  /**
   * Emission control for an entity, or a unit with its members and subordinate units:
   * radio silence, radars off, jammers on or off. Settings left out stay as they are.
   */
  setEmcon(targetId: string, emcon: { radioSilence?: boolean; radarOff?: boolean; jamming?: boolean }): void {
    const t = this.resolveTarget(targetId);
    const members: Entity[] = [];
    const add = (u: Unit) => {
      members.push(...u.memberList);
      for (const sub of this.subordinatesOf(u)) add(sub);
    };
    if (t instanceof Unit) add(t);
    else members.push(t);
    for (const m of members) {
      if (emcon.radioSilence !== undefined) m.radioSilent = emcon.radioSilence;
      if (emcon.radarOff !== undefined) m.radarOff = emcon.radarOff;
      if (emcon.jamming !== undefined && m.type.jammer) m.jamming = emcon.jamming;
    }
    const said = [
      emcon.radioSilence === undefined ? '' : emcon.radioSilence ? 'radio silence' : 'radio free',
      emcon.radarOff === undefined ? '' : emcon.radarOff ? 'radars off' : 'radars on',
      emcon.jamming === undefined || !members.some((m) => m.type.jammer) ? '' : emcon.jamming ? 'jamming on' : 'jamming off',
    ].filter(Boolean);
    if (said.length) this.log('info', `${t.name}: ${said.join(', ')}`, t.id);
    if (emcon.jamming !== undefined) this.ew.update();
  }

  private describeOrder(o: { task?: TaskSpec; plan?: Plan }): string {
    return o.plan ? `plan ${o.plan.name ?? ''}`.trim() : describeStatement({ kind: 'task', task: o.task! }, this);
  }

  private deliverOrders(): void {
    if (!this.pendingOrders.length) return;
    const due = this.pendingOrders.filter((o) => o.due <= this.time + 1e-9);
    if (!due.length) return;
    this.pendingOrders = this.pendingOrders.filter((o) => o.due > this.time + 1e-9);
    for (const o of due) {
      if (!this.entities.has(o.targetId) && !this.units.has(o.targetId)) continue;
      try {
        if (o.plan) this.assignPlan(o.targetId, o.plan);
        else if (o.task) this.assignTask(o.targetId, o.task);
        const t = this.resolveTarget(o.targetId);
        const speaker = t instanceof Unit ? t.leader : t;
        if (speaker) this.radio(speaker, `${t.name}: wilco, ${this.describeOrder(o)}`);
      } catch (err) {
        this.log('task', `Order to ${this.nameOf(o.targetId)} could not be carried out: ${(err as Error).message}`, o.targetId);
      }
    }
  }

  /** Start a task on an entity or unit; a unit with subordinates passes its part of it on. */
  startOrder(owner: Taskable, spec: TaskSpec, cascade = true): void {
    const unit = this.units.get(owner.id);
    const subs = unit && cascade ? this.subordinatesOf(unit) : [];
    if (!unit || subs.length === 0) {
      if (unit && cascade) unit.orderedSubs = [];
      owner.startTask(this, spec);
      return;
    }
    const { own, children } = splitOrder(this, unit, subs, spec);
    unit.startTask(this, own);
    unit.orderedSubs = children.map((c) => c.unit.id);
    for (const c of children) this.issueOrder(c.unit.id, { task: c.spec });
  }

  /** Task status of an entity or unit, counting subordinates still carrying out its order. */
  orderStatus(owner: Taskable): TaskStatus | 'none' {
    const own = owner.taskStatus();
    if (own === 'running') return own;
    const unit = this.units.get(owner.id);
    for (const id of unit?.orderedSubs ?? []) {
      if (this.pendingOrders.some((o) => o.targetId === id)) return 'running';
      const sub = this.units.get(id);
      if (sub && this.orderStatus(sub) === 'running') return 'running';
    }
    return own;
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

  /**
   * Replace the custom catalog (editor entries): checked as a whole, and refused if it
   * would leave live entities without their weapons or sensors. Entities already on the
   * map keep the definition they were made with; new ones get the new one.
   */
  setCustomCatalog(ext: Partial<Catalog>): void {
    const index = new CatalogIndex(mergeCatalog(this.baseCatalog, ext));
    for (const e of this.entities.values()) {
      if (e.remote) continue;
      for (const w of e.type.weapons) if (!index.weapons.has(w)) throw new Error(`${e.name} still uses weapon ${w}`);
      for (const s of e.type.sensors) if (!index.sensors.has(s)) throw new Error(`${e.name} still uses sensor ${s}`);
      if (!index.types.has(e.type.id)) throw new Error(`${e.name} is a ${e.type.id}: delete it first`);
    }
    this.catalog = index;
    this.customCatalog = ext;
    this.catalogVersion++;
  }

  /** Add or change one catalog entry (it goes into the custom catalog). */
  setCatalogEntry(section: CatalogSection, entry: { id: string }): void {
    const before = (this.customCatalog[section] ?? []) as { id: string }[];
    const known = before.some((x) => x.id === entry.id) || this.catalog.catalog[section].some((x) => x.id === entry.id);
    this.setCustomCatalog({ ...this.customCatalog, [section]: [...before.filter((x) => x.id !== entry.id), entry] });
    this.log('info', `catalog: ${entry.id} ${known ? 'changed' : 'added'}`, undefined);
  }

  /** Remove a custom entry (a built-in one it replaced comes back). */
  removeCatalogEntry(section: CatalogSection, id: string): void {
    const list = (this.customCatalog[section] ?? []) as { id: string }[];
    if (!list.some((x) => x.id === id)) throw new Error(`${id} is not a custom ${section} entry`);
    const next = { ...this.customCatalog, [section]: list.filter((x) => x.id !== id) };
    if (!next[section]!.length) delete next[section];
    this.setCustomCatalog(next);
    this.log('info', `catalog: ${id} removed`, undefined);
  }

  /** Direct control: start it (logged once) or update the throttle, turn and target. */
  drive(e: Entity, input: { throttle?: number; turn?: number; targetId?: string | null }): void {
    if (!(e.task instanceof ManualTask) || e.task.status !== 'running') {
      // Driving a unit's leader drives the unit: its own orders stop.
      const u = e.unit;
      if (u && u.leader === e) {
        u.plan = null;
        u.assignedPlan = undefined;
        u.assignedTask = undefined;
        u.taskSpec = null;
        u.leaderTask = null;
        this.pendingOrders = this.pendingOrders.filter((o) => o.targetId !== u.id);
      }
      this.pendingOrders = this.pendingOrders.filter((o) => o.targetId !== e.id);
      e.plan = null;
      e.assignedPlan = undefined;
      e.assignedTask = { type: 'manual' };
      this.setEntityTask(e, new ManualTask({ type: 'manual' }));
      // Members holding their own tasks (defend, overwatch...) drop them and follow in formation.
      if (u && u.leader === e) u.formUp(this);
      this.log('task', `${e.name}: under direct control`, e.id);
    }
    (e.task as ManualTask).input(this, input);
  }

  /** Remove an entity without a "deleted" event (background civilians). */
  removeEntity(id: string): void {
    this.deleteObject(id, true);
  }

  deleteObject(id: string, quiet = false): void {
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
      if (!quiet) this.log('deleted', `${e.name} deleted`, id);
      return;
    }
    const u = this.units.get(id);
    if (u) {
      this.aggregates.release(u);
      for (const m of [...u.memberList]) this.deleteObject(m.id);
      this.dropUnit(id);
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
    if (task && e.alive && !e.remote) task.begin(this, e);
  }

  private resolveTarget(id: string): Entity | Unit {
    const target = this.entities.get(id) ?? this.units.get(id);
    if (!target) throw new Error(`unknown entity or unit ${id}`);
    if (target instanceof Entity && target.remote) throw new Error('remote entities cannot be tasked');
    if (target instanceof Entity && target.destroyed) throw new Error(`${target.name} is destroyed`);
    return target;
  }

  /** Assign a task directly; replaces any running plan on the target. */
  /** Start a task now (no order delay). `cascade`: pass it on to subordinate units. */
  assignTask(targetId: string, spec: TaskSpec, cascade = true): void {
    const t = this.resolveTarget(targetId);
    this.validateTask(spec);
    t.plan = null;
    t.assignedPlan = undefined;
    t.assignedTask = spec;
    if (t instanceof Unit) this.startOrder(t, spec, cascade);
    else this.setEntityTask(t, createTask(spec));
    this.log('task', `${t.name}: ${createTask(spec).describe(this)}`, t.id);
  }

  assignPlan(targetId: string, plan: Plan): void {
    const t = this.resolveTarget(targetId);
    for (const task of planTasks(plan.statements)) this.validateTask(task);
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
    this.pendingOrders = this.pendingOrders.filter((o) => o.targetId !== targetId);
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
      u.startTask(this, { type: 'moveTo', target: r.withdrawTo, covered: true });
      this.log('task', `${u.name}: strength ${alive}/${u.memberList.length}, withdrawing`, u.id);
    }
    for (const e of this.entities.values()) {
      const r = e.reactions;
      if (e.unit || e.withdrawn || e.remote || !e.alive || !r.withdrawBelow || !r.withdrawTo || !e.firepowerKill || e.mobilityKill) continue;
      e.withdrawn = true;
      e.plan = null;
      e.roe = 'returnFire';
      this.setEntityTask(e, createTask({ type: 'moveTo', target: r.withdrawTo, covered: true }));
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
        if (!this.entities.has(spec.targetId)) throw new Error(`unknown entity ${spec.targetId}`);
        break;
      case 'attack':
        // The target may be inside an aggregated unit: attacking it attacks the aggregate.
        if (!this.findEntity(spec.targetId)) throw new Error(`unknown entity ${spec.targetId}`);
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
      case 'overwatch':
      case 'defend':
      case 'ambush':
      case 'screen':
        if (!this.terrain.inBounds(spec.position.x, spec.position.y)) throw new Error('position is outside the terrain');
        if (spec.type === 'ambush') {
          const g = this.graphics.get(spec.killZoneId);
          if (!g || g.kind !== 'area') throw new Error(`unknown area ${spec.killZoneId}`);
        }
        break;
      case 'search': {
        const g = this.graphics.get(spec.areaId);
        if (!g || g.kind !== 'area') throw new Error(`unknown area ${spec.areaId}`);
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
    // An aircraft warned of a missile releases flares and chaff.
    releaseDecoys(this, shot);
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
  /**
   * Plan a route for a force: round obstacles and known minefields, and with `avoidThreats`
   * away from ground known enemies can see and cover with direct fire.
   */
  planRoute(from: Vec2, to: Vec2, domain: Domain, offroadFactor: number, force?: ForceId, avoidThreats = false): Vec2[] | null {
    let overlay = this.obstacles.overlay(force, domain);
    const threat = avoidThreats && force !== undefined ? this.threats.overlay(force, domain) : null;
    if (threat) overlay = overlay ? overlay.map((v, i) => v * threat[i]) : threat;
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
      this.log('detonation', `${shot.weapon.name.replace(/\s*\([^)]*\)$/, '')} smoke round at (${Math.round(det.location.x)}, ${Math.round(det.location.y)})`, shot.shooterId, undefined, { to: det.location, hit: false, weaponId: shot.weapon.id });
      for (const fn of this.listeners.detonation) fn(det);
      return;
    }
    if (det.effects) {
      const names = det.effects.map((f) => `${this.nameOf(f.entityId)}${f.outcome === 'kill' ? ' destroyed' : ` ${f.outcome} kill`}`);
      const at = `(${Math.round(det.location.x)}, ${Math.round(det.location.y)})`;
      const lead = det.emitterLost ? `${shot.weapon.name} lost its emitter and burst at ${at}` : `${shot.weapon.name} impact at ${at}`;
      this.log('detonation', `${lead}: ${names.length ? names.join(', ') : 'no effect'}`, shot.shooterId, det.effects[0]?.entityId ?? (det.emitterLost ? shot.targetId : undefined), {
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
      : det.intercepted
        ? `${shot.weapon.name} intercepted short of ${tname}`
        : det.outcome === 'kill'
        ? `${shot.weapon.name} destroyed ${tname}`
        : det.outcome === 'mobility'
          ? `${shot.weapon.name} hit ${tname}: mobility kill`
          : det.outcome === 'firepower'
            ? `${shot.weapon.name} hit ${tname}: firepower kill`
            : det.hit
              ? `${shot.weapon.name} hit ${tname}${det.armourHeld ? `: ${det.aspect} armour held` : ''}`
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
    this.deliverOrders();
    decaySuppression(this, dt);
    for (const u of this.units.values()) u.update(this);
    for (const u of this.units.values()) u.plan?.update(this, u);

    this.checkWithdrawals();
    this.aggregates.update(dt);

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
        // Without satellites, it steers by where it thinks it is.
        const off = e.nav ? this.nav.taskOffset(e, task) : undefined;
        const tx = e.x;
        const ty = e.y;
        if (off) {
          e.x += off.x;
          e.y += off.y;
        }
        const status = task.update({ engine: this, entity: e, dt });
        if (off) {
          e.x = tx;
          e.y = ty;
          if (e.steer) e.steer = { ...e.steer, x: e.steer.x - off.x, y: e.steer.y - off.y };
        }
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
    for (const e of this.entities.values()) {
      if (this.rules.fuel && e.type.endurance) burnFuel(this, e, dt);
      // Moving out of a prepared position gives it up.
      if (e.prepared && e.speed > 0.5) e.prepared = undefined;
    }

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
      this.ew.update();
      this.nav.update();
      this.df.update();
      checkDfCallsForFire(this);
      updateAntiRadiation(this);
      this.life.update();
      this.alerts.update();
      this.sync.update();
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
    this.pendingOrders = [];
    this.codewords.clear();
    this.sync.clear();
    this.life.clear();
    this.ew.clear();
    this.df.clear();
    this.aggregates.clear();
    this.sensorDue.clear();
    this.losMemo.clear();
    this.smoke.clear();
    this.threats.clear();
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
    // The scenario's own catalog entries (none: the plain catalog), before anything uses them.
    if (s.catalog || Object.keys(this.customCatalog).length) this.setCustomCatalog(s.catalog ? validateCatalogExtension(s.catalog) : {});
    this.setRules(s.rules ?? {});
    this.environment = normalizeEnvironment(s.environment);
    this.events = [];
    this.scenarioName = s.name;
    this.description = s.description ?? '';
    this.time = s.startTime ?? 0;
    this.updateEnvironment();
    this.setHostilities(s.hostilities ?? [[1, 2]]);
    for (const g of s.graphics ?? []) {
      const added = this.addGraphic(g.kind, g.points, g.name, g.force, g.id);
      // Minefields and obstacles keep their density, breached lanes and who knows about them.
      const pt = (p: unknown) => !!p && Number.isFinite((p as Vec2).x) && Number.isFinite((p as Vec2).y);
      if (typeof g.density === 'number' && g.density > 0) added.density = Math.min(3, g.density);
      const lanes = Array.isArray(g.lanes) ? g.lanes.filter((l) => pt(l?.from) && pt(l?.to)) : [];
      if (lanes.length) added.lanes = lanes.map((l) => ({ from: { x: l.from.x, y: l.from.y }, to: { x: l.to.x, y: l.to.y } }));
      const known = Array.isArray(g.knownBy) ? g.knownBy.filter((f) => [0, 1, 2, 3].includes(f)) : [];
      if (known.length) added.knownBy = known;
      if (added.density !== undefined || added.lanes || added.knownBy) this.obstacles.changed();
    }
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
    for (const u of s.units ?? []) if (u.parentId && this.units.has(u.parentId) && this.units.has(u.id)) this.units.get(u.id)!.parentId = u.parentId;
    // Aggregated units take their members out of the entity-level simulation before any orders are given.
    if (s.aggregation) this.aggregates.setPolicy(s.aggregation);
    for (const u of s.units ?? []) {
      const unit = this.units.get(u.id)!;
      if (u.aggregate) this.aggregates.restore(unit, u.aggregate);
      if (u.state?.reaggregate && !unit.aggregate) unit.reaggregate = { quietSince: u.state.reaggregate.quietSince };
    }
    this.pendingOrders = (s.orders ?? []).filter((o) => this.entities.has(o.targetId) || this.units.has(o.targetId)).map((o) => ({ ...o }));
    for (const c of s.codewords ?? []) this.codewords.set(`${c.force}|${c.codeword.toUpperCase()}`, c.time);
    for (const m of s.syncMatrices ?? []) this.sync.set({ force: m.force, phases: m.phases }, m.started);
    this.life.set(s.patternOfLife ?? {});
    // Tasks and plans last, since they can reference any object. Checkpoints resume them part-way.
    for (const r of s.entities ?? []) {
      const e = this.entities.get(r.id);
      // Members of aggregated units are not in the entity-level simulation.
      if (!e || e.destroyed || e.embarkedIn) continue;
      if (r.plan) {
        this.assignPlan(r.id, r.plan);
        if (r.state?.planIndex !== undefined) e.plan!.resume(r.state.planIndex, r.state.taskState);
      } else if (r.task && !r.state?.taskDone) {
        this.assignTask(r.id, r.state?.taskState ?? r.task, false);
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
        this.assignTask(u.id, u.state?.taskState ?? u.task, false);
        unit.assignedTask = u.task;
        if (u.state && perMemberTask(u.task) && !unit.aggregate) {
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
    if (s.df) this.df.restore(s.df);
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
    if (st.prepared) e.prepared = st.prepared;
    if (st.supplies !== undefined) e.supplies = st.supplies;
    if (st.ambient) this.life.adopt(e);
    if (st.jamming === false) e.jamming = false;
    if (st.radioSilence) e.radioSilent = true;
    if (st.radarOff) e.radarOff = true;
    if (st.lastTransmitAt !== undefined) e.lastTransmitAt = st.lastTransmitAt;
    if (st.apsLeft !== undefined) e.apsLeft = st.apsLeft;
    if (st.decoysLeft !== undefined) e.decoysLeft = st.decoysLeft;
    if (st.nav) e.nav = { since: st.nav.since, dir: st.nav.dir, spoofedBy: st.nav.spoofedBy };
  }

  private authoredState(e: Entity): EntityRecord['state'] {
    const st = {
      destroyed: e.destroyed || undefined,
      mobilityKill: e.mobilityKill || undefined,
      firepowerKill: e.firepowerKill || undefined,
      embarkedIn: e.embarkedIn,
      // Emission control set when authoring the scenario.
      radioSilence: e.radioSilent || undefined,
      radarOff: e.radarOff || undefined,
      jamming: e.type.jammer && !e.jamming ? (false as const) : undefined,
    };
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
        prepared: e.prepared,
        ambient: e.ambient || undefined,
        jamming: e.type.jammer && !e.jamming ? false : undefined,
        radioSilence: e.radioSilent || undefined,
        radarOff: e.radarOff || undefined,
        lastTransmitAt: this.time - e.lastTransmitAt < RADIO_HEARD_FOR ? e.lastTransmitAt : undefined,
        apsLeft: e.type.aps && e.apsLeft !== e.type.aps.charges ? e.apsLeft : undefined,
        decoysLeft: e.type.decoys && e.decoysLeft !== e.type.decoys.salvos ? e.decoysLeft : undefined,
        nav: e.nav ? { ...e.nav } : undefined,
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

  /**
   * Go back to a checkpoint taken earlier in this session (undo/redo): unlike loading a
   * scenario, the event log and the rewind point are kept.
   */
  restoreCheckpoint(s: ScenarioFile, note: string): void {
    const rewindPoint = this.initialScenario;
    const events = this.events;
    this.loadScenario(s);
    this.initialScenario = rewindPoint;
    this.events = events;
    this.log('info', note);
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
    // Background civilians are made afresh from the settings, except in checkpoints.
    const local = [...this.entities.values(), ...this.aggregates.hiddenMembers()].filter((e) => !e.remote && !(e.ambient && this.time === 0));
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
        parentId: u.parentId,
        plan: u.assignedPlan,
        task: u.assignedTask,
        reactions: Object.keys(u.reactions).length ? u.reactions : undefined,
        aggregate: this.aggregates.record(u, this.time !== 0),
        state: this.time === 0 ? undefined : {
          planIndex: u.plan ? u.plan.index : undefined,
          taskState: u.aggregate ? this.aggregates.resumeSpec(u) : u.taskSpec && u.leaderTask?.status === 'running' ? u.leaderTask.resumeSpec() : undefined,
          leaderId: u.leader?.id,
          withdrawn: u.withdrawn || undefined,
          taskDone: (!!u.assignedTask && u.taskStatus() !== 'running') || undefined,
          morale: u.morale < 1 ? u.morale : undefined,
          moraleState: u.moraleState !== 'steady' ? u.moraleState : undefined,
          lossesSeen: u.lossesSeen || undefined,
          reaggregate: u.reaggregate ? { ...u.reaggregate } : undefined,
        },
      })),
      graphics: [...this.graphics.values()].map((g) => JSON.parse(JSON.stringify(g)) as Graphic),
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
        decoyed: sh.decoyed,
      })),
      rngState: this.time === 0 ? undefined : this.rng.state,
      rules: JSON.stringify(this.rules) === JSON.stringify(DEFAULT_RULES) ? undefined : { ...this.rules },
      catalog: Object.keys(this.customCatalog).length ? JSON.parse(JSON.stringify(this.customCatalog)) : undefined,
      patternOfLife: this.life.settings.vehicles || this.life.settings.pedestrians ? { ...this.life.settings } : undefined,
      orders: this.pendingOrders.length ? this.pendingOrders.map((o) => ({ ...o })) : undefined,
      syncMatrices: this.sync.all().length ? this.sync.states().map((m) => ({ force: m.force, phases: m.phases, ...(this.time > 0 && Object.keys(m.started).length ? { started: m.started } : {}) })) : undefined,
      codewords: this.codewords.size ? [...this.codewords].map(([k, time]) => ({ force: Number(k.split('|')[0]) as ForceId, codeword: k.slice(k.indexOf('|') + 1), time })) : undefined,
      environment: JSON.stringify(this.environment) === JSON.stringify(DEFAULT_ENVIRONMENT) ? undefined : { ...this.environment },
      smoke: this.smoke.clouds.length ? this.smoke.clouds.map((c) => ({ ...c })) : undefined,
      aggregation: this.aggregates.policyRecord(),
      df: this.time === 0 ? undefined : this.df.record(),
    };
  }

  // ------------------------------------------------------------ snapshots

  snapshotEntity(e: Entity, passengers?: Map<string, string[]>): EntitySnapshot {
    const running = e.task && e.task.status === 'running';
    const riders = (e.type.capacity ?? 0) > 0 ? (passengers ? passengers.get(e.id) : this.passengersOf(e.id).map((p) => p.id)) : undefined;
    const radiates = emissions(this, e);
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
      prepared: e.prepared,
      travel: !e.unit || e.unit.leader === e ? this.travel.get(e) : undefined,
      ambient: e.ambient || undefined,
      jamming: e.type.jammer ? e.jamming : undefined,
      jammed: this.ew.status(e),
      emcon: e.radioSilent || e.radarOff ? { radioSilence: e.radioSilent || undefined, radarOff: e.radarOff || undefined } : undefined,
      emitting: radiates.length ? radiates : undefined,
      aps: e.type.aps ? { left: e.apsLeft, charges: e.type.aps.charges } : undefined,
      decoys: e.type.decoys ? { left: e.decoysLeft, salvos: e.type.decoys.salvos } : undefined,
      gnss: e.nav ? (e.nav.spoofedBy ? 'spoofed' : 'denied') : undefined,
      navError: e.nav ? Math.round(this.nav.errorSize(e)) : undefined,
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
    const children = new Map<string, string[]>();
    for (const u of this.units.values()) {
      if (!u.parentId) continue;
      const list = children.get(u.parentId);
      if (list) list.push(u.id);
      else children.set(u.parentId, [u.id]);
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
        parentId: u.parentId,
        childIds: children.get(u.id),
        leaderId: u.leader?.id,
        memberIds: u.memberList.map((m) => m.id),
        x: c.x,
        y: c.y,
        task: u.aggregate ? this.aggregates.describeTask(u) : u.taskSpec && leaderTask && leaderTask.status === 'running' ? leaderTask.describe(this) : undefined,
        plan: u.plan?.describe(this),
        reactions: Object.keys(u.reactions).length ? u.reactions : undefined,
        withdrawn: u.withdrawn || undefined,
        morale: this.rules.morale ? Math.round(u.morale * 100) / 100 : undefined,
        moraleState: this.rules.morale ? u.moraleState : undefined,
        travel: u.aggregate ? this.aggregates.travel(u) : u.leader ? this.travel.get(u.leader) : undefined,
        aggregate: u.aggregate ? this.aggregates.snapshot(u) : undefined,
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
      orders: this.pendingOrders.length
        ? this.pendingOrders.map((o) => ({ targetId: o.targetId, text: this.describeOrder(o), due: o.due }))
        : undefined,
      schedule: this.schedule(),
      alerts: this.alerts.open().slice(0, 50),
      sync: this.sync.all().length ? this.sync.states() : undefined,
      dfContacts: (dc => (dc.length ? dc : undefined))(this.df.contacts()),
      catalogVersion: this.catalogVersion,
    };
  }

  /** Plan steps that wait for a simulation time still to come, with what follows them. */
  private schedule(): SimState['schedule'] {
    const out: NonNullable<SimState['schedule']> = [];
    const owners: (Unit | Entity)[] = [...this.units.values(), ...[...this.entities.values()].filter((e) => !e.unit)];
    for (const o of owners) {
      const p = o.plan;
      if (!p || p.finished) continue;
      for (let i = p.index; i < p.ops.length; i++) {
        const op = p.ops[i];
        const st = op.op === 'do' ? op.st : undefined;
        if (!st || st.kind !== 'waitUntil' || st.condition.type !== 'simTime' || st.condition.time <= this.time) continue;
        const next = p.statementAt(i + 1);
        out.push({ targetId: o.id, time: st.condition.time, text: `${this.nameOf(o.id)}: ${next ? describeStatement(next, this) : 'plan continues'}` });
      }
    }
    out.sort((a, b) => a.time - b.time);
    return out.length ? out.slice(0, 200) : undefined;
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
