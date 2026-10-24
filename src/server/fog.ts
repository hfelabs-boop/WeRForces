// Fog of war and roles. A player sees its own force in full, other forces' entities
// only as its sensor contacts (at their last seen position), and commands only its
// own force. The controller (exercise control) sees and commands everything.

import type { Engine } from '../sim/engine.js';
import type { Contact } from '../sim/entity.js';
import type { Command, Condition, EntitySnapshot, ForceId, PlanStatement, Role, SimEvent, SimState, TaskSpec, UnitSnapshot } from '../shared/types.js';

export const CONTROLLER: Role = { kind: 'controller' };

export class ForbiddenError extends Error {}

/** Freshest contact per target held by any living entity of the force. */
export function contactsOf(engine: Engine, force: ForceId): Map<string, Contact> {
  const out = new Map<string, Contact>();
  for (const e of engine.entities.values()) {
    if (e.force !== force || e.destroyed) continue;
    for (const c of e.contacts.values()) {
      const t = engine.entities.get(c.id);
      if (!t || t.force === force) continue;
      const have = out.get(c.id);
      if (!have || c.lastSeen > have.lastSeen) out.set(c.id, c);
    }
  }
  return out;
}

function contactView(engine: Engine, real: EntitySnapshot, c: Contact): EntitySnapshot {
  const age = Math.max(0, engine.time - c.lastSeen);
  const type = engine.catalog.types.get(real.typeId);
  return {
    id: real.id,
    name: `${type?.name ?? real.typeId} (${real.id})`,
    typeId: real.typeId,
    force: real.force,
    domain: real.domain,
    symbol: real.symbol,
    x: c.x,
    y: c.y,
    z: c.z,
    agl: c.z - engine.terrain.surfaceHeight(c.x, c.y),
    heading: real.heading,
    pitch: 0,
    // Movement is only apparent while the contact is being watched.
    speed: age < 2 ? real.speed : 0,
    damage: real.damage,
    remote: real.remote,
    roe: 'fireAtWill',
    ammo: [],
    contacts: [],
    contactAge: Math.round(age * 10) / 10,
  };
}

/**
 * Another force's aggregated unit as a contact: where it was last seen, its echelon and
 * the types and numbers seen, nothing of its orders, ammunition or fuel.
 */
function aggregateContactView(engine: Engine, real: UnitSnapshot, force: ForceId): UnitSnapshot | null {
  const unit = engine.units.get(real.id);
  const seen = unit && real.aggregate ? engine.aggregates.seenBy(unit, force) : undefined;
  if (!seen || !real.aggregate) return null;
  const age = Math.max(0, engine.time - seen.lastSeen);
  const a = real.aggregate;
  return {
    id: real.id,
    name: `enemy ${real.echelon} (${real.id})`,
    force: real.force,
    echelon: real.echelon,
    formation: real.formation,
    // Its leader's id lets players order an attack on it; nothing else of its members.
    leaderId: real.leaderId,
    memberIds: [],
    x: seen.x,
    y: seen.y,
    aggregate: {
      alive: a.alive,
      total: a.alive,
      strength: a.strength.filter((g) => g.alive > 0).map((g) => ({ typeId: g.typeId, name: g.name, alive: g.alive, total: g.alive })),
      heading: a.heading,
      speed: age < 2 ? a.speed : 0,
      posture: a.posture,
      typeId: a.typeId,
      domain: a.domain,
      symbol: a.symbol,
      contactAge: Math.round(age * 10) / 10,
    },
  };
}

/** The state a player of `force` is allowed to see. */
export function filterState(engine: Engine, s: SimState, force: ForceId): SimState {
  const seen = contactsOf(engine, force);
  const entities: EntitySnapshot[] = [];
  for (const e of s.entities) {
    // A spoofed navigator does not know it is.
    if (e.force === force) entities.push(e.gnss === 'spoofed' ? { ...e, gnss: undefined, navError: undefined } : e);
    else {
      const c = seen.get(e.id);
      if (c && !e.embarkedIn) entities.push(contactView(engine, e, c));
    }
  }
  return {
    ...s,
    entities,
    // Other forces' aggregated units appear as contacts once this force has seen them.
    units: s.units.flatMap((u) => (u.force === force ? [u] : u.aggregate ? (aggregateContactView(engine, u, force) ?? []) : [])),
    // Obstacles can be seen; an enemy minefield only once this force knows about it.
    graphics: s.graphics.filter((g) => g.force === force || g.force === 0 || g.kind === 'obstacle' || (g.kind === 'minefield' && (g.knownBy ?? []).includes(force))),
    // Orders, plan timings and alerts only for this force's own units and entities.
    orders: s.orders?.filter((o) => forceOf(engine, o.targetId) === force),
    schedule: s.schedule?.filter((o) => forceOf(engine, o.targetId) === force),
    alerts: s.alerts?.filter((a) => a.force === force),
    // Emitters this force's direction finders have located.
    dfContacts: ((list) => (list.length ? list : undefined))((s.dfContacts ?? []).filter((c) => c.force === force)),
    dis: undefined,
  };
}

