// Aggregate-level units (multi-resolution simulation). An aggregated unit is simulated as
// one object: its members leave the entity-level simulation, and the unit moves at the
// speed of its slowest member type, sees with its best sensor and fights other aggregates
// with Lanchester square-law attrition. Near enemy entities it splits back into its
// members, in formation, each with its own damage, ammunition and fuel; once the enemy is
// far away it can join up again.

import { bearing, dist2d, normalizeAngle, rotateOffset } from '../shared/math.js';
import type {
  AggregatePosture,
  AggregateRecord,
  AggregateSnapshot,
  AggregationPolicy,
  ArmorClass,
  Domain,
  EntityTypeDef,
  ForceId,
  TaskSpec,
  Travel,
  Vec2,
  WeaponDef,
} from '../shared/types.js';
import type { Engine } from './engine.js';
import type { Entity } from './entity.js';
import { groundFactor, sensorRange } from './environment.js';
import { burnFuel } from './supply.js';
import { createTask } from './tasks.js';
import { formationOffset, type Unit } from './units.js';

export const DEFAULT_AGGREGATION: Required<AggregationPolicy> = {
  autoDisaggregate: true,
  disaggregateRange: 3000,
  autoReaggregate: true,
  reaggregateRange: 5000,
  reaggregateDelay: 120,
};

/** Share of the time a shooter in an aggregate has a target acquired and laid on. */
export const FIRE_EFFICIENCY = 0.2;
/** Accuracy of fire on the move. */
export const MOVING_FIRE = 0.5;
/** How exposed a target is, by its aggregate's posture. Dug in: see DUG_IN. */
export const EXPOSURE: Record<Exclude<AggregatePosture, 'dugIn'>, number> = { moving: 1, halted: 0.9, defending: 0.75 };
/** Exposure once dug in: infantry dug in, vehicles hull-down (as at entity level). */
export const DUG_IN = { lifeform: 0.4, vehicle: 0.6 };
/** Seconds holding a defended position before it counts as prepared (infantry / vehicles). */
const PREPARE_TIME = { lifeform: 90, vehicle: 30 };
/** Contacts not seen again for this long are dropped. */
const CONTACT_TIMEOUT = 15;
/** Return fire: an aggregate that fired on it within this many seconds. */
const RETURN_FIRE_WINDOW = 60;
/** Entities further away than this are not checked as observers of an aggregate. */
const OBSERVER_REACH = 15000;

/** Tasks an aggregate carries out itself; any other order splits it into entities first. */
const AGGREGATE_TASKS = new Set<TaskSpec['type']>(['moveTo', 'followRoute', 'wait', 'defend', 'overwatch', 'attack']);

export function aggregateTask(spec: TaskSpec): boolean {
  return AGGREGATE_TASKS.has(spec.type);
}

/**
 * Kills per second one shooter achieves with a weapon against one class of target at a
 * range, before posture and cover: Pk at that range (as at entity level) times the rate
 * of fire and FIRE_EFFICIENCY.
 */
export function killRate(w: WeaponDef, armor: ArmorClass, range: number): number {
  const pk = w.pk[armor] ?? 0;
  if (pk <= 0 || w.indirect || range > w.maxRange || range < w.minRange) return 0;
  return (pk * (1 - 0.5 * (range / w.maxRange) ** 2) * FIRE_EFFICIENCY) / w.reloadTime;
}

interface TypeGroup {
  type: EntityTypeDef;
  /** Living members of this type. */
  alive: Entity[];
  total: number;
}

class AggregateTask {
  status: 'running' | 'done' | 'failed' = 'running';
  message?: string;
  path: Vec2[] = [];
  index = 0;
  elapsed = 0;
  /** Route points (followRoute) and the next one to reach. */
  points: Vec2[] = [];
  point = 0;
  arrived = false;
  replanIn = 0;

  constructor(readonly spec: TaskSpec) {}

  resumeSpec(): TaskSpec {
    const s = this.spec;
    if (s.type === 'wait') return { type: 'wait', duration: Math.max(0, s.duration - this.elapsed) };
    if (s.type === 'followRoute') return { ...s, startIndex: this.point };
    if (s.type === 'overwatch' && s.duration !== undefined && this.arrived) return { ...s, duration: Math.max(0, s.duration - this.elapsed) };
    return s;
  }
}

export class Aggregate {
  x: number;
  y: number;
  heading: number;
  speed = 0;
  posture: AggregatePosture = 'halted';
  postureSince: number;
  task: AggregateTask | null = null;
  /** Fractional losses still to be taken, per entity type. */
  readonly pendingLosses = new Map<string, number>();
  /** Fractional rounds still to be taken from the members, per weapon. */
  readonly pendingRounds = new Map<string, number>();
  readonly contacts = new Map<string, { lastSeen: number; x: number; y: number }>();
  readonly seenBy = new Map<ForceId, { lastSeen: number; x: number; y: number }>();
  /** Aggregates that fired on it: unit id -> time. */
  readonly attackers = new Map<string, number>();
  lastFiredAt = -Infinity;
  engagingId?: string;
  /** Losses this tick, per type, with who caused most of them (filled by the attrition step). */
  incoming = new Map<string, { amount: number; by: Map<string, { unit: Aggregate; typeId: string; weapon: WeaponDef; amount: number }> }>();

  constructor(
    readonly unit: Unit,
    pos: Vec2,
    heading: number,
    now: number,
  ) {
    this.x = pos.x;
    this.y = pos.y;
    this.heading = heading;
    this.postureSince = now;
  }

  get id(): string {
    return this.unit.id;
  }

  get force(): ForceId {
    return this.unit.force;
  }

  /** The current task, if the unit is still on it (a stop or a new plan drops it). */
  activeTask(): AggregateTask | null {
    return this.task && this.unit.taskSpec === this.task.spec ? this.task : null;
  }

