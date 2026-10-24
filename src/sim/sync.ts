// Synchronization matrices: a force's global plan in phases. Each phase starts on its
// trigger (manually, at a time, on a codeword, when the previous phase is done, or when a
// condition holds), gives every unit in it its order, and announces itself as a codeword.

import type { ForceId, Phase, PhaseOrder, SyncMatrix, SyncMatrixState } from '../shared/types.js';
import type { Engine } from './engine.js';
import { evaluateCondition, type Taskable } from './plans.js';

/** The codeword a phase announces when it starts: its name, upper-cased. */
export function phaseCodeword(p: Phase): string {
  return p.name.trim().toUpperCase().replace(/[^A-Z0-9 _-]/g, '').slice(0, 40) || p.id.toUpperCase();
}

export class SyncPlans {
  private matrices = new Map<ForceId, SyncMatrix>();
  /** "force|phase id" -> simulation time it started (both forces may have a P1). */
  private started = new Map<string, number>();
  /** "force|phase id" -> time its orders were all carried out (for previousDone delays). */
  private doneSince = new Map<string, number>();

  constructor(private readonly engine: Engine) {}

  clear(): void {
    this.matrices.clear();
    this.started.clear();
    this.doneSince.clear();
  }

  set(m: SyncMatrix, started: Record<string, number> = {}): void {
    for (const p of this.matrices.get(m.force)?.phases ?? []) if (!m.phases.some((q) => q.id === p.id)) this.started.delete(key(m.force, p.id));
    if (!m.phases.length) {
      this.matrices.delete(m.force);
      return;
    }
    this.matrices.set(m.force, { force: m.force, phases: m.phases.map((p) => ({ ...p, orders: p.orders.map((o) => ({ ...o })) })) });
    for (const [id, t] of Object.entries(started)) this.started.set(key(m.force, id), t);
  }

  get(force: ForceId): SyncMatrix | undefined {
    return this.matrices.get(force);
  }

  all(): SyncMatrix[] {
    return [...this.matrices.values()];
  }

  /** For snapshots and checkpoints. */
  states(): SyncMatrixState[] {
    return this.all().map((m) => {
      const started: Record<string, number> = {};
      let current: string | undefined;
      for (const p of m.phases) {
        const t = this.started.get(key(m.force, p.id));
        if (t !== undefined) {
          started[p.id] = t;
          current = p.id;
        }
      }
      return { ...m, started, current };
    });
  }

  /** Start a phase: give its orders and announce it. */
  start(force: ForceId, phaseId: string, why: string): void {
    const m = this.matrices.get(force);
    const p = m?.phases.find((x) => x.id === phaseId);
    if (!m || !p) throw new Error(`unknown phase ${phaseId}`);
    if (this.started.has(key(force, p.id))) return;
    this.started.set(key(force, p.id), this.engine.time);
    const word = phaseCodeword(p);
    this.engine.log('info', `${p.name} begins (${why})`, undefined);
    for (const o of p.orders) this.give(o);
    this.engine.sendCodeword(force, word);
  }

  private give(o: PhaseOrder): void {
    const e = this.engine;
    if (!e.entities.has(o.targetId) && !e.units.has(o.targetId)) return;
    try {
      if (o.stop) e.stop(o.targetId);
      if (o.roe) e.setRoe(o.targetId, o.roe);
      if (o.task) e.issueOrder(o.targetId, { task: o.task });
    } catch (err) {
      e.log('info', `${e.nameOf(o.targetId)}: phase order not carried out: ${err instanceof Error ? err.message : String(err)}`, o.targetId);
    }
  }

  /** Done when every order of the phase has been carried out (nothing left running or on its way). */
  private done(p: Phase): boolean {
    for (const o of p.orders) {
      if (!o.task) continue;
      if (this.engine.pendingOrders.some((x) => x.targetId === o.targetId)) return false;
      const owner = taskable(this.engine, o.targetId);
      if (owner && this.engine.orderStatus(owner) === 'running') return false;
    }
    return true;
  }

  /** Check triggers (once a simulated second). Phases start in order: one waits for the one before. */
  update(): void {
    for (const m of this.matrices.values()) {
      for (let i = 0; i < m.phases.length; i++) {
        const p = m.phases[i];
        if (this.started.has(key(m.force, p.id))) continue;
        const prev = m.phases[i - 1];
        if (prev && !this.started.has(key(m.force, prev.id))) break;
        const t = p.trigger;
        let go = false;
        let why = '';
        switch (t.type) {
          case 'time':
            go = this.engine.time >= t.time;
            why = 'scheduled';
            break;
          case 'codeword':
            go = this.engine.hasCodeword(m.force, t.codeword);
            why = `codeword ${t.codeword.toUpperCase()}`;
            break;
          case 'previousDone':
            if (prev) {
              const now = this.engine.time;
              const k = key(m.force, prev.id);
              if (now - this.started.get(k)! >= 1 && this.done(prev)) {
                const at = this.doneSince.get(k) ?? now;
                this.doneSince.set(k, at);
                go = now - at >= (t.delay ?? 0);
              } else this.doneSince.delete(k);
            } else go = true;
            why = prev ? `${prev.name} complete` : 'start';
            break;
          case 'condition': {
            const owner = taskable(this.engine, t.ownerId);
            go = !!owner && evaluateCondition(t.condition, this.engine, owner);
            why = 'condition met';
            break;
          }
          case 'manual':
            break;
        }
        if (go) this.start(m.force, p.id, why);
        break;
      }
    }
  }

}

function key(force: ForceId, phaseId: string): string {
  return `${force}|${phaseId}`;
}

/** An entity or unit as something whose order status can be asked. */
function taskable(engine: Engine, id: string): Taskable | undefined {
  const u = engine.units.get(id);
  if (u) return u;
  const e = engine.entities.get(id);
  if (!e) return undefined;
  return {
    id: e.id,
    members: () => [e],
    reference: () => e,
    startTask: () => undefined,
    taskStatus: () => e.task?.status ?? 'none',
    applySetting: () => undefined,
  };
}
