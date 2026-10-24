// Sight lines for sensor scans, reused for a few seconds while neither end has moved
// more than a small share of the range. Scans re-check the same pairs every second, and
// at the ranges sensors work over a few metres of movement seldom changes what terrain
// hides; tracing every line again was the largest single cost of big scenarios.
// Only the terrain part is reused: smoke is checked afresh every time.

import type { Vec3 } from '../shared/types.js';
import type { Engine } from './engine.js';
import type { Entity } from './entity.js';

/** Longest a traced line is reused (simulated seconds). */
export const SIGHT_REUSE_TIME = 5;
/** Either end may move this share of the range before the line is traced again... */
export const SIGHT_REUSE_SHARE = 0.02;
/** ...and never more than this many metres. */
export const SIGHT_REUSE_MAX = 25;

interface Sight {
  ax: number;
  ay: number;
  az: number;
  bx: number;
  by: number;
  bz: number;
  time: number;
  terrainVersion: number;
  clear: boolean;
}

/** Per observer: the lines it traced, by target. */
const traced = new WeakMap<Entity, Map<Entity, Sight>>();

/** Line of sight from an observer's eye to a point on a target `range` metres away (as Engine.lineOfSight). */
export function sensorSight(engine: Engine, observer: Entity, target: Entity, eye: Vec3, aim: Vec3, radar: boolean, range: number): boolean {
  let lines = traced.get(observer);
  if (!lines) traced.set(observer, (lines = new Map()));
  const now = engine.time;
  const tol = Math.min(SIGHT_REUSE_MAX, range * SIGHT_REUSE_SHARE);
  const tol2 = tol * tol;
  let s = lines.get(target);
  const reuse =
    s !== undefined &&
    now - s.time <= SIGHT_REUSE_TIME &&
    now >= s.time &&
    s.terrainVersion === engine.terrainVersion &&
    (eye.x - s.ax) ** 2 + (eye.y - s.ay) ** 2 + (eye.z - s.az) ** 2 <= tol2 &&
    (aim.x - s.bx) ** 2 + (aim.y - s.by) ** 2 + (aim.z - s.bz) ** 2 <= tol2;
  if (!reuse) {
    const clear = engine.terrain.lineOfSight(eye, aim);
    if (s) {
      s.ax = eye.x;
      s.ay = eye.y;
      s.az = eye.z;
      s.bx = aim.x;
      s.by = aim.y;
      s.bz = aim.z;
      s.time = now;
      s.terrainVersion = engine.terrainVersion;
      s.clear = clear;
    } else {
      if (lines.size >= 512) prune(lines, now);
      s = { ax: eye.x, ay: eye.y, az: eye.z, bx: aim.x, by: aim.y, bz: aim.z, time: now, terrainVersion: engine.terrainVersion, clear };
      lines.set(target, s);
    }
  }
  return s!.clear && (radar || !engine.smoke.blocks(eye, aim));
}

/** Forget lines too old to be reused. */
function prune(lines: Map<Entity, Sight>, now: number): void {
  for (const [t, s] of lines) if (now - s.time > SIGHT_REUSE_TIME || now < s.time) lines.delete(t);
}
