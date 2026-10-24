// The situation a commander decides on: its own force in full (strength, fuel,
// ammunition, morale, what each unit is doing), the enemy only as its force's contacts
// (with their age), its graphics, the towns, its phases and the time. Enemy information
// comes from the player's fog-of-war view, so a commander knows what a player would.

import type { Domain, EntityTypeDef, ForceId, MoraleState, Roe, SimState, Vec2 } from '../../shared/types.js';
import { filterState } from '../../server/fog.js';
import type { CatalogIndex } from '../catalog.js';
import type { Engine } from '../engine.js';
import type { Entity } from '../entity.js';
import { ammoFraction, usesFuel } from '../supply.js';

export type Role = 'maneuver' | 'fires' | 'recon' | 'supply' | 'air' | 'airDefense' | 'hq' | 'other';

/** One of the force's units, or an entity not in a unit. */
export interface OwnElement {
  id: string;
  name: string;
  kind: 'unit' | 'entity';
  role: Role;
  echelon?: string;
  parentId?: string;
  childIds?: string[];
  x: number;
  y: number;
  domain: Domain;
  alive: number;
  total: number;
  /** Combat power left (see typePower). */
  power: number;
  /** Average fuel of its vehicles (0..1), when they use fuel. */
  fuel?: number;
  /** Average ammunition left (0..1). */
  ammo: number;
  /** Supply vehicles: loads left. */
  supplies?: number;
  morale?: number;
  moraleState?: MoraleState;
  /** Members under fire in the last few seconds, or pinned down. */
  underFire: number;
  pinned: number;
  roe: Roe;
  /** What it is doing, in words ("idle" when nothing). */
  activity: string;
  /** Carrying out an order (or one is on its way). */
  busy: boolean;
  /** Whose order it is carrying out: this commander's, someone else's (a person or a plan) it leaves alone, or none. */
  control: 'commander' | 'other' | 'none';
  /** Longest direct-fire and indirect-fire reach of its living members (m). */
  directRange: number;
  indirectRange?: number;
}

export interface Contact {
  id: string;
  typeId: string;
  /** Type name, as a player sees it ("T-72B3"). */
  type: string;
  domain: Domain;
  symbol: string;
  x: number;
  y: number;
  /** Seconds since it was last seen. */
  age: number;
  /** m/s while it is watched, else 0. */
  speed: number;
  destroyed: boolean;
  power: number;
}

export interface SitGraphic {
  id: string;
  name: string;
  kind: string;
  points: Vec2[];
  center: Vec2;
}

export interface Situation {
  time: number;
  localTime?: string;
  period?: string;
  force: ForceId;
  /** Why this decision is being made: start, scheduled, contact, losses, phase, idle, asked. */
  trigger: string;
  mapSize: number;
  towns: { name: string; x: number; y: number }[];
  own: OwnElement[];
  contacts: Contact[];
  graphics: SitGraphic[];
  phases: { id: string; name: string; trigger: string; started?: number }[];
  codewords: string[];
  /** Own entities lost so far, and enemy ones it has seen destroyed. */
  losses: { own: number; enemySeen: number };
  /** Open alerts for this force (texts). */
  alerts: string[];
}

const PROTECTION: Record<string, number> = { armored: 3, light: 1.4, soft: 0.6, lifeform: 0.5, air: 2, ship: 3 };

/**
 * Rough combat power of an entity type: its best direct-fire weapon's lethality (mostly
 * against armour), scaled by reach, times how hard it is to kill. An M1A2 is about 2.8,
 * a T-72B3 1.9, an M2A3 or BMP-2 1.2, a rifleman 0.08.
 */
export function typePower(t: EntityTypeDef, catalog: CatalogIndex): number {
  let fire = 0;
  for (const wid of t.weapons) {
    const w = catalog.weapons.get(wid);
    if (!w || w.indirect) continue;
    const pk = w.pk;
    const lethal = 0.6 * (pk.armored ?? 0) + 0.25 * (pk.light ?? 0) + 0.15 * (pk.lifeform ?? 0) + (w.targets.includes('air') ? 0.1 * (pk.air ?? 0) : 0);
    fire = Math.max(fire, lethal * Math.min(1.3, Math.max(0.2, w.maxRange / 3000)));
  }
  return Math.round((fire * (PROTECTION[t.armor] ?? 1) + 0.05) * 100) / 100;
}

