// Tasks for unmanned systems: one-way attack (strike), loiter-and-search with attack, and
// the swarm tasks a unit of drones carries out together: a search that shares the area
// out, and a distributed attack that spreads its members over distinct targets.

import { dist2d, pointInPolygon } from '../shared/math.js';
import type { TaskSpec, Vec2 } from '../shared/types.js';
import type { Engine } from './engine.js';
import type { Entity } from './entity.js';
import { sensorRange } from './environment.js';
import { AttackTask, bestWeaponAgainst, MoveToTask, registerTask, sweepTracks, Task, type TaskContext, type TaskStatus } from './tasks.js';
import { DEFAULT_TERMINAL_RANGE, warheadOf } from './unmanned.js';
import type { Unit } from './units.js';

type StrikeSpec = Extract<TaskSpec, { type: 'strike' }>;
type LoiterSpec = Extract<TaskSpec, { type: 'loiter' }>;
type SwarmSearchSpec = Extract<TaskSpec, { type: 'swarmSearch' }>;
type SwarmAttackSpec = Extract<TaskSpec, { type: 'swarmAttack' }>;

/** Seconds a contact may go unseen and still be attacked. */
const FRESH = 5;
/** Default orbit radius (m) of a loiter round a point. */
const LOITER_RADIUS = 1000;
/** Seconds between looks for a target to attack. */
const PICK_INTERVAL = 1;
/** Seconds circling a point before a loitering drone settles for a lesser target. */
const SWEEP_TIME = 300;

/**
 * Rank of a target by preference (0 best), or -1 if it is not wanted. Preferences name
 * armour classes (armored, light, soft, lifeform), symbols (artillery, air-defense…),
 * domains or type ids; 'any' takes anything else. No preferences: anything.
 */
export function preferenceRank(t: Entity, prefer?: string[]): number {
  if (!prefer?.length) return 0;
  for (let i = 0; i < prefer.length; i++) {
    const p = prefer[i];
    if (p === t.type.armor || p === t.type.symbol || p === t.type.id || p === t.domain) return i;
  }
  return prefer.indexOf('any');
}

/** Can it hurt the target: with its warhead (one-way drones) or one of its weapons. */
export function canStrike(engine: Engine, e: Entity, t: Entity): boolean {
  const w = warheadOf(engine, e);
  if (w) return w.targets.includes(t.domain) && (w.pk[t.type.armor] ?? 0) >= 0.02;
  const best = bestWeaponAgainst(engine, e, t);
  return !!best && (best.pk[t.type.armor] ?? 0) >= 0.02;
}

/** The target a drone's task is going for, if any. */
function aimOf(t: Task | null): string | undefined {
  if (!t || t.status !== 'running') return undefined;
  if (t instanceof StrikeTask) return t.s.targetId;
  if (t instanceof LoiterTask || t instanceof SwarmSearchTask || t instanceof SwarmAttackTask) return t.aim;
  return t.spec.type === 'attack' ? t.spec.targetId : undefined;
}

/** How many of the force are going for this target already (other than `except`). */
function claims(engine: Engine, e: Entity, targetId: string): number {
  let n = 0;
  for (const o of engine.entities.values()) if (o !== e && o.force === e.force && o.alive && aimOf(o.task) === targetId) n++;
  return n;
}

/**
 * The best enemy for it to go for among what its side has seen lately: wanted, within the
 * area (or round a point), one it can hurt; preferred kinds first, then those fewest
 * friends are already going for (saturation), then the nearest.
 */
function pickTarget(engine: Engine, e: Entity, o: { prefer?: string[]; area?: Vec2[]; near?: { c: Vec2; r: number }; only?: string[]; firstChoiceOnly?: boolean }): Entity | undefined {
  let best: Entity | undefined;
  let key: [number, number, number] = [Infinity, Infinity, Infinity];
  const ids = o.only ?? [...e.contacts.values()].filter((c) => engine.time - c.lastSeen <= FRESH).map((c) => c.id);
  for (const id of ids) {
    const t = engine.entities.get(id);
    if (!t || !t.alive || t.embarkedIn || !engine.isHostile(e.force, t.force)) continue;
    if (o.area && !pointInPolygon(t, o.area)) continue;
    if (o.near && dist2d(t, o.near.c) > o.near.r) continue;
    const rank = preferenceRank(t, o.prefer);
    if (rank < 0 || (rank > 0 && o.firstChoiceOnly) || !canStrike(engine, e, t)) continue;
    const k: [number, number, number] = [rank, claims(engine, e, t.id), dist2d(e, t)];
    if (k[0] < key[0] || (k[0] === key[0] && (k[1] < key[1] || (k[1] === key[1] && k[2] < key[2])))) {
      key = k;
      best = t;
    }
  }
  return best;
}