  groups(): TypeGroup[] {
    const map = new Map<string, TypeGroup>();
    for (const m of this.unit.memberList) {
      let g = map.get(m.type.id);
      if (!g) map.set(m.type.id, (g = { type: m.type, alive: [], total: 0 }));
      g.total++;
      if (m.alive) g.alive.push(m);
    }
    return [...map.values()];
  }

  /** Living members not counting losses still being taken: the strength that fights. */
  effective(g: TypeGroup): number {
    return Math.max(0, g.alive.length - (this.pendingLosses.get(g.type.id) ?? 0));
  }

  alive(): Entity[] {
    return this.unit.alive();
  }

  /** Domain the unit moves in: ground if it has any vehicles, else on foot (or afloat). */
  domain(): Domain {
    const alive = this.alive();
    if (alive.some((m) => m.domain === 'ground')) return 'ground';
    if (alive.length && alive.every((m) => m.domain === 'surface')) return 'surface';
    return 'lifeform';
  }

  offroadFactor(): number {
    const d = this.domain();
    let f = 1;
    for (const m of this.alive()) if (m.domain === d) f = Math.min(f, m.type.offroadFactor);
    return f;
  }

  sensorHeight(): number {
    return Math.max(2, ...this.alive().map((m) => m.type.sensorHeight));
  }
}

/** The aggregate level: every aggregated unit and the policy for splitting and joining. */
export class Aggregation {
  readonly policy: Required<AggregationPolicy> = { ...DEFAULT_AGGREGATION };
  private readonly list = new Map<string, Aggregate>();
  /** Hidden member id -> its aggregate. */
  private readonly hidden = new Map<string, Aggregate>();

  constructor(private readonly engine: Engine) {}

  get all(): Aggregate[] {
    return [...this.list.values()];
  }

  of(unit: Unit | string): Aggregate | undefined {
    return this.list.get(typeof unit === 'string' ? unit : unit.id);
  }

  /** A member hidden inside an aggregate. */
  member(id: string): Entity | undefined {
    const a = this.hidden.get(id);
    return a?.unit.memberList.find((m) => m.id === id);
  }

  /** The aggregate holding a hidden member. */
  holding(id: string): Aggregate | undefined {
    return this.hidden.get(id);
  }

  hiddenMembers(): Entity[] {
    const out: Entity[] = [];
    for (const a of this.list.values()) for (const m of a.unit.memberList) if (this.hidden.get(m.id) === a) out.push(m);
    return out;
  }

  clear(): void {
    this.list.clear();
    this.hidden.clear();
    Object.assign(this.policy, DEFAULT_AGGREGATION);
  }

  setPolicy(p: AggregationPolicy): void {
    const range = (v: number | undefined, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : undefined);
    if (typeof p.autoDisaggregate === 'boolean') this.policy.autoDisaggregate = p.autoDisaggregate;
    if (typeof p.autoReaggregate === 'boolean') this.policy.autoReaggregate = p.autoReaggregate;
    this.policy.disaggregateRange = range(p.disaggregateRange, 100, 50000) ?? this.policy.disaggregateRange;
    this.policy.reaggregateRange = range(p.reaggregateRange, 100, 100000) ?? this.policy.reaggregateRange;
    this.policy.reaggregateDelay = range(p.reaggregateDelay, 0, 86400) ?? this.policy.reaggregateDelay;
    // Hysteresis: joining up again needs the enemy further away than splitting does.
    if (this.policy.reaggregateRange < this.policy.disaggregateRange) this.policy.reaggregateRange = this.policy.disaggregateRange;
  }

  /** The policy as saved in a scenario (nothing when it is the default). */
  policyRecord(): AggregationPolicy | undefined {
    return JSON.stringify(this.policy) === JSON.stringify(DEFAULT_AGGREGATION) ? undefined : { ...this.policy };
  }

  // ------------------------------------------------------------ aggregating and splitting

  /** Why a unit cannot be aggregated now, or null if it can. */
  refusal(unit: Unit): string | null {
    if (this.list.has(unit.id)) return `${unit.name} is aggregated already`;
    const alive = unit.alive();
    if (!alive.length) return `${unit.name} has no one left`;
    for (const m of alive) {
      if (m.remote) return `${m.name} is owned by another simulation`;
      if (m.domain === 'air') return `${m.name} is an aircraft: air units are not aggregated`;
      if (m.embarkedIn) return `${m.name} is mounted in ${this.engine.nameOf(m.embarkedIn)}`;
      if (this.engine.passengersOf(m.id).length) return `${m.name} carries passengers: dismount them first`;
      if (m.mobilityKill) return `${m.name} is immobilised`;
      if (m.task?.status === 'running' && m.task.spec.type === 'manual') return `${m.name} is under direct control`;
    }
    const spec = unit.taskSpec;
    if (spec && unit.taskStatus() === 'running' && !aggregateTask(spec)) return `${unit.name} is on a task an aggregate cannot carry out (${spec.type}): stop it first`;
    return null;
  }

  /** Simulate the unit as one object. Throws if it cannot be (see refusal()). */
  aggregate(unit: Unit, quiet = false): Aggregate {
    const why = this.refusal(unit);
    if (why) throw new Error(why);
    const engine = this.engine;
    // Carry on with the unit's order if an aggregate can do it.
    const spec = unit.taskSpec && unit.taskStatus() === 'running' ? (unit.leaderTask?.status === 'running' ? unit.leaderTask.resumeSpec() : unit.taskSpec) : null;
    const lead = unit.leader && unit.leader.alive ? unit.leader : unit.alive()[0];
    const a = new Aggregate(unit, unit.centroid(), lead.heading, engine.time);
    this.hide(a);
    unit.leader = lead;
    unit.leaderTask = null;
    unit.reaggregate = null;
    if (spec) {
      unit.taskSpec = spec;
      this.begin(a, spec);
    } else {
      unit.taskSpec = null;
    }
    if (!quiet) engine.log('info', `${unit.name} aggregated: ${this.composition(a)}`, unit.id);
    return a;
  }

