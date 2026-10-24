// Units (aggregates of entities) with a leader, a formation and unit-level tasking.

import { rotateOffset } from '../shared/math.js';
import type { ForceId, Formation, Plan, PlanStatement, Reactions, TaskSpec, UnitTemplate, Vec2 } from '../shared/types.js';
import type { Engine } from './engine.js';
import type { Entity } from './entity.js';
import type { PlanExecutor, Taskable } from './plans.js';
import { createTask, FormationTask, indirectWeaponFor, type Task, type TaskStatus } from './tasks.js';

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
  return spec.type === 'attack' || spec.type === 'fireMission' || spec.type === 'mount' || spec.type === 'dismount';
}

export class Unit implements Taskable {
  plan: PlanExecutor | null = null;
  taskSpec: TaskSpec | null = null;
  assignedPlan?: Plan;
  assignedTask?: TaskSpec;
  reactions: Reactions = {};
  withdrawn = false;
  leader: Entity | undefined;
  /** The task instance currently executing the unit task on the leader. */
  leaderTask: Task | null = null;

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
    this.taskSpec = spec;
    const leader = this.leader;
    if (!leader) return;
    if (spec.type === 'attack') {
      for (const m of this.alive()) engine.setEntityTask(m, createTask(spec));
      return;
    }
    if (spec.type === 'fireMission') {
      // Every tube that can reach the target fires; the rest stay put.
      const alive = this.alive();
      const tubes = alive.filter((m) => indirectWeaponFor(engine, m, spec.target, spec.weaponId));
      for (const m of tubes.length ? tubes : alive) engine.setEntityTask(m, createTask(spec));
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
    if (!leader) return;
    for (const f of this.followers()) {
      if (!(f.task instanceof FormationTask) || f.task.leaderId !== leader.id || f.task.status !== 'running') {
        engine.setEntityTask(f, new FormationTask(leader.id));
      }
    }
  }

  taskStatus(): TaskStatus | 'none' {
    if (!this.taskSpec) return 'none';
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
    const mobile = this.alive().filter((m) => !m.mobilityKill);
    const old = this.leader;
    if (old && old.alive && (!old.mobilityKill || mobile.length === 0)) return;
    const next = mobile[0] ?? this.alive()[0];
    if (!next || next === old) return;
    const wasRunning = !!this.taskSpec && !perMemberTask(this.taskSpec) && this.leaderTask?.status === 'running';
    this.leader = next;
    engine.log('info', `${this.name}: ${old?.name ?? 'leader'} ${old?.alive ? 'immobilised' : 'lost'}, ${next.name} takes command`, this.id);
    if (wasRunning && this.taskSpec) {
      this.leaderTask = createTask(this.taskSpec);
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
