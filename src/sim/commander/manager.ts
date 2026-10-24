// Commanders for forces: when each decides (at its interval, and sooner on contact,
// losses, a new phase or a unit left idle), what it is told (its force's fog-of-war
// view) and how its orders are carried out: through the same permission check and
// commands as a player of that force, never around them. Decisions are logged as info
// events from the force's headquarters, so only that force (and exercise control) hears them.
//
// The rule-based commander decides inside the simulation step, deterministically. An LLM
// commander's model calls run in the background: the simulation goes on, and its orders
// are carried out at the next simulated second after they arrive (while paused, they wait).

import type { CommanderDecision, CommanderKind, CommanderOptions, CommanderSettings, CommanderStatus } from '../../shared/commander.js';
import { OrderError, orderContext, parseOrder, type OrderContext } from '../../shared/orders.js';
import { FORCE_NAMES, type Command, type ForceId, type Role, type SimState } from '../../shared/types.js';
import { applyCommand } from '../../server/commands.js';
import { checkCommand, contactsOf, filterState, ForbiddenError } from '../../server/fog.js';
import type { Engine } from '../engine.js';
import { Rng } from '../rng.js';
import { Unit } from '../units.js';
import { LlmCommander, type LlmTransport } from './llm.js';
import { checkOptions, withDefaults } from './options.js';
import { RulesCommander } from './rules.js';
import { buildSituation, type OwnElement } from './situation.js';
import type { ActionResult, CallBudget, CommanderAction, TerrainView } from './types.js';

/** How a server reaches a language model (set from its environment; absent in plain engines and batch runs). */
export interface LlmProvider {
  transport?: LlmTransport;
  /** Why there is no transport (e.g. no key configured). */
  unavailable?: string;
}

/** Commands a commander may give: a player's orders, not its editing. */
const ALLOWED = new Set<Command['cmd']>(['assignTask', 'assignPlan', 'stop', 'setRoe', 'setReactions', 'setFormation', 'sendCodeword', 'startPhase']);
const KEEP_DECISIONS = 30;
const EVENT_PRIORITY = ['losses', 'contact', 'phase', 'idle'];

interface Slot {
  force: ForceId;
  kind: 'rules' | 'llm';
  options: CommanderOptions;
  rules?: RulesCommander;
  llm?: LlmCommander;
  rng: Rng;
  next: number;
  lastEvent: number;
  pendingEvent?: string;
  asked: boolean;
  given: Map<string, [string, number]>;
  others: Map<string, [string, number]>;
  known: Set<string>;
  lossesSeen: number;
  phase?: string;
  busySeen: Set<string>;
  decisions: CommanderDecision[];
  state: CommanderStatus['state'];
  error?: string;
  queue: { action?: CommanderAction; resolve?: (r: ActionResult) => void; finish?: () => void }[];
  usage: { calls: number; inputTokens: number; outputTokens: number };
  callTimes: number[];
  abort?: AbortController;
}

export class Commanders {
  private slots = new Map<ForceId, Slot>();
  /** Set by the server when a model is configured. */
  llm?: LlmProvider;
  private readonly terrain: TerrainView;

  constructor(private readonly engine: Engine) {
    this.terrain = {
      get size() {
        return engine.terrain.spec.size;
      },
      canStand: (p) => engine.canStand('ground', p),
      nearestLand: (p, r = 400) => engine.findValidPosition(p, 'ground', r),
    };
  }

  get active(): boolean {
    return this.slots.size > 0;
  }

  get(force: ForceId): CommanderStatus | undefined {
    const s = this.slots.get(force);
    return s && this.statusOf(s);
  }

  /** Put a force under a commander, or take it back ('none'). Throws Error on bad options. */
  set(force: ForceId, kind: CommanderKind, options: unknown = {}, quiet = false): void {
    const opts = checkOptions(options);
    const old = this.slots.get(force);
    if (old) this.stopSlot(old);
    if (kind === 'none') {
      this.slots.delete(force);
      if (old && !quiet) this.say(force, `${FORCE_NAMES[force]} commander stood down`);
      return;
    }
    if (kind !== 'rules' && kind !== 'llm') throw new Error("kind must be 'none', 'rules' or 'llm'");
    const slot = this.makeSlot(force, kind, opts);
    this.slots.set(force, slot);
    if (!quiet) this.say(force, `${FORCE_NAMES[force]} is now run by the ${kind === 'rules' ? 'rule-based' : 'LLM'} commander`);
  }