  private hide(a: Aggregate): void {
    this.list.set(a.id, a);
    a.unit.aggregate = a;
    for (const m of a.unit.memberList) {
      // Wrecks stay where they are.
      if (!m.alive) continue;
      this.engine.detachEntity(m);
      this.hidden.set(m.id, a);
    }
    this.syncMembers(a);
  }

  /**
   * Split an aggregate back into its members: in formation around its position, facing
   * its way, each with its own damage, ammunition and fuel. The unit's order carries on.
   * `reaggregate`: join up again when the enemy has gone (automatic splits).
   */
  disaggregate(unit: Unit, reason?: string, reaggregate = false): void {
    const a = this.list.get(unit.id);
    if (!a) {
      // Split up automatically, and told to stay so: it no longer joins up again by itself.
      if (unit.reaggregate && !reaggregate) {
        unit.reaggregate = null;
        return;
      }
      throw new Error(`${unit.name} is not aggregated`);
    }
    const engine = this.engine;
    const task = a.activeTask();
    const resume = task && task.status === 'running' ? task.resumeSpec() : null;
    const alive = unit.alive();
    const lead = unit.leader && unit.leader.alive ? unit.leader : alive[0];
    const order = lead ? [lead, ...alive.filter((m) => m !== lead)] : alive;
    const slots = this.slots(a, order.length);
    order.forEach((m, k) => {
      const at = engine.findValidPosition(slots[k], m.domain) ?? { x: a.x, y: a.y };
      this.place(m, at, a);
      if (a.posture === 'dugIn') m.prepared = m.domain === 'lifeform' ? 'dugIn' : 'hullDown';
      this.hidden.delete(m.id);
      engine.attachEntity(m, k);
    });
    this.list.delete(unit.id);
    unit.aggregate = null;
    unit.leader = lead;
    unit.leaderTask = null;
    unit.reaggregate = reaggregate ? {} : null;
    engine.log('info', `${unit.name} disaggregated${reason ? ` (${reason})` : ''}: ${alive.length} members`, unit.id);
    if (resume) unit.startTask(engine, resume);
    else {
      unit.taskSpec = null;
      unit.formUp(engine);
    }
  }

  /** Put members back as entities without restarting anything (the unit is being deleted). */
  release(unit: Unit): void {
    const a = this.list.get(unit.id);
    if (!a) return;
    for (const m of unit.memberList) {
      if (this.hidden.get(m.id) !== a) continue;
      this.hidden.delete(m.id);
      this.engine.attachEntity(m, 0);
    }
    this.list.delete(unit.id);
    unit.aggregate = null;
  }

  /** Formation slots for n members around the aggregate's position (their centre is the position). */
  private slots(a: Aggregate, n: number): Vec2[] {
    const offs: Vec2[] = [];
    for (let k = 0; k < n; k++) offs.push(k === 0 ? { x: 0, y: 0 } : formationOffset(a.unit.formation, k, a.unit.spacing));
    const mx = offs.reduce((s, o) => s + o.x, 0) / Math.max(1, n);
    const my = offs.reduce((s, o) => s + o.y, 0) / Math.max(1, n);
    const size = this.engine.terrain.spec.size;
    return offs.map((o) => {
      const r = rotateOffset({ x: o.x - mx, y: o.y - my }, a.heading);
      return { x: Math.min(size, Math.max(0, a.x + r.x)), y: Math.min(size, Math.max(0, a.y + r.y)) };
    });
  }

  private place(m: Entity, p: Vec2, a: Aggregate): void {
    const t = this.engine.terrain;
    m.x = p.x;
    m.y = p.y;
    m.z = m.domain === 'surface' ? t.surfaceHeight(p.x, p.y) : t.elevation(p.x, p.y);
    m.heading = a.heading;
    m.speed = 0;
    m.pitch = 0;
    m.roll = 0;
  }

  /** Hidden members follow the aggregate, so anything reading their position sees it. */
  private syncMembers(a: Aggregate): void {
    const z = this.engine.terrain.elevation(a.x, a.y);
    for (const m of a.unit.memberList) {
      if (this.hidden.get(m.id) !== a) continue;
      m.x = a.x;
      m.y = a.y;
      m.z = m.domain === 'surface' ? this.engine.terrain.surfaceHeight(a.x, a.y) : z;
      m.heading = a.heading;
      m.speed = a.speed;
    }
  }

  // ------------------------------------------------------------ orders

  /** Give an aggregated unit an order. Returns false if it had to split up to carry it out. */
  startTask(unit: Unit, spec: TaskSpec): boolean {
    const a = this.list.get(unit.id);
    if (!a) return false;
    if (!aggregateTask(spec)) {
      this.disaggregate(unit, `to ${createTask(spec).describe(this.engine).replace(/^./, (c) => c.toLowerCase())}`, true);
      return false;
    }
    unit.taskSpec = spec;
    this.begin(a, spec);
    return true;
  }

  private begin(a: Aggregate, spec: TaskSpec): void {
    const t = new AggregateTask(spec);
    a.task = t;
    if (spec.type === 'moveTo') this.planTo(a, t, spec.target, !!spec.covered);
    else if (spec.type === 'followRoute') {
      const g = this.engine.graphics.get(spec.routeId);
      if (!g || !g.points.length) return this.fail(a, t, `route ${spec.routeId} not found`);
      t.points = spec.reverse ? [...g.points].reverse() : [...g.points];
      t.point = Math.max(0, Math.min(t.points.length - 1, spec.startIndex ?? 0));
      this.planTo(a, t, t.points[t.point], false);
    } else if (spec.type === 'defend' || spec.type === 'overwatch') this.planTo(a, t, spec.position, false);
  }