/** The task that attacks a target: a strike for one-way drones, an attack for armed ones. */
function attackTask(e: Entity, targetId: string): Task {
  return e.type.unmanned?.warhead ? new StrikeTask({ type: 'strike', targetId }) : new AttackTask(targetId);
}

/** Sensor reach for track spacing (at least 100 m, at most 1.5 km). */
function trackSpacing(engine: Engine, e: Entity, spacing?: number): number {
  let reach = 300;
  for (const sid of e.type.sensors) reach = Math.max(reach, sensorRange(engine.catalog.sensors.get(sid)!, engine.env));
  return spacing ?? Math.max(100, Math.min(1500, reach));
}

/** Step through waypoints one leg at a time (air flies straight; ground plans a route). */
class Legs {
  private leg: Task | null = null;
  private legTo?: Vec2;

  /** True when the waypoint is reached (or cannot be). */
  to(ctx: TaskContext, p: Vec2): boolean {
    if (!this.leg || this.legTo !== p) {
      this.leg = new MoveToTask(p);
      this.legTo = p;
    }
    const s = this.leg.update(ctx);
    if (s === 'running') return false;
    this.leg = null;
    return true;
  }

  get path(): Vec2[] {
    return this.leg?.remainingPath ?? [];
  }
}

// ---------------------------------------------------------------- strike

/**
 * One-way attack: fly at the target at full speed, leading it, and dive in from the
 * terminal range with line of sight. The warhead is delivered as a shot from where the
 * drone is, so the armour of the face it strikes counts (top attack for loitering
 * munitions). A remotely piloted drone needs its link to the end.
 */
export class StrikeTask extends Task {
  constructor(readonly s: StrikeSpec) {
    super(s);
  }

  protected override start({ engine, entity }: TaskContext): void {
    if (!warheadOf(engine, entity)) this.fail('not a one-way attack drone');
  }

  protected tick({ engine, entity }: TaskContext): TaskStatus {
    const t = engine.findEntity(this.s.targetId);
    if (!t || t.destroyed || t.embarkedIn) return 'done';
    const w = warheadOf(engine, entity)!;
    if (!w.targets.includes(t.domain) || (w.pk[t.type.armor] ?? 0) < 0.02) return this.fail('its warhead cannot hurt the target');
    const range = Math.hypot(t.x - entity.x, t.y - entity.y, t.z - entity.z);
    const terminal = entity.type.unmanned?.terminalRange ?? DEFAULT_TERMINAL_RANGE;
    if (range <= terminal && engine.entities.has(t.id) && engine.losCached(entity, t)) {
      engine.unmanned.detonate(entity, t, w);
      return 'done';
    }
    // Lead a moving target by the time it takes to get there (at most 10 s).
    const lead = Math.min(10, range / Math.max(entity.type.maxSpeed, 1));
    const v = t.velocity;
    entity.steer = { x: t.x + v.x * lead, y: t.y + v.y * lead, speed: entity.type.maxSpeed, arrive: false };
    return 'running';
  }

  describe(engine: Engine): string {
    return `Strike ${engine.findEntity(this.s.targetId)?.name ?? this.s.targetId}`;
  }
}

// ---------------------------------------------------------------- loiter

/**
 * Loiter over an area (sweeping it again and again) or round a point, for a time or
 * until out of endurance; with `attack`, go for the first suitable enemy found. Members
 * of a unit start at different points of the sweep (`slot` of `slots`).
 */
