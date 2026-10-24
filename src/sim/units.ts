// Units (aggregates of entities) with a leader, a formation and unit-level tasking.

import { rotateOffset } from '../shared/math.js';
import type { ForceId, Formation, MoraleState, Plan, PlanStatement, Reactions, TaskSpec, UnitTemplate, Vec2 } from '../shared/types.js';
import type { Aggregate } from './aggregate.js';
import type { Engine } from './engine.js';
import type { Entity } from './entity.js';
import type { PlanExecutor, Taskable } from './plans.js';
import { createTask, FormationTask, indirectWeaponFor, ManualTask, type Task, type TaskStatus } from './tasks.js';
import { needsSupply } from './supply.js';
import { isSwarmTask, startSwarm } from './unmannedTasks.js';

/** Body-frame offset (x = right, y = forward) for follower k (1-based) in a formation. */
export function formationOffset(formation: Formation, k: number, spacing: number): Vec2 {
  const rank = Math.ceil(k / 2);
  const side = k % 2 === 1 ? 1 : -1;
  switch (formation) {
    case 'column':
      return { x: 0, y: -k * spacing };
    case 'line':
      return { x: side * rank * spacing, y: 0 };
    case 'wedge':
      return { x: side * rank * spacing, y: -rank * spacing };
    case 'vee':
      return { x: side * rank * spacing, y: rank * spacing };
    case 'echelonRight':
      return { x: k * spacing, y: -k * spacing };
  }
}

/** Unit tasks that every member executes itself, rather than the leader with the rest in formation. */
export function perMemberTask(spec: TaskSpec): boolean {
  return spec.type === 'attack' || spec.type === 'strike' || isSwarmTask(spec) || spec.type === 'fireMission' || spec.type === 'mount' || spec.type === 'dismount' || spec.type === 'resupply' || DEPLOYED.has(spec.type);
}

/** Tasks for which a unit's members deploy in a line across the facing direction. */
const DEPLOYED = new Set<TaskSpec['type']>(['overwatch', 'defend', 'ambush', 'screen']);

type DeployedSpec = Extract<TaskSpec, { type: 'overwatch' | 'defend' | 'ambush' | 'screen' }>;

/** Facing in degrees for a deployed task: as given, toward an ambush's kill zone, or the direction of the move. */
function facingFor(spec: DeployedSpec, from: Vec2, engine: Engine): number {
  if (spec.facing !== undefined) return spec.facing;
  let toward: Vec2 | undefined;
  if (spec.type === 'ambush') {
    const zone = engine.graphics.get(spec.killZoneId);
    if (zone?.points.length) toward = zone.points.reduce((s, p) => ({ x: s.x + p.x / zone.points.length, y: s.y + p.y / zone.points.length }), { x: 0, y: 0 });
  }
  const a = toward ? spec.position : from;
  const b = toward ?? spec.position;
  const deg = Math.hypot(b.x - a.x, b.y - a.y) > 5 ? (Math.atan2(b.x - a.x, b.y - a.y) * 180) / Math.PI : 0;
  return (deg + 360) % 360;
}

/** Each member's own spec: positions spread along a line across the facing, centred on the given one. */
function deploy(spec: DeployedSpec, members: Entity[], from: Vec2, spacing: number, engine: Engine): DeployedSpec[] {
  const facing = facingFor(spec, from, engine);
  const n = members.length;
  const gap = n > 1 && 'width' in spec && spec.width ? spec.width / (n - 1) : spacing;
  const h = (facing * Math.PI) / 180;
  return members.map((_, i) => {
    const off = rotateOffset({ x: (i - (n - 1) / 2) * gap, y: 0 }, h);
    return { ...spec, facing, position: { x: Math.round(spec.position.x + off.x), y: Math.round(spec.position.y + off.y) } };
  });
}

/**
 * Split an order to a unit with subordinate units: the unit's own part (its HQ members)
 * and each subordinate's. Moves keep the subordinates' current offsets; positional tasks
 * spread them in a line across the facing with the HQ behind; anything else goes to all.
 */