  private planTo(a: Aggregate, t: AggregateTask, goal: Vec2, covered: boolean): void {
    const route = this.engine.planRoute({ x: a.x, y: a.y }, goal, a.domain(), a.offroadFactor(), a.force, covered);
    if (!route) return this.fail(a, t, 'no route');
    t.path = route;
    t.index = 0;
  }

  private fail(a: Aggregate, t: AggregateTask, message: string): void {
    t.status = 'failed';
    t.message = message;
    this.engine.log('task', `${a.unit.name}: ${createTask(t.spec).describe(this.engine)} failed: ${message}`, a.id);
  }

  resumeSpec(unit: Unit): TaskSpec | undefined {
    const t = this.list.get(unit.id)?.activeTask();
    return t && t.status === 'running' ? t.resumeSpec() : undefined;
  }

  describeTask(unit: Unit): string | undefined {
    const a = this.list.get(unit.id);
    const t = a?.activeTask();
    if (!a || !t || t.status !== 'running') return undefined;
    if (t.spec.type === 'followRoute') return `Follow route ${this.engine.graphics.get(t.spec.routeId)?.name ?? t.spec.routeId} (wp ${t.point + 1}/${t.points.length})`;
    if (t.spec.type === 'attack') {
      // An attack on a member of a unit is an attack on the unit.
      const target = this.engine.findEntity(t.spec.targetId);
      return `Attack ${target?.unit?.name ?? target?.name ?? t.spec.targetId}`;
    }
    const base = createTask(t.spec).describe(this.engine).replace(/ \(moving\)$/, '');
    return (t.spec.type === 'defend' || t.spec.type === 'overwatch') && !t.arrived ? `${base} (moving)` : base;
  }

  travel(unit: Unit): Travel | undefined {
    const a = this.list.get(unit.id);
    const t = a?.activeTask();
    if (!a || !t || t.status !== 'running' || t.index >= t.path.length) return undefined;
    let remaining = dist2d(a, t.path[t.index]);
    for (let i = t.index + 1; i < t.path.length; i++) remaining += dist2d(t.path[i - 1], t.path[i]);
    const v = this.unitSpeed(a, t.spec);
    if (this.outOfFuel(a)) return { remaining: Math.round(remaining), stalled: 'out of fuel' };
    return { remaining: Math.round(remaining), eta: v > 0.1 ? Math.round(this.engine.time + remaining / v) : undefined };
  }

  // ------------------------------------------------------------ the step

  /** One simulation step: movement, then (once a second) sensing and the policy, then attrition. */
  update(dt: number): void {
    const engine = this.engine;
    const second = Math.round(engine.time * 10) % 10 === 0;
    if (!this.list.size) {
      if (second) this.checkReaggregation();
      return;
    }
    for (const a of this.list.values()) {
      if (!a.alive().length) continue;
      this.move(a, dt);
      this.syncMembers(a);
    }
    if (second) {
      for (const a of this.list.values()) this.sense(a);
      this.checkDisaggregation();
      this.checkReaggregation();
    }
    this.fight(dt);
  }

  private outOfFuel(a: Aggregate): boolean {
    return this.engine.rules.fuel && a.alive().some((m) => m.type.endurance?.km && m.fuel <= 0);
  }

  /** Speed of the slowest member on the ground here, capped at the order's speed. */
  unitSpeed(a: Aggregate, spec?: TaskSpec): number {
    const t = this.engine.terrain;
    const weather = groundFactor(this.engine.env);
    let v = Infinity;
    for (const m of a.alive()) {
      const mob = t.mobilityFactor(a.x, a.y, m.moveDomain, m.type.offroadFactor * weather);
      v = Math.min(v, m.cruiseSpeed, m.type.maxSpeed * Math.max(mob, 0.1));
    }
    const cap = spec && 'speed' in spec && spec.speed ? spec.speed : Infinity;
    return Number.isFinite(v) ? Math.min(v, cap) : 0;
  }

  private move(a: Aggregate, dt: number): void {
    const engine = this.engine;
    const t = a.activeTask();
    let moving = false;
    let holding = false;
    if (t && t.status === 'running') {
      const s = t.spec;
      if (s.type === 'wait') {
        t.elapsed += dt;
        if (t.elapsed >= s.duration) t.status = 'done';
      } else if (s.type === 'attack') {
        moving = this.closeIn(a, t, s.targetId, dt);
      } else if (t.index < t.path.length) {
        moving = this.follow(a, t, dt);
      } else if (s.type === 'moveTo') {
        t.status = 'done';
      } else if (s.type === 'followRoute') {
        if (t.point >= t.points.length - 1) t.status = 'done';
        else {
          t.point++;
          this.planTo(a, t, t.points[t.point], false);
        }
      } else if (s.type === 'defend' || s.type === 'overwatch') {
        if (!t.arrived) {
          t.arrived = true;
          t.elapsed = 0;
          if (s.facing !== undefined) a.heading = normalizeAngle((s.facing * Math.PI) / 180);
        }
        holding = true;
        t.elapsed += dt;
        if (s.type === 'overwatch' && s.duration !== undefined && t.elapsed >= s.duration) t.status = 'done';
      }
    }
    if (!moving) a.speed = 0;
    const posture: AggregatePosture = moving ? 'moving' : holding ? (a.posture === 'dugIn' ? 'dugIn' : 'defending') : 'halted';
    if (posture !== a.posture) {
      a.posture = posture;
      a.postureSince = engine.time;
    }
    if (a.posture === 'defending') {
      const wait = a.alive().some((m) => m.domain === 'lifeform') ? PREPARE_TIME.lifeform : PREPARE_TIME.vehicle;
      if (engine.time - a.postureSince >= wait) {
        a.posture = 'dugIn';
        a.postureSince = engine.time;
      }
    }
  }