export class LoiterTask extends Task {
  private tracks: Vec2[] = [];
  private index = 0;
  private elapsed = 0;
  private legs = new Legs();
  private strike: Task | null = null;
  private center?: Vec2;
  private area?: Vec2[];
  private nextPick = -Infinity;
  /** Searched the whole area (or circled for a while): lesser targets will do now. */
  private swept = false;
  private legsFlown = 0;
  /** The target it is going for. */
  aim?: string;

  constructor(readonly s: LoiterSpec) {
    super(s);
  }

  protected override start({ engine, entity }: TaskContext): void {
    if (this.s.areaId) {
      const g = engine.graphics.get(this.s.areaId);
      if (!g || g.kind !== 'area' || g.points.length < 3) {
        this.fail('not an area');
        return;
      }
      this.area = g.points;
      this.tracks = sweepTracks(g.points, trackSpacing(engine, entity));
      const n = Math.max(1, this.s.slots ?? 1);
      this.index = this.s.startIndex ?? Math.floor(((this.s.slot ?? 0) * this.tracks.length) / n);
    } else {
      this.center = this.s.center ?? { x: Math.round(entity.x), y: Math.round(entity.y) };
    }
  }

  protected tick(ctx: TaskContext): TaskStatus {
    const { engine, entity, dt } = ctx;
    this.elapsed += dt;
    if (this.s.duration !== undefined && this.elapsed >= this.s.duration) return this.end(entity, 'done');
    if (this.strike) {
      const st = this.strike.update(ctx);
      if (st === 'running') return 'running';
      this.strike = null;
      this.aim = undefined;
      if (!entity.alive) return 'done';
    }
    if (this.s.attack && engine.time >= this.nextPick && engine.unmanned.mayPickTargets(entity)) {
      this.nextPick = engine.time + PICK_INTERVAL;
      const r = this.s.radius ?? LOITER_RADIUS;
      // Lesser targets only once it has looked everywhere for a better one.
      const swept = this.swept || (!this.tracks.length && this.elapsed > SWEEP_TIME);
      const t = pickTarget(engine, entity, { prefer: this.s.prefer, area: this.area, near: this.center ? { c: this.center, r: r * 1.5 } : undefined, firstChoiceOnly: !swept });
      if (t) {
        this.aim = t.id;
        this.strike = attackTask(entity, t.id);
        engine.log('task', `${entity.name}: found ${t.name}, attacking`, entity.id, t.id);
        if (this.strike.update(ctx) === 'running') return 'running';
        this.strike = null;
        this.aim = undefined;
        if (!entity.alive) return 'done';
      }
    }
    if (this.tracks.length) {
      if (this.legs.to(ctx, this.tracks[this.index % this.tracks.length])) {
        this.index = (this.index + 1) % this.tracks.length;
        if (++this.legsFlown >= this.tracks.length) this.swept = true;
      }
    } else {
      const c = this.center!;
      const r = this.s.radius ?? LOITER_RADIUS;
      const a = Math.atan2(entity.x - c.x, entity.y - c.y) + Math.min(0.6, 400 / Math.max(r, 1));
      entity.steer = { x: c.x + Math.sin(a) * r, y: c.y + Math.cos(a) * r, speed: entity.cruiseSpeed, arrive: false };
    }
    return 'running';
  }

  private end(entity: Entity, s: TaskStatus): TaskStatus {
    this.strike?.cancel(entity);
    this.strike = null;
    return s;
  }

  override cancel(entity: Entity): void {
    this.strike?.cancel(entity);
    super.cancel(entity);
  }

  describe(engine: Engine): string {
    const where = this.s.areaId ? (engine.graphics.get(this.s.areaId)?.name ?? this.s.areaId) : `(${Math.round((this.center ?? this.s.center)?.x ?? 0)}, ${Math.round((this.center ?? this.s.center)?.y ?? 0)})`;
    const what = `Loiter over ${where}${this.s.attack ? ' and attack' : ''}`;
    return this.strike ? `${what}: ${this.strike.describe(engine)}` : what;
  }

  override resumeSpec(): TaskSpec {
    return {
      ...this.s,
      startIndex: this.tracks.length ? this.index % this.tracks.length : undefined,
      center: this.center ?? this.s.center,
      duration: this.s.duration === undefined ? undefined : Math.max(0, this.s.duration - this.elapsed),
    };
  }

