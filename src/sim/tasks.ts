// Tasks: the atomic behaviours an entity (or a unit's leader) executes.
// Each task produces a steering command per tick and reports running/done/failed.

import { bearing, dist2d, rotateOffset } from '../shared/math.js';
import type { TaskSpec, Vec2, WeaponDef } from '../shared/types.js';
import type { Engine } from './engine.js';
import { fireIndirect } from './combat.js';
import type { Entity } from './entity.js';

export type TaskStatus = 'running' | 'done' | 'failed';

export interface TaskContext {
  engine: Engine;
  entity: Entity;
  dt: number;
}

export abstract class Task {
  status: TaskStatus = 'running';
  message?: string;
  private started = false;

  constructor(readonly spec: TaskSpec) {}

  update(ctx: TaskContext): TaskStatus {
    if (this.status !== 'running') return this.status;
    if (!this.started) {
      this.started = true;
      this.start(ctx);
      if (this.status !== 'running') return this.status;
    }
    this.status = this.tick(ctx);
    return this.status;
  }

  /** Called when the task is replaced or the entity is destroyed. */
  cancel(entity: Entity): void {
    entity.steer = null;
  }

  protected fail(message: string): TaskStatus {
    this.message = message;
    this.status = 'failed';
    return 'failed';
  }

  protected start(_ctx: TaskContext): void {}
  protected abstract tick(ctx: TaskContext): TaskStatus;
  abstract describe(engine: Engine): string;

  /** Remaining planned waypoints, for display. */
  get remainingPath(): Vec2[] {
    return [];
  }

  /** A spec that resumes this task from where it is now (used by checkpoints). */
  resumeSpec(): TaskSpec {
    return this.spec;
  }
}

function arriveRadius(e: Entity): number {
  if (e.domain === 'air') return (e.type.minSpeed ?? 0) > 0 ? Math.max(300, e.speed * 3) : 40;
  if (e.domain === 'surface') return 40;
  return e.domain === 'lifeform' ? 3 : 8;
}

/** Follows planned waypoints toward a goal, replanning when blocked. */
class PathFollower {
  private waypoints: Vec2[] = [];
  private index = 0;
  private blockedTime = 0;
  goal: Vec2 | null = null;

  plan(e: Entity, engine: Engine, goal: Vec2): boolean {
    this.goal = { ...goal };
    const route = engine.planRoute(e, goal, e.domain, e.type.offroadFactor, e.force);
    if (!route) return false;
    this.waypoints = route;
    this.index = 0;
    this.blockedTime = 0;
    return true;
  }

  get remaining(): Vec2[] {
    return this.waypoints.slice(this.index);
  }

  /** Steers along the path. Returns true when the final waypoint is reached. */
  step(e: Entity, engine: Engine, dt: number, speed: number, arrive = true): boolean {
    if (!this.goal) return true;
    const r = arriveRadius(e);
    while (this.index < this.waypoints.length - 1 && dist2d(e, this.waypoints[this.index]) < r * 2.5) this.index++;
    const wp = this.waypoints[this.index];
    if (!wp) return true;
    const last = this.index === this.waypoints.length - 1;
    const d = dist2d(e, wp);
    if (last && d < r && (!arrive || e.domain === 'air' || e.speed < 0.5)) {
      e.steer = arrive ? { x: wp.x, y: wp.y, speed: 0, arrive: true } : null;
      return true;
    }
    e.steer = { x: wp.x, y: wp.y, speed, arrive: last && arrive };
    if (e.blocked) {
      this.blockedTime += dt;
      if (this.blockedTime > 3 && this.goal) {
        if (!this.plan(e, engine, this.goal)) return true;
      }
    } else {
      this.blockedTime = 0;
    }
    return false;
  }
}

export class MoveToTask extends Task {
  private path = new PathFollower();

  constructor(readonly target: Vec2, readonly speed?: number) {
    super({ type: 'moveTo', target, speed });
  }

  protected override start({ engine, entity }: TaskContext): void {
    if (!this.path.plan(entity, engine, this.target)) this.fail('no route to destination');
  }

  protected tick({ engine, entity, dt }: TaskContext): TaskStatus {
    return this.path.step(entity, engine, dt, this.speed ?? entity.cruiseSpeed) ? 'done' : 'running';
  }