  /** Drive along the planned path at unit speed. True while moving. */
  private follow(a: Aggregate, t: AggregateTask, dt: number): boolean {
    if (this.outOfFuel(a)) return false;
    const v = this.unitSpeed(a, t.spec);
    let step = v * dt;
    let moved = 0;
    while (step > 1e-9 && t.index < t.path.length) {
      const wp = t.path[t.index];
      const d = dist2d(a, wp);
      if (d > 0.01) a.heading = bearing(a, wp);
      if (d <= step) {
        a.x = wp.x;
        a.y = wp.y;
        step -= d;
        moved += d;
        t.index++;
      } else {
        a.x += Math.sin(a.heading) * step;
        a.y += Math.cos(a.heading) * step;
        moved += step;
        step = 0;
      }
    }
    a.speed = moved / dt;
    if (this.engine.rules.fuel) for (const m of a.alive()) {
      if (!m.type.endurance) continue;
      m.speed = a.speed;
      burnFuel(this.engine, m, dt);
    }
    return moved > 0;
  }

  /** Attack: close on the target until in range with line of sight, then hold and fire. */
  private closeIn(a: Aggregate, t: AggregateTask, targetId: string, dt: number): boolean {
    const engine = this.engine;
    const target = engine.findEntity(targetId);
    const unit = target?.unit;
    const gone = !target || (unit ? !unit.alive().length : target.destroyed);
    if (gone) {
      t.status = 'done';
      return false;
    }
    const goal = unit?.aggregate ? { x: unit.aggregate.x, y: unit.aggregate.y } : { x: target.x, y: target.y };
    const reach = this.reach(a, target.type.armor);
    if (reach <= 0) {
      if (t.status === 'running') this.fail(a, t, 'no weapon can engage the target');
      return false;
    }
    const d = dist2d(a, goal);
    if (d <= reach * 0.8 && this.sees(a, goal)) {
      a.heading = bearing(a, goal);
      t.path = [];
      return false;
    }
    t.replanIn -= dt;
    if (t.replanIn <= 0 || t.index >= t.path.length) {
      t.replanIn = 10;
      this.planTo(a, t, goal, false);
      if (t.status !== 'running') return false;
    }
    return this.follow(a, t, dt);
  }

  /** Longest direct-fire range with ammunition against a class of target (0: none). */
  private reach(a: Aggregate, armor?: ArmorClass): number {
    let r = 0;
    for (const m of a.alive()) {
      if (m.firepowerKill) continue;
      for (const wid of m.type.weapons) {
        const w = this.engine.catalog.weapon(wid);
        if (w.indirect || (m.ammo.get(wid) ?? 0) < 1) continue;
        if (armor && !((w.pk[armor] ?? 0) > 0)) continue;
        r = Math.max(r, w.maxRange);
      }
    }
    return r;
  }

  /** Line of sight from the aggregate's position to a point (ground level plus 2 m). */
  private sees(a: Aggregate, p: Vec2): boolean {
    const t = this.engine.terrain;
    const from = { x: a.x, y: a.y, z: t.elevation(a.x, a.y) + a.sensorHeight() };
    return this.engine.lineOfSight(from, { x: p.x, y: p.y, z: t.elevation(p.x, p.y) + 2 });
  }

  /** Best sensor range of the living members against ground targets, in today's light and weather. */
  sensorRange(a: Aggregate): number {
    let r = 0;
    for (const m of a.alive()) {
      if (m.embarkedIn) continue;
      for (const sid of m.type.sensors) {
        const s = this.engine.catalog.sensors.get(sid);
        if (s && (s.detects.includes('ground') || s.detects.includes('lifeform'))) r = Math.max(r, sensorRange(s, this.engine.env));
      }
    }
    return r;
  }

  /**
   * Once a second: which enemy aggregates this one sees (within its best sensor range,
   * with line of sight), and which forces see it (their aggregates, or any of their
   * entities with a sensor in range and line of sight). No random draws.
   */
  private sense(a: Aggregate): void {
    const engine = this.engine;
    const now = engine.time;
    if (a.alive().length) {
      const range = this.sensorRange(a);
      for (const b of this.list.values()) {
        if (b === a || !b.alive().length || !engine.isHostile(a.force, b.force)) continue;
        if (dist2d(a, b) > range || !this.sees(a, b)) continue;
        a.contacts.set(b.id, { lastSeen: now, x: b.x, y: b.y });
        b.seenBy.set(a.force, { lastSeen: now, x: b.x, y: b.y });
      }
    }
    for (const [id, c] of a.contacts) {
      const b = this.list.get(id);
      if (!b || !b.alive().length || now - c.lastSeen > CONTACT_TIMEOUT) a.contacts.delete(id);
    }
    // Entity-level observers.
    const t = engine.terrain;
    const aim = { x: a.x, y: a.y, z: t.elevation(a.x, a.y) + 2 };
    for (const e of engine.entities.values()) {
      if (!e.alive || e.embarkedIn || e.remote || !engine.isHostile(e.force, a.force)) continue;
      const seen = a.seenBy.get(e.force);
      if (seen && seen.lastSeen === now) continue;
      const d = Math.hypot(e.x - a.x, e.y - a.y);
      if (d > OBSERVER_REACH) continue;
      let range = 0;
      for (const sid of e.type.sensors) {
        const s = engine.catalog.sensors.get(sid);
        if (s && (s.detects.includes('ground') || s.detects.includes('lifeform'))) range = Math.max(range, sensorRange(s, engine.env));
      }
      if (d > range || !engine.lineOfSight(e.eye, aim)) continue;
      a.seenBy.set(e.force, { lastSeen: now, x: a.x, y: a.y });
    }
  }

  /** Enemy entities (not aggregated) within `range` of a point: the nearest distance, or Infinity. */
  private nearestEnemyEntity(force: ForceId, p: Vec2): number {
    let best = Infinity;
    for (const e of this.engine.entities.values()) {
      if (!e.alive || e.embarkedIn || e.ambient || !this.engine.isHostile(force, e.force)) continue;
      best = Math.min(best, Math.hypot(e.x - p.x, e.y - p.y));
    }
    return best;
  }

