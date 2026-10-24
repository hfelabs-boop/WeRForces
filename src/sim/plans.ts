// Plans: ordered lists of tasks, settings and wait conditions executed in sequence.

import { pointInPolygon } from '../shared/math.js';
import type { Condition, Plan, PlanStatement, TaskSpec } from '../shared/types.js';
import type { Engine } from './engine.js';
import type { Entity } from './entity.js';
import { ammoFraction } from './supply.js';
import { DEFAULT_MISSION_ROUNDS, type TaskStatus } from './tasks.js';

/** Something a plan can drive: an entity or a unit. */
export interface Taskable {
  readonly id: string;
  /** Members whose state is checked by conditions (the entity itself, or unit members). */
  members(): Entity[];
  /** Position used for area conditions (entity, or unit leader). */
  reference(): Entity | undefined;
  startTask(engine: Engine, spec: TaskSpec): void;
  taskStatus(): TaskStatus | 'none';
  applySetting(engine: Engine, st: PlanStatement): void;
}

export function describeStatement(st: PlanStatement, engine?: Engine): string {
  switch (st.kind) {
    case 'task': {
      const t = st.task;
      switch (t.type) {
        case 'moveTo':
          return `Move to (${Math.round(t.target.x)}, ${Math.round(t.target.y)})`;
        case 'followRoute':
          return `Follow route ${engine?.graphics.get(t.routeId)?.name ?? t.routeId}`;
        case 'patrol':
          return `Patrol ${engine?.graphics.get(t.routeId)?.name ?? t.routeId}`;
        case 'wait':
          return `Wait ${t.duration}s`;
        case 'follow':
          return `Follow ${engine?.entities.get(t.targetId)?.name ?? t.targetId}`;
        case 'attack':
          return `Attack ${engine?.entities.get(t.targetId)?.name ?? t.targetId}`;
        case 'orbit':
          return `Orbit r=${t.radius}m`;
        case 'formation':
          return 'Hold formation';
        case 'mount':
          return `Mount ${engine?.entities.get(t.carrierId)?.name ?? engine?.units.get(t.carrierId)?.name ?? t.carrierId}`;
        case 'dismount':
          return 'Dismount passengers';
        case 'breach':
          return `Breach ${engine?.graphics.get(t.graphicId)?.name ?? t.graphicId}`;
        case 'resupply':
          return t.supplierId ? `Resupply from ${engine?.entities.get(t.supplierId)?.name ?? t.supplierId}` : 'Resupply';
        case 'overwatch':
        case 'defend':
        case 'screen':
          return `${t.type[0].toUpperCase()}${t.type.slice(1)} (${Math.round(t.position.x)}, ${Math.round(t.position.y)})${t.facing !== undefined ? ` facing ${Math.round(t.facing)}°` : ''}`;
        case 'ambush':
          return `Ambush ${engine?.graphics.get(t.killZoneId)?.name ?? t.killZoneId} from (${Math.round(t.position.x)}, ${Math.round(t.position.y)})`;
        case 'search':
          return `Search ${engine?.graphics.get(t.areaId)?.name ?? t.areaId}`;
        case 'fireMission':
          return `${t.smoke ? 'Smoke' : 'Fire'} mission at (${Math.round(t.target.x)}, ${Math.round(t.target.y)}), ${t.rounds ?? DEFAULT_MISSION_ROUNDS} rounds`;
      }
      break;
    }
    case 'setRoe':
      return `Set ROE ${st.roe}`;
    case 'setSpeed':
      return `Set speed ${st.speed} m/s`;
    case 'setAltitude':
      return `Set altitude ${st.altitude} m AGL`;
    case 'setFormation':
      return `Set formation ${st.formation}`;
    case 'waitUntil':
      return `Wait until ${describeCondition(st.condition, engine)}`;
    case 'setReactions':
      return `Set reactions: ${describeReactions(st.reactions)}`;
  }
}

export function describeReactions(r: { onContact?: string; withdrawBelow?: number; callForFire?: boolean }): string {
  const parts = [`on contact ${r.onContact ?? 'continue'}`];
  if (r.withdrawBelow !== undefined && r.withdrawBelow > 0) parts.push(`withdraw below ${Math.round(r.withdrawBelow * 100)}%`);
  if (r.callForFire) parts.push('call for fire');
  return parts.join(', ');
}