function forceOf(engine: Engine, id: string): ForceId | undefined {
  return engine.findEntity(id)?.force ?? engine.units.get(id)?.force;
}

/** Kinds of another force's events a player notices when they are aimed at its own. */
const PERCEIVED = new Set<SimEvent['kind']>(['fire', 'detonation', 'damaged', 'destroyed']);

/** How a player refers to another force's entity: by type and id, not its real name. */
function contactName(engine: Engine, id: string): string | undefined {
  const e = engine.findEntity(id);
  return e ? `${e.type.name} (${id})` : undefined;
}

/**
 * Events a player may see: those involving its own entities or units, and general
 * announcements. Other forces' entities are named as contacts, not by their real names.
 */
export function filterEvents(engine: Engine, events: SimEvent[], force: ForceId): SimEvent[] {
  // Members inside aggregated units count too (their losses are reported while hidden).
  const forceOf = (id?: string) => (id ? (engine.findEntity(id)?.force ?? engine.units.get(id)?.force) : undefined);
  const out: SimEvent[] = [];
  for (const ev of events) {
    // Another force's doings show only when they land on this force: being shot at,
    // hit or killed. Its radio traffic, detections and orders stay hidden.
    const visible = (ev.kind === 'info' && !ev.entityId) || forceOf(ev.entityId) === force || (forceOf(ev.targetId) === force && PERCEIVED.has(ev.kind));
    if (!visible) continue;
    let text = ev.text;
    for (const id of [ev.entityId, ev.targetId]) {
      if (!id || forceOf(id) === force) continue;
      const e = engine.findEntity(id);
      const alias = contactName(engine, id);
      if (e && alias) text = text.split(e.name).join(alias);
      // Nor the name of its unit.
      if (e?.unit && text.includes(e.unit.name)) text = text.split(e.unit.name).join(`enemy unit (${e.unit.id})`);
      const u = engine.units.get(id);
      if (u && text.includes(u.name)) text = text.split(u.name).join(`enemy unit (${u.id})`);
    }
    out.push(text === ev.text ? ev : { ...ev, text });
  }
  return out;
}

/** True if the role may see this entity (own force, or detected). */
export function canSee(engine: Engine, role: Role, id: string): boolean {
  if (role.kind === 'controller') return true;
  const e = engine.entities.get(id);
  if (!e) return false;
  return e.force === role.force || contactsOf(engine, role.force).has(id);
}

const PLAYER_COMMANDS = new Set<Command['cmd']>([
  'assignTask',
  'assignPlan',
  'stop',
  'setRoe',
  'setReactions',
  'setFormation',
  'rename',
  'createGraphic',
  'updateGraphic',
  'deleteObject',
  'embark',
  'disembark',
  'ackAlert',
  'sendCodeword',
  'setSyncMatrix',
  'startPhase',
  'setJamming',
  'setEmcon',
  'drive',
  'batch',
  'aggregate',
  'disaggregate',
]);

/**
 * Throws ForbiddenError unless the role may run the command. Players may only order
 * their own force, refer to objects they can see, and edit their own graphics.
 */