  /** Ask for a decision at the next simulated second. */
  requestDecision(force: ForceId): void {
    const s = this.slots.get(force);
    if (!s) throw new Error(`${FORCE_NAMES[force]} has no commander`);
    s.asked = true;
  }

  clear(): void {
    for (const s of this.slots.values()) this.stopSlot(s);
    this.slots.clear();
  }

  /** For scenario files: the settings, plus in checkpoints where each commander is in its cycle. */
  save(checkpoint: boolean): CommanderSettings[] | undefined {
    if (!this.slots.size) return undefined;
    return [...this.slots.values()].map((s) => ({
      force: s.force,
      kind: s.kind,
      options: { ...s.options },
      ...(checkpoint
        ? {
            state: {
              next: s.next,
              given: Object.fromEntries(s.given),
              others: Object.fromEntries(s.others),
              rngState: s.rng.state,
              ...(s.rules ? { memory: s.rules.saveMemory() } : {}),
            },
          }
        : {}),
    }));
  }

  load(list: CommanderSettings[] | undefined): void {
    this.clear();
    for (const c of list ?? []) {
      if (![0, 1, 2, 3].includes(c?.force) || (c.kind !== 'rules' && c.kind !== 'llm')) continue;
      let opts: CommanderOptions;
      try {
        opts = checkOptions(c.options);
      } catch (err) {
        throw new Error(`commanders: ${(err as Error).message}`);
      }
      const slot = this.makeSlot(c.force, c.kind, opts);
      const st = c.state;
      if (st) {
        slot.next = Number(st.next) || 0;
        slot.given = new Map(Object.entries(st.given ?? {}));
        slot.others = new Map(Object.entries(st.others ?? {}));
        slot.rng.state = st.rngState;
        slot.decisions = [];
        slot.known = new Set(contactsOf(this.engine, c.force).keys());
        slot.lossesSeen = this.ownLosses(c.force);
        slot.phase = this.currentPhase(c.force);
        if (st.memory && slot.rules) slot.rules.loadMemory(st.memory);
      }
      this.slots.set(c.force, slot);
    }
  }

  status(): CommanderStatus[] | undefined {
    if (!this.slots.size) return undefined;
    return [...this.slots.values()].sort((a, b) => a.force - b.force).map((s) => this.statusOf(s, 10));
  }

  /** Once a simulated second: carry out what has arrived, then decide where it is due. */
  update(): void {
    if (!this.slots.size) return;
    let full: SimState | undefined;
    for (const slot of [...this.slots.values()].sort((a, b) => a.force - b.force)) {
      this.drain(slot);
      if (this.slots.get(slot.force) !== slot) continue;
      const trigger = this.trigger(slot);
      if (!trigger) continue;
      if (slot.kind === 'llm') {
        if (slot.state === 'thinking') continue;
        if (!this.llm?.transport) {
          slot.state = 'unavailable';
          slot.error = this.llm?.unavailable ?? 'no language model is configured on this server';
          slot.next = this.engine.time + withDefaults(slot.options).interval;
          continue;
        }
        const why = this.refuseCall(slot, false);
        if (why) {
          if (why.startsWith('token budget')) {
            slot.state = 'error';
            slot.error = why;
          }
          if (trigger !== 'scheduled' && trigger !== 'start') slot.pendingEvent ??= trigger;
          slot.next = Math.max(slot.next, this.engine.time + 10);
          continue;
        }
      }
      full ??= this.engine.snapshot();
      this.decide(slot, trigger, full);
    }
  }

  // ------------------------------------------------------------ internals

  private makeSlot(force: ForceId, kind: 'rules' | 'llm', options: CommanderOptions): Slot {
    const seed = options.seed ?? ((this.engine.terrain.spec.seed * 7919 + force * 104729) ^ 0xc0de) >>> 0;
    return {
      force,
      kind,
      options,
      rules: kind === 'rules' ? new RulesCommander() : undefined,
      llm: kind === 'llm' ? new LlmCommander() : undefined,
      rng: new Rng(seed),
      next: this.engine.time,
      lastEvent: -Infinity,
      asked: false,
      given: new Map(),
      others: new Map(),
      known: new Set(contactsOf(this.engine, force).keys()),
      lossesSeen: this.ownLosses(force),
      phase: this.currentPhase(force),
      busySeen: new Set(),
      decisions: [],
      state: 'ready',
      queue: [],
      usage: { calls: 0, inputTokens: 0, outputTokens: 0 },
      callTimes: [],
    };
  }

