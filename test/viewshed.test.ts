import { describe, expect, it } from 'vitest';
import { base64ToBytes } from '../src/shared/terrainGrid.js';
import { Engine } from '../src/sim/engine.js';
import { Terrain } from '../src/sim/terrain.js';
import { computeViewshed, VIEW_HIDDEN, VIEW_OUT, VIEW_SEEN } from '../src/sim/viewshed.js';

const base = Terrain.generate({ size: 6000, seed: 9, towns: 2 });
const cols = 81;
const heights = new Float32Array(cols * cols).fill(20);
// A ridge 60 m high along y = 2000.
for (let i = 0; i < cols; i++) for (const r of [39, 40, 41]) heights[r * cols + i] = r === 40 ? 80 : 60;
const ridged = new Terrain({ ...base.spec, size: 4000, cellSize: 50, seed: 77 }, heights, new Uint8Array(cols * cols), [], []);

describe('viewshed', () => {
  it('sees the near side of a ridge, not the dead ground behind it', () => {
    const eng = new Engine({ terrain: ridged });
    eng.newScenario('view', ridged.spec);
    const eye = { x: 2000, y: 1200, z: 22 };
    const v = computeViewshed(eng, eye, 1500);
    const cells = base64ToBytes(v.cellsB64);
    const at = (x: number, y: number) => cells[Math.round((y - v.y0) / v.cell) * v.cols + Math.round((x - v.x0) / v.cell)];
    expect(at(2000, 1600)).toBe(VIEW_SEEN);
    expect(at(2000, 2400)).toBe(VIEW_HIDDEN); // behind the ridge
    expect(at(2000, 1200 + 1490)).toBe(VIEW_HIDDEN);
    expect(at(3400, 2600)).toBe(VIEW_OUT); // in the grid corner, beyond the radius
    expect(v.visibleFraction).toBeGreaterThan(0.3);
    expect(v.visibleFraction).toBeLessThan(0.9);
    // From on top of the ridge, the far side shows.
    const top = computeViewshed(eng, { x: 2000, y: 2000, z: 85 }, 1500);
    expect(top.visibleFraction).toBeGreaterThan(v.visibleFraction);
    // Smoke hides ground from eyes, not radar.
    eng.smoke.add({ x: 2000, y: 1500 }, 80, 300);
    const smoked = computeViewshed(eng, eye, 1500);
    expect(smoked.visibleFraction).toBeLessThan(v.visibleFraction);
    expect(computeViewshed(eng, eye, 1500, 2, true).visibleFraction).toBe(v.visibleFraction);
  });
});
