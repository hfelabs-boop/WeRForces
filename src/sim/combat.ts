// Direct and guided fire: target selection under rules of engagement, munition
// fly-out, hit/kill adjudication and damage states.

import { dist2d } from '../shared/math.js';
import type { ArmorClass, Vec2, Vec3, WeaponDef } from '../shared/types.js';
import type { Engine } from './engine.js';
import type { Entity } from './entity.js';
import type { Aspect } from './models.js';
import { accuracyFactor, exposureFactor, reloadFactor, suppress } from './morale.js';

export interface Shot {
  eventNumber: number;
  shooterId: string;
  targetId?: string;
  weapon: WeaponDef;
  from: Vec3;
  /** Aim point at launch. */
  to: Vec3;
  fireTime: number;
  impactTime: number;
  range: number;
  /** A smoke round: makes a cloud where it lands instead of a blast. */
  smoke?: boolean;
}

export type DetonationOutcome = 'kill' | 'mobility' | 'firepower' | 'miss' | 'noEffect';

export interface Detonation {
  shot: Shot;
  location: Vec3;
  hit: boolean;
  outcome: DetonationOutcome;
  /** A command-guided missile lost guidance (launcher killed or lost sight). */
  guidanceLost?: boolean;
  /** A smoke round: it made a cloud. */
  smoke?: boolean;
  /** Direct fire that hit: the face struck, and whether its armour stopped the round. */
  aspect?: Aspect;
  armourHeld?: boolean;
  /** Area-effect rounds: every local entity damaged by the blast. */
  effects?: { entityId: string; outcome: Exclude<DetonationOutcome, 'miss' | 'noEffect'> }[];
}

/** What a shot's kill chance is made of: hitting, and defeating the armour on the face it strikes. */
export interface PkParts {
  /** Kill chance if the armour is defeated, after range and condition modifiers. */
  base: number;
  /** The face struck. */
  aspect: Aspect;
  /** Chance the armour on that face is defeated (1 without armour data). */
  perforation: number;
}

/**
 * Kill chance of a shot split into its parts. `from` is where the round comes from
 * (default the shooter; with neither, it counts as a side hit).
 */
export function pkParts(engine: Engine, shooter: Entity | undefined, target: Entity, weapon: WeaponDef, range: number, from?: Vec3): PkParts {
  const models = engine.models;
  let pk = weapon.pk[target.type.armor] ?? 0;
  pk *= models.ballistic.rangeFactor(weapon, range, target.type);
  if (!weapon.guided) {
    if (shooter && shooter.speed > 2) pk *= 0.7;
    if (target.speed > 8) pk *= 0.8;
  }
  if ((target.domain === 'ground' || target.domain === 'lifeform') && engine.terrain.isForest(target.x, target.y)) pk *= 0.75;
  if (shooter) pk *= accuracyFactor(engine, shooter);
  pk *= exposureFactor(target, engine.terrain);
  const origin = from ?? shooter?.position;
  const aspect = origin ? models.hitKill.aspect(target, origin, weapon) : weapon.indirect || weapon.topAttack ? 'top' : 'side';
  return { base: pk, aspect, perforation: models.hitKill.perforation(weapon, target.type, aspect) };
}

/** Effective kill probability for a shot, after range, condition and armour modifiers. */
export function effectivePk(engine: Engine, shooter: Entity | undefined, target: Entity, weapon: WeaponDef, range: number, from?: Vec3): number {
  const p = pkParts(engine, shooter, target, weapon, range, from);
  return p.base * p.perforation;
}

function canEngage(engine: Engine, shooter: Entity, target: Entity, w: WeaponDef, range: number): boolean {
  if (!w.targets.includes(target.domain)) return false;
  if (range < w.minRange || range > w.maxRange) return false;
  if ((w.pk[target.type.armor] ?? 0) < 0.02) return false;
  return engine.losCached(shooter, target);
}