  describe(): string {
    return `Move to (${Math.round(this.target.x)}, ${Math.round(this.target.y)})`;
  }

  override get remainingPath(): Vec2[] {
    return this.path.remaining;
  }
}

export class FollowRouteTask extends Task {
  private path = new PathFollower();
  private points: Vec2[] = [];
  private index = 0;
  private direction = 1;

  constructor(
    readonly routeId: string,
    readonly speed: number | undefined,
    readonly reverse: boolean,
    readonly loop: boolean,
    readonly startIndex?: number,
  ) {
    super(loop ? { type: 'patrol', routeId, speed } : { type: 'followRoute', routeId, speed, reverse, startIndex });
  }

  override resumeSpec(): TaskSpec {
    return this.loop ? this.spec : { type: 'followRoute', routeId: this.routeId, speed: this.speed, reverse: this.reverse, startIndex: this.index };
  }

  protected override start({ engine, entity }: TaskContext): void {
    const g = engine.graphics.get(this.routeId);
    if (!g || g.points.length === 0) {
      this.fail(`route ${this.routeId} not found`);
      return;
    }
    this.points = this.reverse ? [...g.points].reverse() : [...g.points];
    // Join the route at the nearest point when patrolling, at the start otherwise.
    if (this.startIndex !== undefined) this.index = Math.max(0, Math.min(this.points.length - 1, this.startIndex));
    else if (this.loop) {
      let best = 0;
      for (let i = 1; i < this.points.length; i++) if (dist2d(entity, this.points[i]) < dist2d(entity, this.points[best])) best = i;
      this.index = best;
    }
    if (!this.path.plan(entity, engine, this.points[this.index])) this.fail('no route to first waypoint');
  }

  protected tick({ engine, entity, dt }: TaskContext): TaskStatus {
    const lastLeg = !this.loop && this.index === this.points.length - 1;
    const arrived = this.path.step(entity, engine, dt, this.speed ?? entity.cruiseSpeed, lastLeg);
    if (!arrived) return 'running';
    if (lastLeg) return 'done';
    this.index += this.direction;
    if (this.loop) {
      const closed = this.points.length > 2 && dist2d(this.points[0], this.points[this.points.length - 1]) < 50;
      if (this.index >= this.points.length) {
        if (closed) this.index = 1;
        else {
          this.direction = -1;
          this.index = this.points.length - 2;
        }
      } else if (this.index < 0) {
        this.direction = 1;
        this.index = 1;
      }
      this.index = Math.max(0, Math.min(this.points.length - 1, this.index));
    }
    if (!this.path.plan(entity, engine, this.points[this.index])) return this.fail('no route to next waypoint');
    return 'running';
  }

  override get remainingPath(): Vec2[] {
    const rest = this.loop ? [] : this.points.slice(this.index + 1);
    return [...this.path.remaining, ...rest];
  }

  describe(engine: Engine): string {
    const name = engine.graphics.get(this.routeId)?.name ?? this.routeId;
    const total = this.points.length || engine.graphics.get(this.routeId)?.points.length || 0;
    return `${this.loop ? 'Patrol' : 'Follow route'} ${name} (wp ${this.index + 1}/${total})`;
  }
}

export class WaitTask extends Task {
  private elapsed = 0;

  constructor(readonly duration: number) {
    super({ type: 'wait', duration });
  }

  protected tick({ entity, dt }: TaskContext): TaskStatus {
    entity.steer = null;
    this.elapsed += dt;
    return this.elapsed >= this.duration ? 'done' : 'running';
  }

  describe(): string {
    return `Wait ${Math.max(0, Math.ceil(this.duration - this.elapsed))}s`;
  }

  override resumeSpec(): TaskSpec {
    return { type: 'wait', duration: Math.max(0, this.duration - this.elapsed) };
  }
}

export class FollowEntityTask extends Task {
  private path = new PathFollower();
  private replanIn = 0;

  constructor(readonly targetId: string, readonly distance = 50) {
    super({ type: 'follow', targetId, distance });
  }

