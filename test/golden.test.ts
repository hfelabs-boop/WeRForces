import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GOLDEN_RUNS, goldenRun, type GoldenSummary } from './golden/golden.js';

describe('golden runs', () => {
  for (const { scenario, seconds } of GOLDEN_RUNS) {
    it(`${scenario} plays out as recorded (${seconds} s)`, { timeout: 120000 }, () => {
      const file = `test/golden/${scenario}.json`;
      expect(existsSync(file), `missing ${file}: run npm run golden:update`).toBe(true);
      const want = JSON.parse(readFileSync(file, 'utf8')) as GoldenSummary;
      const got = goldenRun(scenario, seconds);
      // Outcome first (a readable diff), then everything else via the digest.
      expect({ alive: got.alive, kills: got.kills }, 'outcome changed; if intended, run npm run golden:update').toEqual({ alive: want.alive, kills: want.kills });
      expect(got.events, 'event count changed; if intended, run npm run golden:update').toBe(want.events);
      expect(got.digest, 'event log changed; if intended, run npm run golden:update').toBe(want.digest);
    });
  }
});
