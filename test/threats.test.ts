import { describe, expect, it } from 'vitest';
import { Engine } from '../src/sim/engine.js';
import { Terrain } from '../src/sim/terrain.js';

const base = Terrain.generate({ size: 6000, seed: 9, towns: 2 });
const cols = 81;
const cs = 50;
// Flat ground at 20 m with a 40 m high east-west ridge along y = 1500..1600, from x = 1000 to 3000.
const heights = new Float32Array(cols * cols).fill(20);
for (let r = 0; r < cols; r++) for (let c = 0; c < cols; c++) if (r * cs >= 1500 && r * cs <= 1600 && c * cs >= 1000 && c * cs <= 3000) heights[r * cols + c] = 60;
const ridge = new Terrain({ ...base.spec, size: 4000, cellSize: cs, seed: 4242 }, heights, new Uint8Array(cols * cols), [], []);

function engine(): Engine {
  const e = new Engine({ terrain: ridge });
  e.newScenario('threats', ridge.spec);
  return e;
}

/** Fraction of a route's length (sampled every 10 m) in sight of a point. */
function exposed(eng: Engine, from: { x: number; y: number }, route: { x: number; y: number }[], eye: { x: number; y: number; z: number }): number {
  const pts = [from, ...route];
  let seen = 0;
  let all = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    for (let s = 0; s < d; s += 10) {
      const x = pts[i - 1].x + ((pts[i].x - pts[i - 1].x) * s) / d;
      const y = pts[i - 1].y + ((pts[i].y - pts[i - 1].y) * s) / d;
      all++;
      if (Math.hypot(x - eye.x, y - eye.y) < 4000 && eng.terrain.lineOfSight(eye, { x, y, z: eng.terrain.surfaceHeight(x, y) + 2 })) seen++;
    }
  }
  return seen / all;
}

describe('threat-aware routes', () => {
  it('a covered route keeps behind the ridge, out of sight of a known enemy', () => {
    const eng = engine();
    // An enemy tank north of the ridge watches the open ground in front of it.
    const enemy = eng.createEntity({ typeId: 'ru-t72b3', force: 2, x: 2000, y: 2600, heading: Math.PI });
    enemy.roe = 'holdFire';
    const scout = eng.createEntity({ typeId: 'us-hmmwv', force: 1, x: 500, y: 1800 });
    scout.roe = 'holdFire';
    const from = { x: 500, y: 1800 };
    const to = { x: 3500, y: 1800 };
    // Before Blue knows about it, the covered route is the ordinary one.
    expect(eng.planRoute(from, to, 'ground', 0.6, 1, true)).toEqual(eng.planRoute(from, to, 'ground', 0.6, 1));
    eng.runFor(10);
    expect(scout.contacts.has(enemy.id)).toBe(true);
    const eye = { x: enemy.x, y: enemy.y, z: enemy.z + enemy.type.sensorHeight };
    const direct = eng.planRoute(from, to, 'ground', 0.6, 1)!;
    const covered = eng.planRoute(from, to, 'ground', 0.6, 1, true)!;
    const a = exposed(eng, from, direct, eye);
    const b = exposed(eng, from, covered, eye);
    expect(a).toBeGreaterThan(0.2);
    expect(b).toBeLessThan(a / 2);
    // Red does not know about the scout, so its routes are unchanged.
    expect(eng.planRoute({ x: 500, y: 3500 }, { x: 3500, y: 3500 }, 'ground', 0.6, 2, true)).toEqual(eng.planRoute({ x: 500, y: 3500 }, { x: 3500, y: 3500 }, 'ground', 0.6, 2));
  });

  it('moveTo with covered uses it and spends far less time in view', () => {
    const run = (covered: boolean) => {
      const eng = engine();
      const enemy = eng.createEntity({ typeId: 'ru-t72b3', force: 2, x: 2000, y: 2600, heading: Math.PI });
      enemy.roe = 'holdFire';
      const scout = eng.createEntity({ typeId: 'us-hmmwv', force: 1, x: 500, y: 1800 });
      scout.roe = 'holdFire';
      eng.runFor(10);
      eng.assignTask(scout.id, { type: 'moveTo', target: { x: 3500, y: 1800 }, covered });
      expect(eng.snapshot().entities.find((e) => e.id === scout.id)!.task).toBe(covered ? 'Move to (3500, 1800) by a covered route' : 'Move to (3500, 1800)');
      let seen = 0;
      for (let t = 0; t < 600 && scout.task?.status === 'running'; t++) {
        eng.runFor(1);
        if (eng.terrain.lineOfSight({ x: enemy.x, y: enemy.y, z: enemy.z + 2.4 }, { x: scout.x, y: scout.y, z: scout.z + 2 })) seen++;
      }
      expect(scout.task?.status).toBe('done');
      return seen;
    };
    const open = run(false);
    const hidden = run(true);
    expect(hidden).toBeLessThan(open / 2);
  });
});
