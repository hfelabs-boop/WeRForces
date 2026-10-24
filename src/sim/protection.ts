// Hard-kill countermeasures on platforms. Active protection systems (Trophy, Arena) fire a
// charge at an incoming missile, rocket or loitering munition coming from inside their
// arc, defeating it with a probability; charges run out. Aircraft release flares and chaff
// automatically on missile launch warning, cutting that missile's kill chance while
// salvos last. Both act on the shot flow in combat.ts and leave the armour and ballistic
// models alone.

import { angleDiff, bearing, DEG } from '../shared/math.js';
import type { Vec3, WeaponDef } from '../shared/types.js';
import type { Shot } from './combat.js';
import type { Engine } from './engine.js';
import type { Entity } from './entity.js';

/** Whether active protection can engage this munition: explicit, or guided missiles and slow rockets fired at ground targets. */
export function apsDefeatable(w: WeaponDef): boolean {
  if (w.apsDefeatable !== undefined) return w.apsDefeatable;
  if (w.indirect || !w.targets.includes('ground')) return false;
  return !!w.guided || (!!w.penetration && w.projectileSpeed < 400);
}

/**
 * Active protection against a threat arriving at `target` from `from`: it fires a charge
 * if it has one, the threat comes from inside its arc and, for top attack, it covers the
 * roof. Logs what happened; true when the threat is defeated. One-way attack drones and
 * other threats outside the shot flow can call it too.
 */
export function activeProtection(engine: Engine, target: Entity, from: Vec3, threat: string, topAttack: boolean): boolean {
  const aps = target.type.aps;
  if (!aps || target.apsLeft <= 0 || target.remote || target.destroyed) return false;
  if (topAttack && !aps.top) return false;
  const arc = (aps.arc ?? 360) * DEG;
  if (arc < 2 * Math.PI - 1e-6 && Math.abs(angleDiff(target.heading, bearing(target, from))) > arc / 2) return false;
  target.apsLeft--;
  const defeated = engine.rng.chance(aps.pk);
  const name = aps.name ?? 'active protection';
  const left = `${target.apsLeft} charge${target.apsLeft === 1 ? '' : 's'} left`;
  engine.log('info', `${target.name}: ${name} ${defeated ? `defeated an incoming ${threat}` : `fired at an incoming ${threat} and missed`} (${left})`, target.id);
  return defeated;
}

/** Active protection against a shot about to strike its target. */
export function interceptShot(engine: Engine, shot: Shot, target: Entity): boolean {
  if (!target.type.aps || target.apsLeft <= 0 || !apsDefeatable(shot.weapon)) return false;
  const top = engine.models.hitKill.aspect(target, shot.from, shot.weapon) === 'top';
  return activeProtection(engine, target, shot.from, shot.weapon.name, top);
}

/** On launch: an aircraft warned of a guided missile coming at it releases flares and chaff. */
export function releaseDecoys(engine: Engine, shot: Shot): void {
  const target = shot.targetId ? engine.entities.get(shot.targetId) : undefined;
  if (!target || target.remote || target.destroyed || target.domain !== 'air' || !shot.weapon.guided) return;
  if (!target.type.decoys || target.decoysLeft <= 0) return;
  target.decoysLeft--;
  shot.decoyed = true;
  engine.log('info', `${target.name} released flares and chaff (${target.decoysLeft} salvo${target.decoysLeft === 1 ? '' : 's'} left)`, target.id);
}

/** Multiplier on a shot's kill chance from decoys it was fired at. */
export function decoyFactor(shot: Shot, target: Entity): number {
  return shot.decoyed ? (target.type.decoys?.pkFactor ?? 1) : 1;
}