  protected tick({ engine, entity, dt }: TaskContext): TaskStatus {
    const target = engine.entities.get(this.targetId);
    if (!target || target.destroyed) return 'done';
    const back = rotateOffset({ x: 0, y: -this.distance }, target.heading);
    const goal = { x: target.x + back.x, y: target.y + back.y };
    const d = dist2d(entity, goal);
    const speed = Math.min(entity.type.maxSpeed, Math.max(target.speed * (d > this.distance ? 1.3 : 1), d > 20 ? entity.cruiseSpeed : 0));
    if (entity.domain === 'air' || d < 300) {
      entity.steer = { x: goal.x, y: goal.y, speed, arrive: target.speed < 0.5, finalHeading: target.heading };
      return 'running';
    }
    this.replanIn -= dt;
    if (this.replanIn <= 0) {
      this.replanIn = 5;
      this.path.plan(entity, engine, goal);
    }
    this.path.step(entity, engine, dt, speed, false);
    return 'running';
  }

  describe(engine: Engine): string {
    return `Follow ${engine.entities.get(this.targetId)?.name ?? this.targetId}`;
  }
}

/** Best weapon against a target: highest kill probability among those with ammo. */
export function bestWeaponAgainst(engine: Engine, shooter: Entity, target: Entity): WeaponDef | undefined {
  let best: WeaponDef | undefined;
  let bestPk = 0;
  for (const wid of shooter.type.weapons) {
    if ((shooter.ammo.get(wid) ?? 0) <= 0) continue;
    const w = engine.catalog.weapon(wid);
    if (w.indirect || !w.targets.includes(target.domain)) continue;
    const pk = w.pk[target.type.armor] ?? 0;
    if (pk > bestPk) {
      bestPk = pk;
      best = w;
    }
  }
  return best;
}

export class AttackTask extends Task {
  private path = new PathFollower();
  private replanIn = 0;

  constructor(readonly targetId: string) {
    super({ type: 'attack', targetId });
  }

  protected override start({ entity }: TaskContext): void {
    entity.attackTargetId = this.targetId;
  }

  override cancel(entity: Entity): void {
    super.cancel(entity);
    if (entity.attackTargetId === this.targetId) entity.attackTargetId = undefined;
  }

  protected tick({ engine, entity, dt }: TaskContext): TaskStatus {
    const target = engine.entities.get(this.targetId);
    if (!target || target.destroyed) {
      this.cancel(entity);
      return 'done';
    }
    entity.attackTargetId = this.targetId;
    const weapon = bestWeaponAgainst(engine, entity, target);
    if (!weapon) {
      this.cancel(entity);
      return this.fail('no weapon can engage the target');
    }
    const d = dist2d(entity, target);
    const standoff = weapon.maxRange * 0.8;
    const los = engine.losCached(entity, target);
    if (d <= standoff && d >= weapon.minRange && los) {
      // In a firing position: hold (fixed wing keeps flying past and comes around).
      if ((entity.type.minSpeed ?? 0) > 0) entity.steer = { x: target.x, y: target.y, speed: entity.cruiseSpeed, arrive: false };
      else entity.steer = { x: entity.x, y: entity.y, speed: 0, arrive: true, finalHeading: bearing(entity, target) };
      return 'running';
    }
    if (entity.domain === 'air') {
      entity.steer = { x: target.x, y: target.y, speed: entity.cruiseSpeed, arrive: false };
      return 'running';
    }
    this.replanIn -= dt;
    if (this.replanIn <= 0) {
      this.replanIn = 10;
      if (!this.path.plan(entity, engine, target)) {
        this.cancel(entity);
        return this.fail('no route to target');
      }
    }
    this.path.step(entity, engine, dt, entity.cruiseSpeed, true);
    return 'running';
  }

  override get remainingPath(): Vec2[] {
    return this.path.remaining;
  }

  describe(engine: Engine): string {
    return `Attack ${engine.entities.get(this.targetId)?.name ?? this.targetId}`;
  }
}

export class OrbitTask extends Task {
  private elapsed = 0;

  constructor(readonly center: Vec2, readonly radius: number, readonly duration?: number) {
    super({ type: 'orbit', center, radius, duration });
  }