/** Choose and fire at most one weapon this tick, honouring ROE and explicit attack targets. */
export function updateCombat(engine: Engine, shooter: Entity): void {
  if (shooter.remote || shooter.destroyed || shooter.firepowerKill || shooter.embarkedIn) return;
  // An unmanned system without its datalink fires only as far as its autonomy allows.
  const mode = shooter.uxs ? engine.unmanned.fireMode(shooter) : 'free';
  if (mode === 'none') {
    shooter.engagingId = undefined;
    return;
  }
  const now = engine.time;
  const candidates: Entity[] = [];
  const explicit = shooter.attackTargetId ? engine.entities.get(shooter.attackTargetId) : undefined;
  if (explicit && explicit.alive) candidates.push(explicit);
  if (shooter.roe !== 'holdFire' && mode === 'free') {
    for (const c of shooter.contacts.values()) {
      const t = engine.entities.get(c.id);
      if (!t || t.destroyed || t.embarkedIn || t === explicit || !engine.isHostile(shooter.force, t.force)) continue;
      if (shooter.roe === 'returnFire') {
        const last = shooter.attackers.get(t.id);
        if (last === undefined || now - last > 60) continue;
      }
      candidates.push(t);
    }
  }
  if (candidates.length === 0) {
    shooter.engagingId = undefined;
    return;
  }
  // Keep the current target first, then nearest; spread fire across the unit by counting a
  // target others in the unit already engage as further away (fire distribution).
  const mates = shooter.unit?.memberList.filter((m) => m !== shooter && m.alive) ?? [];
  const dist = new Map<Entity, number>();
  for (const t of candidates) {
    const engaged = mates.reduce((n, m) => n + (m.engagingId === t.id ? 1 : 0), 0);
    dist.set(t, dist2d(shooter, t) * (1 + 0.6 * engaged));
  }
  candidates.sort((a, b) => {
    if (a === explicit) return -1;
    if (b === explicit) return 1;
    if (a.id === shooter.engagingId) return -1;
    if (b.id === shooter.engagingId) return 1;
    return dist.get(a)! - dist.get(b)!;
  });

  for (const target of candidates.slice(0, 6)) {
    const range = Math.hypot(target.x - shooter.x, target.y - shooter.y, target.z - shooter.z);
    let best: WeaponDef | undefined;
    let bestScore = 0;
    for (const wid of shooter.type.weapons) {
      if ((shooter.ammo.get(wid) ?? 0) <= 0) continue;
      const w = engine.catalog.weapon(wid);
      if (w.indirect || !w.targets.includes(target.domain) || range < w.minRange || range > w.maxRange) continue;
      const pk = effectivePk(engine, shooter, target, w, range);
      // Conserve missiles: prefer guns unless the missile is clearly better.
      const score = pk - (w.guided ? 0.15 : 0);
      if (score > bestScore) {
        bestScore = score;
        best = w;
      }
    }
    if (!best) continue;
    if ((shooter.weaponReadyAt.get(best.id) ?? 0) > now) {
      // Best weapon is reloading: stay on this target rather than switching.
      shooter.engagingId = target.id;
      return;
    }
    if (engine.hasShotInFlight(shooter.id, target.id, best)) {
      shooter.engagingId = target.id;
      return;
    }
    if (!canEngage(engine, shooter, target, best, range)) continue;
    fire(engine, shooter, target, best, range);
    return;
  }
  shooter.engagingId = undefined;
}

function fire(engine: Engine, shooter: Entity, target: Entity, w: WeaponDef, range: number): void {
  const now = engine.time;
  shooter.ammo.set(w.id, (shooter.ammo.get(w.id) ?? 0) - 1);
  shooter.weaponReadyAt.set(w.id, now + w.reloadTime * engine.rng.range(0.9, 1.1) * reloadFactor(engine, shooter));
  shooter.lastFiredAt = now;
  shooter.engagingId = target.id;
  const flight = Math.max(0.1, range / w.projectileSpeed);
  // Fire control leads a moving target: aim where it will be when the round arrives.
  // (Guided weapons steer themselves; the aim point only matters for unguided rounds.)
  const v = w.guided ? { x: 0, y: 0, z: 0 } : target.velocity;
  const shot: Shot = {
    eventNumber: engine.nextEventNumber(),
    shooterId: shooter.id,
    targetId: target.id,
    weapon: w,
    from: { x: shooter.x, y: shooter.y, z: shooter.z + shooter.type.sensorHeight },
    to: { x: target.x + v.x * flight, y: target.y + v.y * flight, z: target.z + v.z * flight + 1 },
    fireTime: now,
    impactTime: now + flight,
    range,
  };
  engine.launch(shot);
  // The target notices it is being engaged.
  target.attackers.set(shooter.id, now);
  target.underFireUntil = now + 15;
}

