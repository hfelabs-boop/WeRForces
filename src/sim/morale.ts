// Suppression and morale. Incoming fire suppresses an entity for a few seconds: it
// shoots less accurately and more slowly, spots less, and infantry get pinned down.
// Units lose morale with losses and sustained suppression; shaken units fight worse,
// broken units abandon their plan and fall back until they rally.

import type { ArmorClass, MoraleState, Vec2 } from '../shared/types.js';
import type { Engine } from './engine.js';
import type { Entity } from './entity.js';
import type { Terrain } from './terrain.js';
import type { Unit } from './units.js';

/** Seconds for suppression to halve once the fire stops. */
export const SUPPRESSION_HALF_LIFE = 6;
/** Infantry at or above this suppression are pinned down. */
export const PINNED_AT = 0.6;
/** How much of a suppressive effect gets through, by armour. */
const EXPOSURE: Record<ArmorClass, number> = { lifeform: 1, soft: 0.7, light: 0.45, armored: 0.2, air: 0.4, ship: 0.2, drone: 0.4 };
/** Distance a broken unit falls back from the enemy. */
const FALL_BACK = 1500;

/** Add suppression from fire landing on or near an entity. */
export function suppress(engine: Engine, e: Entity, amount: number): void {
  if (!engine.rules.suppression || e.remote || e.destroyed || e.embarkedIn || amount <= 0) return;
  e.suppression = Math.min(1, e.suppression + amount * EXPOSURE[e.type.armor]);
}

/** Suppression wears off exponentially. */
export function decaySuppression(engine: Engine, dt: number): void {
  const k = Math.pow(0.5, dt / SUPPRESSION_HALF_LIFE);
  for (const e of engine.entities.values()) {
    if (e.suppression === 0) continue;
    e.suppression *= k;
    if (e.suppression < 0.01) e.suppression = 0;
  }
}

/** Infantry stay pinned until suppression drops back below this. */
export const UNPINNED_BELOW = 0.45;

export function isPinned(engine: Engine, e: Entity): boolean {
  if (!engine.rules.suppression || e.domain !== 'lifeform') return false;
  // Broken troops crawl away under fire rather than staying pinned.
  if (engine.rules.morale && moraleOf(e) === 'broken') return false;
  return e.suppression >= (e.pinned ? UNPINNED_BELOW : PINNED_AT);
}

/** Multiplier on the chance of hitting a target: pinned infantry are lying flat. */
export function exposureFactor(e: Entity, terrain?: Terrain): number {
  const prepared = e.prepared === 'dugIn' ? 0.4 : e.prepared === 'hullDown' ? 0.6 : 1;
  // Troops in buildings have cover.
  const buildings = terrain && e.domain === 'lifeform' && !e.prepared && terrain.isBuiltUp(e.x, e.y) ? 0.6 : 1;
  return (e.pinned ? 0.5 : 1) * prepared * buildings;
}

function moraleOf(e: Entity): MoraleState {
  return e.unit ? e.unit.moraleState : e.moraleState;
}

/** Multiplier on a shooter's kill probability from suppression and morale. */
export function accuracyFactor(engine: Engine, shooter: Entity): number {
  let f = 1;
  if (engine.rules.suppression) f *= 1 - 0.6 * shooter.suppression;
  if (engine.rules.morale) {
    const m = moraleOf(shooter);
    if (m === 'shaken') f *= 0.8;
    else if (m === 'broken') f *= 0.6;
  }
  return f;
}

/** Multiplier on reload time from suppression. */
export function reloadFactor(engine: Engine, shooter: Entity): number {
  return engine.rules.suppression ? 1 + shooter.suppression : 1;
}

/** Multiplier on an observer's detection probability from suppression. */
export function spotFactor(engine: Engine, observer: Entity): number {
  return engine.rules.suppression ? 1 - 0.5 * observer.suppression : 1;
}

function stateFor(m: number, current: MoraleState): MoraleState {
  if (current === 'broken') return m >= 0.4 ? 'shaken' : 'broken';
  return m < 0.25 ? 'broken' : m < 0.5 ? 'shaken' : 'steady';
}

