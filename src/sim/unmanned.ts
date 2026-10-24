// Unmanned systems: control datalinks, and what happens without them.
//
// Once a simulated second every unmanned system works out whether it can reach its
// operator. A radio (`rf`) link needs the operator, or another own drone that relays (a
// mesh), within radio range and line of sight, and no enemy datalink jamming; a satellite
// link only needs to be free of jamming; a fibre-optic tether cannot be jammed but ends at
// its length; autonomous systems need no link. Without a link a system falls back on its
// lost-link behaviour (hover, return, continue, land) as far as its autonomy requires:
// remotely piloted ones stop seeing and shooting, supervised ones finish what they were
// doing, autonomous ones carry on. Orders sent to it wait until the link is back.

import { dist2d } from '../shared/math.js';
import type { Autonomy, ForceId, LinkLossReason, LinkStatus, LostLinkBehaviour, UnmannedState, Vec2, WeaponDef } from '../shared/types.js';
import type { Engine } from './engine.js';
import type { Entity } from './entity.js';
import { createTask, type Task } from './tasks.js';

/** Radio range (m) of a datalink whose type gives none. */
export const DEFAULT_LINK_RANGE = 5000;
/** One-way attack: distance (m) from the target it dives in at, when its type gives none. */
export const DEFAULT_TERMINAL_RANGE = 150;
/** Radius (m) a fixed-wing drone circles at while it holds. */
const HOLD_ORBIT = 300;

/** An unmanned system's runtime state (Entity.uxs). */
export interface UxsState {
  /** The operator it is assigned to; missing: any of its force's operators (or its unit's leader). */
  controllerId?: string;
  /** Overrides of the type's lost-link behaviour and autonomy. */
  lostLink?: LostLinkBehaviour;
  autonomy?: Autonomy;
  up: boolean;
  reason?: LinkLossReason;
  jammerId?: string;
  /** While linked: the operator at the far end, and the radio hops to it. */
  rootId?: string;
  hops?: number;
  /** Simulation time the link last went up or down. */
  since: number;
  /** Where it returns to: its operator when last linked, or where it started. */
  home: Vec2;
  holdAt?: Vec2;
  /** Landed on lost link: the altitude setting to take off to again (null: the type's). */
  landedFrom?: number | null;
  tetherCut?: boolean;
  /** A one-way munition that has delivered its warhead. */
  expended?: boolean;
  /** Lost link "return": the move home. */
  homing?: Task | null;
}

export function autonomyOf(e: Entity): Autonomy {
  return e.uxs?.autonomy ?? e.type.unmanned?.autonomy ?? 'remote';
}

export function lostLinkOf(e: Entity): LostLinkBehaviour {
  return e.uxs?.lostLink ?? e.type.unmanned?.lostLink ?? 'hover';
}

export function linkRangeOf(e: Entity): number {
  return e.type.unmanned?.linkRange ?? DEFAULT_LINK_RANGE;
}

/** The warhead a one-way attack drone delivers, if it is one. */
export function warheadOf(engine: Engine, e: Entity): WeaponDef | undefined {
  const id = e.type.unmanned?.warhead;
  return id ? engine.catalog.weapons.get(id) : undefined;
}

/** In words: why a link is down. */
export function reasonText(engine: Engine, st: UxsState): string {
  switch (st.reason) {
    case 'jammed':
      return `jammed${st.jammerId ? ` by ${engine.nameOf(st.jammerId)}` : ''}`;
    case 'range':
      return 'out of radio range of its operator';
    case 'terrain':
      return 'no line of sight to its operator';
    case 'noController':
      return 'no operator';
    case 'controllerLost':
      return 'its operator is lost';
    case 'tether':
      return 'its fibre-optic cable ran out';
    default:
      return 'no link';
  }
}

/** In words: what it does without its link. */
export function fallbackText(e: Entity): string {
  const a = autonomyOf(e);
  const busy = !!e.task && e.task.status === 'running';
  if (a === 'autonomous') return 'carries on by itself';
  if (a === 'supervised' && busy) return 'carries on with its task, but attacks nothing new';
  const b = lostLinkOf(e);
  const fixedWing = (e.type.minSpeed ?? 0) > 0;
  if (b === 'continue' && busy) return 'carries on with its task, blind';
  if (b === 'return' || (b === 'land' && fixedWing)) return 'returns to its operator';
  if (b === 'land') return e.domain === 'air' ? 'lands where it is' : 'stops where it is';
  return e.domain !== 'air' ? 'stops where it is' : fixedWing ? 'circles where it is' : 'hovers where it is';
}

