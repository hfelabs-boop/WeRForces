// Tasks: the atomic behaviours an entity (or a unit's leader) executes.
// Each task produces a steering command per tick and reports running/done/failed.

import { bearing, dist2d, pointInPolygon, rotateOffset } from '../shared/math.js';
import type { TaskSpec, Vec2, WeaponDef } from '../shared/types.js';
import type { Engine } from './engine.js';
import { fireIndirect } from './combat.js';
import type { Entity } from './entity.js';
import { sensorRange } from './environment.js';
import { needsSupply, RESUPPLY_RANGE, suppliersFor } from './supply.js';

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

/** Seconds between replans of a covered route. */
const COVERED_REPLAN = 15;

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
  /** Obstacles version the path was planned with: replan when lanes or known minefields change. */
  private obstacles = -1;
  goal: Vec2 | null = null;

  /** `covered`: route away from known enemies' fields of fire. */
  constructor(readonly covered = false) {}

  plan(e: Entity, engine: Engine, goal: Vec2): boolean {
    this.goal = { ...goal };
    const route = engine.planRoute(e, goal, e.domain, e.type.offroadFactor, e.force, this.covered);
    this.obstacles = engine.obstacles.version;
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
    if (this.obstacles !== engine.obstacles.version && e.domain !== 'air' && e.domain !== 'surface') {
      // A lane was breached, or a minefield found: the best way may have changed.
      if (!this.plan(e, engine, this.goal)) return true;
    }
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
  private path: PathFollower;
  private replanIn = COVERED_REPLAN;

  constructor(readonly target: Vec2, readonly speed?: number, readonly covered = false) {
    super({ type: 'moveTo', target, speed, covered: covered || undefined });
    this.path = new PathFollower(covered);
  }

  protected override start({ engine, entity }: TaskContext): void {
    if (!this.path.plan(entity, engine, this.target)) this.fail('no route to destination');
  }

  protected tick({ engine, entity, dt }: TaskContext): TaskStatus {
    if (this.covered && entity.domain !== 'air') {
      // New contacts change where it is safe to go.
      this.replanIn -= dt;
      if (this.replanIn <= 0) {
        this.replanIn = COVERED_REPLAN;
        this.path.plan(entity, engine, this.target);
      }
    }
    return this.path.step(entity, engine, dt, this.speed ?? entity.cruiseSpeed) ? 'done' : 'running';
  }

  describe(): string {
    return `Move to (${Math.round(this.target.x)}, ${Math.round(this.target.y)})${this.covered ? ' by a covered route' : ''}`;
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
  /** Around minefields and obstacles: a planned path to the slot, through lanes. */
  private detour: PathFollower | null = null;
  private detourTo?: Vec2;
  private detourAge = 0;

  constructor(readonly leaderId: string) {
    super({ type: 'formation', leaderId });
  }

  protected tick({ engine, entity, dt }: TaskContext): TaskStatus {
    const unit = entity.unit;
    const leader = engine.entities.get(this.leaderId);
    if (!unit || !leader || leader.destroyed) return 'done';
    const slot = unit.slotPosition(entity, leader);
    const d = dist2d(entity, slot);
    const catchUp = d > 15 ? Math.min(entity.type.maxSpeed, leader.speed * 1.2 + d * 0.05) : leader.speed;
    const speed = Math.max(catchUp, d > 15 ? Math.min(entity.cruiseSpeed, entity.type.maxSpeed) * 0.5 : 0);
    const stopped = leader.speed < 0.5;
    // Straight to the slot, unless an obstacle or a known minefield is in the way.
    if (engine.obstacles.any && d > 15 && engine.obstacles.barrierBetween(entity, slot, entity.force, entity.domain)) {
      this.detourAge += dt;
      if (!this.detour || !this.detourTo || dist2d(this.detourTo, slot) > 60 || this.detourAge > 10) {
        this.detour = new PathFollower();
        this.detourTo = { ...slot };
        this.detourAge = 0;
        if (!this.detour.plan(entity, engine, slot)) this.detour = null;
      }
      if (this.detour) {
        this.detour.step(entity, engine, dt, Math.max(speed, entity.cruiseSpeed * 0.6), stopped);
        return 'running';
      }
    } else this.detour = null;
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
    // Engineers sent to clear a minefield know it is there, and so does their side.
    else if (g.kind === 'minefield') engine.obstacles.reveal(g, entity.force);
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

/** Go to a friendly supply vehicle, halt beside it and take on fuel and ammunition. */
export class ResupplyTask extends Task {
  private path = new PathFollower();
  private replanIn = 0;
  private plannedTo?: Vec2;

  constructor(private supplierId?: string) {
    super({ type: 'resupply', supplierId });
  }

  protected override start({ engine, entity }: TaskContext): void {
    if (entity.domain === 'air' || entity.domain === 'surface') {
      this.fail('only ground vehicles and troops resupply in the field');
    } else if (this.supplierId) {
      const s = engine.entities.get(this.supplierId);
      if (!s || !s.type.supply) this.fail('not a supply vehicle');
      else if (s.force !== entity.force) this.fail('not a friendly supply vehicle');
    } else {
      // The nearest supply vehicle with something left.
      let best: Entity | undefined;
      for (const s of suppliersFor(engine, entity)) if (s !== entity && (!best || dist2d(entity, s) < dist2d(entity, best))) best = s;
      if (best) this.supplierId = best.id;
      else this.fail('no supply vehicle with stock left');
    }
  }

  protected tick({ engine, entity, dt }: TaskContext): TaskStatus {
    if (!needsSupply(engine, entity)) return 'done';
    const s = this.supplierId ? engine.entities.get(this.supplierId) : undefined;
    if (!s || s.destroyed) return this.fail('supply vehicle lost');
    if (s.supplies <= 1e-6) return this.fail(`${s.name} has run out of supplies`);
    const d = dist2d(entity, s);
    if (d <= RESUPPLY_RANGE * 0.6) {
      // Close enough: halt; supplies flow once both have stopped.
      entity.steer = { x: entity.x, y: entity.y, speed: 0, arrive: true };
      return 'running';
    }
    // Pull up 20 m short, on this side of it.
    const goal = { x: s.x + ((entity.x - s.x) / d) * 20, y: s.y + ((entity.y - s.y) / d) * 20 };
    this.replanIn -= dt;
    if (this.replanIn <= 0 || !this.plannedTo || dist2d(this.plannedTo, goal) > 30) {
      this.replanIn = 15;
      this.plannedTo = goal;
      if (!this.path.plan(entity, engine, goal)) return this.fail('no route to the supply vehicle');
    }
    this.path.step(entity, engine, dt, entity.cruiseSpeed, true);
    return 'running';
  }

  describe(engine: Engine): string {
    const s = this.supplierId ? engine.entities.get(this.supplierId) : undefined;
    return `Resupply${s ? ` from ${s.name}` : ''}`;
  }

  override resumeSpec(): TaskSpec {
    return { type: 'resupply', supplierId: this.supplierId };
  }

  override get remainingPath(): Vec2[] {
    return this.path.remaining;
  }
}

export function createTask(spec: TaskSpec): Task {
  switch (spec.type) {
    case 'moveTo':
      return new MoveToTask(spec.target, spec.speed, spec.covered);
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
    case 'resupply':
      return new ResupplyTask(spec.supplierId);
    case 'overwatch':
      return new OverwatchTask(spec);
    case 'defend':
      return new DefendTask(spec);
    case 'ambush':
      return new AmbushTask(spec);
    case 'screen':
      return new ScreenTask(spec);
    case 'search':
      return new SearchTask(spec);
  }
}

// ---------------------------------------------------------------- tactical tasks

/** Seconds holding still before infantry are dug in / vehicles hull-down. */
export const PREPARE_TIME = { lifeform: 90, vehicle: 30 };

/** Bearing in radians from degrees, or undefined. */
function facingOf(deg: number | undefined): number | undefined {
  return deg === undefined ? undefined : (deg * Math.PI) / 180;
}

/**
 * Move to a position, then hold it facing a direction. After holding still for a while
 * the entity is in a prepared position (dug in, or hull-down), harder to see and hit.
 */
abstract class HoldPositionTask extends Task {
  protected path = new PathFollower();
  protected arrived = false;
  protected heldFor = 0;
  /** Radians; the direction of the move when not given. */
  protected facing?: number;

  constructor(spec: TaskSpec, readonly position: Vec2, facingDeg?: number) {
    super(spec);
    this.facing = facingOf(facingDeg);
  }

  protected override start({ engine, entity }: TaskContext): void {
    if (this.facing === undefined) this.facing = dist2d(entity, this.position) > 5 ? bearing(entity, this.position) : entity.heading;
    if (dist2d(entity, this.position) <= arriveRadius(entity) * 2) this.arrived = true;
    else if (!this.path.plan(entity, engine, this.position)) this.fail('no route to the position');
  }

  /** Steps the move or the hold; true while holding the position. */
  protected hold({ engine, entity, dt }: TaskContext, speed = entity.cruiseSpeed): boolean {
    if (!this.arrived) {
      if (this.path.step(entity, engine, dt, speed)) this.arrived = true;
      else return false;
    }
    entity.steer = { x: entity.x, y: entity.y, speed: 0, arrive: true, finalHeading: this.facing };
    if (entity.domain === 'air' || entity.domain === 'surface') return true;
    if (entity.speed < 0.3) this.heldFor += dt;
    else this.heldFor = 0;
    if (!entity.prepared) {
      const need = entity.domain === 'lifeform' ? PREPARE_TIME.lifeform : PREPARE_TIME.vehicle;
      if (this.heldFor >= need) entity.prepared = entity.domain === 'lifeform' ? 'dugIn' : 'hullDown';
    }
    return true;
  }

  override cancel(entity: Entity): void {
    super.cancel(entity);
    entity.prepared = undefined;
  }

  override get remainingPath(): Vec2[] {
    return this.arrived ? [] : this.path.remaining;
  }

  protected where(): string {
    return `(${Math.round(this.position.x)}, ${Math.round(this.position.y)})`;
  }
}

/** Support by fire: take a position and watch (and engage) toward a direction. */
export class OverwatchTask extends HoldPositionTask {
  private watched = 0;

  constructor(readonly s: Extract<TaskSpec, { type: 'overwatch' }>) {
    super(s, s.position, s.facing);
  }

  protected tick(ctx: TaskContext): TaskStatus {
    if (!this.hold(ctx)) return 'running';
    this.watched += ctx.dt;
    return this.s.duration !== undefined && this.watched >= this.s.duration ? 'done' : 'running';
  }

  describe(): string {
    return `Overwatch from ${this.where()}${this.arrived ? '' : ' (moving)'}`;
  }
}

/** Defend a position: hold it, dig in, and fight from it without chasing. */
export class DefendTask extends HoldPositionTask {
  constructor(readonly s: Extract<TaskSpec, { type: 'defend' }>) {
    super(s, s.position, s.facing);
  }

  protected tick(ctx: TaskContext): TaskStatus {
    this.hold(ctx);
    return 'running';
  }

  describe(): string {
    return `Defend ${this.where()}${this.arrived ? '' : ' (moving)'}`;
  }
}

/**
 * Ambush: take a position with weapons tight, and open fire all at once when an enemy
 * enters the kill zone (or the ambush is discovered).
 */
export class AmbushTask extends HoldPositionTask {
  sprung = false;

  constructor(readonly s: Extract<TaskSpec, { type: 'ambush' }>) {
    super(s, s.position, s.facing);
  }

  protected override start(ctx: TaskContext): void {
    const zone = ctx.engine.graphics.get(this.s.killZoneId);
    if (!zone || zone.kind !== 'area' || zone.points.length < 3) {
      this.fail('the kill zone must be an area');
      return;
    }
    if (this.facing === undefined) {
      const c = zone.points.reduce((s, p) => ({ x: s.x + p.x / zone.points.length, y: s.y + p.y / zone.points.length }), { x: 0, y: 0 });
      this.facing = bearing(this.position, c);
    }
    super.start(ctx);
    if (this.s.sprung) this.sprung = true;
    ctx.entity.roe = this.sprung ? 'fireAtWill' : 'holdFire';
  }

  protected tick(ctx: TaskContext): TaskStatus {
    const { engine, entity } = ctx;
    this.hold(ctx);
    if (this.sprung) return 'running';
    const zone = engine.graphics.get(this.s.killZoneId);
    let trigger = entity.underFireUntil > engine.time;
    if (!trigger && zone) {
      for (const id of entity.contacts.keys()) {
        const t = engine.entities.get(id);
        if (t && t.alive && engine.isHostile(entity.force, t.force) && pointInPolygon(t, zone.points)) {
          trigger = true;
          break;
        }
      }
    }
    if (trigger) {
      // Spring it for the whole unit at once.
      const group = entity.unit ? entity.unit.alive() : [entity];
      for (const m of group) {
        if (m.task instanceof AmbushTask && !m.task.sprung) {
          m.task.sprung = true;
          m.roe = 'fireAtWill';
        }
      }
      engine.log('task', `${entity.unit?.name ?? entity.name} sprang the ambush on ${zone?.name ?? 'the kill zone'}`, entity.unit?.id ?? entity.id);
    }
    return 'running';
  }

  override resumeSpec(): TaskSpec {
    return { ...this.s, sprung: this.sprung || undefined };
  }

  describe(engine: Engine): string {
    const zone = engine.graphics.get(this.s.killZoneId);
    return this.sprung ? `Ambush on ${zone?.name ?? this.s.killZoneId}: sprung` : `Ambush on ${zone?.name ?? this.s.killZoneId}${this.arrived ? ', waiting' : ' (moving)'}`;
  }
}

/**
 * Screen: watch from a position with return-fire ROE, and fall back once an enemy comes
 * closer than the break-contact distance.
 */
export class ScreenTask extends HoldPositionTask {
  private falling = false;
  private retreat = new PathFollower(true);

  constructor(readonly s: Extract<TaskSpec, { type: 'screen' }>) {
    super(s, s.position, s.facing);
  }

  protected override start(ctx: TaskContext): void {
    super.start(ctx);
    if (this.status === 'running') ctx.entity.roe = 'returnFire';
  }

  private fallback(): Vec2 {
    if (this.s.fallback) return this.s.fallback;
    const back = (this.facing ?? 0) + Math.PI;
    return { x: this.position.x + Math.sin(back) * 2000, y: this.position.y + Math.cos(back) * 2000 };
  }

  protected tick(ctx: TaskContext): TaskStatus {
    const { engine, entity, dt } = ctx;
    if (this.falling) return this.retreat.step(entity, engine, dt, entity.type.maxSpeed * 0.8) ? 'done' : 'running';
    this.hold(ctx);
    const breakAt = this.s.breakContact ?? 1500;
    for (const id of entity.contacts.keys()) {
      const t = engine.entities.get(id);
      if (!t || !t.alive || !engine.isHostile(entity.force, t.force) || dist2d(entity, t) > breakAt) continue;
      const fb = this.fallback();
      const edge = engine.terrain.spec.size - 50;
      const to = { x: Math.max(50, Math.min(edge, fb.x)), y: Math.max(50, Math.min(edge, fb.y)) };
      this.falling = true;
      entity.prepared = undefined;
      if (!this.retreat.plan(entity, engine, to)) return this.fail('no route to fall back');
      engine.log('task', `${entity.name}: enemy within ${Math.round(dist2d(entity, t))} m, screen falling back`, entity.id, t.id);
      return 'running';
    }
    return 'running';
  }

  describe(): string {
    return this.falling ? 'Screen: falling back' : `Screen from ${this.where()}${this.arrived ? '' : ' (moving)'}`;
  }

  override get remainingPath(): Vec2[] {
    return this.falling ? this.retreat.remaining : this.arrived ? [] : this.path.remaining;
  }
}

/** Search an area: sweep it in parallel tracks spaced to the entity's sensor range. */
export class SearchTask extends Task {
  private path = new PathFollower();
  private tracks: Vec2[] = [];
  private index = 0;
  private found = new Set<string>();

  constructor(readonly s: Extract<TaskSpec, { type: 'search' }>) {
    super(s);
  }

  protected override start({ engine, entity }: TaskContext): void {
    const area = engine.graphics.get(this.s.areaId);
    if (!area || area.kind !== 'area' || area.points.length < 3) {
      this.fail('not an area');
      return;
    }
    let reach = 300;
    for (const sid of entity.type.sensors) reach = Math.max(reach, sensorRange(engine.catalog.sensors.get(sid)!, engine.env));
    const spacing = this.s.spacing ?? Math.max(100, Math.min(1500, reach));
    this.tracks = sweepTracks(area.points, spacing).filter((p) => engine.terrain.mobilityFactor(p.x, p.y, entity.domain, entity.type.offroadFactor) > 0 || entity.domain === 'air');
    // Start from whichever end is nearer.
    if (this.tracks.length && dist2d(entity, this.tracks.at(-1)!) < dist2d(entity, this.tracks[0])) this.tracks.reverse();
    this.index = Math.min(this.s.startIndex ?? 0, this.tracks.length);
    if (!this.tracks.length) this.fail('nothing to search');
  }

  protected tick({ engine, entity, dt }: TaskContext): TaskStatus {
    for (const id of entity.contacts.keys()) {
      const t = engine.entities.get(id);
      if (t && engine.isHostile(entity.force, t.force)) this.found.add(id);
    }
    while (this.index < this.tracks.length) {
      const wp = this.tracks[this.index];
      if (!this.path.goal || this.path.goal.x !== wp.x || this.path.goal.y !== wp.y) {
        if (!this.path.plan(entity, engine, wp)) {
          this.index++;
          continue;
        }
      }
      if (!this.path.step(entity, engine, dt, this.s.speed ?? entity.cruiseSpeed, this.index === this.tracks.length - 1)) return 'running';
      this.index++;
    }
    const area = engine.graphics.get(this.s.areaId);
    engine.log('task', `${entity.name} finished searching ${area?.name ?? this.s.areaId}: ${this.found.size} enemy found`, entity.id);
    return 'done';
  }

  describe(engine: Engine): string {
    const area = engine.graphics.get(this.s.areaId);
    return `Search ${area?.name ?? this.s.areaId}${this.tracks.length ? ` (${Math.min(this.index + 1, this.tracks.length)}/${this.tracks.length})` : ''}`;
  }

  override resumeSpec(): TaskSpec {
    return { ...this.s, startIndex: this.index };
  }

  override get remainingPath(): Vec2[] {
    return [...this.path.remaining, ...this.tracks.slice(this.index + 1)];
  }
}

/** Waypoints for a back-and-forth sweep of a polygon, tracks `spacing` apart along its long axis. */
export function sweepTracks(poly: Vec2[], spacing: number): Vec2[] {
  const xs = poly.map((p) => p.x);
  const ys = poly.map((p) => p.y);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  // Tracks run along the longer side, so there are fewer turns.
  const alongX = x1 - x0 >= y1 - y0;
  const out: Vec2[] = [];
  const across0 = alongX ? y0 : x0;
  const across1 = alongX ? y1 : x1;
  const n = Math.max(1, Math.round((across1 - across0) / spacing));
  for (let i = 0; i < n; i++) {
    const c = across0 + (across1 - across0) * ((i + 0.5) / n);
    // Where this track is inside the polygon.
    const along: number[] = [];
    const a0 = alongX ? x0 : y0;
    const a1 = alongX ? x1 : y1;
    for (let a = a0; a <= a1; a += Math.max(10, spacing / 10)) {
      const p = alongX ? { x: a, y: c } : { x: c, y: a };
      if (pointInPolygon(p, poly)) along.push(a);
    }
    if (!along.length) continue;
    const ends = [along[0], along[along.length - 1]];
    if (i % 2) ends.reverse();
    for (const a of ends) out.push(alongX ? { x: Math.round(a), y: Math.round(c) } : { x: Math.round(c), y: Math.round(a) });
  }
  return out;
}