  override get remainingPath(): Vec2[] {
    return this.strike ? [] : this.legs.path;
  }
}

// ---------------------------------------------------------------- swarm search

/** Waypoints of member `slot` of `slots` sharing the sweep of an area, with track lines of at most `spacing` apart. */
export function sweepShare(poly: Vec2[], spacing: number, slot?: number, slots?: number): Vec2[] {
  const n = Math.max(1, slots ?? 1);
  const xs = poly.map((p) => p.x);
  const ys = poly.map((p) => p.y);
  const alongX = Math.max(...xs) - Math.min(...xs) >= Math.max(...ys) - Math.min(...ys);
  const across = alongX ? Math.max(...ys) - Math.min(...ys) : Math.max(...xs) - Math.min(...xs);
  // At least one track line per member.
  const lines = Math.max(n, Math.round(across / spacing));
  const all = sweepTracks(poly, across / lines);
  if (slot === undefined) return all;
  const count = all.length / 2;
  const from = Math.floor((slot * count) / n);
  const to = Math.floor(((slot + 1) * count) / n);
  return all.slice(from * 2, Math.max(from + 1, to) * 2);
}

/** Swarm search: sweep its share of an area; with `attack`, strike a target found that no one else is going for. */
export class SwarmSearchTask extends Task {
  private tracks: Vec2[] = [];
  private index = 0;
  private legs = new Legs();
  private strike: Task | null = null;
  private found = new Set<string>();
  private area: Vec2[] = [];
  private nextPick = -Infinity;
  aim?: string;

  constructor(readonly s: SwarmSearchSpec) {
    super(s);
  }

  protected override start({ engine, entity }: TaskContext): void {
    const g = engine.graphics.get(this.s.areaId);
    if (!g || g.kind !== 'area' || g.points.length < 3) {
      this.fail('not an area');
      return;
    }
    this.area = g.points;
    this.tracks = sweepShare(g.points, trackSpacing(engine, entity, this.s.spacing), this.s.slot, this.s.slots);
    if (entity.domain !== 'air') this.tracks = this.tracks.filter((p) => engine.terrain.mobilityFactor(p.x, p.y, entity.moveDomain, entity.type.offroadFactor) > 0);
    this.index = Math.min(this.s.startIndex ?? 0, this.tracks.length);
    if (!this.tracks.length) this.fail('nothing to search');
  }

  protected tick(ctx: TaskContext): TaskStatus {
    const { engine, entity } = ctx;
    for (const id of entity.contacts.keys()) {
      const t = engine.entities.get(id);
      if (t && engine.isHostile(entity.force, t.force)) this.found.add(id);
    }
    if (this.strike) {
      const st = this.strike.update(ctx);
      if (st === 'running') return 'running';
      this.strike = null;
      this.aim = undefined;
      if (!entity.alive) return 'done';
    }
    if (this.s.attack && engine.time >= this.nextPick && engine.unmanned.mayPickTargets(entity)) {
      this.nextPick = engine.time + PICK_INTERVAL;
      // Each member goes for a different target; the others search on.
      const t = pickTarget(engine, entity, { prefer: this.s.prefer, area: this.area });
      if (t && claims(engine, entity, t.id) === 0) {
        this.aim = t.id;
        this.strike = attackTask(entity, t.id);
        engine.log('task', `${entity.name}: found ${t.name}, attacking`, entity.id, t.id);
        if (this.strike.update(ctx) === 'running') return 'running';
        this.strike = null;
        this.aim = undefined;
        if (!entity.alive) return 'done';
      }
    }
    while (this.index < this.tracks.length) {
      if (!this.legs.to(ctx, this.tracks[this.index])) return 'running';
      this.index++;
    }
    const unit = entity.unit;
    const others = unit ? unit.alive().filter((m) => m !== entity && m.task instanceof SwarmSearchTask && m.task.status === 'running').length : 0;
    if (!others) {
      const area = engine.graphics.get(this.s.areaId);
      const n = unit ? new Set(unit.alive().flatMap((m) => (m.task instanceof SwarmSearchTask ? [...m.task.found] : []))).size + this.found.size : this.found.size;
      engine.log('task', `${unit?.name ?? entity.name} finished searching ${area?.name ?? this.s.areaId}: ${unit ? Math.max(n, this.found.size) : n} enemy found`, unit?.id ?? entity.id);
    }
    return 'done';
  }