/** Where a broken force falls back to: away from the nearest enemy it knows of. */
function fallBackPoint(engine: Engine, members: Entity[]): Vec2 {
  let x = 0;
  let y = 0;
  for (const m of members) {
    x += m.x;
    y += m.y;
  }
  const c = { x: x / members.length, y: y / members.length };
  let enemy: Vec2 | null = null;
  let best = Infinity;
  for (const m of members) {
    for (const k of m.contacts.values()) {
      const t = engine.entities.get(k.id);
      if (!t || t.destroyed || !engine.isHostile(m.force, t.force)) continue;
      const d = Math.hypot(k.x - c.x, k.y - c.y);
      if (d < best) {
        best = d;
        enemy = k;
      }
    }
  }
  // With no known enemy, fall back the way it came.
  const h = members[0].heading;
  const dir = enemy && best > 1 ? { x: (c.x - enemy.x) / best, y: (c.y - enemy.y) / best } : { x: -Math.sin(h), y: -Math.cos(h) };
  const size = engine.terrain.spec.size;
  const p = { x: Math.min(size, Math.max(0, c.x + dir.x * FALL_BACK)), y: Math.min(size, Math.max(0, c.y + dir.y * FALL_BACK)) };
  return engine.findValidPosition(p, members[0].domain) ?? c;
}

interface MoraleSubject {
  name: string;
  id: string;
  morale: number;
  moraleState: MoraleState;
}

/** One second of morale for a unit or a lone entity. Returns the new state. */
function step(engine: Engine, who: MoraleSubject, alive: Entity[], size: number, newLosses: number, lost: number): MoraleState {
  let m = who.morale;
  // Losing about a third of the unit leaves it shaken on its own; heavy fire wears it down further.
  m -= (newLosses * 1.5) / size;
  const supp = alive.reduce((s, e) => s + e.suppression, 0) / alive.length;
  if (supp > 0.2) m -= 0.05 * (supp - 0.2);
  const underFire = alive.some((e) => e.underFireUntil > engine.time);
  // Losses cap how far morale recovers.
  const cap = 1 - (0.5 * lost) / size;
  if (!underFire && m < cap) m = Math.min(cap, m + 0.01);
  who.morale = Math.max(0, Math.min(1, m));
  const next = stateFor(who.morale, who.moraleState);
  const prev = who.moraleState;
  who.moraleState = next;
  if (next !== prev) {
    const text = next === 'broken' ? 'broke and is falling back' : prev === 'broken' ? 'rallied' : next === 'shaken' ? 'is shaken' : 'is steady again';
    engine.log('info', `${who.name} ${text}`, who.id);
  }
  return prev;
}

function breakUnit(engine: Engine, u: Unit): void {
  const alive = u.alive();
  u.plan = null;
  for (const m of u.memberList) m.roe = 'returnFire';
  u.startTask(engine, { type: 'moveTo', target: fallBackPoint(engine, alive), covered: true });
}

function breakEntity(engine: Engine, e: Entity): void {
  e.plan = null;
  e.roe = 'returnFire';
  engine.assignTaskInternal(e, { type: 'moveTo', target: fallBackPoint(engine, [e]), covered: true });
}

/** Run once per simulated second. */
export function updateMorale(engine: Engine): void {
  if (!engine.rules.morale) return;
  for (const u of engine.units.values()) {
    const alive = u.alive().filter((m) => !m.remote);
    if (alive.length === 0) continue;
    const lost = u.memberList.length - u.alive().length;
    const prev = step(engine, u, alive, u.memberList.length, lost - u.lossesSeen, lost);
    u.lossesSeen = lost;
    if (u.moraleState === 'broken' && prev !== 'broken') breakUnit(engine, u);
    // Rallying: stop where it is and wait for orders.
    if (prev === 'broken' && u.moraleState !== 'broken') {
      u.taskSpec = null;
      if (u.leader) engine.setEntityTask(u.leader, null);
      u.formUp(engine);
    }
  }
  for (const e of engine.entities.values()) {
    if (e.unit || e.remote || e.destroyed || e.embarkedIn || e.domain === 'air') continue;
    const prev = step(engine, e, [e], 1, 0, 0);
    if (e.moraleState === 'broken' && prev !== 'broken') breakEntity(engine, e);
    if (prev === 'broken' && e.moraleState !== 'broken') engine.setEntityTask(e, null);
  }
}