export function describeCondition(c: Condition, engine?: Engine): string {
  switch (c.type) {
    case 'simTime':
      return `time >= ${c.time}s`;
    case 'inArea':
      return `in area ${engine?.graphics.get(c.areaId)?.name ?? c.areaId}`;
    case 'enemyDetected':
      return 'enemy detected';
    case 'underFire':
      return 'under fire';
    case 'entityDestroyed':
      return `${engine?.entities.get(c.entityId)?.name ?? c.entityId} destroyed`;
    case 'enemyInArea':
      return `enemy in ${engine?.graphics.get(c.areaId)?.name ?? c.areaId}`;
    case 'strengthBelow':
      return `strength below ${Math.round(c.fraction * 100)}%`;
    case 'fuelBelow':
      return `fuel below ${Math.round(c.fraction * 100)}%`;
    case 'ammoBelow':
      return `ammunition below ${Math.round(c.fraction * 100)}%`;
  }
}

export function evaluateCondition(c: Condition, engine: Engine, owner: Taskable): boolean {
  switch (c.type) {
    case 'simTime':
      return engine.time >= c.time;
    case 'inArea': {
      const area = engine.graphics.get(c.areaId);
      const ref = owner.reference();
      return !!area && !!ref && area.points.length >= 3 && pointInPolygon(ref, area.points);
    }
    case 'enemyDetected':
      return owner.members().some((m) => [...m.contacts.keys()].some((id) => {
        const other = engine.entities.get(id);
        return !!other && other.alive && engine.isHostile(m.force, other.force);
      }));
    case 'underFire':
      return owner.members().some((m) => m.underFireUntil > engine.time);
    case 'entityDestroyed': {
      const e = engine.entities.get(c.entityId);
      return !e || e.destroyed;
    }
    case 'enemyInArea': {
      const area = engine.graphics.get(c.areaId);
      const force = owner.members()[0]?.force;
      if (!area || area.points.length < 3 || force === undefined) return false;
      for (const e of engine.entities.values()) {
        if (e.alive && !e.embarkedIn && engine.isHostile(force, e.force) && pointInPolygon(e, area.points)) return true;
      }
      return false;
    }
    case 'strengthBelow': {
      const members = owner.members();
      if (members.length === 0) return false;
      return members.filter((m) => m.alive).length / members.length < c.fraction;
    }
    case 'fuelBelow': {
      const v = owner.members().filter((m) => m.alive && m.type.endurance);
      return v.length > 0 && v.reduce((s, m) => s + m.fuel, 0) / v.length < c.fraction;
    }
    case 'ammoBelow': {
      const v = owner.members().filter((m) => m.alive && m.type.weapons.length);
      return v.length > 0 && v.reduce((s, m) => s + ammoFraction(engine, m), 0) / v.length < c.fraction;
    }
  }
}

export class PlanExecutor {
  index = 0;
  finished = false;
  private taskActive = false;
  /** Task spec to use instead of the statement's when resuming from a checkpoint. */
  private resumeTask?: TaskSpec;

  constructor(readonly plan: Plan) {}

  /** Continue at a statement, optionally resuming its task part-way (checkpoints). */
  resume(index: number, taskState?: TaskSpec): void {
    this.index = Math.max(0, Math.min(index, this.plan.statements.length));
    this.resumeTask = taskState;
    // A plan that had already completed stays completed.
    if (this.index >= this.plan.statements.length && !this.plan.loop) this.finished = true;
  }

  /** The statement in progress, if it is a task statement that has started. */
  get activeTask(): boolean {
    return this.taskActive;
  }

  /** Advance through the plan. Executes any number of instant statements per tick. */
  update(engine: Engine, owner: Taskable): void {
    let guard = 0;
    while (!this.finished && guard++ < 50) {
      if (this.index >= this.plan.statements.length) {
        if (this.plan.loop && this.plan.statements.length > 0) this.index = 0;
        else {
          this.finished = true;
          engine.log('task', `${engine.nameOf(owner.id)}: plan ${this.plan.name ?? ''} complete`.replace('  ', ' '), owner.id);
          return;
        }
      }
      const st = this.plan.statements[this.index];
      if (st.kind === 'task') {
        if (!this.taskActive) {
          // A task resumed from a checkpoint is not passed down again: subordinates resume their own.
          engine.startOrder(owner, this.resumeTask ?? st.task, !this.resumeTask);
          this.resumeTask = undefined;
          this.taskActive = true;
          return;
        }
        const status = engine.orderStatus(owner);
        if (status === 'running') return;
        this.taskActive = false;
        this.index++;
        continue;
      }
      if (st.kind === 'waitUntil') {
        if (!evaluateCondition(st.condition, engine, owner)) return;
        this.index++;
        continue;
      }
      owner.applySetting(engine, st);
      this.index++;
    }
  }

  describe(engine: Engine): string {
    if (this.finished) return `${this.plan.name ?? 'Plan'}: complete`;
    const st = this.plan.statements[this.index];
    const step = st ? describeStatement(st, engine) : '';
    return `${this.plan.name ?? 'Plan'} ${this.index + 1}/${this.plan.statements.length}: ${step}`;
  }
}