  private checkDisaggregation(): void {
    if (!this.policy.autoDisaggregate) return;
    const split: Aggregate[] = [];
    for (const a of this.list.values()) {
      if (!a.alive().length) continue;
      if (this.nearestEnemyEntity(a.force, a) <= this.policy.disaggregateRange) split.push(a);
    }
    for (const a of split) this.disaggregate(a.unit, `enemy within ${km(this.policy.disaggregateRange)}`, true);
  }

  private checkReaggregation(): void {
    if (!this.policy.autoReaggregate) return;
    const now = this.engine.time;
    for (const u of this.engine.units.values()) {
      const r = u.reaggregate;
      if (!r || u.aggregate) continue;
      if (!u.alive().length) {
        u.reaggregate = null;
        continue;
      }
      if (this.nearestEnemyEntity(u.force, u.centroid()) <= this.policy.reaggregateRange) {
        r.quietSince = undefined;
        continue;
      }
      r.quietSince ??= now;
      if (now - r.quietSince < this.policy.reaggregateDelay || this.refusal(u)) continue;
      this.aggregate(u, true);
      this.engine.log('info', `${u.name} aggregated again: no enemy within ${km(this.policy.reaggregateRange)}`, u.id);
    }
  }

  // ------------------------------------------------------------ attrition

  /**
   * Lanchester square-law attrition between aggregates, for one step. Every shooter type
   * of the firing aggregate spreads its fire over the target types it can hurt, in
   * proportion to their numbers; each target type j then loses
   *
   *   dm_j/dt = - sum_i n_i * (m_j / sum_l m_l) * k_ij
   *
   * where n_i and m_j are effective strengths and k_ij the kill rate of one shooter of
   * type i against one target of type j (killRate() with the best weapon, times posture
   * and cover). Losses build up as fractions and a member of the type is lost each time
   * they pass a whole one; the seeded generator picks which.
   */
  private fight(dt: number): void {
    const engine = this.engine;
    for (const a of this.list.values()) a.incoming.clear();
    const firing: Aggregate[] = [];
    for (const a of this.list.values()) {
      const b = this.pickTarget(a);
      a.engagingId = b?.id;
      if (!b) continue;
      if (this.fireOn(a, b, dt)) firing.push(a);
    }
    // Losses are applied once everyone has fired, so the order does not matter.
    for (const b of this.list.values()) {
      for (const [typeId, inc] of b.incoming) {
        const pending = (b.pendingLosses.get(typeId) ?? 0) + inc.amount;
        b.pendingLosses.set(typeId, pending);
        let left = pending;
        while (left >= 1) {
          const pool = b.alive().filter((m) => m.type.id === typeId);
          if (!pool.length) {
            left = 0;
            break;
          }
          const victim = pool[Math.floor(engine.rng.next() * pool.length)];
          let by: { unit: Aggregate; typeId: string; weapon: WeaponDef; amount: number } | undefined;
          for (const c of inc.by.values()) if (!by || c.amount > by.amount) by = c;
          this.lose(b, victim, by);
          left -= 1;
        }
        if (left > 0 && !b.alive().some((m) => m.type.id === typeId)) left = 0;
        if (left > 0) b.pendingLosses.set(typeId, left);
        else b.pendingLosses.delete(typeId);
      }
    }
    for (const a of firing) this.spendRounds(a);
  }

  private pickTarget(a: Aggregate): Aggregate | undefined {
    const engine = this.engine;
    if (!a.alive().length || !a.contacts.size) return undefined;
    const roe = a.unit.leader?.roe ?? 'fireAtWill';
    const t = a.activeTask();
    const attackUnit = t?.spec.type === 'attack' ? engine.findEntity(t.spec.targetId)?.unit?.id : undefined;
    const reach = this.reach(a);
    let best: Aggregate | undefined;
    let bestScore = Infinity;
    for (const [id, c] of a.contacts) {
      if (engine.time - c.lastSeen > 2) continue;
      const b = this.list.get(id);
      if (!b || !b.alive().length) continue;
      const d = dist2d(a, b);
      if (d > reach) continue;
      const attacked = id === attackUnit;
      if (roe === 'holdFire' && !attacked) continue;
      if (roe === 'returnFire' && !attacked && !((a.attackers.get(id) ?? -Infinity) >= engine.time - RETURN_FIRE_WINDOW)) continue;
      const score = attacked ? -1 : id === a.engagingId ? d * 0.8 : d;
      if (score < bestScore) {
        bestScore = score;
        best = b;
      }
    }
    return best;
  }

  /** Exposure of a target type in an aggregate: posture times cover where it stands. */
  private exposure(b: Aggregate, type: EntityTypeDef): number {
    const t = this.engine.terrain;
    const foot = type.domain === 'lifeform';
    const posture = b.posture === 'dugIn' ? (foot ? DUG_IN.lifeform : DUG_IN.vehicle) : EXPOSURE[b.posture];
    let cover = 1;
    if ((type.domain === 'ground' || foot) && t.isForest(b.x, b.y)) cover = 0.75;
    else if (foot && t.isBuiltUp(b.x, b.y)) cover = 0.6;
    return posture * cover;
  }

  /** Accuracy of an aggregate's fire: on the move, and its morale. */
  private shooterFactor(a: Aggregate): number {
    let f = a.posture === 'moving' ? MOVING_FIRE : 1;
    if (this.engine.rules.morale) f *= a.unit.moraleState === 'shaken' ? 0.8 : a.unit.moraleState === 'broken' ? 0.6 : 1;
    return f;
  }

  /** Kill rate of one shooter type against one target type at a range, with the weapon that does best. */
  private bestWeapon(shooters: Entity[], target: EntityTypeDef, range: number): { w: WeaponDef; k: number; n: number } | null {
    let best: { w: WeaponDef; k: number; n: number } | null = null;
    const type = shooters[0]?.type;
    if (!type) return null;
    for (const wid of type.weapons) {
      const w = this.engine.catalog.weapon(wid);
      if (!w.targets.includes(target.domain)) continue;
      const k = killRate(w, target.armor, range);
      if (k <= 0) continue;
      const n = shooters.filter((m) => (m.ammo.get(wid) ?? 0) >= 1).length;
      if (n && (!best || k > best.k)) best = { w, k, n };
    }
    return best;
  }