interface Reach {
  e: Entity;
  root: string;
  hops: number;
}

export class Unmanned {
  constructor(private readonly engine: Engine) {}

  /** State for a new entity of an unmanned type. */
  init(e: Entity): void {
    if (e.type.unmanned) e.uxs = { up: true, since: this.engine.time, home: { x: e.x, y: e.y } };
  }

  linked(e: Entity): boolean {
    return !e.uxs || e.uxs.up;
  }

  /** Its picture gets through to its operator, or it looks for itself. */
  sees(e: Entity): boolean {
    return !e.uxs || e.uxs.up || autonomyOf(e) !== 'remote';
  }

  /** 'free': fires under its ROE; 'explicit': only at the target it was given; 'none'. */
  fireMode(e: Entity): 'free' | 'explicit' | 'none' {
    if (!e.uxs || e.uxs.up) return 'free';
    const a = autonomyOf(e);
    return a === 'autonomous' ? 'free' : a === 'supervised' ? 'explicit' : 'none';
  }

  /** May it start an attack on a target it found itself? */
  mayPickTargets(e: Entity): boolean {
    return !e.uxs || e.uxs.up || autonomyOf(e) === 'autonomous';
  }

  /** An order to this entity or unit would get through now. */
  reachable(id: string): boolean {
    const e = this.engine.entities.get(id) ?? this.engine.units.get(id)?.leader;
    return !e || this.linked(e);
  }

  /** The operator at the far end of its link, while linked. */
  controllerOf(e: Entity): Entity | undefined {
    const id = e.uxs?.up ? e.uxs.rootId : undefined;
    return id ? this.engine.entities.get(id) : undefined;
  }

  /** Assign an operator (null: any of its force's) and override the lost-link behaviour or autonomy (null: the type's). */
  setControl(e: Entity, c: { controllerId?: string | null; lostLink?: LostLinkBehaviour | null; autonomy?: Autonomy | null }): void {
    const st = e.uxs;
    if (!st) throw new Error(`${e.name} is not an unmanned system`);
    if (c.controllerId !== undefined) {
      if (c.controllerId === null) st.controllerId = undefined;
      else {
        const op = this.engine.entities.get(c.controllerId);
        if (!op || op.remote) throw new Error(`unknown entity ${c.controllerId}`);
        if (op.force !== e.force) throw new Error(`${op.name} is not of ${e.name}'s force`);
        if (op === e) throw new Error(`${e.name} cannot control itself`);
        st.controllerId = op.id;
      }
    }
    if (c.lostLink !== undefined) st.lostLink = c.lostLink ?? undefined;
    if (c.autonomy !== undefined) st.autonomy = c.autonomy ?? undefined;
  }

  // ------------------------------------------------------------ links

  /** Work out every unmanned system's link (once a simulated second, after jamming). */
  update(): void {
    const engine = this.engine;
    const drones: Entity[] = [];
    for (const e of engine.entities.values()) if (e.uxs && e.alive && !e.remote && !e.embarkedIn) drones.push(e);
    if (!drones.length) return;
    const stations = new Map<ForceId, Entity[]>();
    for (const e of engine.entities.values()) {
      if (!e.type.controlStation || !e.alive || e.remote || e.embarkedIn) continue;
      const list = stations.get(e.force);
      if (list) list.push(e);
      else stations.set(e.force, [e]);
    }
    // Drones that pass other drones' links on: radio, relaying, not jammed themselves.
    const relays = new Map<ForceId, Entity[]>();
    for (const d of drones) {
      const u = d.type.unmanned!;
      if (u.link !== 'rf' || u.satcom || !u.relay || d.uxs!.expended || engine.ew.datalinkJammed(d)) continue;
      const list = relays.get(d.force);
      if (list) list.push(d);
      else relays.set(d.force, [d]);
    }
    const cache = new Map<string, Reach[]>();
    const changed: Entity[] = [];
    for (const d of drones) {
      const st = d.uxs!;
      if (st.expended) continue;
      const was = st.up;
      this.compute(d, stations.get(d.force) ?? [], relays.get(d.force) ?? [], cache);
      if (st.up && st.rootId) {
        const root = engine.entities.get(st.rootId);
        if (root) st.home = { x: root.x, y: root.y };
      }
      if (was !== st.up) {
        st.since = engine.time;
        if (st.up) this.regained(d);
        else {
          st.holdAt = undefined;
          st.homing = null;
        }
        changed.push(d);
      }
    }
    if (changed.length) this.announce(changed);
  }

