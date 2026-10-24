// Fuel and resupply. Vehicles burn fuel by the distance they drive, aircraft by the time
// they fly. Supply vehicles (with a `supply` capacity) refuel and rearm friendly
// entities that halt next to them, until their own stock runs out.

import type { Engine } from './engine.js';
import type { Entity } from './entity.js';

/** Within this distance of a halted supply vehicle, a halted entity is resupplied. */
export const RESUPPLY_RANGE = 60;
/** Fraction of a full tank transferred per second. */
const FUEL_RATE = 1 / 60;
/** Fraction of each weapon's full load transferred per second. */
const AMMO_RATE = 1 / 40;
/** Fuel fraction at which a "low on fuel" warning is logged. */
export const LOW_FUEL = 0.2;
/** Moving slower than this counts as halted. */
const HALTED = 0.5;

/** True if this entity type burns fuel. */
export function usesFuel(e: Entity): boolean {
  return !!(e.type.endurance?.km || e.type.endurance?.hours);
}

/** Burn fuel for one step (dt seconds). Out of fuel, vehicles stop and aircraft come down. */
export function burnFuel(engine: Engine, e: Entity, dt: number): void {
  if (!engine.rules.fuel || e.destroyed || e.remote || e.embarkedIn || e.fuel <= 0) return;
  const end = e.type.endurance;
  if (!end) return;
  let used = 0;
  if (e.domain === 'air') {
    if (end.hours && (e.speed > 1 || e.z - engine.terrain.surfaceHeight(e.x, e.y) > 5)) used = dt / (end.hours * 3600);
  } else if (end.km) {
    used = (e.speed * dt) / (end.km * 1000);
  }
  if (used <= 0) return;
  const before = e.fuel;
  e.fuel = Math.max(0, e.fuel - used);
  if (before > LOW_FUEL && e.fuel <= LOW_FUEL) engine.log('info', `${e.name} is low on fuel (${Math.round(LOW_FUEL * 100)}%)`, e.id);
  if (e.fuel <= 0) {
    if (e.domain === 'air') {
      e.destroyed = true;
      engine.afterDamage(e, 'kill', undefined, 'fuel exhaustion');
    } else {
      engine.log('info', `${e.name} is out of fuel`, e.id);
    }
  }
}

/** Fraction (0..1) of its full load of ammunition an entity has left, over all its weapons. */
export function ammoFraction(engine: Engine, e: Entity): number {
  let have = 0;
  let full = 0;
  for (const wid of e.type.weapons) {
    const cap = engine.catalog.weapon(wid).ammo;
    have += Math.min(cap, e.ammo.get(wid) ?? 0) / cap;
    full += 1;
  }
  return full ? have / full : 1;
}

/** True if the entity could take on fuel or ammunition. */
export function needsSupply(engine: Engine, e: Entity): boolean {
  if (usesFuel(e) && e.fuel < 0.999) return true;
  return e.type.weapons.some((w) => (e.ammo.get(w) ?? 0) < engine.catalog.weapon(w).ammo);
}

/** Supply vehicles that could serve an entity: friendly, alive, with stock left. */
export function suppliersFor(engine: Engine, e: Entity): Entity[] {
  const out: Entity[] = [];
  for (const s of engine.entities.values()) {
    if (s.type.supply && s.alive && !s.remote && !s.embarkedIn && s.force === e.force && s.supplies > 1e-6) out.push(s);
  }
  return out;
}

/** Once a second: halted supply vehicles refuel and rearm halted friendly entities beside them. */
export function updateResupply(engine: Engine, dt = 1): void {
  for (const s of engine.entities.values()) {
    if (!s.type.supply || !s.alive || s.remote || s.embarkedIn || s.supplies <= 1e-6 || s.speed > HALTED) continue;
    for (const e of engine.entities.values()) {
      if (s.supplies <= 1e-6) break;
      if (e.force !== s.force || !e.alive || e.remote || e.embarkedIn || e.speed > HALTED) continue;
      if (Math.abs(e.x - s.x) > RESUPPLY_RANGE || Math.abs(e.y - s.y) > RESUPPLY_RANGE || Math.hypot(e.x - s.x, e.y - s.y) > RESUPPLY_RANGE) continue;
      if (e.domain === 'air' && e.z - engine.terrain.surfaceHeight(e.x, e.y) > 5) continue;
      if (!needsSupply(engine, e)) continue;
      // A full load (fuel and every weapon) costs one unit of the supplier's stock.
      let cost = 0;
      if (usesFuel(e) && e.fuel < 1) {
        const add = Math.min(1 - e.fuel, FUEL_RATE * dt, s.supplies * 2);
        e.fuel += add;
        cost += add / 2;
      }
      const n = e.type.weapons.length;
      for (const wid of e.type.weapons) {
        const cap = engine.catalog.weapon(wid).ammo;
        const have = e.ammo.get(wid) ?? 0;
        if (have >= cap) continue;
        const add = Math.min(cap - have, Math.max(1, Math.round(cap * AMMO_RATE * dt)), Math.floor(((s.supplies - cost) * 2 * n * cap) + 1e-9));
        if (add <= 0) continue;
        e.ammo.set(wid, have + add);
        cost += add / cap / n / 2;
      }
      s.supplies -= cost;
      if (s.supplies < 1e-6) s.supplies = 0;
      if (!needsSupply(engine, e)) engine.log('info', `${e.name} resupplied by ${s.name}`, e.id, s.id);
      if (s.supplies <= 1e-6) engine.log('info', `${s.name} has run out of supplies`, s.id);
    }
  }
}