  protected tick({ entity, dt }: TaskContext): TaskStatus {
    this.elapsed += dt;
    if (this.duration !== undefined && this.elapsed >= this.duration) return 'done';
    const angle = Math.atan2(entity.x - this.center.x, entity.y - this.center.y);
    const lead = Math.min(0.6, 400 / Math.max(this.radius, 1));
    const a = angle + lead;
    const target = { x: this.center.x + Math.sin(a) * this.radius, y: this.center.y + Math.cos(a) * this.radius };
    entity.steer = { x: target.x, y: target.y, speed: entity.cruiseSpeed, arrive: false };
    return 'running';
  }

  describe(): string {
    return `Orbit (${Math.round(this.center.x)}, ${Math.round(this.center.y)}) r=${Math.round(this.radius)}m`;
  }

  override resumeSpec(): TaskSpec {
    return { type: 'orbit', center: this.center, radius: this.radius, duration: this.duration === undefined ? undefined : Math.max(0, this.duration - this.elapsed) };
  }
}

/** Unit subordinate behaviour: hold the assigned slot relative to the unit leader. */
export class FormationTask extends Task {
  constructor(readonly leaderId: string) {
    super({ type: 'formation', leaderId });
  }

  protected tick({ engine, entity }: TaskContext): TaskStatus {
    const unit = entity.unit;
    const leader = engine.entities.get(this.leaderId);
    if (!unit || !leader || leader.destroyed) return 'done';
    const slot = unit.slotPosition(entity, leader);
    const d = dist2d(entity, slot);
    const catchUp = d > 15 ? Math.min(entity.type.maxSpeed, leader.speed * 1.2 + d * 0.05) : leader.speed;
    const speed = Math.max(catchUp, d > 15 ? Math.min(entity.cruiseSpeed, entity.type.maxSpeed) * 0.5 : 0);
    const stopped = leader.speed < 0.5;
    entity.steer = { x: slot.x, y: slot.y, speed, arrive: stopped, finalHeading: leader.heading };
    // If terrain blocks the slot, fall in behind the leader instead.
    if (entity.blocked) entity.steer = { x: leader.x, y: leader.y, speed, arrive: true };
    return 'running';
  }

  describe(engine: Engine): string {
    return `In formation on ${engine.entities.get(this.leaderId)?.name ?? this.leaderId}`;
  }
}

export const DEFAULT_MISSION_ROUNDS = 3;
/** Seconds to lay the weapon on a new target before the first round. */
export const LAY_TIME = 20;

/** Indirect-fire weapon (with ammunition) that can reach a point from where the entity is. */
export function indirectWeaponFor(engine: Engine, e: Entity, target: Vec2, weaponId?: string): WeaponDef | undefined {
  const d = dist2d(e, target);
  for (const wid of e.type.weapons) {
    if (weaponId && wid !== weaponId) continue;
    const w = engine.catalog.weapon(wid);
    if (!w.indirect || (e.ammo.get(wid) ?? 0) <= 0) continue;
    if (d >= w.minRange && d <= w.maxRange) return w;
  }
  return undefined;
}

/** Halt, lay on the target, then fire a number of indirect-fire rounds at it. */
export class FireMissionTask extends Task {
  private fired = 0;
  private laidAt?: number;
  readonly rounds: number;

  constructor(readonly mission: Extract<TaskSpec, { type: 'fireMission' }>) {
    super(mission);
    this.rounds = Math.max(1, Math.round(mission.rounds ?? DEFAULT_MISSION_ROUNDS));
  }