  private compute(d: Entity, stations: Entity[], relays: Entity[], cache: Map<string, Reach[]>): void {
    const engine = this.engine;
    const st = d.uxs!;
    const u = d.type.unmanned!;
    const set = (up: boolean, reason?: LinkLossReason, rootId?: string, hops?: number, jammerId?: string) => {
      st.up = up;
      st.reason = reason;
      st.rootId = rootId;
      st.hops = hops;
      st.jammerId = jammerId;
    };
    if (u.link === 'autonomous') return set(true);
    if (u.link === 'rf') {
      const jammer = engine.ew.datalinkJammedBy(d);
      if (jammer) return set(false, 'jammed', undefined, undefined, jammer);
      if (u.satcom) return set(true);
    }
    // Who it can be controlled from.
    let sources: Entity[];
    let key: string;
    if (st.controllerId) {
      const c = engine.entities.get(st.controllerId);
      if (!c || !c.alive || c.embarkedIn || c.force !== d.force) return set(false, 'controllerLost');
      sources = [c];
      key = `#${c.id}`;
    } else {
      const lead = d.unit?.leader;
      const byLeader = lead && lead !== d && lead.alive && !lead.uxs && !lead.type.controlStation ? lead : undefined;
      sources = byLeader ? [...stations, byLeader] : stations;
      key = `F${d.force}${byLeader ? `|${byLeader.id}` : ''}`;
    }
    if (!sources.length) return set(false, 'noController');
    if (u.link === 'fiber') {
      if (st.tetherCut) return set(false, 'tether');
      // A tether runs to one operator: the one it is given, or the nearest within reach.
      let c = st.controllerId ? sources[0] : undefined;
      if (!c) {
        let best = Infinity;
        for (const s of sources) {
          const r = Math.hypot(s.x - d.x, s.y - d.y, s.z - d.z);
          if (r <= linkRangeOf(d) && r < best) {
            best = r;
            c = s;
          }
        }
        if (!c) return set(false, 'range');
        st.controllerId = c.id;
      }
      if (Math.hypot(c.x - d.x, c.y - d.y, c.z - d.z) > linkRangeOf(d)) {
        st.tetherCut = true;
        return set(false, 'tether');
      }
      return set(true, undefined, c.id, 1);
    }
    // Radio: straight to an operator, or through relaying drones.
    let reach = cache.get(key);
    if (!reach) {
      reach = this.mesh(sources, relays);
      cache.set(key, reach);
    }
    for (const r of reach) {
      if (r.e === d) return set(true, undefined, r.root, r.hops);
    }
    for (const r of reach) {
      if (this.hop(r.e, d)) return set(true, undefined, r.root, r.hops + 1);
    }
    // Why not: too far from the nearest operator, or something in the way.
    let near = Infinity;
    for (const s of sources) near = Math.min(near, Math.hypot(s.x - d.x, s.y - d.y, s.z - d.z));
    return set(false, near > linkRangeOf(d) ? 'range' : 'terrain');
  }

  /** Every relay reachable from the sources, breadth first: who it reaches through, and in how many hops. */
  private mesh(sources: Entity[], relays: Entity[]): Reach[] {
    const out: Reach[] = sources.map((s) => ({ e: s, root: s.id, hops: 0 }));
    const seen = new Set(sources.map((s) => s.id));
    for (let i = 0; i < out.length; i++) {
      const f = out[i];
      for (const r of relays) {
        if (seen.has(r.id) || !this.hop(f.e, r)) continue;
        seen.add(r.id);
        out.push({ e: r, root: f.root, hops: f.hops + 1 });
      }
    }
    return out;
  }

