// Kinematic movement models for ground, lifeform, surface and air entities.

import { angleDiff, bearing, clamp, normalizeAngle } from '../shared/math.js';
import type { Entity } from './entity.js';
import type { Terrain } from './terrain.js';

const G = 9.81;

function approach(current: number, target: number, up: number, down: number): number {
  if (target > current) return Math.min(target, current + up);
  return Math.max(target, current - down);
}

function turnTowards(e: Entity, desired: number, dt: number): number {
  const diff = angleDiff(e.heading, desired);
  const maxTurn = e.type.turnRate * dt;
  const turn = clamp(diff, -maxTurn, maxTurn);
  e.heading = normalizeAngle(e.heading + turn);
  return turn / dt;
}

/** `offroadScale` slows movement off roads (rain, snow). */
export function stepMovement(e: Entity, terrain: Terrain, dt: number, offroadScale = 1): void {
  if (e.remote) return;
  if (e.domain === 'air') stepAir(e, terrain, dt);
  else stepSurfaceBound(e, terrain, dt, offroadScale);
}

/** A passable step at up to 60° off the heading, preferring directions closest to `toward`. */
function slideAround(e: Entity, terrain: Terrain, offroad: number, step: number, toward: number): { x: number; y: number } | null {
  const tries = [0.35, -0.35, 0.7, -0.7, 1.05, -1.05]
    .map((d) => e.heading + d)
    .sort((a, b) => Math.abs(angleDiff(a, toward)) - Math.abs(angleDiff(b, toward)));
  for (const h of tries) {
    const x = clamp(e.x + Math.sin(h) * step, 0, terrain.spec.size);
    const y = clamp(e.y + Math.cos(h) * step, 0, terrain.spec.size);
    if (terrain.mobilityFactor(x, y, e.moveDomain, offroad) > 0) return { x, y };
  }
  return null;
}

function stepSurfaceBound(e: Entity, terrain: Terrain, dt: number, offroadScale: number): void {
  const t = e.type;
  const offroad = t.offroadFactor * offroadScale;
  const cmd = e.destroyed || e.mobilityKill ? null : e.steer;
  e.blocked = false;
  let targetSpeed = 0;
  let dist = 0;
  if (cmd) {
    dist = Math.hypot(cmd.x - e.x, cmd.y - e.y);
    const mob = terrain.mobilityFactor(e.x, e.y, e.moveDomain, offroad);
    targetSpeed = Math.min(cmd.speed, t.maxSpeed * Math.max(mob, 0.1));
    if (cmd.arrive) {
      targetSpeed = dist < 1 ? 0 : Math.min(targetSpeed, Math.sqrt(2 * t.acceleration * 0.6 * dist));
    }
    if (dist > 0.5) {
      const err = Math.abs(angleDiff(e.heading, bearing(e, cmd)));
      if (e.moveDomain !== 'lifeform') {
        if (err > 1.2) targetSpeed *= 0.2;
        else if (err > 0.45) targetSpeed *= 0.6;
      }
      turnTowards(e, bearing(e, cmd), dt);
    } else if (cmd.finalHeading !== undefined) {
      turnTowards(e, cmd.finalHeading, dt);
    }
  }
  e.speed = approach(e.speed, targetSpeed, t.acceleration * dt, t.acceleration * 2 * dt);
  let step = e.speed * dt;
  if (cmd && cmd.arrive && step > dist) step = dist;
  if (step > 0) {
    const nx = clamp(e.x + Math.sin(e.heading) * step, 0, terrain.spec.size);
    const ny = clamp(e.y + Math.cos(e.heading) * step, 0, terrain.spec.size);
    if (terrain.mobilityFactor(nx, ny, e.moveDomain, offroad) <= 0) {
      // Skirt the edge (a route leg can clip the corner of a lake between its check
      // points): edge along at a slant toward where it is steering, if it can.
      const slide = cmd ? slideAround(e, terrain, offroad, step, bearing(e, cmd)) : null;
      if (slide) {
        e.x = slide.x;
        e.y = slide.y;
        e.speed *= 0.7;
      } else {
        e.blocked = true;
        e.speed = 0;
      }
    } else {
      e.x = nx;
      e.y = ny;
    }
  }
  e.vz = 0;
  if (e.domain === 'surface') {
    // Sea level, or a lake's surface on imported terrain.
    e.z = terrain.surfaceHeight(e.x, e.y);
    e.pitch = 0;
  } else {
    e.z = terrain.elevation(e.x, e.y);
    const ax = Math.sin(e.heading) * 4;
    const ay = Math.cos(e.heading) * 4;
    e.pitch = Math.atan2(terrain.elevation(e.x + ax, e.y + ay) - terrain.elevation(e.x - ax, e.y - ay), 8);
  }
  e.roll = 0;
}