  override cancel(entity: Entity): void {
    this.strike?.cancel(entity);
    super.cancel(entity);
  }

  /** Enemies it has seen while searching. */
  get seen(): ReadonlySet<string> {
    return this.found;
  }

  describe(engine: Engine): string {
    const area = engine.graphics.get(this.s.areaId);
    const what = `Swarm search ${area?.name ?? this.s.areaId}${this.s.attack ? ' and attack' : ''}${this.tracks.length ? ` (${Math.min(this.index + 1, this.tracks.length)}/${this.tracks.length})` : ''}`;
    return this.strike ? `${what}: ${this.strike.describe(engine)}` : what;
  }

  override resumeSpec(): TaskSpec {
    return { ...this.s, startIndex: this.index };
  }

  override get remainingPath(): Vec2[] {
    return this.strike ? [] : [...this.legs.path, ...this.tracks.slice(this.index + 1)];
  }
}

// ---------------------------------------------------------------- swarm attack

/**
 * Distributed attack: go for the target it was given; when that one is down, take the
 * best one fewest others are going for. With an area and nothing to attack, wait over it.
 */
export class SwarmAttackTask extends Task {
  private strike: Task | null = null;
  private area?: Vec2[];
  private center?: Vec2;
  private assigned?: string;
  private legs = new Legs();
  private nextPick = -Infinity;
  aim?: string;

  constructor(readonly s: SwarmAttackSpec) {
    super(s);
    this.assigned = s.assignedId;
  }

  protected override start({ engine }: TaskContext): void {
    if (this.s.areaId) {
      const g = engine.graphics.get(this.s.areaId);
      if (!g || g.kind !== 'area' || g.points.length < 3) {
        this.fail('not an area');
        return;
      }
      this.area = g.points;
      this.center = centroid(g.points);
    }
  }

  protected tick(ctx: TaskContext): TaskStatus {
    const { engine, entity } = ctx;
    if (this.strike) {
      const st = this.strike.update(ctx);
      if (st === 'running') return 'running';
      this.strike = null;
      this.aim = undefined;
      this.assigned = undefined;
      if (!entity.alive) return 'done';
    }
    let t = this.assigned ? engine.findEntity(this.assigned) : undefined;
    if (!t || !t.alive) {
      this.assigned = undefined;
      t = undefined;
      // Targets the operator gave may be taken on without a link; new ones need it (or autonomy).
      const only = this.s.targetIds;
      if (engine.time >= this.nextPick && (only || engine.unmanned.mayPickTargets(entity))) {
        this.nextPick = engine.time + PICK_INTERVAL;
        t = pickTarget(engine, entity, { prefer: this.s.prefer, area: only ? undefined : this.area, only });
        if (!t && !this.area) return 'done';
      }
    }
    if (!t) {
      if (!this.area) return 'running';
      // Nothing to attack yet: wait over the area.
      const c = this.center!;
      if (entity.domain === 'air' && (entity.type.minSpeed ?? 0) > 0) {
        const a = Math.atan2(entity.x - c.x, entity.y - c.y) + 0.6;
        entity.steer = { x: c.x + Math.sin(a) * 500, y: c.y + Math.cos(a) * 500, speed: entity.cruiseSpeed, arrive: false };
      } else if (dist2d(entity, c) > 30) this.legs.to(ctx, c);
      else entity.steer = { x: c.x, y: c.y, speed: 0, arrive: true };
      return 'running';
    }
    this.assigned = t.id;
    this.aim = t.id;
    this.strike = attackTask(entity, t.id);
    const st = this.strike.update(ctx);
    if (st !== 'running') {
      this.strike = null;
      this.aim = undefined;
      this.assigned = undefined;
      if (!entity.alive) return 'done';
    }
    return 'running';
  }

  override cancel(entity: Entity): void {
    this.strike?.cancel(entity);
    super.cancel(entity);
  }