export function checkCommand(engine: Engine, role: Role, raw: unknown): void {
  if (role.kind === 'controller') return;
  const force = role.force;
  const c = (raw ?? {}) as Command & Record<string, unknown>;
  if (!PLAYER_COMMANDS.has(c.cmd)) throw new ForbiddenError(`players cannot ${String(c.cmd ?? 'do that')}; ask exercise control`);
  const ownObject = (id: unknown, what: string) => {
    const s = String(id);
    const f = engine.findEntity(s)?.force ?? engine.units.get(s)?.force ?? engine.graphics.get(s)?.force;
    if (f === undefined) return; // unknown ids fail later with the usual error
    if (f !== force) throw new ForbiddenError(`${what} ${s} is not under your command`);
  };
  const visible = (id: unknown) => {
    const s = String(id);
    if (engine.entities.has(s) && !canSee(engine, role, s)) throw new ForbiddenError(`unknown entity ${s}`);
    if (engine.units.has(s) && engine.units.get(s)!.force !== force) throw new ForbiddenError(`unknown unit ${s}`);
    // A member of another force's aggregate: only once the aggregate has been seen.
    const holder = engine.aggregates.holding(s);
    if (holder && holder.force !== force && !engine.aggregates.seenBy(holder.unit, force)) throw new ForbiddenError(`unknown entity ${s}`);
  };
  const graphicOk = (id: unknown) => {
    const g = engine.graphics.get(String(id));
    if (g && g.force !== force && g.force !== 0) throw new ForbiddenError(`unknown graphic ${String(id)}`);
  };
  const task = (t: TaskSpec | undefined) => {
    if (!t || typeof t !== 'object') return;
    if (t.type === 'attack' || t.type === 'follow') visible(t.targetId);
    if (t.type === 'mount') ownObject(t.carrierId, 'carrier');
    if (t.type === 'followRoute' || t.type === 'patrol') graphicOk(t.routeId);
    if (t.type === 'formation') ownObject(t.leaderId, 'leader');
  };
  const condition = (cond: Condition | undefined) => {
    const c = cond as (Condition & { areaId?: string; entityId?: string; conditions?: Condition[]; condition?: Condition }) | undefined;
    if (!c || typeof c !== 'object') return;
    if (c.areaId) graphicOk(c.areaId);
    if (c.entityId) visible(c.entityId);
    if (Array.isArray(c.conditions)) c.conditions.forEach(condition);
    if (c.condition) condition(c.condition);
  };
  const statement = (st: PlanStatement) => {
    if (st?.kind === 'task') task(st.task);
    if (st?.kind === 'waitUntil' || st?.kind === 'if' || st?.kind === 'while') condition(st.condition);
    if (st?.kind === 'if') [...(st.then ?? []), ...(st.else ?? [])].forEach(statement);
    if (st?.kind === 'while') (st.body ?? []).forEach(statement);
  };
  switch (c.cmd) {
    case 'batch':
      for (const sub of Array.isArray(c.commands) ? c.commands : []) checkCommand(engine, role, sub);
      return;
    case 'assignTask':
      ownObject(c.targetId, 'object');
      task(c.task);
      return;
    case 'assignPlan':
      ownObject(c.targetId, 'object');
      for (const st of (c.plan?.statements ?? []) as PlanStatement[]) statement(st);
      return;
    case 'stop':
    case 'setRoe':
    case 'setReactions':
    case 'setEmcon':
      ownObject(c.targetId, 'object');
      return;
    case 'setFormation':
    case 'aggregate':
    case 'disaggregate':
      ownObject(c.unitId, 'unit');
      return;
    case 'drive':
      ownObject(c.id, 'object');
      if (c.targetId) visible(c.targetId);
      return;
    case 'setJamming':
    case 'rename':
    case 'updateGraphic':
      ownObject(c.id, 'object');
      return;
    case 'deleteObject':
      if (!engine.graphics.has(String(c.id))) throw new ForbiddenError('players can only delete their own graphics');
      ownObject(c.id, 'graphic');
      return;
    case 'createGraphic':
      // Players draw for their own force.
      (c as { force?: ForceId }).force = force;
      return;
    case 'embark':
      ownObject(c.passengerId, 'passenger');
      ownObject(c.carrierId, 'carrier');
      return;
    case 'disembark':
      ownObject(c.carrierId, 'carrier');
      return;
    case 'sendCodeword':
      if (Number(c.force) !== force) throw new ForbiddenError('players send codewords to their own force only');
      return;
    case 'setSyncMatrix':
    case 'startPhase':
      if (Number(c.force) !== force) throw new ForbiddenError("players plan for their own force only");
      if (c.cmd === 'setSyncMatrix') {
        for (const p of (Array.isArray(c.phases) ? c.phases : []) as { orders?: { targetId?: string; task?: TaskSpec }[]; trigger?: { ownerId?: string; condition?: Condition } }[]) {
          for (const o of p?.orders ?? []) {
            ownObject(o?.targetId, 'object');
            task(o?.task);
          }
          if (p?.trigger?.ownerId) ownObject(p.trigger.ownerId, 'object');
          condition(p?.trigger?.condition);
        }
      }
      return;
    case 'ackAlert':
      // Players acknowledge their own force's alerts only.
      (c as { force?: ForceId }).force = force;
      return;
  }
}

/** Parse "blue:KEY", "red:KEY", "2:KEY" into a player force and key. */
export function parsePlayer(spec: string): { force: ForceId; key: string } {
  const i = spec.indexOf(':');
  if (i <= 0 || i === spec.length - 1) throw new Error(`--player expects force:key, e.g. blue:s3cret (got "${spec}")`);
  const name = spec.slice(0, i).toLowerCase();
  const forces: Record<string, ForceId> = { other: 0, blue: 1, red: 2, neutral: 3, '0': 0, '1': 1, '2': 2, '3': 3 };
  const force = forces[name];
  if (force === undefined) throw new Error(`unknown force "${name}" (use blue, red or neutral)`);
  return { force, key: spec.slice(i + 1) };
}
