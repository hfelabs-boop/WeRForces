// Viewshed: which ground an observer can see, out to a radius, for the map overlay. Each
// cell's centre is tested with the simulation's own line of sight (terrain, forest,
// buildings and smoke), at a target height above the ground.

import type { Vec3, Viewshed } from '../shared/types.js';
import { bytesToBase64 } from '../shared/terrainGrid.js';
import type { Engine } from './engine.js';

/** Cell values. */
export const VIEW_OUT = 0;
export const VIEW_HIDDEN = 1;
export const VIEW_SEEN = 2;

/** At most this many cells across, so a big radius stays quick. */
const MAX_CELLS = 161;

export function computeViewshed(engine: Engine, eye: Vec3, radius: number, targetHeight = 2, radar = false): Viewshed {
  const t = engine.terrain;
  const size = t.spec.size;
  const cell = Math.max(t.spec.cellSize, Math.ceil((radius * 2) / MAX_CELLS / 5) * 5);
  const n = Math.min(MAX_CELLS, Math.ceil((radius * 2) / cell) + 1);
  const x0 = eye.x - ((n - 1) / 2) * cell;
  const y0 = eye.y - ((n - 1) / 2) * cell;
  const cells = new Uint8Array(n * n);
  let seen = 0;
  let total = 0;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const x = x0 + c * cell;
      const y = y0 + r * cell;
      if (x < 0 || y < 0 || x > size || y > size || Math.hypot(x - eye.x, y - eye.y) > radius || t.isWater(x, y)) continue;
      total++;
      const target = { x, y, z: t.surfaceHeight(x, y) + targetHeight };
      const visible = engine.lineOfSight(eye, target, radar);
      cells[r * n + c] = visible ? VIEW_SEEN : VIEW_HIDDEN;
      if (visible) seen++;
    }
  }
  return { x0, y0, cell, cols: n, rows: n, eye, radius, targetHeight, cellsB64: bytesToBase64(cells), visibleFraction: total ? Math.round((seen / total) * 1000) / 1000 : 0 };
}