export function splitOrder(engine: Engine, unit: Unit, subs: Unit[], spec: TaskSpec): { own: TaskSpec; children: { unit: Unit; spec: TaskSpec }[] } {
  const here = unit.centroid();
  const size = engine.terrain.spec.size;
  const clampPt = (p: Vec2) => ({ x: Math.round(Math.max(0, Math.min(size, p.x))), y: Math.round(Math.max(0, Math.min(size, p.y))) });
  if (spec.type === 'moveTo') {
    return {
      own: spec,
      children: subs.map((u) => {
        const c = u.centroid();
        return { unit: u, spec: { ...spec, target: clampPt({ x: spec.target.x + c.x - here.x, y: spec.target.y + c.y - here.y }) } };
      }),
    };
  }
  if (DEPLOYED.has(spec.type)) {
    const s = spec as DeployedSpec;
    const facing = facingFor(s, here, engine);
    const h = (facing * Math.PI) / 180;
    const n = subs.length;
    const foot = subs.every((u) => u.leader?.domain === 'lifeform');
    const width = 'width' in s ? s.width : undefined;
    const gap = width ? width / n : foot ? 150 : 400;
    const side = (u: Unit) => {
      const c = u.centroid();
      return (c.x - here.x) * Math.cos(h) - (c.y - here.y) * Math.sin(h);
    };
    const order = [...subs].sort((a, b) => side(a) - side(b));
    const behind = rotateOffset({ x: 0, y: -(foot ? 150 : 300) }, h);
    return {
      own: { ...s, facing, ...('width' in s ? { width: undefined } : {}), position: clampPt({ x: s.position.x + behind.x, y: s.position.y + behind.y }) },
      children: order.map((u, i) => {
        const off = rotateOffset({ x: (i - (n - 1) / 2) * gap, y: 0 }, h);
        return { unit: u, spec: { ...s, facing, ...(s.type === 'overwatch' ? {} : { width: Math.round(gap * 0.8) }), position: clampPt({ x: s.position.x + off.x, y: s.position.y + off.y }) } };
      }),
    };
  }
  return { own: spec, children: subs.map((u) => ({ unit: u, spec })) };
}

export class Unit implements Taskable {
  /** Superior unit in the chain of command. */
  parentId?: string;
  /** Subordinate units given the current order (its status includes theirs). */
  orderedSubs: string[] = [];
  plan: PlanExecutor | null = null;
  taskSpec: TaskSpec | null = null;
  assignedPlan?: Plan;
  assignedTask?: TaskSpec;
  reactions: Reactions = {};
  withdrawn = false;
  /** 0..1 cohesion. */
  morale = 1;
  moraleState: MoraleState = 'steady';
  /** Members already counted as lost by the morale model. */
  lossesSeen = 0;
  leader: Entity | undefined;
  /** The task instance currently executing the unit task on the leader. */
  leaderTask: Task | null = null;
  /** Set while the unit is simulated as one aggregate object (its members are hidden). */
  aggregate: Aggregate | null = null;
  /** Split up automatically: aggregate again once the enemy has been far away for a while. */
  reaggregate: { quietSince?: number } | null = null;

  constructor(
    readonly id: string,
    public name: string,
    readonly force: ForceId,
    readonly memberList: Entity[],
    public formation: Formation,
    public spacing: number,
    readonly echelon: UnitTemplate['echelon'],
  ) {
    for (const m of memberList) m.unit = this;
    this.leader = memberList.find((m) => m.alive);
  }

  members(): Entity[] {
    return this.memberList;
  }

  alive(): Entity[] {
    return this.memberList.filter((m) => m.alive);
  }

  reference(): Entity | undefined {
    return this.leader;
  }

  followers(): Entity[] {
    return this.memberList.filter((m) => m.alive && m !== this.leader);
  }

  slotPosition(entity: Entity, leader: Entity): Vec2 {
    const idx = this.followers().indexOf(entity) + 1;
    const off = rotateOffset(formationOffset(this.formation, Math.max(idx, 1), this.spacing), leader.heading);
    return { x: leader.x + off.x, y: leader.y + off.y };
  }