/** Launch an indirect-fire round at a ground point. */
export function fireIndirect(engine: Engine, shooter: Entity, w: WeaponDef, point: Vec2, smoke = false): void {
  const now = engine.time;
  shooter.ammo.set(w.id, (shooter.ammo.get(w.id) ?? 0) - 1);
  shooter.weaponReadyAt.set(w.id, now + w.reloadTime * engine.rng.range(0.9, 1.1) * reloadFactor(engine, shooter));
  shooter.lastFiredAt = now;
  const range = dist2d(shooter, point);
  engine.launch({
    eventNumber: engine.nextEventNumber(),
    shooterId: shooter.id,
    weapon: w,
    from: { x: shooter.x, y: shooter.y, z: shooter.z + 2 },
    to: { x: point.x, y: point.y, z: engine.terrain.surfaceHeight(point.x, point.y) },
    fireTime: now,
    impactTime: now + Math.max(1, range / w.projectileSpeed),
    range,
    smoke: smoke || undefined,
  });
}

/** Normal deviate (Box-Muller) from the engine's random stream. */
function gaussian(engine: Engine): number {
  const u = Math.max(1e-12, engine.rng.next());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * engine.rng.next());
}

/**
 * Area effect of a blast: each entity within the lethal radius is damaged with a
 * probability that falls off with distance from the burst. Entities that are near
 * but not hurt still come under fire.
 */
export function applyBlast(engine: Engine, w: WeaponDef, at: Vec3, shooterId?: string): NonNullable<Detonation['effects']> {
  const radius = w.blastRadius ?? 0;
  const effects: NonNullable<Detonation['effects']> = [];
  engine.spatial.invalidate();
  engine.spatial.build(engine.entities.values(), engine.time);
  for (const e of engine.spatial.query(at.x, at.y, radius * 3)) {
    if (e.destroyed || e.embarkedIn) continue;
    const d = dist2d(e, at);
    // Aircraft only suffer from bursts close to their altitude.
    if (e.domain === 'air' && Math.abs(e.z - at.z) > radius) continue;
    if (d > radius * 3) continue;
    if (!e.remote) {
      if (shooterId) e.attackers.set(shooterId, engine.time);
      e.underFireUntil = engine.time + 15;
      suppress(engine, e, 0.8 * (1 - d / (radius * 3)));
    }
    if (d > radius || e.remote) continue;
    // Blast and fragments come from above: the roof armour counts.
    let pk = (w.pk[e.type.armor] ?? 0) * (1 - d / radius) ** 2 * engine.models.hitKill.perforation(w, e.type, 'top');
    // Prone or dug-in infantry in woods are partly protected.
    if (e.domain === 'lifeform' && engine.terrain.isForest(e.x, e.y)) pk *= 0.7;
    if (pk <= 0) continue;
    const outcome = applyDamage(engine, e, pk);
    if (outcome !== 'miss' && outcome !== 'noEffect') effects.push({ entityId: e.id, outcome });
  }
  return effects;
}

const KILL_ONLY: ArmorClass[] = ['lifeform', 'air'];

/** Adjudicate damage on a local target. Returns the outcome applied. */
export function applyDamage(engine: Engine, target: Entity, pk: number): DetonationOutcome {
  const roll = engine.rng.next();
  if (roll < pk) {
    target.destroyed = true;
    return 'kill';
  }
  if (KILL_ONLY.includes(target.type.armor) || roll >= Math.min(1, pk * 1.8)) return 'miss';
  // Partial kill: mobility or firepower, escalating to a kill if both are lost.
  let mobility = engine.rng.chance(0.5);
  // A system that is already knocked out cannot be knocked out again: hit the other one.
  if (mobility && target.mobilityKill) mobility = false;
  else if (!mobility && target.firepowerKill) mobility = true;
  if (mobility) {
    if (target.firepowerKill) target.destroyed = true;
    target.mobilityKill = true;
  } else {
    if (target.mobilityKill) target.destroyed = true;
    target.firepowerKill = true;
  }
  if (target.destroyed) return 'kill';
  return mobility ? 'mobility' : 'firepower';
}

