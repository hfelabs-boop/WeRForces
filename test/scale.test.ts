import { describe, expect, it } from 'vitest';
import { buildBenchScenario, eventDigest } from '../scripts/bench-scenario.js';

/** Run the benchmark scenario: wall time for the measured stretch and a digest of every event. */
function run(entities: number, seconds: number) {
  const { engine, counts } = buildBenchScenario(entities);
  const log = eventDigest(engine);
  const t0 = performance.now();
  engine.runFor(seconds);
  const wall = (performance.now() - t0) / 1000;
  const alive = [...engine.entities.values()].filter((e) => e.alive).length;
  return { counts, wall, alive, events: log.count(), digest: log.digest() };
}

describe('scale', () => {
  it('1,000 entities fighting run well ahead of real time, and the same seed plays out the same', { timeout: 180_000 }, () => {
    const a = run(1000, 30);
    expect(a.counts.entities).toBeGreaterThanOrEqual(1000);
    expect(a.events).toBeGreaterThan(100);
    // Several times faster than real time here; the budget leaves room for slow CI runners.
    expect(a.wall, `30 simulated seconds took ${a.wall.toFixed(1)} s`).toBeLessThan(15);
    const b = run(1000, 30);
    expect({ events: b.events, alive: b.alive, digest: b.digest }).toEqual({ events: a.events, alive: a.alive, digest: a.digest });
  });
});
