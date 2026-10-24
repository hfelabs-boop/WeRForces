// The attention queue: things the operator should look at, so nobody has to watch every
// unit all the time (idle, broken, out of fuel or ammunition, leader lost, losses, first
// contact...). It only reads the simulation, so it never changes how a run plays out.

import type { Alert, AlertKind, ForceId } from '../shared/types.js';
import type { Engine } from './engine.js';
import type { Entity } from './entity.js';
import type { Unit } from './units.js';

/** Seconds a unit must stay idle before it is reported. */
const IDLE_AFTER = 10;
/** Seconds without fire (or contact) before a new burst is reported again. */
const QUIET = 60;
/** Alerts kept, open or acknowledged. */
const MAX_ALERTS = 200;

const SEVERITY: Record<AlertKind, Alert['severity']> = {
  taskFailed: 'warning',
  idle: 'info',
  broken: 'critical',
  outOfFuel: 'critical',
  lowFuel: 'warning',
  outOfAmmo: 'critical',
  leaderLost: 'warning',
  losses: 'warning',
  underFire: 'info',
  contact: 'info',
  jammed: 'warning',
  linkLost: 'warning',
};

/** A unit, or an entity that is not in one: what the operator gives orders to. */
type Owner = { id: string; name: string; force: ForceId; members: Entity[]; unit?: Unit; entity?: Entity };

interface OwnerMemory {
  busy: boolean;
  idleSince?: number;
  leaderId?: string;
  lastFire: number;
  lastContact: number;
  failedTask?: object;
}

export class Alerts {
  private list: Alert[] = [];
  private seq = 0;
  private memory = new Map<string, OwnerMemory>();

  /** Acknowledged alerts whose condition has since cleared. */
  private readonly cleared = new WeakSet<Alert>();

  constructor(private readonly engine: Engine) {
    engine.on('event', (ev) => {
      if (ev.kind !== 'destroyed' || !ev.entityId) return;
      const e = engine.entities.get(ev.entityId);
      if (!e || e.remote) return;
      const owner = e.unit ? e.unit : e;
      const n = e.unit ? e.unit.alive().length : 0;
      this.raise('losses', owner.id, e.force, e.unit ? `${e.unit.name}: ${e.name} destroyed (${n} left)` : `${e.name} destroyed`);
    });
    engine.on('reset', () => this.clear());
  }

  clear(): void {
    this.list = [];
    this.memory.clear();
  }

  /** Open alerts, newest first. */
  open(): Alert[] {
    return this.list.filter((a) => !a.acknowledged).sort((a, b) => b.time - a.time);
  }

  all(): Alert[] {
    return [...this.list].sort((a, b) => b.time - a.time);
  }

  acknowledge(id: string): boolean {
    const a = this.list.find((x) => x.id === id);
    if (!a) return false;
    a.acknowledged = true;
    return true;
  }

  acknowledgeAll(force?: ForceId): number {
    let n = 0;
    for (const a of this.list) {
      if (a.acknowledged || (force !== undefined && a.force !== force)) continue;
      a.acknowledged = true;
      n++;
    }
    return n;
  }

  /** Raise (or raise again) the alert of this kind about an object. */
  raise(kind: AlertKind, objectId: string, force: ForceId, text: string): Alert {
    const time = this.engine.time;
    const open = this.list.find((a) => a.kind === kind && a.objectId === objectId && !a.acknowledged);
    if (open) {
      open.text = text;
      open.time = time;
      open.count++;
      return open;
    }
    const a: Alert = { id: `A${++this.seq}`, kind, severity: SEVERITY[kind], objectId, force, text, time, count: 1 };
    this.list.push(a);
    if (this.list.length > MAX_ALERTS) {
      // Drop the oldest acknowledged first, then the oldest.
      const i = this.list.findIndex((x) => x.acknowledged);
      this.list.splice(i >= 0 ? i : 0, 1);
    }
    return a;
  }

  /** Close an open alert whose condition has cleared; an acknowledged one stays in the history but no longer holds back a new one. */
  private resolve(kind: AlertKind, objectId: string): void {
    this.list = this.list.filter((a) => !(a.kind === kind && a.objectId === objectId && !a.acknowledged));
    for (const a of this.list) if (a.kind === kind && a.objectId === objectId) this.cleared.add(a);
  }

  private owners(): Owner[] {
    const out: Owner[] = [];
    for (const u of this.engine.units.values()) out.push({ id: u.id, name: u.name, force: u.force, members: u.alive(), unit: u });
    for (const e of this.engine.entities.values()) if (!e.unit && !e.remote && !e.ambient && e.alive) out.push({ id: e.id, name: e.name, force: e.force, members: [e], entity: e });
    return out;
  }