/** Resolve a munition arriving at its target. */
export function resolveImpact(engine: Engine, shot: Shot): Detonation {
  if (shot.weapon.indirect || !shot.targetId) {
    // Ballistic error grows with range.
    const w = shot.weapon;
    const sigma = (w.dispersion ?? 0) * (0.5 + 0.5 * Math.min(1, shot.range / w.maxRange));
    const x = shot.to.x + gaussian(engine) * sigma;
    const y = shot.to.y + gaussian(engine) * sigma;
    const location = { x, y, z: engine.terrain.surfaceHeight(x, y) };
    if (shot.smoke && w.smoke) {
      engine.smoke.add(location, w.smoke.radius, w.smoke.duration);
      return { shot, location, hit: false, outcome: 'noEffect', smoke: true };
    }
    const effects = w.blastRadius ? applyBlast(engine, w, location, shot.shooterId) : [];
    const outcome = effects.some((f) => f.outcome === 'kill') ? 'kill' : effects[0]?.outcome ?? 'noEffect';
    return { shot, location, hit: effects.length > 0, outcome, effects };
  }
  const target = shot.targetId ? engine.entities.get(shot.targetId) : undefined;
  const shooter = engine.entities.get(shot.shooterId);
  if (!target || target.destroyed) {
    return { shot, location: shot.to, hit: false, outcome: 'noEffect' };
  }
  // Wire/command-guided missiles need the launcher to keep guiding them to impact.
  if (shot.weapon.commandGuided) {
    const guiding = shooter && shooter.alive && !shooter.firepowerKill && engine.losCached(shooter, target);
    if (!guiding) {
      suppress(engine, target, 0.15);
      return { shot, location: scatter(engine, target.position), hit: false, outcome: 'miss', guidanceLost: true };
    }
  }
  // Guided munitions track the target; ballistic rounds land at the (led) aim point, so a
  // target that changed speed or turned while the round was in flight is missed.
  const moved = dist2d(target, shot.to);
  const tracked = shot.weapon.guided || moved < 6;
  const parts = pkParts(engine, shooter, target, shot.weapon, shot.range, shot.from);
  // Hitting does not depend on the armour; defeating it does.
  const base = tracked ? parts.base : 0;
  const hitChance = Math.min(1, base * 1.8);
  const hit = engine.rng.chance(hitChance);
  if (target.remote) {
    // Remote entities adjudicate their own damage from our detonation.
    const loc = hit ? target.position : scatter(engine, shot.to);
    return { shot, location: loc, hit, outcome: 'noEffect' };
  }
  // Rounds landing on or around a target keep its head down.
  suppress(engine, target, hit ? 0.35 : 0.25);
  if (!hit) return { shot, location: scatter(engine, shot.to), hit: false, outcome: 'miss' };
  // A hit defeats the armour on the face it strikes, or does nothing.
  if (parts.perforation < 1 && !engine.rng.chance(parts.perforation)) {
    return { shot, location: target.position, hit: true, outcome: 'noEffect', aspect: parts.aspect, armourHeld: true };
  }
  // Given a hit through the armour, the kill probability is base / hitChance, so overall
  // P(kill) is base × perforation, the effective Pk.
  const outcome = applyDamage(engine, target, base / hitChance);
  return { shot, location: target.position, hit: true, outcome: outcome === 'miss' ? 'noEffect' : outcome, aspect: parts.aspect };
}

function scatter(engine: Engine, p: Vec3): Vec3 {
  const a = engine.rng.range(0, Math.PI * 2);
  const r = engine.rng.range(4, 25);
  const x = p.x + Math.sin(a) * r;
  const y = p.y + Math.cos(a) * r;
  return { x, y, z: engine.terrain.surfaceHeight(x, y) };
}