function stepAir(e: Entity, terrain: Terrain, dt: number): void {
  const t = e.type;
  const surface = terrain.surfaceHeight(e.x, e.y);
  if (e.destroyed) {
    e.speed = approach(e.speed, 0, 5 * dt, 5 * dt);
    e.vz = -40;
    e.z = Math.max(surface, e.z + e.vz * dt);
    if (e.z <= surface) {
      e.vz = 0;
      e.speed = 0;
    }
    e.x = clamp(e.x + Math.sin(e.heading) * e.speed * dt, 0, terrain.spec.size);
    e.y = clamp(e.y + Math.cos(e.heading) * e.speed * dt, 0, terrain.spec.size);
    return;
  }
  const fixedWing = (t.minSpeed ?? 0) > 0;
  const cmd = e.steer;
  let targetSpeed = fixedWing ? t.cruiseSpeed : 0;
  let turnRate = 0;
  if (cmd) {
    const dist = Math.hypot(cmd.x - e.x, cmd.y - e.y);
    targetSpeed = Math.min(cmd.speed, t.maxSpeed);
    if (cmd.arrive && !fixedWing) {
      targetSpeed = dist < 2 ? 0 : Math.min(targetSpeed, Math.sqrt(2 * t.acceleration * 0.6 * dist));
    }
    if (dist > 2) turnRate = turnTowards(e, bearing(e, cmd), dt);
    else if (cmd.finalHeading !== undefined) turnRate = turnTowards(e, cmd.finalHeading, dt);
  } else if (fixedWing) {
    // Loiter: hold a gentle standard-rate turn.
    turnRate = turnTowards(e, e.heading + 1, dt);
  }
  if (fixedWing) targetSpeed = Math.max(targetSpeed, t.minSpeed!);
  e.speed = approach(e.speed, targetSpeed, t.acceleration * dt, t.acceleration * 1.5 * dt);
  e.x = clamp(e.x + Math.sin(e.heading) * e.speed * dt, 0, terrain.spec.size);
  e.y = clamp(e.y + Math.cos(e.heading) * e.speed * dt, 0, terrain.spec.size);

  // Terrain following: look ahead so we climb before reaching high ground.
  const agl = e.altitudeOverride ?? t.cruiseAltitude ?? 100;
  let ground = surface;
  for (const ahead of [3, 6, 10]) {
    const d = e.speed * ahead;
    ground = Math.max(ground, terrain.surfaceHeight(e.x + Math.sin(e.heading) * d, e.y + Math.cos(e.heading) * d));
  }
  const climb = t.climbRate ?? 10;
  const targetZ = ground + agl;
  e.vz = clamp((targetZ - e.z) / 2, -climb, climb);
  e.z = Math.max(surface, e.z + e.vz * dt);
  e.pitch = Math.atan2(e.vz, Math.max(e.speed, 1));
  e.roll = clamp(Math.atan((e.speed * turnRate) / G), -1.2, 1.2);
}
