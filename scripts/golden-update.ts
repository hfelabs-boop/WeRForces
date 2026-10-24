// Regenerate the golden-run summaries in test/golden after an intended model change.
//   npm run golden:update

import { writeFileSync } from 'node:fs';
import { GOLDEN_RUNS, goldenRun } from '../test/golden/golden.js';

for (const { scenario, seconds } of GOLDEN_RUNS) {
  const s = goldenRun(scenario, seconds);
  writeFileSync(`test/golden/${scenario}.json`, `${JSON.stringify(s, null, 2)}\n`);
  console.log(`${scenario}: ${Object.entries(s.alive).map(([f, a]) => `force ${f} ${a}`).join(', ')}, ${s.kills.length} kills, ${s.events} events`);
}
