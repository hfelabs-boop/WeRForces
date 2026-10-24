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
    case 'if':
      return `If ${describeCondition(st.condition, engine)}`;
    case 'while':
      return `While ${describeCondition(st.condition, engine)}`;
    case 'sendCodeword':
      return `Send codeword ${st.codeword}`;
    case 'report':
      return `Report "${st.text}"`;
  }
  return '';
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
    case 'codeword':
      return `codeword ${c.codeword}`;
    case 'all':
      return c.conditions.map((x) => describeCondition(x, engine)).join(' and ');
    case 'any':
      return c.conditions.map((x) => describeCondition(x, engine)).join(' or ');
    case 'not':
      return `not (${describeCondition(c.condition, engine)})`;
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
    case 'codeword': {
      const force = owner.members()[0]?.force;
      // A jammed radio does not hear it.
      const ref = owner.reference();
      if (ref && engine.ew.radioJammed(ref)) return false;
      return force !== undefined && engine.hasCodeword(force, c.codeword);
    }
    case 'all':
      return c.conditions.every((x) => evaluateCondition(x, engine, owner));
    case 'any':
      return c.conditions.some((x) => evaluateCondition(x, engine, owner));
    case 'not':
      return !evaluateCondition(c.condition, engine, owner);
  }
}

/** Every task in a plan, inside if/while blocks too. */
export function planTasks(statements: PlanStatement[]): TaskSpec[] {
  const out: TaskSpec[] = [];
  for (const st of statements) {
    if (st.kind === 'task') out.push(st.task);
    else if (st.kind === 'if') out.push(...planTasks(st.then), ...planTasks(st.else ?? []));
    else if (st.kind === 'while') out.push(...planTasks(st.body));
  }
  return out;
}

/** One step of a compiled plan: a statement, a conditional jump (if/while), or a jump. */
export type PlanOp =
  | { op: 'do'; st: PlanStatement }
  /** Go on if the condition holds, else jump to `else`. */
  | { op: 'test'; st: Extract<PlanStatement, { kind: 'if' | 'while' }>; else: number }
  | { op: 'jump'; to: number };

/** Flatten nested if/while blocks into steps with jumps; a flat plan compiles one step per statement. */
export function compilePlan(statements: PlanStatement[]): PlanOp[] {
  const ops: PlanOp[] = [];
  const emit = (list: PlanStatement[]) => {
    for (const st of list) {
      if (st.kind === 'if') {
        const test = { op: 'test', st, else: -1 } as Extract<PlanOp, { op: 'test' }>;
        ops.push(test);
        emit(st.then);
        if (st.else?.length) {
          const jump = { op: 'jump', to: -1 } as Extract<PlanOp, { op: 'jump' }>;
          ops.push(jump);
          test.else = ops.length;
          emit(st.else);
          jump.to = ops.length;
        } else test.else = ops.length;
      } else if (st.kind === 'while') {
        const start = ops.length;
        const test = { op: 'test', st, else: -1 } as Extract<PlanOp, { op: 'test' }>;
        ops.push(test);
        emit(st.body);
        ops.push({ op: 'jump', to: start });
        test.else = ops.length;
      } else ops.push({ op: 'do', st });
    }
  };
  emit(statements);
  return ops;
}

export class PlanExecutor {
  /** Position in `ops` (the compiled plan); saved in checkpoints. */
  index = 0;
  finished = false;
  readonly ops: PlanOp[];
  private taskActive = false;
  /** Task spec to use instead of the statement's when resuming from a checkpoint. */
  private resumeTask?: TaskSpec;

  constructor(readonly plan: Plan) {
    this.ops = compilePlan(plan.statements);
  }

  /** Continue at a step, optionally resuming its task part-way (checkpoints). */
  resume(index: number, taskState?: TaskSpec): void {
    this.index = Math.max(0, Math.min(index, this.ops.length));
    this.resumeTask = taskState;
    // A plan that had already completed stays completed.
    if (this.index >= this.ops.length && !this.plan.loop) this.finished = true;
  }

  /** The statement at a step (an if/while for its test, nothing for a jump). */
  statementAt(i: number): PlanStatement | undefined {
    const op = this.ops[i];
    return op && op.op !== 'jump' ? op.st : undefined;
  }

  /** The statement in progress, if it is a task statement that has started. */
  get activeTask(): boolean {
    return this.taskActive;
  }

  /** Advance through the plan. Executes any number of instant statements per tick. */
  update(engine: Engine, owner: Taskable): void {
    let guard = 0;
    while (!this.finished && guard++ < 50) {
      if (this.index >= this.ops.length) {
        if (this.plan.loop && this.ops.length > 0) this.index = 0;
        else {
          this.finished = true;
          engine.log('task', `${engine.nameOf(owner.id)}: plan ${this.plan.name ?? ''} complete`.replace('  ', ' '), owner.id);
          return;
        }
      }
      const op = this.ops[this.index];
      if (op.op === 'jump') {
        this.index = op.to;
        continue;
      }
      if (op.op === 'test') {
        this.index = evaluateCondition(op.st.condition, engine, owner) ? this.index + 1 : op.else;
        continue;
      }
      const st = op.st;
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
      if (st.kind === 'sendCodeword') {
        const force = owner.members()[0]?.force;
        if (force !== undefined) engine.sendCodeword(force, st.codeword, owner.id);
        this.index++;
        continue;
      }
      if (st.kind === 'report') {
        const speaker = owner.reference();
        if (speaker) engine.radio(speaker, `${engine.nameOf(owner.id)}: ${st.text}`);
        this.index++;
        continue;
      }
      owner.applySetting(engine, st);
      this.index++;
    }
  }

  describe(engine: Engine): string {
    if (this.finished) return `${this.plan.name ?? 'Plan'}: complete`;
    const st = this.statementAt(this.index);
    const step = st ? describeStatement(st, engine) : '';
    return `${this.plan.name ?? 'Plan'} ${this.index + 1}/${this.ops.length}: ${step}`;
  }
}
