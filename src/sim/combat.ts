// Direct and guided fire: target selection under rules of engagement, munition
// fly-out, hit/kill adjudication and damage states.

import { dist2d } from '../shared/math.js';
import type { ArmorClass, Vec3, WeaponDef } from '../shared/types.js';
import type { Engine } from './engine.js';
import type { Entity } from './entity.js';

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
}

export type DetonationOutcome = 'kill' | 'mobility' | 'firepower' | 'miss' | 'noEffect';

export interface Detonation {
  shot: Shot;
  location: Vec3;
  hit: boolean;
  outcome: DetonationOutcome;
  /** A command-guided missile lost guidance (launcher killed or lost sight). */
  guidanceLost?: boolean;
}

/** Effective kill probability for a shot, after range and condition modifiers. */
export function effectivePk(engine: Engine, shooter: Entity | undefined, target: Entity, weapon: WeaponDef, range: number): number {
  let pk = weapon.pk[target.type.armor] ?? 0;
  pk *= 1 - 0.5 * Math.min(1, range / weapon.maxRange) ** 2;
  if (!weapon.guided) {
    if (shooter && shooter.speed > 2) pk *= 0.7;
    if (target.speed > 8) pk *= 0.8;
  }
  if ((target.domain === 'ground' || target.domain === 'lifeform') && engine.terrain.isForest(target.x, target.y)) pk *= 0.75;
  return pk;
}

function canEngage(engine: Engine, shooter: Entity, target: Entity, w: WeaponDef, range: number): boolean {
  if (!w.targets.includes(target.domain)) return false;
  if (range < w.minRange || range > w.maxRange) return false;
  if ((w.pk[target.type.armor] ?? 0) < 0.02) return false;
  return engine.terrain.lineOfSight(shooter.eye, { x: target.x, y: target.y, z: target.z + 1.5 });
}

/** Choose and fire at most one weapon this tick, honouring ROE and explicit attack targets. */
export function updateCombat(engine: Engine, shooter: Entity): void {
  if (shooter.remote || shooter.destroyed || shooter.firepowerKill || shooter.embarkedIn) return;
  const now = engine.time;
  const candidates: Entity[] = [];
  const explicit = shooter.attackTargetId ? engine.entities.get(shooter.attackTargetId) : undefined;
  if (explicit && explicit.alive) candidates.push(explicit);
  if (shooter.roe !== 'holdFire') {
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
  // Keep the current target first, then nearest.
  const dist = new Map<Entity, number>();
  for (const t of candidates) dist.set(t, dist2d(shooter, t));
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
      if (!w.targets.includes(target.domain) || range < w.minRange || range > w.maxRange) continue;
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
  shooter.weaponReadyAt.set(w.id, now + w.reloadTime * engine.rng.range(0.9, 1.1));
  shooter.lastFiredAt = now;
  shooter.engagingId = target.id;
  const shot: Shot = {
    eventNumber: engine.nextEventNumber(),
    shooterId: shooter.id,
    targetId: target.id,
    weapon: w,
    from: { x: shooter.x, y: shooter.y, z: shooter.z + shooter.type.sensorHeight },
    to: { x: target.x, y: target.y, z: target.z + 1 },
    fireTime: now,
    impactTime: now + Math.max(0.1, range / w.projectileSpeed),
    range,
  };
  engine.launch(shot);
  // The target notices it is being engaged.
  target.attackers.set(shooter.id, now);
  target.underFireUntil = now + 15;
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
  const target = shot.targetId ? engine.entities.get(shot.targetId) : undefined;
  const shooter = engine.entities.get(shot.shooterId);
  if (!target || target.destroyed) {
    return { shot, location: shot.to, hit: false, outcome: 'noEffect' };
  }
  // Wire/command-guided missiles need the launcher to keep guiding them to impact.
  if (shot.weapon.commandGuided) {
    const guiding = shooter && shooter.alive && !shooter.firepowerKill && engine.terrain.lineOfSight(shooter.eye, { x: target.x, y: target.y, z: target.z + 1.5 });
    if (!guiding) return { shot, location: scatter(engine, target.position), hit: false, outcome: 'miss', guidanceLost: true };
  }
  // Guided munitions track the target; ballistic rounds land at the launch aim point.
  const moved = dist2d(target, shot.to);
  const tracked = shot.weapon.guided || moved < 6;
  const pk = tracked ? effectivePk(engine, shooter, target, shot.weapon, shot.range) : 0;
  const hitChance = Math.min(1, pk * 1.8);
  const hit = engine.rng.chance(hitChance);
  if (target.remote) {
    // Remote entities adjudicate their own damage from our detonation.
    const loc = hit ? target.position : scatter(engine, shot.to);
    return { shot, location: loc, hit, outcome: 'noEffect' };
  }
  if (!hit) return { shot, location: scatter(engine, shot.to), hit: false, outcome: 'miss' };
  // Given a hit, the kill probability is pk / hitChance so overall P(kill) == pk.
  const outcome = applyDamage(engine, target, pk / hitChance);
  return { shot, location: target.position, hit: true, outcome: outcome === 'miss' ? 'noEffect' : outcome };
}

function scatter(engine: Engine, p: Vec3): Vec3 {
  const a = engine.rng.range(0, Math.PI * 2);
  const r = engine.rng.range(4, 25);
  const x = p.x + Math.sin(a) * r;
  const y = p.y + Math.cos(a) * r;
  return { x, y, z: engine.terrain.surfaceHeight(x, y) };
}