  private stopSlot(s: Slot): void {
    s.abort?.abort();
    for (const q of s.queue) q.resolve?.({ ok: false, text: 'the commander was stood down' });
    s.queue = [];
  }

  private statusOf(s: Slot, max = KEEP_DECISIONS): CommanderStatus {
    return {
      force: s.force,
      kind: s.kind,
      options: { ...s.options },
      state: s.state,
      next: s.next,
      ...(s.error ? { error: s.error } : {}),
      decisions: s.decisions.slice(0, max),
      ...(s.kind === 'llm' ? { usage: { ...s.usage } } : {}),
    };
  }

  private ownLosses(force: ForceId): number {
    let n = 0;
    for (const e of this.engine.entities.values()) if (e.force === force && e.destroyed && !e.ambient) n++;
    return n;
  }

  private currentPhase(force: ForceId): string | undefined {
    if (!this.engine.sync.get(force)) return undefined;
    return this.engine.sync.states().find((m) => m.force === force)?.current;
  }

  /** The order an object is carrying out (or has on its way), as a signature. */
  private sig(id: string): string {
    const e = this.engine;
    const p = e.pendingOrders.find((o) => o.targetId === id);
    if (p) return JSON.stringify(p.plan ? { plan: p.plan } : p.task);
    const t = e.units.get(id) ?? e.entities.get(id);
    if (!t) return '';
    if (t.assignedPlan) return JSON.stringify({ plan: t.assignedPlan });
    return t.assignedTask ? JSON.stringify(t.assignedTask) : '';
  }

  private busy(id: string): boolean {
    const e = this.engine;
    if (e.pendingOrders.some((o) => o.targetId === id)) return true;
    const u = e.units.get(id);
    if (u) return (!!u.plan && !u.plan.finished) || e.orderStatus(u) === 'running';
    const ent = e.entities.get(id);
    return !!ent && ((!!ent.plan && !ent.plan.finished) || ent.task?.status === 'running');
  }

  private controlOf(slot: Slot, id: string, depth = 0): { busy: boolean; control: OwnElement['control'] } {
    const busy = this.busy(id);
    const s = this.sig(id);
    if (!s) {
      slot.others.delete(id);
      return { busy, control: 'none' };
    }
    const g = slot.given.get(id);
    if (g && g[0] === s) return { busy, control: 'commander' };
    // An order passed down from a superior the commander ordered is the commander's too.
    const parent = this.engine.units.get(id)?.parentId;
    if (parent && depth < 8) {
      const up = this.controlOf(slot, parent, depth + 1);
      if (up.control === 'commander' && up.busy) return { busy, control: 'commander' };
    }
    let o = slot.others.get(id);
    if (!o || o[0] !== s) {
      o = [s, this.engine.time];
      slot.others.set(id, o);
    }
    const holdOff = withDefaults(slot.options).holdOff;
    return { busy, control: busy && this.engine.time - o[1] < holdOff ? 'other' : 'none' };
  }

