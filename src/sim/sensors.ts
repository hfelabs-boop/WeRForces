// Perception: entities build a contact list from their sensors, with range, field of
// view, terrain/canopy line of sight and probabilistic detection.

import { angleDiff, bearing, clamp } from '../shared/math.js';
import type { EntityTypeDef, SensorDef } from '../shared/types.js';
import type { Engine } from './engine.js';
import type { Entity } from './entity.js';
import { LAND_COVER } from '../shared/terrainGrid.js';
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

/** Size (m) sensor ranges are quoted for; smaller targets are seen proportionally closer. */
export const REFERENCE_SIZE = 3;

/**
 * Share of an optical or thermal sensor's range at which a target of this type can be
 * seen: what the eye resolves scales with the target's size, so a 0.3 m drone is seen at
 * a tenth of the range of a vehicle. Types without a size count as full size.
 */
export function sizeFactor(type: EntityTypeDef): number {
  return type.size === undefined ? 1 : Math.min(1, type.size / REFERENCE_SIZE);
}

/** How far a radar detects a target of this type, before jamming. */
export function radarRange(engine: Engine, s: SensorDef, type: EntityTypeDef): number {
  const radar = engine.models.radar;
  return radar.detectionRange(s, radar.rcs(type));
}

export function updateSensors(engine: Engine, observer: Entity): void {
  const now = engine.time;
  // A remotely flown drone without its datalink sends no picture back to its operator.
  const blind = !!observer.uxs && !engine.unmanned.sees(observer);
  if (observer.alive && !observer.remote && !observer.embarkedIn && observer.type.sensors.length > 0 && !blind) {
    const eye = observer.eye;
    // Muzzle flashes give away a shooter at night further than the dark would allow.
    const flashEnv = engine.env.light < FLASH_LIGHT ? { ...engine.env, light: FLASH_LIGHT } : engine.env;
    const sensors = observer.type.sensors.map((sid) => {
      const s = engine.catalog.sensors.get(sid)!;
      // Enemy radar jamming cuts a radar's range.
      const jam = s.radar ? engine.ew.radarFactor(observer) : 1;
      return { s, jam, range: sensorRange(s, engine.env) * jam, flashRange: sensorRange(s, flashEnv) * jam };
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
      for (const { s, jam, range: dark, flashRange } of sensors) {
        // Radars see big targets further than small ones (the radar range equation).
        const maxRange = s.radar && s.refRange ? radarRange(engine, s, target.type) * jam : (flash ? flashRange : dark) * (s.radar ? 1 : sizeFactor(target.type));
        if (range > maxRange || !s.detects.includes(target.domain)) continue;
        if (s.fov < Math.PI * 2 - 1e-6) {
          const off = Math.abs(angleDiff(observer.heading, bearing(observer, target)));
          if (off > s.fov / 2) continue;
        }
        const aim = { x: target.x, y: target.y, z: target.z + Math.min(2, target.type.sensorHeight || 2) };
        if (!engine.lineOfSight(eye, aim, !!s.radar)) continue;
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
  const share = observer.unit && !engine.ew.radioJammed(observer) && (!observer.uxs || engine.unmanned.linked(observer)) ? observer.unit.alive() : [observer];
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
