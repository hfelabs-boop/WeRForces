// Named, swappable physical models: armour by aspect (hit/kill), ballistics of unguided
// direct fire, radar detection range, and navigation without satellites (inertial drift
// under GNSS jamming, and spoofing). Each is one interface with a default
// implementation; `Engine.models` holds the ones in use, so a study can swap one out for
// an engine without touching the rest of the simulation.

import { angleDiff, bearing, DEG } from '../shared/math.js';
import type { EntityTypeDef, SensorDef, Vec3, WeaponDef } from '../shared/types.js';

/** The face of a target a round strikes. */
export type Aspect = 'front' | 'side' | 'rear' | 'top';

/** Where a target is and which way it faces (an Entity fits). */
export interface Facing {
  x: number;
  y: number;
  z: number;
  heading: number;
}

/** Hit/kill: which armour a round meets, and the chance it defeats it. */
export interface HitKillModel {
  readonly name: string;
  readonly description: string;
  /** The face a round fired from `from` strikes. */
  aspect(target: Facing, from: Vec3, weapon: WeaponDef): Aspect;
  /** Probability that a hit on that face defeats the armour; 1 without penetration or protection data. */
  perforation(weapon: WeaponDef, target: EntityTypeDef, aspect: Aspect): number;
}

/** Ballistics: how hitting falls off with range. */
export interface BallisticModel {
  readonly name: string;
  readonly description: string;
  /** Multiplier on the short-range Pk for a shot at this range (0-1). */
  rangeFactor(weapon: WeaponDef, range: number, target: EntityTypeDef): number;
}

/** Radar: how far a radar detects a target of a given radar cross-section. */
export interface RadarModel {
  readonly name: string;
  readonly description: string;
  /** Radar cross-section of an entity type (m²). */
  rcs(type: EntityTypeDef): number;
  /** Detection range (m) of a radar against a target of this cross-section, before jamming. */
  detectionRange(sensor: SensorDef, rcs: number): number;
}

/** Navigation: how far a GNSS navigator's position estimate drifts once satellites are lost or spoofed. */
export interface NavigationModel {
  readonly name: string;
  readonly description: string;
  /** Position error (m) after `t` s on inertial navigation alone, for a unit drifting at `drift` m/s. */
  inertialError(t: number, drift: number): number;
  /** How far (m) a spoofer has walked a receiver's position off after `t` s. */
  spoofOffset(t: number): number;
}

export interface Models {
  hitKill: HitKillModel;
  ballistic: BallisticModel;
  radar: RadarModel;
  navigation: NavigationModel;
}

// ---------------------------------------------------------------- hit/kill

/** Half-width of the frontal arc, and of the rear arc about the tail. */
export const FRONT_ARC = 30 * DEG;
/** Rounds arriving steeper than this hit the roof. */
export const TOP_ANGLE = 45 * DEG;
/** Spread of the armour actually met (weak spots, angle of impact) as a log-normal sigma. */
export const PERFORATION_SIGMA = 0.35;