  /** Check the state of every unit and loose entity (once a simulated second). */
  update(): void {
    const engine = this.engine;
    const now = engine.time;
    const seen = new Set<string>();
    for (const o of this.owners()) {
      seen.add(o.id);
      let m = this.memory.get(o.id);
      if (!m) {
        m = { busy: false, lastFire: -Infinity, lastContact: -Infinity, leaderId: o.unit?.leader?.id };
        this.memory.set(o.id, m);
      }
      if (!o.members.length) {
        for (const k of ['idle', 'broken', 'outOfFuel', 'lowFuel', 'outOfAmmo'] as AlertKind[]) this.resolve(k, o.id);
        continue;
      }
      // Idle: was busy, now has nothing to do.
      const plan = o.unit ? o.unit.plan : o.entity!.plan;
      const ordered = engine.pendingOrders.some((p) => p.targetId === o.id) || (o.unit ? engine.orderStatus(o.unit) === 'running' : false);
      const busy = (!!plan && !plan.finished) || ordered || o.members.some((e) => e.task?.status === 'running' && e.task.spec.type !== 'formation');
      if (busy) {
        m.busy = true;
        m.idleSince = undefined;
        this.resolve('idle', o.id);
      } else if (m.busy) {
        m.idleSince ??= now;
        if (now - m.idleSince >= IDLE_AFTER) {
          m.busy = false;
          this.raise('idle', o.id, o.force, `${o.name} has finished its orders and is idle`);
        }
      }
      // Failed tasks.
      for (const e of o.members) {
        const t = e.task;
        if (t && t.status === 'failed' && m.failedTask !== t) {
          m.failedTask = t;
          this.raise('taskFailed', o.id, o.force, `${o.name}: ${t.describe(engine)} failed${t.message ? `: ${t.message}` : ''}`);
        }
      }
      // Morale.
      if (engine.rules.morale) {
        const broken = o.unit ? o.unit.moraleState === 'broken' : o.entity!.moraleState === 'broken';
        if (broken) this.raiseOnce('broken', o, `${o.name} has broken and is falling back`);
        else this.resolve('broken', o.id);
      }
      // Fuel.
      if (engine.rules.fuel) {
        const fuelled = o.members.filter((e) => e.type.endurance);
        const empty = fuelled.filter((e) => e.fuel <= 0).length;
        const low = fuelled.filter((e) => e.fuel > 0 && e.fuel < 0.2).length;
        if (empty) this.raiseOnce('outOfFuel', o, o.unit ? `${o.name}: ${empty} of ${o.members.length} out of fuel` : `${o.name} is out of fuel`);
        else this.resolve('outOfFuel', o.id);
        if (low && !empty) this.raiseOnce('lowFuel', o, o.unit ? `${o.name}: ${low} low on fuel` : `${o.name} is low on fuel`);
        else this.resolve('lowFuel', o.id);
      }
      // Ammunition: members whose weapons are all empty.
      const armed = o.members.filter((e) => e.type.weapons.length > 0);
      const dry = armed.filter((e) => e.type.weapons.every((w) => (e.ammo.get(w) ?? 0) <= 0)).length;
      if (dry) this.raiseOnce('outOfAmmo', o, o.unit ? `${o.name}: ${dry} of ${o.members.length} out of ammunition` : `${o.name} is out of ammunition`);
      else this.resolve('outOfAmmo', o.id);
      // Radio jammed: orders arrive late, no contact sharing or calls for fire.
      const lead = o.unit?.leader ?? o.entity;
      const by = lead ? engine.ew.radioJammedBy(lead) : undefined;
      if (by) this.raiseOnce('jammed', o, `${o.name}: radio jammed`);
      else this.resolve('jammed', o.id);
      // Unmanned systems that lost their datalink.
      const lost = o.members.filter((e) => e.uxs && !e.uxs.up);
      if (lost.length) this.raiseOnce('linkLost', o, o.unit && o.members.length > 1 ? `${o.name}: ${lost.length} of ${o.members.length} lost their datalink` : `${o.name}: datalink lost`);
      else this.resolve('linkLost', o.id);
      // Leader lost.
      if (o.unit) {
        const lead = o.unit.leader;
        if (m.leaderId && lead && lead.id !== m.leaderId) {
          const old = engine.entities.get(m.leaderId);
          if (!old || !old.alive || old.mobilityKill) this.raise('leaderLost', o.id, o.force, `${o.name} lost its leader${old ? ` (${old.name})` : ''}; ${lead.name} takes command`);
        }
        m.leaderId = lead?.id;
      }
      // Under fire, after a quiet spell.
      const fired = o.members.some((e) => e.underFireUntil > now);
      if (fired) {
        if (now - m.lastFire > QUIET) this.raise('underFire', o.id, o.force, `${o.name} is under fire`);
        m.lastFire = now;
      }
      // First contact, after a quiet spell.
      const contact = o.members.some((e) => [...e.contacts.keys()].some((id) => {
        const t = engine.entities.get(id);
        return !!t && t.alive && engine.isHostile(o.force, t.force);
      }));
      if (contact) {
        if (now - m.lastContact > QUIET) this.raise('contact', o.id, o.force, `${o.name} has made contact with the enemy`);
        m.lastContact = now;
      }
    }
    for (const id of [...this.memory.keys()]) if (!seen.has(id)) this.memory.delete(id);
  }

  /** Raise unless one is already open (conditions that last, like being out of fuel). */
  private raiseOnce(kind: AlertKind, o: Owner, text: string): void {
    const open = this.list.find((a) => a.kind === kind && a.objectId === o.id && !a.acknowledged);
    if (open) open.text = text;
    // Acknowledged while the condition lasts: stay quiet until it clears and comes back.
    else if (!this.list.some((a) => a.kind === kind && a.objectId === o.id && a.acknowledged && !this.cleared.has(a))) this.raise(kind, o.id, o.force, text);
  }
}
