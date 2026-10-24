// Performance benchmark: N entities (half Blue, half Red) on the default terrain,
// moving and fighting. Reports wall-clock cost per simulated second.
//   npx tsx scripts/bench.ts [entities...]      e.g. npx tsx scripts/bench.ts 100 500 1000 2000

import { Engine } from '../src/sim/engine.js';
import { Rng } from '../src/sim/rng.js';

const sizes = process.argv.slice(2).map(Number).filter((n) => n > 0);
const engine = new Engine();
const types = ['us-m1a2', 'us-m2a3', 'us-hmmwv', 'ru-t72b3', 'ru-bmp2', 'ru-brdm2'];

for (const n of sizes.length ? sizes : [100, 500, 1000]) {
  engine.newScenario(`bench ${n}`);
  const rng = new Rng(n);
  const size = engine.terrain.spec.size;
  let placed = 0;
  while (placed < n) {
    const force = placed % 2 === 0 ? 1 : 2;
    // Blue in the west half, Red in the east half, so they meet in the middle.
    const x = force === 1 ? rng.range(500, size / 2 - 500) : rng.range(size / 2 + 500, size - 500);
    const y = rng.range(500, size - 500);
    if (!engine.canStand('ground', { x, y })) continue;
    const typeId = types[(force === 1 ? 0 : 3) + rng.int(0, 3)];
    const e = engine.createEntity({ typeId, force: force as 1 | 2, x, y });
    engine.assignTask(e.id, { type: 'moveTo', target: engine.findValidPosition({ x: size - x, y }, 'ground') ?? { x, y } });
    placed++;
  }
  // Warm up (route planning happens on the first tick), then measure.
  engine.runFor(1);
  const seconds = n >= 1000 ? 20 : 60;
  const t0 = performance.now();
  engine.runFor(seconds);
  const ms = (performance.now() - t0) / seconds;
  const alive = [...engine.entities.values()].filter((e) => e.alive).length;
  console.log(`${String(n).padStart(5)} entities: ${ms.toFixed(1).padStart(7)} ms per simulated second  (${(1000 / ms).toFixed(1)}x real time, ${alive} alive after ${seconds + 1}s)`);
}