/** Standard normal cumulative distribution (Abramowitz and Stegun 7.1.26, error < 1.5e-7). */
export function normalCdf(x: number): number {
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return x >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

/**
 * Default hit/kill model. Indirect and top-attack rounds, and rounds arriving steeper than
 * 45°, hit the roof; otherwise the bearing of the shooter off the target's hull heading
 * picks the face: within 30° of the nose is the front, within 30° of the tail the rear,
 * anything else the side. A hit defeats the armour with probability
 * Φ(ln(penetration / protection) / 0.35): one half when they are equal, about 0.1 when
 * the armour is half again as thick as the round penetrates, about 0.98 when the round
 * penetrates twice the armour.
 */
export const aspectArmour: HitKillModel = {
  name: 'aspect-armour',
  description: 'Penetration against front, side, rear or top protection, picked by the direction of the shot relative to the target heading.',
  aspect(target, from, weapon) {
    if (weapon.indirect || weapon.topAttack) return 'top';
    const horizontal = Math.hypot(from.x - target.x, from.y - target.y);
    if (from.z - target.z > horizontal * Math.tan(TOP_ANGLE)) return 'top';
    const off = Math.abs(angleDiff(target.heading, bearing(target, from)));
    if (off <= FRONT_ARC) return 'front';
    if (off >= Math.PI - FRONT_ARC) return 'rear';
    return 'side';
  },
  perforation(weapon, target, aspect) {
    const armour = target.protection?.[aspect];
    if (!weapon.penetration || !armour) return 1;
    return normalCdf(Math.log(weapon.penetration / armour) / PERFORATION_SIGMA);
  },
};

// ---------------------------------------------------------------- ballistics

/** Gravity (m/s²). */
export const GRAVITY = 9.81;
/** Range at which a weapon's Pk is quoted ("short range"). */
export const REFERENCE_RANGE = 100;
/** Default one-sigma range-estimate error when a weapon gives none. */
export const DEFAULT_RANGE_ERROR = 0.05;

/** Radius (m) of a circle with the area a target presents to a shooter. */
export function presentedRadius(type: EntityTypeDef): number {
  switch (type.domain) {
    case 'lifeform':
      return 0.4;
    case 'air':
      return 2.5;
    case 'surface':
      return 5;
    default:
      return 1.5;
  }
}

/** The generic range falloff, for guided weapons and weapons without ballistic data. */
export function genericRangeFactor(weapon: WeaponDef, range: number): number {
  return 1 - 0.5 * Math.min(1, range / weapon.maxRange) ** 2;
}

/**
 * One-sigma miss distance (m) of an unguided round at a range: angular spread grows
 * linearly, and the error in compensating gravity drop (½·g·t² with t = range / speed)
 * grows with the range-estimate error as 2 × drop × error.
 */
export function aimError(weapon: WeaponDef, range: number): number {
  const spread = ((weapon.spreadMrad ?? 0) / 1000) * range;
  const t = range / weapon.projectileSpeed;
  const drop = 0.5 * GRAVITY * t * t;
  const elevation = 2 * drop * (weapon.rangeError ?? DEFAULT_RANGE_ERROR);
  return Math.hypot(spread, elevation);
}

/** Chance that a round with circular normal error `sigma` lands within `radius` of the aim point. */
export function circularHitChance(radius: number, sigma: number): number {
  if (sigma <= 0) return 1;
  return 1 - Math.exp(-(radius * radius) / (2 * sigma * sigma));
}

/**
 * Default ballistic model. Unguided direct-fire weapons with `spreadMrad` set hit with
 * the chance a circular normal error (see `aimError`) puts the round within the target's
 * presented radius, relative to that chance at 100 m (where Pk is quoted). Everything
 * else, guided munitions and machine-gun bursts among them, keeps the generic falloff
 * 1 − 0.5 × (range / max range)².
 */
export const dropAndSpread: BallisticModel = {
  name: 'drop-and-spread',
  description: 'Unguided rounds: angular spread plus gravity-drop error from misjudged range, against the target presented area.',
  rangeFactor(weapon, range, target) {
    if (weapon.guided || weapon.indirect || weapon.spreadMrad === undefined) return genericRangeFactor(weapon, range);
    const radius = presentedRadius(target);
    const ref = circularHitChance(radius, aimError(weapon, Math.min(range, REFERENCE_RANGE)));
    const now = circularHitChance(radius, aimError(weapon, range));
    return ref > 0 ? Math.min(1, now / ref) : 0;
  },
};

// ---------------------------------------------------------------- radar

/** Radar cross-section (m²) by symbol, then by domain, for types that give none. */
const RCS_BY_SYMBOL: Partial<Record<EntityTypeDef['symbol'], number>> = { 'fixed-wing': 5, rotary: 10, uav: 1, ship: 5000, boat: 50 };
const RCS_BY_DOMAIN: Record<EntityTypeDef['domain'], number> = { air: 5, surface: 500, ground: 20, lifeform: 1 };
/** Reference cross-section of a radar's reference range when the sensor gives none (m²). */
export const DEFAULT_REFERENCE_RCS = 1;

/**
 * Default radar model: the radar range equation. The signal-to-noise ratio falls as
 * RCS / range⁴, so a radar that detects a target of `refRcs` m² at `refRange` detects one
 * of σ m² at refRange × (σ / refRcs)^¼, never beyond its instrumented `maxRange`.
 * Radars without a reference range detect everything out to `maxRange`.
 */
export const radarEquation: RadarModel = {
  name: 'radar-equation',
  description: 'Detection range scales with the fourth root of the radar cross-section, up to the instrumented range.',
  rcs(type) {
    return type.rcs ?? RCS_BY_SYMBOL[type.symbol] ?? RCS_BY_DOMAIN[type.domain];
  },
  detectionRange(sensor, rcs) {
    if (!sensor.refRange) return sensor.maxRange;
    const range = sensor.refRange * Math.pow(Math.max(0, rcs) / (sensor.refRcs ?? DEFAULT_REFERENCE_RCS), 0.25);
    return Math.min(sensor.maxRange, range);
  },
};

// ---------------------------------------------------------------- navigation

/** Default inertial drift rate (m/s): a small drone's MEMS unit. Vehicles and munitions give their own. */
export const DEFAULT_INS_DRIFT = 1;
/** Default drift rate of GNSS-guided munitions (m/s). */
export const DEFAULT_MUNITION_INS_DRIFT = 3;
/** Time (s) over which inertial error turns from linear (velocity error) to quadratic (accelerometer bias). */
export const INS_KNEE = 300;
/** Inertial error never grows beyond this (m): dead reckoning on landmarks takes over. */
export const MAX_INS_ERROR = 5000;
/** How fast a spoofer walks a receiver off (m/s), and how far at most (m). */
export const SPOOF_RATE = 5;
export const MAX_SPOOF_OFFSET = 3000;

/**
 * Default navigation model. Without satellites a navigator dead-reckons on its inertial
 * unit: the error grows as drift × t × (1 + t / 300 s), linear at first (a velocity error)
 * and then quadratic (an uncorrected accelerometer bias), up to 5 km. A drone drifting at
 * 1 m/s is about 70 m out after a minute and 170 m after two; a munition at 3 m/s is 50 m
 * out after 15 s. A spoofer walks a receiver off at 5 m/s, up to 3 km, without it knowing.
 */
export const inertialDrift: NavigationModel = {
  name: 'inertial-drift',
  description: 'GNSS denied: inertial error grows linearly, then quadratically, with the time since the fix was lost; spoofing walks the position off at a steady rate.',
  inertialError(t, drift) {
    if (t <= 0) return 0;
    return Math.min(MAX_INS_ERROR, drift * t * (1 + t / INS_KNEE));
  },
  spoofOffset(t) {
    return Math.min(MAX_SPOOF_OFFSET, SPOOF_RATE * Math.max(0, t));
  },
};

export const DEFAULT_MODELS: Readonly<Models> = { hitKill: aspectArmour, ballistic: dropAndSpread, radar: radarEquation, navigation: inertialDrift };