  describe(engine: Engine): string {
    const target = this.assigned ? engine.findEntity(this.assigned) : undefined;
    const where = this.s.areaId ? ` in ${engine.graphics.get(this.s.areaId)?.name ?? this.s.areaId}` : '';
    return target ? `Swarm attack: ${this.strike?.describe(engine) ?? `strike ${target.name}`}` : `Swarm attack${where}: looking for targets`;
  }

  override resumeSpec(): TaskSpec {
    return { ...this.s, assignedId: this.assigned };
  }
}

function centroid(points: Vec2[]): Vec2 {
  const c = points.reduce((s, p) => ({ x: s.x + p.x / points.length, y: s.y + p.y / points.length }), { x: 0, y: 0 });
  return { x: Math.round(c.x), y: Math.round(c.y) };
}

// ---------------------------------------------------------------- units

/** Swarm tasks: a unit's members each carry out their share. */
export function isSwarmTask(spec: TaskSpec): spec is LoiterSpec | SwarmSearchSpec | SwarmAttackSpec {
  return spec.type === 'loiter' || spec.type === 'swarmSearch' || spec.type === 'swarmAttack';
}

/**
 * A unit's swarm task: searches and loiters share the area out (members in order across
 * it, so their tracks do not cross); an attack spreads the members over the targets, so
 * each target gets one before any gets two, nearest member first.
 */
export function startSwarm(engine: Engine, unit: Unit, spec: LoiterSpec | SwarmSearchSpec | SwarmAttackSpec): void {
  const alive = unit.alive();
  if (spec.type === 'swarmAttack') {
    const known = new Set<string>();
    if (spec.targetIds) for (const id of spec.targetIds) known.add(id);
    else for (const m of alive) for (const c of m.contacts.values()) if (engine.time - c.lastSeen <= FRESH) known.add(c.id);
    const area = spec.areaId ? engine.graphics.get(spec.areaId)?.points : undefined;
    const c = unit.centroid();
    const targets = [...known]
      .map((id) => engine.findEntity(id))
      .filter((t): t is Entity => !!t && t.alive && !t.embarkedIn && engine.isHostile(unit.force, t.force) && (!area || spec.targetIds !== undefined || pointInPolygon(t, area)) && preferenceRank(t, spec.prefer) >= 0)
      .sort((a, b) => preferenceRank(a, spec.prefer) - preferenceRank(b, spec.prefer) || dist2d(a, c) - dist2d(b, c));
    const free = [...alive];
    const assigned = new Map<Entity, string>();
    while (free.length && targets.length) {
      let progress = false;
      for (const t of targets) {
        const able = free.filter((m) => canStrike(engine, m, t));
        if (!able.length) continue;
        const m = able.reduce((a, b) => (dist2d(a, t) <= dist2d(b, t) ? a : b));
        assigned.set(m, t.id);
        free.splice(free.indexOf(m), 1);
        progress = true;
        if (!free.length) break;
      }
      if (!progress) break;
    }
    for (const m of alive) engine.setEntityTask(m, new SwarmAttackTask({ ...spec, assignedId: assigned.get(m) }));
    return;
  }
  const g = spec.areaId ? engine.graphics.get(spec.areaId) : undefined;
  let order = alive;
  if (g && g.points.length >= 3) {
    const xs = g.points.map((p) => p.x);
    const ys = g.points.map((p) => p.y);
    const alongX = Math.max(...xs) - Math.min(...xs) >= Math.max(...ys) - Math.min(...ys);
    order = [...alive].sort((a, b) => (alongX ? a.y - b.y : a.x - b.x));
  }
  order.forEach((m, i) => {
    const own = { ...spec, slot: i, slots: order.length, startIndex: undefined };
    engine.setEntityTask(m, spec.type === 'loiter' ? new LoiterTask(own as LoiterSpec) : new SwarmSearchTask(own as SwarmSearchSpec));
  });
}

registerTask('strike', (s) => new StrikeTask(s as StrikeSpec));
registerTask('loiter', (s) => new LoiterTask(s as LoiterSpec));
registerTask('swarmSearch', (s) => new SwarmSearchTask(s as SwarmSearchSpec));
registerTask('swarmAttack', (s) => new SwarmAttackTask(s as SwarmAttackSpec));