  /** Why to decide now, if it is time. */
  private trigger(slot: Slot): string | null {
    const e = this.engine;
    const t = e.time;
    // Watch for events: new contacts, losses, a new phase, a unit done with the commander's order.
    let contact = false;
    for (const [id, c] of contactsOf(e, slot.force)) {
      const target = e.entities.get(id);
      if (!target || !target.alive || !e.isHostile(slot.force, target.force) || t - c.lastSeen > 5 || slot.known.has(id)) continue;
      slot.known.add(id);
      contact = true;
    }
    const lost = this.ownLosses(slot.force);
    const losses = lost > slot.lossesSeen;
    slot.lossesSeen = lost;
    const phase = this.currentPhase(slot.force);
    const phaseChanged = phase !== slot.phase;
    slot.phase = phase;
    let idle = false;
    for (const id of slot.given.keys()) {
      const busy = this.busy(id);
      if (!busy && slot.busySeen.has(id)) idle = true;
      if (busy) slot.busySeen.add(id);
      else slot.busySeen.delete(id);
    }
    const events = { losses, contact, phase: phaseChanged, idle } as Record<string, boolean>;
    for (const k of EVENT_PRIORITY) {
      if (!events[k]) continue;
      if (!slot.pendingEvent || EVENT_PRIORITY.indexOf(k) < EVENT_PRIORITY.indexOf(slot.pendingEvent)) slot.pendingEvent = k;
    }
    if (slot.asked) {
      slot.asked = false;
      return 'asked';
    }
    if (t >= slot.next) return slot.decisions.length ? 'scheduled' : 'start';
    const gap = Math.max(10, withDefaults(slot.options).interval / 4);
    if (slot.pendingEvent && t - slot.lastEvent >= gap) return slot.pendingEvent;
    return null;
  }

  private decide(slot: Slot, trigger: string, full: SimState): void {
    const e = this.engine;
    const opts = withDefaults(slot.options);
    slot.next = e.time + opts.interval;
    slot.lastEvent = e.time;
    slot.pendingEvent = undefined;
    const sit = buildSituation(e, slot.force, trigger, (id) => this.controlOf(slot, id), full);
    if (!sit.own.some((o) => o.alive > 0)) return;
    if (slot.rules) {
      let d: { summary: string; actions: CommanderAction[] };
      try {
        d = slot.rules.decide(sit, this.terrain, slot.rng, opts);
      } catch (err) {
        slot.state = 'error';
        slot.error = err instanceof Error ? err.message : String(err);
        return;
      }
      const cache: { ctx?: OrderContext } = {};
      const results = d.actions.map((a) => this.execute(slot, a, cache));
      this.record(slot, trigger, d.summary, results);
      return;
    }
    this.startLlm(slot, trigger, sit);
  }

  private startLlm(slot: Slot, trigger: string, sit: ReturnType<typeof buildSituation>): void {
    const transport = this.llm?.transport;
    if (!transport || !slot.llm) return;
    slot.state = 'thinking';
    slot.error = undefined;
    const abort = new AbortController();
    slot.abort = abort;
    const live = () => this.slots.get(slot.force) === slot && !abort.signal.aborted;
    const act = (action: CommanderAction) =>
      new Promise<ActionResult>((resolve) => {
        if (!live()) return resolve({ ok: false, text: 'the commander was stood down' });
        slot.queue.push({ action, resolve });
      });
    const budget: CallBudget = {
      refuse: () => (live() ? this.refuseCall(slot, true) : 'the commander was stood down'),
      record: (u) => {
        slot.usage.calls++;
        slot.usage.inputTokens += u.input_tokens ?? 0;
        slot.usage.outputTokens += u.output_tokens ?? 0;
      },
    };
    const opts = withDefaults(slot.options);
    slot.llm
      .decide({ transport, situation: sit, act, budget, options: opts, signal: abort.signal, previous: slot.decisions.slice(0, 3) })
      .then(
        (out) => {
          if (!live()) return;
          slot.queue.push({
            finish: () => {
              slot.state = 'ready';
              this.record(slot, trigger, out.summary, out.results);
            },
          });
        },
        (err: unknown) => {
          if (!live()) return;
          const msg = err instanceof Error ? err.message : String(err);
          slot.queue.push({
            finish: () => {
              slot.state = 'error';
              slot.error = msg;
              // Try again later, not at once.
              slot.next = Math.max(slot.next, this.engine.time + opts.interval * 2);
              this.record(slot, trigger, `No decision: ${msg}`, []);
            },
          });
        },
      );
  }

  /** Model calls are limited per simulated minute and by the token budget. */
  private refuseCall(slot: Slot, take: boolean): string | null {
    const o = withDefaults(slot.options);
    const t = this.engine.time;
    slot.callTimes = slot.callTimes.filter((x) => t - x < 60);
    if (slot.usage.inputTokens + slot.usage.outputTokens >= o.tokenBudget) return `token budget of ${o.tokenBudget} used up`;
    if (slot.callTimes.length >= o.maxCallsPerMinute) return `rate limit: ${o.maxCallsPerMinute} model calls per simulated minute`;
    if (take) slot.callTimes.push(t);
    return null;
  }

