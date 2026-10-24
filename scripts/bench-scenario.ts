// A large, mixed scenario for performance work: two forces of platoons and squads in
// formation advancing into each other across a 24 km terrain, a few attack helicopters
// and fighters overhead, some units holding ground, and civilian traffic in the towns.
// Used by scripts/bench.ts and the scale regression test.

import { createHash } from 'node:crypto';
import type { ForceId } from '../src/shared/types.js';
import { Engine } from '../src/sim/engine.js';
import { Rng } from '../src/sim/rng.js';
import { Terrain } from '../src/sim/terrain.js';

/** Unit templates per force, with relative weights. */
const GROUND: Record<1 | 2, [string, number][]> = {
  1: [
    ['us-tank-platoon', 3],
    ['us-mech-platoon', 3],
    ['us-rifle-squad', 3],
    ['us-scout-section', 1],
    ['us-mortar-section', 1],
  ],
  2: [
    ['ru-tank-platoon', 3],
    ['ru-mech-platoon', 4],
    ['ru-rifle-squad', 3],
    ['ru-recon-patrol', 1],
    ['ru-mortar-battery', 1],
  ],
};
const AIR: Record<1 | 2, string[]> = { 1: ['us-attack-team', 'us-fighter-flight'], 2: ['ru-flanker-flight'] };

export const BENCH_TERRAIN_SIZE = 24000;

let cachedTerrain: Terrain | null = null;

/** The benchmark terrain: 24 km square, generated once per process. */
export function benchTerrain(): Terrain {
  cachedTerrain ??= Terrain.generate({ seed: 4242, size: BENCH_TERRAIN_SIZE, towns: 12 });
  return cachedTerrain;
}

export interface BenchCounts {
  entities: number;
  units: number;
  air: number;
  civilians: number;
}

/**
 * Build a scenario of about `n` entities (12% civilians up to the pattern-of-life cap,
 * 2% aircraft, the rest ground units) on a fresh engine. The same n and seed always
 * build the same scenario.
 */
export function buildBenchScenario(n: number, seed = 1): { engine: Engine; counts: BenchCounts } {
  const engine = new Engine({ terrain: benchTerrain(), seed });
  engine.newScenario(`bench ${n}`, benchTerrain().spec);
  engine.reseed(seed);
  const rng = new Rng(seed * 7919 + n);
  const size = engine.terrain.spec.size;
  const civilians = Math.min(600, Math.round(n * 0.12));
  const airBudget = Math.max(2, Math.round(n * 0.02));
  const groundBudget = n - civilians - airBudget;
  let air = 0;
  let placed = 0;
  let units = 0;
  const pick = (list: [string, number][]) => {
    const total = list.reduce((s, [, w]) => s + w, 0);
    let r = rng.range(0, total);
    for (const [id, w] of list) if ((r -= w) < 0) return id;
    return list[list.length - 1][0];
  };
  // Ground: Blue in a band west of the centre line, Red east of it, 3-4 km apart, so the
  // forward units are in sensor range from the start and the rest close up as they advance.
  for (let k = 0; placed < groundBudget && k < groundBudget * 4; k++) {
    const force = (k % 2 === 0 ? 1 : 2) as 1 | 2;
    const west = force === 1;
    const x = west ? rng.range(size * 0.22, size * 0.45) : rng.range(size * 0.55, size * 0.78);
    const y = rng.range(size * 0.06, size * 0.94);
    if (!engine.canStand('ground', { x, y })) continue;
    const tpl = pick(GROUND[force]);
    const heading = west ? Math.PI / 2 : -Math.PI / 2;
    const unit = engine.createUnitFromTemplate(tpl, force, x, y, heading);
    units++;
    placed += unit.memberList.length;
    // Most advance across the centre line; one in five holds where it is.
    const roll = rng.next();
    if (tpl.includes('mortar')) continue;
    if (roll < 0.2) {
      engine.assignTask(unit.id, { type: 'defend', position: { x: Math.round(x), y: Math.round(y) }, facing: west ? 90 : 270 });
    } else {
      const tx = west ? x + rng.range(5000, 9000) : x - rng.range(5000, 9000);
      const target = engine.findValidPosition({ x: Math.max(200, Math.min(size - 200, tx)), y }, 'ground', 800);
      if (target) engine.assignTask(unit.id, { type: 'moveTo', target: { x: Math.round(target.x), y: Math.round(target.y) } });
    }
  }
  // Air: flights crossing over the battle area from each side.
  for (let k = 0; air < airBudget && k < airBudget * 4; k++) {
    const force = (k % 3 === 2 ? 2 : 1) as ForceId;
    const west = force === 1;
    const list = AIR[force as 1 | 2];
    const tpl = list[k % list.length];
    const x = west ? rng.range(size * 0.05, size * 0.2) : rng.range(size * 0.8, size * 0.95);
    const y = rng.range(size * 0.1, size * 0.9);
    const unit = engine.createUnitFromTemplate(tpl, force, x, y, west ? Math.PI / 2 : -Math.PI / 2);
    units++;
    air += unit.memberList.length;
    engine.assignTask(unit.id, { type: 'moveTo', target: { x: Math.round(size - x), y: Math.round(y) } });
  }
  // Civilians: pattern of life fills the towns and roads on the first second.
  engine.life.set({ vehicles: Math.ceil(civilians / 2), pedestrians: Math.floor(civilians / 2) });
  engine.runFor(1);
  const civ = [...engine.entities.values()].filter((e) => e.ambient).length;
  return { engine, counts: { entities: engine.entities.size, units, air, civilians: civ } };
}

/** Hash of every event (time, kind, text) from now on: equal digests mean identical runs. */
export function eventDigest(engine: Engine): { digest: () => string; count: () => number } {
  const hash = createHash('sha256');
  let count = 0;
  engine.on('event', (ev) => {
    hash.update(`${ev.time.toFixed(1)}|${ev.kind}|${ev.text}\n`);
    count++;
  });
  return { digest: () => hash.copy().digest('hex'), count: () => count };
}