  /** Work out this step's losses on b from a's fire. Returns false if a has nothing that can hurt b. */
  private fireOn(a: Aggregate, b: Aggregate, dt: number): boolean {
    const engine = this.engine;
    const range = dist2d(a, b);
    const targets = b.groups().filter((g) => g.alive.length);
    const sf = this.shooterFactor(a);
    let fired = false;
    for (const g of a.groups()) {
      const shooters = g.alive.filter((m) => !m.firepowerKill);
      if (!shooters.length) continue;
      const eff = Math.max(0, shooters.length - (a.pendingLosses.get(g.type.id) ?? 0) * (shooters.length / g.alive.length));
      const options: { tg: TypeGroup; w: WeaponDef; k: number; frac: number; m: number }[] = [];
      for (const tg of targets) {
        const bw = this.bestWeapon(shooters, tg.type, range);
        if (!bw) continue;
        options.push({ tg, w: bw.w, k: bw.k * sf * this.exposure(b, tg.type), frac: bw.n / shooters.length, m: b.effective(tg) });
      }
      const total = options.reduce((s, o) => s + o.m, 0);
      if (total <= 0) continue;
      for (const o of options) {
        const share = o.m / total;
        const n = eff * o.frac;
        const amount = n * share * o.k * dt;
        if (amount <= 0) continue;
        fired = true;
        let inc = b.incoming.get(o.tg.type.id);
        if (!inc) b.incoming.set(o.tg.type.id, (inc = { amount: 0, by: new Map() }));
        inc.amount += amount;
        const key = `${a.id}|${g.type.id}`;
        const c = inc.by.get(key);
        if (c) c.amount += amount;
        else inc.by.set(key, { unit: a, typeId: g.type.id, weapon: o.w, amount });
        // Rounds: every shot laid on a target, hit or not.
        a.pendingRounds.set(o.w.id, (a.pendingRounds.get(o.w.id) ?? 0) + (n * share * FIRE_EFFICIENCY * dt) / o.w.reloadTime);
      }
    }
    if (fired) {
      a.lastFiredAt = engine.time;
      b.attackers.set(a.id, engine.time);
      // Firing gives it away.
      a.seenBy.set(b.force, { lastSeen: engine.time, x: a.x, y: a.y });
      for (const m of b.alive()) m.underFireUntil = engine.time + 15;
      for (const m of a.alive()) m.lastFiredAt = engine.time;
    }
    return fired;
  }

  /** Take whole rounds from the members that have the most of each weapon. */
  private spendRounds(a: Aggregate): void {
    for (const [wid, n] of a.pendingRounds) {
      let left = n;
      while (left >= 1) {
        let from: Entity | undefined;
        for (const m of a.alive()) if ((m.ammo.get(wid) ?? 0) >= 1 && (!from || m.ammo.get(wid)! > from.ammo.get(wid)!)) from = m;
        if (!from) {
          left = 0;
          break;
        }
        from.ammo.set(wid, from.ammo.get(wid)! - 1);
        left -= 1;
      }
      if (left > 0) a.pendingRounds.set(wid, left);
      else a.pendingRounds.delete(wid);
    }
  }

  /** A member is lost to aggregate fire: it is destroyed and left behind as a wreck. */
  private lose(b: Aggregate, victim: Entity, by?: { unit: Aggregate; typeId: string; weapon: WeaponDef }): void {
    const engine = this.engine;
    const killer = by ? (by.unit.alive().find((m) => m.type.id === by.typeId) ?? by.unit.alive()[0]) : undefined;
    victim.destroyed = true;
    if (by) engine.log('detonation', `${by.weapon.name} hit ${victim.name} (aggregate fire from ${by.unit.unit.name})`, killer?.id, victim.id, { to: victim.position, hit: true, weaponId: by.weapon.id });
    engine.afterDamage(victim, 'kill', killer?.id);
    // The wreck stays on the map where the unit is.
    this.hidden.delete(victim.id);
    const k = b.unit.memberList.indexOf(victim);
    const off = rotateOffset({ x: ((k % 5) - 2) * 15, y: -Math.floor(k / 5) * 15 }, b.heading);
    const at = engine.findValidPosition({ x: b.x + off.x, y: b.y + off.y }, victim.domain) ?? { x: b.x, y: b.y };
    this.place(victim, at, b);
    engine.attachEntity(victim, 0);
    if (b.unit.leader === victim) {
      const next = b.alive()[0];
      b.unit.leader = next;
      if (next) engine.log('info', `${b.unit.name}: ${victim.name} lost, ${next.name} takes command`, b.id);
    }
    if (!b.alive().length) {
      // Nothing left to aggregate: an ordinary unit of wrecks from now on.
      this.list.delete(b.id);
      b.unit.aggregate = null;
      b.unit.taskSpec = null;
      engine.log('info', `${b.unit.name} destroyed`, b.id);
    }
  }

  // ------------------------------------------------------------ views and records

  private composition(a: Aggregate): string {
    return a
      .groups()
      .filter((g) => g.alive.length)
      .map((g) => `${g.alive.length} × ${g.type.name}`)
      .join(', ');
  }

  /** Potential kills per minute of the living members against their best targets at short range. */
  combatPower(a: Aggregate): number {
    let cp = 0;
    for (const m of a.alive()) {
      if (m.firepowerKill) continue;
      let best = 0;
      for (const wid of m.type.weapons) {
        const w = this.engine.catalog.weapon(wid);
        if (w.indirect || (m.ammo.get(wid) ?? 0) < 1) continue;
        for (const armor of Object.keys(w.pk) as ArmorClass[]) best = Math.max(best, killRate(w, armor, 0));
      }
      cp += best * 60;
    }
    return Math.round(cp * 100) / 100;
  }

