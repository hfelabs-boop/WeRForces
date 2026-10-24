// Perception: entities build a contact list from their sensors, with range, field of
// view, terrain/canopy line of sight and probabilistic detection.

import { angleDiff, bearing, clamp } from '../shared/math.js';
import type { Engine } from './engine.js';
import type { Entity } from './entity.js';

export const SENSOR_INTERVAL = 1;
const CONTACT_TIMEOUT = 15;

/** Probability that one sensor scan detects a target. */
export function detectionProbability(engine: Engine, observer: Entity, target: Entity, range: number, maxRange: number, radar: boolean): number {
  let p = 0.9 * (1 - 0.7 * (range / maxRange) ** 2);
  if (!radar) {
    const groundTarget = target.domain === 'ground' || target.domain === 'lifeform';
    if (groundTarget && engine.terrain.isForest(target.x, target.y)) p *= 0.35;
    if (target.domain === 'lifeform') p *= 0.6;
  }
  if (target.speed > 1) p *= 1.3;
  if (engine.time - target.lastFiredAt < 5) p *= 2;
  // Contacts already being tracked are easy to maintain.
  if (observer.contacts.has(target.id)) p = Math.max(p, 0.95);
  return clamp(p, 0, 0.99);
}

export function updateSensors(engine: Engine, observer: Entity): void {
  const now = engine.time;
  if (observer.alive && !observer.remote && observer.type.sensors.length > 0) {
    const eye = observer.eye;
    for (const target of engine.entities.values()) {
      if (target === observer || target.force === observer.force || target.destroyed) continue;
      const range = Math.hypot(target.x - observer.x, target.y - observer.y, target.z - observer.z);
      for (const sid of observer.type.sensors) {
        const s = engine.catalog.sensors.get(sid)!;
        if (range > s.maxRange || !s.detects.includes(target.domain)) continue;
        if (s.fov < Math.PI * 2 - 1e-6) {
          const off = Math.abs(angleDiff(observer.heading, bearing(observer, target)));
          if (off > s.fov / 2) continue;
        }
        const aim = { x: target.x, y: target.y, z: target.z + Math.min(2, target.type.sensorHeight || 2) };
        if (!engine.terrain.lineOfSight(eye, aim)) continue;
        if (!engine.rng.chance(detectionProbability(engine, observer, target, range, s.maxRange, !!s.radar))) continue;
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
  const share = observer.unit ? observer.unit.alive() : [observer];
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
  }
}