  /** One radio hop: within both ends' range, with line of sight (smoke does not stop radio). */
  private hop(a: Entity, b: Entity): boolean {
    const range = Math.min(a.uxs ? linkRangeOf(a) : Infinity, b.uxs ? linkRangeOf(b) : Infinity);
    if (Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) > range) return false;
    return this.engine.lineOfSight(a.eye, b.eye, true);
  }

  /** Back in contact: take off again if it landed, and go back to its task. */
  private regained(e: Entity): void {
    const st = e.uxs!;
    if (st.landedFrom !== undefined) {
      e.altitudeOverride = st.landedFrom ?? undefined;
      st.landedFrom = undefined;
    }
    st.holdAt = undefined;
    st.homing?.cancel(e);
    st.homing = null;
  }

  /** Log who lost or regained a link: once per unit, or per loose entity. */
  private announce(changed: Entity[]): void {
    const engine = this.engine;
    const byOwner = new Map<string, Entity[]>();
    for (const e of changed) {
      const k = e.unit && e.unit.memberList.length > 1 ? e.unit.id : e.id;
      const list = byOwner.get(k);
      if (list) list.push(e);
      else byOwner.set(k, [e]);
    }
    for (const [id, list] of byOwner) {
      const unit = engine.units.get(id);
      const lost = list.filter((e) => !e.uxs!.up);
      const back = list.filter((e) => e.uxs!.up);
      if (!unit) {
        const e = list[0];
        engine.log('info', e.uxs!.up ? `${e.name}: datalink back` : `${e.name}: datalink lost (${reasonText(engine, e.uxs!)}); it ${fallbackText(e)}`, e.id, e.uxs!.jammerId);
        continue;
      }
      if (lost.length) engine.log('info', `${unit.name}: ${lost.length === 1 ? lost[0].name : `${lost.length} drones`} lost the datalink (${reasonText(engine, lost[0].uxs!)})`, unit.id, lost[0].uxs!.jammerId);
      if (back.length) engine.log('info', `${unit.name}: datalink back for ${back.length === 1 ? back[0].name : `${back.length} drones`}`, unit.id);
    }
  }

  // ------------------------------------------------------------ lost-link behaviour

  /**
   * Without its link, steer it by its lost-link behaviour instead of its task this tick.
   * True when it did (the task waits and resumes when the link is back).
   */
  overrides(e: Entity, dt: number): boolean {
    const st = e.uxs;
    if (!st || st.up || st.expended) return false;
    const busy = !!e.task && e.task.status === 'running';
    if (busy && autonomyOf(e) !== 'remote') return false;
    let b = lostLinkOf(e);
    if (busy && b === 'continue') return false;
    const fixedWing = (e.type.minSpeed ?? 0) > 0;
    if (b === 'land' && fixedWing) b = 'return';
    if (b === 'return') {
      if (dist2d(e, st.home) > (e.domain === 'air' ? 60 : 15)) {
        st.homing ??= createTask({ type: 'moveTo', target: { x: st.home.x, y: st.home.y } });
        if (st.homing.update({ engine: this.engine, entity: e, dt }) === 'running') return true;
      }
      // Home (or no way there): hold.
      st.homing = null;
      b = 'hover';
    }
    if (b === 'land' && e.domain === 'air') {
      if (st.landedFrom === undefined) {
        st.landedFrom = e.altitudeOverride ?? null;
        e.altitudeOverride = 0;
      }
      e.steer = { x: e.x, y: e.y, speed: 0, arrive: true };
      return true;
    }
    const at = (st.holdAt ??= { x: e.x, y: e.y });
    if (e.domain === 'air' && fixedWing) {
      const a = Math.atan2(e.x - at.x, e.y - at.y) + Math.min(0.6, 400 / HOLD_ORBIT);
      e.steer = { x: at.x + Math.sin(a) * HOLD_ORBIT, y: at.y + Math.cos(a) * HOLD_ORBIT, speed: e.cruiseSpeed, arrive: false };
    } else if (e.domain === 'air') {
      e.steer = { x: at.x, y: at.y, speed: e.cruiseSpeed, arrive: true };
    } else {
      e.steer = { x: e.x, y: e.y, speed: 0, arrive: true };
    }
    return true;
  }

  // ------------------------------------------------------------ swarms

  /**
   * Flocking: drones of a unit flying close together steer apart a little, keeping the
   * distance they are heading for, so a swarm spreads out instead of bunching up.
   */
  separate(): void {
    for (const u of this.engine.units.values()) {
      if (u.aggregate || u.memberList.length < 2) continue;
      const m = u.memberList.filter((e) => e.uxs && e.alive && e.domain === 'air' && e.steer && !e.embarkedIn);
      if (m.length < 2) continue;
      const sep = Math.max(10, Math.min(40, u.spacing * 0.6));
      const push = m.map((a) => {
        let px = 0;
        let py = 0;
        for (const b of m) {
          if (a === b) continue;
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const d = Math.hypot(dx, dy);
          if (d >= sep || d < 1e-6) continue;
          const w = (1 - d / sep) / d;
          px += dx * w;
          py += dy * w;
        }
        return { px, py };
      });
      m.forEach((a, i) => {
        const { px, py } = push[i];
        const s = a.steer!;
        if (px === 0 && py === 0) return;
        const dx = s.x - a.x;
        const dy = s.y - a.y;
        const l = Math.hypot(dx, dy);
        if (l < 1) {
          // Holding still in a crowd: drift apart.
          a.steer = { ...s, x: a.x + px * sep * 0.5, y: a.y + py * sep * 0.5, speed: Math.max(s.speed, 2) };
          return;
        }
        // Turn away from neighbours, keeping the distance to the steering point.
        const ux = dx / l + 2 * px;
        const uy = dy / l + 2 * py;
        const n = Math.hypot(ux, uy) || 1;
        a.steer = { ...s, x: a.x + (ux / n) * l, y: a.y + (uy / n) * l };
      });
    }
  }

  // ------------------------------------------------------------ one-way attack

  /**
   * A one-way attack drone dives into its target: its warhead goes off through the usual
   * weapon path (hit, armour of the face it strikes, damage) and the drone is spent.
   */
  detonate(e: Entity, t: Entity, w: WeaponDef): void {
    const engine = this.engine;
    const now = engine.time;
    const range = Math.hypot(t.x - e.x, t.y - e.y, t.z - e.z);
    e.uxs!.expended = true;
    engine.launch({
      eventNumber: engine.nextEventNumber(),
      shooterId: e.id,
      targetId: t.id,
      weapon: w,
      from: { x: e.x, y: e.y, z: e.z },
      to: { x: t.x, y: t.y, z: t.z + 1 },
      fireTime: now,
      impactTime: now + Math.max(0.1, range / w.projectileSpeed),
      range,
    });
    t.attackers.set(e.id, now);
    t.underFireUntil = now + 15;
    // The drone is the munition: it is gone from the battlefield (not a loss to its side).
    e.destroyed = true;
    e.lastFiredAt = now;
    e.plan = null;
    e.contacts.clear();
    e.attackTargetId = undefined;
    e.engagingId = undefined;
  }

  // ------------------------------------------------------------ snapshots and saving

  status(e: Entity): LinkStatus | undefined {
    const st = e.uxs;
    if (!st || st.expended) return undefined;
    return {
      mode: e.type.unmanned!.link,
      up: st.up,
      reason: st.up ? undefined : st.reason,
      controllerId: st.up ? st.rootId : st.controllerId,
      hops: st.up ? st.hops : undefined,
      lostFor: st.up ? undefined : Math.round((this.engine.time - st.since) * 10) / 10,
      autonomy: autonomyOf(e),
      lostLink: lostLinkOf(e),
    };
  }

  /** For scenario files: the settings, and in checkpoints the link state too. */
  record(e: Entity, checkpoint: boolean): UnmannedState | undefined {
    const st = e.uxs;
    if (!st) return undefined;
    const out: UnmannedState = { controllerId: st.controllerId, lostLink: st.lostLink, autonomy: st.autonomy };
    if (checkpoint) {
      Object.assign(out, {
        linkUp: st.up,
        reason: st.reason,
        jammerId: st.jammerId,
        rootId: st.rootId,
        hops: st.hops,
        since: st.since,
        home: { x: Math.round(st.home.x * 10) / 10, y: Math.round(st.home.y * 10) / 10 },
        holdAt: st.holdAt,
        landedFrom: st.landedFrom,
        tetherCut: st.tetherCut || undefined,
        expended: st.expended || undefined,
      });
    }
    for (const k of Object.keys(out) as (keyof UnmannedState)[]) if (out[k] === undefined) delete out[k];
    return Object.keys(out).length ? out : undefined;
  }

  restore(e: Entity, r: UnmannedState): void {
    const st = e.uxs;
    if (!st) return;
    st.controllerId = r.controllerId;
    st.lostLink = r.lostLink;
    st.autonomy = r.autonomy;
    if (r.linkUp !== undefined) st.up = r.linkUp;
    st.reason = r.reason;
    st.jammerId = r.jammerId;
    st.rootId = r.rootId;
    st.hops = r.hops;
    if (r.since !== undefined) st.since = r.since;
    if (r.home) st.home = { ...r.home };
    st.holdAt = r.holdAt ? { ...r.holdAt } : undefined;
    st.landedFrom = r.landedFrom;
    st.tetherCut = r.tetherCut;
    st.expended = r.expended;
  }
}