function entityPower(e: Entity, catalog: CatalogIndex, engine: Engine): number {
  if (!e.alive) return 0;
  if (e.firepowerKill) return 0.05;
  const p = typePower(e.type, catalog) * (e.mobilityKill ? 0.7 : 1);
  // Nearly out of ammunition, it cannot fight for long.
  return p * Math.min(1, 0.3 + ammoFraction(engine, e));
}

function roleOf(members: Entity[], engine: Engine, hasChildren: boolean, name: string): Role {
  if (hasChildren) return 'hq';
  const types = members.map((m) => m.type);
  if (!types.length) return 'other';
  const some = (f: (t: EntityTypeDef) => boolean) => types.filter(f).length * 2 >= types.length;
  if (some((t) => t.weapons.some((w) => engine.catalog.weapons.get(w)?.indirect))) return 'fires';
  if (some((t) => !!t.supply)) return 'supply';
  if (some((t) => t.domain === 'air')) return 'air';
  if (some((t) => t.symbol === 'air-defense')) return 'airDefense';
  if (some((t) => t.symbol === 'recon') || /\b(scouts?|recon(naissance)?)\b/i.test(name)) return 'recon';
  if (some((t) => t.symbol === 'engineer' || t.symbol === 'ew' || t.weapons.length === 0)) return 'other';
  return 'maneuver';
}

function ranges(members: Entity[], engine: Engine): { direct: number; indirect?: number } {
  let direct = 0;
  let indirect = 0;
  for (const m of members) {
    if (!m.alive || m.firepowerKill) continue;
    for (const wid of m.type.weapons) {
      const w = engine.catalog.weapons.get(wid);
      if (!w || (m.ammo.get(wid) ?? 0) <= 0) continue;
      if (w.indirect) indirect = Math.max(indirect, w.maxRange);
      else direct = Math.max(direct, w.maxRange);
    }
  }
  return { direct, indirect: indirect || undefined };
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : undefined);
const r1 = (v: number) => Math.round(v);

/** Control and activity of each own unit and loose entity, worked out by the commander's host. */
export type ControlOf = (id: string) => { busy: boolean; control: OwnElement['control'] };

/**
 * The situation for a force's commander. Enemy contacts come from the player's view of
 * the state (filterState); own units are read in full.
 */
