// Navigation under GNSS denial. Entities that navigate by satellite (types with `gnss`, and
// unmanned systems) and lose their fix to enemy jamming fall back on inertial navigation:
// where they think they are drifts away from where they are, by the navigation model's
// error for the time since the fix was lost (see models.ts). Tasks steer by the believed
// position, so moves end off target and routes are flown off track; the fix comes back
// as soon as the jamming stops. A spoofing jammer gives a false fix instead, walking the
// believed position away from the spoofer without the navigator noticing.
//
// GNSS-guided munitions (WeaponDef.gnss) lose their fix from where their path first comes
// into a hostile GNSS jammer's reach, and miss by the inertial error they gather by impact.

import { bearing } from '../shared/math.js';
import type { EntityTypeDef, Vec2 } from '../shared/types.js';
import type { Shot } from './combat.js';
import type { Engine } from './engine.js';
import type { Entity } from './entity.js';
import { circularHitChance, DEFAULT_INS_DRIFT, DEFAULT_MUNITION_INS_DRIFT, presentedRadius } from './models.js';
import type { Task } from './tasks.js';

/** Tasks that keep station by sight (on a leader, a target, a carrier), so a drifting fix does not throw them off. */
const BY_SIGHT = new Set(['formation', 'follow', 'attack', 'manual', 'mount', 'dismount', 'resupply']);
/** Points sampled along a munition's path when looking for where it enters a jammer's reach. */
const PATH_SAMPLES = 20;

/** Navigates by satellite: types that say so, and unmanned systems. */
export function navigatesByGnss(t: EntityTypeDef): boolean {
  return !!(t.gnss || t.unmanned);
}

export class Navigation {
  constructor(private readonly engine: Engine) {}

  /** Once a simulated second, after jamming is worked out: who has lost (or regained) a fix. */
  update(): void {
    const eng = this.engine;
    for (const e of eng.entities.values()) {
      if (e.remote || e.ambient || (!e.nav && !navigatesByGnss(e.type))) continue;
      const denied = e.alive ? eng.ew.gnssJammedBy(e) : undefined;
      if (!denied) {
        if (e.nav) {
          const spoofed = e.nav.spoofedBy;
          e.nav = undefined;
          if (!spoofed && e.alive && this.speaks(e)) eng.log('info', `${e.name}: GNSS back`, e.id);
        }
        continue;
      }
      const spoofer = eng.ew.gnssSpoofedBy(e);
      if (e.nav && e.nav.spoofedBy === spoofer) continue;
      if (spoofer) {
        // The false fix pulls away from the spoofer.
        const s = eng.entities.get(spoofer)!;
        e.nav = { since: eng.time, dir: bearing(s, e), spoofedBy: spoofer };
        // Only the spoofer's side knows.
        if (this.speaks(e)) eng.log('info', `${s.name} spoofing the GNSS of ${e.name}`, s.id, e.id);
      } else {
        e.nav = { since: eng.time, dir: eng.rng.range(0, Math.PI * 2) };
        if (this.speaks(e)) eng.log('info', `${e.name}: GNSS jammed, navigating by inertial`, e.id);
      }
    }
  }

  /** Loose entities and unit leaders report; the rest of a unit goes quietly. */
  private speaks(e: Entity): boolean {
    return !e.unit || e.unit.leader === e;
  }

  /** Where the entity thinks it is minus where it is (m), or undefined with a good fix. */
  error(e: Entity): Vec2 | undefined {
    const n = e.nav;
    if (!n) return undefined;
    const m = this.errorSize(e);
    return { x: Math.sin(n.dir) * m, y: Math.cos(n.dir) * m };
  }

  /** Size of the navigation error (m). */
  errorSize(e: Entity): number {
    const n = e.nav;
    if (!n) return 0;
    const t = this.engine.time - n.since;
    const model = this.engine.models.navigation;
    return n.spoofedBy ? model.spoofOffset(t) : model.inertialError(t, e.type.insDrift ?? DEFAULT_INS_DRIFT);
  }

  /** The error a task sees: none for tasks that keep station by sight. */
  taskOffset(e: Entity, task: Task): Vec2 | undefined {
    if (!e.nav || BY_SIGHT.has(task.spec.type)) return undefined;
    const err = this.error(e);
    return err && (err.x !== 0 || err.y !== 0) ? err : undefined;
  }

  /**
   * Seconds a GNSS-guided munition flies without satellites: from where its path first
   * comes within reach of a GNSS jammer hostile to the shooter, to impact.
   */
  deniedFlight(shot: Shot): number {
    if (!shot.weapon.gnss) return 0;
    const eng = this.engine;
    const force = eng.entities.get(shot.shooterId)?.force;
    if (force === undefined) return 0;
    const jammers = eng.ew.jammers().filter((j) => j.type.jammer!.gnss && eng.isHostile(j.force, force));
    if (!jammers.length) return 0;
    const flight = Math.max(0, shot.impactTime - shot.fireTime);
    for (let k = 0; k <= PATH_SAMPLES; k++) {
      const f = k / PATH_SAMPLES;
      const x = shot.from.x + (shot.to.x - shot.from.x) * f;
      const y = shot.from.y + (shot.to.y - shot.from.y) * f;
      if (jammers.some((j) => Math.hypot(j.x - x, j.y - y) <= j.type.jammer!.range)) return (1 - f) * flight;
    }
    return 0;
  }

  /** One-sigma extra miss distance (m) of a GNSS-guided munition at impact. */
  munitionError(shot: Shot): number {
    const t = this.deniedFlight(shot);
    return t > 0 ? this.engine.models.navigation.inertialError(t, shot.weapon.insDrift ?? DEFAULT_MUNITION_INS_DRIFT) : 0;
  }

  /**
   * Multiplier on a GNSS-guided munition's kill chance against an entity: the chance its
   * navigation error still puts it within its blast radius (or the target's size) of the target.
   */
  munitionFactor(shot: Shot, target: Entity): number {
    const sigma = this.munitionError(shot);
    if (sigma <= 0) return 1;
    return circularHitChance(Math.max(shot.weapon.blastRadius ?? 0, presentedRadius(target.type)), sigma);
  }
}
