// Perception: entities build a contact list from their sensors, with range, field of
// view, terrain/canopy line of sight and probabilistic detection.

import { angleDiff, bearing, clamp } from '../shared/math.js';
import type { Engine } from './engine.js';
import type { Entity } from './entity.js';
import { LAND_COVER } from '../shared/terrainGrid.js';
import type { Vec3 } from '../shared/types.js';
import { sensorRange } from './environment.js';
import { spotFactor } from './morale.js';

export const SENSOR_INTERVAL = 1;
const CONTACT_TIMEOUT = 15;
/** Light level at which a muzzle flash can be seen (fraction of daylight range). */
const FLASH_LIGHT = 0.5;

/** Probability that one sensor scan detects a target. */
export function detectionProbability(engine: Engine, observer: Entity, target: Entity, range: number, maxRange: number, radar: boolean): number {
  let p = 0.9 * (1 - 0.7 * (range / maxRange) ** 2);
  if (!radar) {
    const groundTarget = target.domain === 'ground' || target.domain === 'lifeform';
    if (groundTarget && engine.terrain.isForest(target.x, target.y)) p *= 0.35;
    else if (groundTarget && engine.terrain.isBuiltUp(target.x, target.y)) p *= 0.6;
    else if (target.domain === 'lifeform' && engine.terrain.coverAt(target.x, target.y) === LAND_COVER.shrub) p *= 0.7;
    if (target.domain === 'lifeform') p *= 0.6;
  }
  if (target.speed > 1) p *= 1.3;
  // Dug in or hull-down and quiet: hard to spot.
  else if (target.prepared && engine.time - target.lastFiredAt >= 5) p *= 0.5;
  if (engine.time - target.lastFiredAt < 5) p *= 2;
  // Contacts already being tracked are easy to maintain.
  if (observer.contacts.has(target.id)) p = Math.max(p, 0.95);
  p *= spotFactor(engine, observer);
  return clamp(p, 0, 0.99);
}

export function updateSensors(engine: Engine, observer: Entity): void {
  const now = engine.time;
  if (observer.alive && !observer.remote && !observer.embarkedIn && observer.type.sensors.length > 0) {
    const eye = observer.eye;
    // Muzzle flashes give away a shooter at night further than the dark would allow.
    const flashEnv = engine.env.light < FLASH_LIGHT ? { ...engine.env, light: FLASH_LIGHT } : engine.env;
    const sensors = observer.type.sensors.map((sid) => {
      const s = engine.catalog.sensors.get(sid)!;
      // Enemy radar jamming cuts a radar's range.
      const jam = s.radar ? engine.ew.radarFactor(observer) : 1;
      return { s, range: sensorRange(s, engine.env) * jam, flashRange: sensorRange(s, flashEnv) * jam };
    });
    let reach = 0;
    for (const { flashRange } of sensors) reach = Math.max(reach, flashRange);
    engine.spatial.build(engine.entities.values(), engine.time);
    for (const target of engine.spatial.query(observer.x, observer.y, reach, observer.force)) {
      if (target === observer || target.destroyed || target.embarkedIn) continue;
      const dx = target.x - observer.x;
      const dy = target.y - observer.y;
      const dz = target.z - observer.z;
      const range2 = dx * dx + dy * dy + dz * dz;
      if (range2 > reach * reach) continue;
      const range = Math.sqrt(range2);
      const flash = now - target.lastFiredAt < 5;
      // Line of sight is the same for every sensor of a kind: trace it at most once each.
      let aim: Vec3 | undefined;
      let sight: boolean | undefined;
      let radarSight: boolean | undefined;
      for (const { s, range: dark, flashRange } of sensors) {
        const maxRange = flash ? flashRange : dark;
        if (range > maxRange || !s.detects.includes(target.domain)) continue;
        if (s.fov < Math.PI * 2 - 1e-6) {
          const off = Math.abs(angleDiff(observer.heading, bearing(observer, target)));
          if (off > s.fov / 2) continue;
        }
        aim ??= { x: target.x, y: target.y, z: target.z + Math.min(2, target.type.sensorHeight || 2) };
        if (s.radar) radarSight ??= engine.lineOfSight(eye, aim, true);
        else sight ??= engine.lineOfSight(eye, aim, false);
        if (!(s.radar ? radarSight : sight)) continue;
        if (!engine.rng.chance(detectionProbability(engine, observer, target, range, maxRange, !!s.radar))) continue;
        recordContact(engine, observer, target, now);
        break;
      }
    }
  }
  for (const [id, c] of observer.contacts) {
    const t = engine.entities.get(id);
    if (!t || t.destroyed || now - c.lastSeen > CONTACT_TIMEOUT) observer.contacts.delete(id);
  }
}

function recordContact(engine: Engine, observer: Entity, target: Entity, now: number): void {
  const isNew = !observer.contacts.has(target.id);
  // Contacts go round the unit on the radio, unless it is jammed.
  const share = observer.unit && !engine.ew.radioJammed(observer) ? observer.unit.alive() : [observer];
  for (const m of share) {
    const existing = m.contacts.get(target.id);
    m.contacts.set(target.id, {
      id: target.id,
      firstSeen: existing?.firstSeen ?? now,
      lastSeen: now,
      x: target.x,
      y: target.y,
      z: target.z,
    });
  }
  if (isNew && engine.isHostile(observer.force, target.force)) {
    engine.log('detected', `${observer.name} detected ${target.name}`, observer.id, target.id);
    // The unit's leader reports it on the radio net.
    const speaker = observer.unit?.leader ?? observer;
    engine.radio(speaker, `${observer.unit?.name ?? observer.name}: contact, ${target.type.name} at ${Math.round(target.x)} ${Math.round(target.y)}`, target.id);
  }
}
