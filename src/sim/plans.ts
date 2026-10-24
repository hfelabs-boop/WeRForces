// Plans: ordered lists of tasks, settings and wait conditions executed in sequence.

import { pointInPolygon } from '../shared/math.js';
import type { Condition, Plan, PlanStatement, TaskSpec } from '../shared/types.js';
import type { Engine } from './engine.js';
import type { Entity } from './entity.js';
import type { TaskStatus } from './tasks.js';

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
  }
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
  }
}

export class PlanExecutor {
  index = 0;
  finished = false;
  private taskActive = false;

  constructor(readonly plan: Plan) {}

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
          owner.startTask(engine, st.task);
          this.taskActive = true;
          return;
        }
        const status = owner.taskStatus();
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