  startTask(engine: Engine, spec: TaskSpec): void {
    // An aggregate carries out the order itself, or splits up first.
    if (this.aggregate && engine.aggregates.startTask(this, spec)) return;
    this.taskSpec = spec;
    const leader = this.leader;
    if (!leader) return;
    if (spec.type === 'attack' || spec.type === 'strike') {
      for (const m of this.alive()) engine.setEntityTask(m, createTask(spec));
      return;
    }
    if (isSwarmTask(spec)) {
      // Drones share the area out, or spread over the targets.
      startSwarm(engine, this, spec);
      return;
    }
    if (spec.type === 'fireMission') {
      // Every tube that can reach the target fires; the rest stay put.
      const alive = this.alive();
      const tubes = alive.filter((m) => indirectWeaponFor(engine, m, spec.target, spec.weaponId));
      for (const m of tubes.length ? tubes : alive) engine.setEntityTask(m, createTask(spec));
      return;
    }
    if (DEPLOYED.has(spec.type)) {
      const alive = this.alive();
      // Members keep their left-to-right order across the line.
      const specs = deploy(spec as DeployedSpec, alive, this.centroid(), Math.max(this.spacing, leader.domain === 'lifeform' ? 15 : 60), engine);
      const h = ((specs[0]?.facing ?? 0) * Math.PI) / 180;
      const side = (m: Entity) => (m.x - leader.x) * Math.cos(h) - (m.y - leader.y) * Math.sin(h);
      const order = [...alive].sort((a, b) => side(a) - side(b));
      order.forEach((m, i) => engine.setEntityTask(m, createTask(specs[i])));
      return;
    }
    if (spec.type === 'resupply') {
      // Every member that needs it goes to the supply vehicle; the rest stay put.
      for (const m of this.alive()) engine.setEntityTask(m, needsSupply(engine, m) ? createTask(spec) : null);
      return;
    }
    if (spec.type === 'mount' || spec.type === 'dismount') {
      // Members board (in turn, so seats are shared out) or carriers unload; the rest keep still.
      const who = this.alive().filter((m) => (spec.type === 'mount' ? !m.embarkedIn : engine.passengersOf(m.id).length > 0));
      for (const m of who) {
        const task = createTask(spec);
        engine.setEntityTask(m, task);
        // Start now so each member reserves its seat before the next one chooses.
        if (spec.type === 'mount') task.update({ engine, entity: m, dt: 0 });
      }
      return;
    }
    this.leaderTask = createTask(spec);
    engine.setEntityTask(leader, this.leaderTask);
    this.formUp(engine);
  }

  /** (Re)assign formation-keeping to every follower that is not doing something else. */
  formUp(engine: Engine): void {
    const leader = this.leader;
    if (!leader || this.aggregate) return;
    for (const f of this.followers()) {
      // Someone driving it by hand keeps it.
      if (f.task instanceof ManualTask && f.task.status === 'running') continue;
      if (!(f.task instanceof FormationTask) || f.task.leaderId !== leader.id || f.task.status !== 'running') {
        engine.setEntityTask(f, new FormationTask(leader.id));
      }
    }
  }

  taskStatus(): TaskStatus | 'none' {
    if (!this.taskSpec) return 'none';
    if (this.aggregate) return this.aggregate.activeTask()?.status ?? 'done';
    // No one left to carry it out.
    if (!this.alive().length) return 'failed';
    if (perMemberTask(this.taskSpec)) {
      const type = this.taskSpec.type;
      return this.alive().some((m) => m.task?.status === 'running' && m.task.spec.type === type) ? 'running' : 'done';
    }
    return this.leaderTask?.status ?? 'done';
  }

  applySetting(engine: Engine, st: PlanStatement): void {
    if (st.kind === 'setFormation') {
      this.formation = st.formation;
      return;
    }
    if (st.kind === 'setReactions') {
      // Plan steps change only the reactions they name.
      engine.setReactions(this.id, { ...this.reactions, ...st.reactions });
      return;
    }
    for (const m of this.memberList) engine.applyEntitySetting(m, st);
  }

  /** Called every tick: replaces a destroyed or immobilised leader and keeps the unit tasked. */
  update(engine: Engine): void {
    // An aggregate's leader is replaced as it takes losses (see aggregate.ts).
    if (this.aggregate) return;
    const mobile = this.alive().filter((m) => !m.mobilityKill);
    const old = this.leader;
    if (old && old.alive && (!old.mobilityKill || mobile.length === 0)) return;
    const next = mobile[0] ?? this.alive()[0];
    if (!next || next === old) return;
    this.leader = next;
    engine.log('info', `${this.name}: ${old?.name ?? 'leader'} ${old?.alive ? 'immobilised' : 'lost'}, ${next.name} takes command`, this.id);
    // Attacks, fire missions and mounting are done by every member: they simply carry on.
    if (this.taskSpec && perMemberTask(this.taskSpec) && this.taskStatus() === 'running') return;
    const running = !!this.taskSpec && !perMemberTask(this.taskSpec) && this.leaderTask?.status === 'running' ? this.leaderTask : null;
    if (running) {
      // The new leader picks up where the old one was (e.g. the same waypoint of a route).
      this.leaderTask = createTask(running.resumeSpec());
      engine.setEntityTask(next, this.leaderTask);
    } else {
      engine.setEntityTask(next, null);
    }
    this.formUp(engine);
  }

  centroid(): Vec2 {
    const alive = this.alive();
    const list = alive.length ? alive : this.memberList;
    let x = 0;
    let y = 0;
    for (const m of list) {
      x += m.x;
      y += m.y;
    }
    return { x: x / Math.max(1, list.length), y: y / Math.max(1, list.length) };
  }
}