  protected tick({ engine, entity }: TaskContext): TaskStatus {
    entity.steer = { x: entity.x, y: entity.y, speed: 0, arrive: true };
    if (entity.firepowerKill) return this.fail('weapon out of action');
    const w = indirectWeaponFor(engine, entity, this.mission.target, this.mission.weaponId);
    if (w && this.mission.smoke && !w.smoke) return this.fail('no smoke rounds for this weapon');
    if (!w) {
      if (this.fired > 0) return 'done';
      const any = entity.type.weapons.map((id) => engine.catalog.weapon(id)).filter((x) => x.indirect && (!this.mission.weaponId || x.id === this.mission.weaponId));
      if (any.length === 0) return this.fail('no indirect-fire weapon');
      if (any.every((x) => (entity.ammo.get(x.id) ?? 0) <= 0)) return this.fail('out of ammunition');
      return this.fail('target out of range');
    }
    // Lay the weapon once stopped.
    if (entity.speed > 0.5) return 'running';
    this.laidAt ??= engine.time + LAY_TIME;
    if (engine.time < this.laidAt || (entity.weaponReadyAt.get(w.id) ?? 0) > engine.time) return 'running';
    // Spread the sheaf: rounds land at random points within the mission radius.
    const r = this.mission.radius ?? 0;
    let point = this.mission.target;
    if (r > 0) {
      const a = engine.rng.range(0, Math.PI * 2);
      const d = r * Math.sqrt(engine.rng.next());
      point = { x: point.x + Math.sin(a) * d, y: point.y + Math.cos(a) * d };
    }
    fireIndirect(engine, entity, w, point, this.mission.smoke);
    this.fired++;
    return this.fired >= this.rounds ? 'done' : 'running';
  }

  describe(): string {
    const t = this.mission.target;
    const at = `${this.mission.smoke ? 'Smoke mission' : 'Fire mission'} at (${Math.round(t.x)}, ${Math.round(t.y)})`;
    return this.fired === 0 ? `${at}, ${this.rounds} round${this.rounds > 1 ? 's' : ''}` : `${at}: ${this.fired}/${this.rounds} fired`;
  }

  override resumeSpec(): TaskSpec {
    return { ...this.mission, rounds: this.rounds - this.fired };
  }
}

/** Walk to a carrier and board it. A unit id as carrier picks the nearest member with a free seat. */
export class MountTask extends Task {
  private path = new PathFollower();
  private replanIn = 0;
  /** The carrier entity actually boarding (resolved from a unit id at start). */
  carrier?: string;

  constructor(readonly carrierId: string) {
    super({ type: 'mount', carrierId });
  }

  protected override start({ engine, entity }: TaskContext): void {
    if (entity.domain !== 'lifeform') {
      this.fail('only dismounted infantry can mount');
      return;
    }
    const unit = engine.units.get(this.carrierId);
    const candidates = unit ? unit.alive() : [engine.entities.get(this.carrierId)].filter((c): c is Entity => !!c);
    const free = candidates.filter((c) => c.alive && c !== entity && engine.freeSeats(c, entity) > 0).sort((a, b) => dist2d(entity, a) - dist2d(entity, b));
    if (free.length === 0) {
      this.fail(candidates.some((c) => (c.type.capacity ?? 0) > 0) ? 'no free seats' : 'not a carrier');
      return;
    }
    this.carrier = free[0].id;
  }

  protected tick({ engine, entity, dt }: TaskContext): TaskStatus {
    const c = this.carrier ? engine.entities.get(this.carrier) : undefined;
    if (!c || c.destroyed) return this.fail('carrier destroyed');
    if (engine.freeSeats(c, entity) <= 0) return this.fail(`${c.name} is full`);
    const d = dist2d(entity, c);
    const landed = c.domain !== 'air' || c.z - engine.terrain.surfaceHeight(c.x, c.y) < 5;
    if (d <= 20 && c.speed < 1 && landed) {
      engine.embark(entity, c);
      return 'done';
    }
    if (d < 300) {
      entity.steer = { x: c.x, y: c.y, speed: entity.cruiseSpeed, arrive: true };
      return 'running';
    }
    this.replanIn -= dt;
    if (this.replanIn <= 0) {
      this.replanIn = 10;
      this.path.plan(entity, engine, c);
    }
    this.path.step(entity, engine, dt, entity.cruiseSpeed, true);
    return 'running';
  }

  describe(engine: Engine): string {
    return `Mount ${engine.entities.get(this.carrier ?? this.carrierId)?.name ?? engine.units.get(this.carrierId)?.name ?? this.carrierId}`;
  }

  override resumeSpec(): TaskSpec {
    return { type: 'mount', carrierId: this.carrier ?? this.carrierId };
  }

  override get remainingPath(): Vec2[] {
    return this.path.remaining;
  }
}