  /** Carry out what an LLM commander has asked for since the last second. */
  private drain(slot: Slot): void {
    if (!slot.queue.length) return;
    const items = slot.queue;
    slot.queue = [];
    const cache: { ctx?: OrderContext } = {};
    for (const q of items) {
      try {
        if (q.action) q.resolve?.(this.execute(slot, q.action, cache));
        q.finish?.();
      } catch (err) {
        q.resolve?.({ ok: false, text: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  /** Carry out one order as a player of the force would give it. */
  private execute(slot: Slot, action: CommanderAction, cache: { ctx?: OrderContext }): ActionResult {
    const e = this.engine;
    const role: Role = { kind: 'player', force: slot.force };
    let commands: Command[];
    let text: string;
    if ('report' in action) return { ok: true, text: 'noted' };
    if ('order' in action) {
      try {
        cache.ctx ??= orderContext(filterState(e, e.snapshot(), slot.force), e.terrain.towns, e.terrain.spec.size, (id) => e.catalog.types.get(id), slot.force);
        const parsed = parseOrder(action.order, cache.ctx);
        commands = parsed.commands;
        text = parsed.description;
      } catch (err) {
        if (err instanceof OrderError) return { ok: false, text: `"${action.order}": ${err.message}` };
        throw err;
      }
    } else {
      commands = [action.command];
      text = action.text;
    }
    for (const c of commands) if (!ALLOWED.has(c?.cmd)) return { ok: false, text: `${text}: a commander cannot ${String(c?.cmd)}` };
    try {
      for (const c of commands) checkCommand(e, role, c);
    } catch (err) {
      if (err instanceof ForbiddenError) return { ok: false, text: `${text}: ${err.message}` };
      throw err;
    }
    for (const c of commands) {
      const r = applyCommand(e, c);
      if (!r.ok) return { ok: false, text: `${text}: ${r.error}` };
      const target = (c as { targetId?: string }).targetId;
      if (target && (c.cmd === 'assignTask' || c.cmd === 'assignPlan' || c.cmd === 'stop')) {
        slot.given.set(target, [this.sig(target), e.time]);
        slot.others.delete(target);
        if (this.busy(target)) slot.busySeen.add(target);
      }
    }
    // Typed orders say who they are for; plain commands carry their own text.
    return { ok: true, text };
  }

  private record(slot: Slot, trigger: string, summary: string, results: ActionResult[]): void {
    const orders = results.filter((r) => r.ok).map((r) => r.text);
    const rejected = results.filter((r) => !r.ok).map((r) => r.text);
    const d: CommanderDecision = { time: Math.round(this.engine.time), trigger, summary, orders, ...(rejected.length ? { rejected } : {}) };
    const prev = slot.decisions[0];
    slot.decisions.unshift(d);
    if (slot.decisions.length > KEEP_DECISIONS) slot.decisions.length = KEEP_DECISIONS;
    // Quiet when nothing changed.
    if (!orders.length && !rejected.length && prev?.summary === summary) return;
    let text = `${FORCE_NAMES[slot.force]} commander: ${summary}`;
    if (orders.length) text += ` Orders: ${orders.join('; ')}.`;
    if (rejected.length) text += ` Refused: ${rejected.join('; ')}.`;
    this.say(slot.force, text.length > 600 ? `${text.slice(0, 597)}...` : text);
  }

  /** Log for the force only: an info event from one of its entities (an event without one would reach every player). */
  say(force: ForceId, text: string): void {
    const who = this.speaker(force);
    if (who) this.engine.log('info', text, who);
  }

  /** Who speaks for the force: its top headquarters' leader, else any of its living entities. */
  speaker(force: ForceId): string | undefined {
    let best: Unit | undefined;
    for (const u of this.engine.units.values()) {
      if (u.force !== force || u.parentId || !u.leader?.alive) continue;
      if (!best || this.engine.subordinatesOf(u).length > this.engine.subordinatesOf(best).length) best = u;
    }
    if (best) return best.leader!.id;
    for (const e of this.engine.entities.values()) if (e.force === force && e.alive && !e.ambient && !e.remote) return e.id;
    return undefined;
  }
}
