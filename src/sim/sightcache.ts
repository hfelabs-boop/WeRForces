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

/** Per line: both ends (x, y, z), when it was traced, and whether it was clear. */
const STRIDE = 8;

/**
 * One observer's traced lines: an open-addressing table keyed by the target's `seq`
 * (0 = empty slot), in typed arrays so a scan's lookups stay in a few cache lines.
 */
interface Lines {
  keys: Int32Array;
  data: Float64Array;
  count: number;
  terrainVersion: number;
}

const traced = new WeakMap<Entity, Lines>();
/** The last observer and its lines (a scan asks about many targets in a row). */
let lastObserver: Entity | null = null;
let lastLines: Lines | null = null;

function table(capacity: number, terrainVersion: number): Lines {
  return { keys: new Int32Array(capacity), data: new Float64Array(capacity * STRIDE), count: 0, terrainVersion };
}

function slot(lines: Lines, key: number): number {
  const mask = lines.keys.length - 1;
  let i = Math.imul(key, 0x9e3779b1) & mask;
  while (lines.keys[i] !== 0 && lines.keys[i] !== key) i = (i + 1) & mask;
  return i;
}

function usable(time: number, now: number): boolean {
  return now >= time && now - time <= SIGHT_REUSE_TIME;
}

/** A table without the lines too old to reuse, with room to grow. */
function rebuilt(old: Lines, now: number): Lines {
  let live = 0;
  for (let i = 0; i < old.keys.length; i++) if (old.keys[i] !== 0 && usable(old.data[i * STRIDE + 6], now)) live++;
  let capacity = 16;
  while (capacity < live * 3) capacity *= 2;
  const t = table(capacity, old.terrainVersion);
  for (let i = 0; i < old.keys.length; i++) {
    const o = i * STRIDE;
    if (old.keys[i] === 0 || !usable(old.data[o + 6], now)) continue;
    const j = slot(t, old.keys[i]);
    t.keys[j] = old.keys[i];
    t.data.set(old.data.subarray(o, o + STRIDE), j * STRIDE);
    t.count++;
  }
  return t;
}

/** Line of sight from an observer's eye to a point on a target `range` metres away (as Engine.lineOfSight). */
export function sensorSight(engine: Engine, observer: Entity, target: Entity, eye: Vec3, aim: Vec3, radar: boolean, range: number): boolean {
  let lines = lastObserver === observer ? lastLines : (traced.get(observer) ?? null);
  // A new terrain makes every line stale.
  if (!lines || lines.terrainVersion !== engine.terrainVersion) {
    lines = table(16, engine.terrainVersion);
    traced.set(observer, lines);
  }
  lastObserver = observer;
  lastLines = lines;
  const now = engine.time;
  const tol = Math.min(SIGHT_REUSE_MAX, range * SIGHT_REUSE_SHARE);
  const tol2 = tol * tol;
  let i = slot(lines, target.seq);
  let o = i * STRIDE;
  const d = lines.data;
  if (
    lines.keys[i] === target.seq &&
    usable(d[o + 6], now) &&
    (eye.x - d[o]) ** 2 + (eye.y - d[o + 1]) ** 2 + (eye.z - d[o + 2]) ** 2 <= tol2 &&
    (aim.x - d[o + 3]) ** 2 + (aim.y - d[o + 4]) ** 2 + (aim.z - d[o + 5]) ** 2 <= tol2
  ) {
    return d[o + 7] === 1 && (radar || !engine.smoke.blocks(eye, aim));
  }
  const clear = engine.terrain.lineOfSight(eye, aim);
  if (lines.keys[i] !== target.seq) {
    if ((lines.count + 1) * 3 > lines.keys.length * 2) {
      lines = rebuilt(lines, now);
      traced.set(observer, lines);
      lastLines = lines;
      i = slot(lines, target.seq);
      o = i * STRIDE;
    }
    lines.keys[i] = target.seq;
    lines.count++;
  }
  const t = lines.data;
  t[o] = eye.x;
  t[o + 1] = eye.y;
  t[o + 2] = eye.z;
  t[o + 3] = aim.x;
  t[o + 4] = aim.y;
  t[o + 5] = aim.z;
  t[o + 6] = now;
  t[o + 7] = clear ? 1 : 0;
  return clear && (radar || !engine.smoke.blocks(eye, aim));
}