  pooledAmmo(a: Aggregate): number {
    let have = 0;
    let full = 0;
    for (const m of a.alive()) {
      for (const wid of m.type.weapons) {
        const cap = this.engine.catalog.weapon(wid).ammo;
        have += Math.min(cap, m.ammo.get(wid) ?? 0);
        full += cap;
      }
    }
    return full ? have / full : 1;
  }

  pooledFuel(a: Aggregate): number | undefined {
    const v = a.alive().filter((m) => m.type.endurance);
    return v.length && this.engine.rules.fuel ? v.reduce((s, m) => s + m.fuel, 0) / v.length : undefined;
  }

  snapshot(unit: Unit): AggregateSnapshot | undefined {
    const a = this.list.get(unit.id);
    if (!a) return undefined;
    const groups = a.groups();
    const lead = (unit.leader ?? unit.memberList[0]).type;
    const fuel = this.pooledFuel(a);
    const r2 = (v: number) => Math.round(v * 100) / 100;
    return {
      alive: groups.reduce((s, g) => s + g.alive.length, 0),
      total: unit.memberList.length,
      strength: groups.map((g) => ({ typeId: g.type.id, name: g.type.name, alive: g.alive.length, effective: r2(a.effective(g)), total: g.total })),
      combatPower: this.combatPower(a),
      heading: a.heading,
      speed: r2(a.speed),
      posture: a.posture,
      unitSpeed: r2(this.unitSpeed(a)),
      sensorRange: Math.round(this.sensorRange(a)),
      ammo: r2(this.pooledAmmo(a)),
      fuel: fuel === undefined ? undefined : Math.round(fuel * 1000) / 1000,
      engagingId: a.engagingId,
      contacts: a.contacts.size ? [...a.contacts.keys()] : undefined,
      typeId: lead.id,
      domain: lead.domain,
      symbol: lead.symbol,
    };
  }

  /** Forces that hold this aggregate as a contact, with where they last saw it. */
  seenBy(unit: Unit, force: ForceId): { lastSeen: number; x: number; y: number } | undefined {
    const s = this.list.get(unit.id)?.seenBy.get(force);
    return s && this.engine.time - s.lastSeen <= CONTACT_TIMEOUT ? s : undefined;
  }

  /** True if this unit (aggregated) has an enemy aggregate in sight. */
  detectsEnemy(id: string): boolean {
    const a = this.list.get(id);
    return !!a && [...a.contacts.keys()].some((c) => !!this.list.get(c)?.alive().length);
  }

  /** Hostile aggregates with their position inside a polygon. */
  enemyIn(force: ForceId, inside: (p: Vec2) => boolean): boolean {
    for (const a of this.list.values()) if (a.alive().length && this.engine.isHostile(force, a.force) && inside(a)) return true;
    return false;
  }

  record(unit: Unit, checkpoint: boolean): AggregateRecord | undefined {
    const a = this.list.get(unit.id);
    if (!a) return undefined;
    const r1 = (v: number) => Math.round(v * 10) / 10;
    const rec: AggregateRecord = { x: r1(a.x), y: r1(a.y), heading: Math.round(a.heading * 1000) / 1000 };
    if (!checkpoint) return rec;
    const map = (m: Map<string, number>) => (m.size ? Object.fromEntries(m) : undefined);
    return {
      ...rec,
      x: a.x,
      y: a.y,
      heading: a.heading,
      speed: a.speed || undefined,
      posture: a.posture,
      postureSince: a.postureSince,
      pendingLosses: map(a.pendingLosses),
      pendingRounds: map(a.pendingRounds),
      contacts: a.contacts.size ? [...a.contacts].map(([id, c]) => ({ id, ...c })) : undefined,
      seenBy: a.seenBy.size ? [...a.seenBy].map(([force, c]) => ({ force, ...c })) : undefined,
      attackers: map(a.attackers),
      lastFiredAt: Number.isFinite(a.lastFiredAt) ? a.lastFiredAt : undefined,
    };
  }

  /** Aggregate a unit from a scenario file, at the saved position and with the saved state. */
  restore(unit: Unit, rec: AggregateRecord): void {
    if (!unit.alive().length || this.list.has(unit.id)) return;
    const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
    const c = unit.centroid();
    const a = new Aggregate(unit, { x: num(rec.x, c.x), y: num(rec.y, c.y) }, num(rec.heading, unit.leader?.heading ?? 0), this.engine.time);
    if (unit.leader && !unit.leader.alive) unit.leader = unit.alive()[0];
    a.speed = num(rec.speed, 0);
    if (rec.posture && ['moving', 'halted', 'defending', 'dugIn'].includes(rec.posture)) a.posture = rec.posture;
    a.postureSince = num(rec.postureSince, this.engine.time);
    for (const [k, v] of Object.entries(rec.pendingLosses ?? {})) if (Number.isFinite(v)) a.pendingLosses.set(k, v);
    for (const [k, v] of Object.entries(rec.pendingRounds ?? {})) if (Number.isFinite(v)) a.pendingRounds.set(k, v);
    for (const ct of rec.contacts ?? []) a.contacts.set(ct.id, { lastSeen: ct.lastSeen, x: ct.x, y: ct.y });
    for (const s of rec.seenBy ?? []) a.seenBy.set(s.force, { lastSeen: s.lastSeen, x: s.x, y: s.y });
    for (const [k, v] of Object.entries(rec.attackers ?? {})) a.attackers.set(k, v);
    if (rec.lastFiredAt !== undefined) a.lastFiredAt = rec.lastFiredAt;
    unit.taskSpec = null;
    unit.leaderTask = null;
    this.hide(a);
  }
}

function km(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1).replace(/\.0$/, '')} km` : `${Math.round(m)} m`;
}