/** Stop (helicopters land) and let every passenger out. */
export class DismountTask extends Task {
  constructor() {
    super({ type: 'dismount' });
  }

  protected tick({ engine, entity }: TaskContext): TaskStatus {
    entity.steer = { x: entity.x, y: entity.y, speed: 0, arrive: true };
    if (entity.speed > 0.5) return 'running';
    if (entity.domain === 'air' && entity.z - engine.terrain.surfaceHeight(entity.x, entity.y) > 5) {
      // Helicopters set down first (fixed-wing aircraft cannot hover to land).
      if ((entity.type.minSpeed ?? 0) > 0) return this.fail('fixed-wing aircraft cannot land to dismount');
      entity.altitudeOverride = 0;
      return 'running';
    }
    engine.dismountAll(entity);
    return 'done';
  }

  describe(): string {
    return 'Dismount passengers';
  }
}

/** Engineers: move up to a minefield or obstacle and breach a lane through it. */
export class BreachTask extends Task {
  private path = new PathFollower();
  private replanIn = 0;
  private site?: Vec2;
  /** Seconds of breaching work done. */
  work = 0;

  constructor(readonly graphicId: string) {
    super({ type: 'breach', graphicId });
  }

  protected override start({ engine, entity }: TaskContext): void {
    const g = engine.graphics.get(this.graphicId);
    if (!entity.type.breachTime) this.fail('not an engineer');
    else if (!g || (g.kind !== 'minefield' && g.kind !== 'obstacle')) this.fail('not a minefield or obstacle');
  }

  protected tick({ engine, entity, dt }: TaskContext): TaskStatus {
    const g = engine.graphics.get(this.graphicId);
    if (!g) return this.fail('obstacle removed');
    if (!this.site) {
      // Work from just outside the edge nearest to where the engineers are.
      const edge = engine.obstacles.nearestEdge(g, entity);
      const d = dist2d(entity, edge);
      this.site = d < 15 ? { x: entity.x, y: entity.y } : { x: edge.x + ((entity.x - edge.x) / d) * 12, y: edge.y + ((entity.y - edge.y) / d) * 12 };
    }
    if (dist2d(entity, this.site) > 10) {
      this.replanIn -= dt;
      if (this.replanIn <= 0) {
        this.replanIn = 15;
        if (!this.path.plan(entity, engine, this.site)) return this.fail('no route to the obstacle');
      }
      this.path.step(entity, engine, dt, entity.cruiseSpeed, true);
      return 'running';
    }
    entity.steer = { x: entity.x, y: entity.y, speed: 0, arrive: true };
    // Work goes slowly under fire.
    this.work += dt * (1 - 0.8 * entity.suppression);
    if (this.work < entity.type.breachTime!) return 'running';
    engine.obstacles.breach(g, entity);
    engine.log('task', `${entity.name} breached a lane through ${g.name}`, entity.id);
    return 'done';
  }

  describe(engine: Engine): string {
    const g = engine.graphics.get(this.graphicId);
    return `Breach ${g?.name ?? this.graphicId}${this.work > 0 ? `: ${Math.round(this.work)} s of work` : ''}`;
  }

  override get remainingPath(): Vec2[] {
    return this.path.remaining;
  }
}

export function createTask(spec: TaskSpec): Task {
  switch (spec.type) {
    case 'moveTo':
      return new MoveToTask(spec.target, spec.speed);
    case 'followRoute':
      return new FollowRouteTask(spec.routeId, spec.speed, spec.reverse ?? false, false, spec.startIndex);
    case 'patrol':
      return new FollowRouteTask(spec.routeId, spec.speed, false, true);
    case 'wait':
      return new WaitTask(spec.duration);
    case 'follow':
      return new FollowEntityTask(spec.targetId, spec.distance);
    case 'attack':
      return new AttackTask(spec.targetId);
    case 'orbit':
      return new OrbitTask(spec.center, spec.radius, spec.duration);
    case 'formation':
      return new FormationTask(spec.leaderId);
    case 'fireMission':
      return new FireMissionTask(spec);
    case 'mount':
      return new MountTask(spec.carrierId);
    case 'dismount':
      return new DismountTask();
    case 'breach':
      return new BreachTask(spec.graphicId);
  }
}