export function buildSituation(engine: Engine, force: ForceId, trigger: string, controlOf: ControlOf, full?: SimState): Situation {
  const view = filterState(engine, full ?? engine.snapshot(), force);
  const own: OwnElement[] = [];
  const element = (id: string, name: string, kind: 'unit' | 'entity', members: Entity[], extra: Partial<OwnElement>, activity: string | undefined): OwnElement => {
    const living = members.filter((m) => m.alive);
    const lead = living[0] ?? members[0];
    const fuel = avg(living.filter((m) => usesFuel(m) && engine.rules.fuel).map((m) => m.fuel));
    const supplies = living.filter((m) => m.type.supply).reduce((s, m) => s + m.supplies, 0);
    const rg = ranges(living, engine);
    const c = controlOf(id);
    const pos = extra.x !== undefined ? { x: extra.x, y: extra.y! } : lead ? { x: lead.x, y: lead.y } : { x: 0, y: 0 };
    return {
      id,
      name,
      kind,
      role: 'other',
      domain: lead?.domain ?? 'ground',
      alive: living.length,
      total: members.length,
      power: Math.round(living.reduce((s, m) => s + entityPower(m, engine.catalog, engine), 0) * 100) / 100,
      fuel: fuel === undefined ? undefined : Math.round(fuel * 100) / 100,
      ammo: Math.round((avg(living.map((m) => ammoFraction(engine, m))) ?? 0) * 100) / 100,
      supplies: members.some((m) => m.type.supply) ? Math.round(supplies * 10) / 10 : undefined,
      underFire: living.filter((m) => m.underFireUntil > engine.time).length,
      pinned: living.filter((m) => m.pinned).length,
      roe: lead?.roe ?? 'fireAtWill',
      activity: activity ?? 'idle',
      busy: c.busy,
      control: c.control,
      directRange: rg.direct,
      indirectRange: rg.indirect,
      ...extra,
      x: r1(pos.x),
      y: r1(pos.y),
    };
  };
  for (const u of view.units) {
    const unit = engine.units.get(u.id);
    if (!unit) continue;
    const members = unit.memberList.filter((m) => !m.embarkedIn || m.alive);
    const el = element(u.id, u.name, 'unit', members, { echelon: u.echelon, parentId: u.parentId, childIds: u.childIds, x: u.x, y: u.y, morale: u.morale, moraleState: u.moraleState }, u.plan ?? u.task);
    el.role = roleOf(unit.memberList, engine, !!u.childIds?.length, u.name);
    own.push(el);
  }
  for (const e of view.entities) {
    if (e.force !== force || e.unitId || e.ambient || e.embarkedIn || e.remote) continue;
    const ent = engine.entities.get(e.id);
    if (!ent) continue;
    const el = element(e.id, e.name, 'entity', [ent], { moraleState: e.moraleState, morale: e.morale }, e.plan ?? e.task);
    el.role = roleOf([ent], engine, false, e.name);
    own.push(el);
  }
  const contacts: Contact[] = [];
  let enemySeen = 0;
  for (const e of view.entities) {
    if (e.force === force || e.contactAge === undefined || !engine.isHostile(force, e.force)) continue;
    const t = engine.catalog.types.get(e.typeId);
    const destroyed = e.damage === 'destroyed';
    if (destroyed) enemySeen++;
    contacts.push({
      id: e.id,
      typeId: e.typeId,
      type: t?.name ?? e.typeId,
      domain: e.domain,
      symbol: e.symbol,
      x: r1(e.x),
      y: r1(e.y),
      age: e.contactAge,
      speed: Math.round(e.speed * 10) / 10,
      destroyed,
      power: destroyed || !t ? 0 : e.damage === 'firepower' ? 0.05 : typePower(t, engine.catalog) * (e.damage === 'mobility' ? 0.7 : 1),
    });
  }
  const sync = view.sync?.find((m) => m.force === force);
  const codewords: string[] = [];
  for (const k of engine.codewords.keys()) if (k.startsWith(`${force}|`)) codewords.push(k.slice(k.indexOf('|') + 1));
  return {
    time: Math.round(engine.time),
    localTime: engine.env.localTime,
    period: engine.env.period,
    force,
    trigger,
    mapSize: engine.terrain.spec.size,
    towns: engine.terrain.towns.map((t) => ({ name: t.name, x: r1(t.x), y: r1(t.y) })),
    own: own.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    contacts: contacts.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    graphics: view.graphics
      .filter((g) => g.points.length)
      .map((g) => ({ id: g.id, name: g.name, kind: g.kind, points: g.points.map((p) => ({ x: r1(p.x), y: r1(p.y) })), center: centroid(g.points) })),
    phases: (sync?.phases ?? []).map((p) => ({ id: p.id, name: p.name, trigger: p.trigger.type, started: sync?.started[p.id] })),
    codewords,
    losses: { own: [...engine.entities.values()].filter((e) => e.force === force && !e.ambient && e.destroyed).length, enemySeen },
    alerts: (view.alerts ?? []).filter((a) => !a.acknowledged).slice(0, 10).map((a) => a.text),
  };
}

export function centroid(points: Vec2[]): Vec2 {
  const n = points.length || 1;
  return { x: r1(points.reduce((s, p) => s + p.x, 0) / n), y: r1(points.reduce((s, p) => s + p.y, 0) / n) };
}
