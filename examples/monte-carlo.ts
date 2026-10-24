// Monte Carlo analysis with the engine as a library: run a scenario many times with
// different random seeds and summarise the outcomes. No server needed.
//
//   npx tsx examples/monte-carlo.ts [scenario name or .json path] [runs] [seconds]
//   npx tsx examples/monte-carlo.ts calloway-crossroads 20 2400
//   npx tsx examples/monte-carlo.ts my-variant.json 20 2400

import { readFileSync } from 'node:fs';
import { pointInPolygon } from '../src/shared/math.js';
import type { ScenarioFile } from '../src/shared/types.js';
import { Engine } from '../src/sim/engine.js';

const [name = 'calloway-crossroads', runsArg = '10', secondsArg = '2400'] = process.argv.slice(2);
const file = name.endsWith('.json') ? name : `scenarios/${name}.json`;
const scenario = JSON.parse(readFileSync(file, 'utf8')) as ScenarioFile;
const runs = Number(runsArg);
const seconds = Number(secondsArg);

// Reuse one engine: the terrain is generated once and kept across loads.
const engine = new Engine();
const objective = scenario.graphics.find((g) => g.kind === 'area');

interface Outcome {
  blueLost: number;
  redLost: number;
  shots: number;
  objectiveHeld: boolean;
}

const outcomes: Outcome[] = [];
const started = Date.now();
for (let i = 0; i < runs; i++) {
  engine.loadScenario(scenario);
  engine.reseed(1000 + i); // a different replication each time
  let shots = 0;
  const off = engine.on('fire', () => shots++);
  engine.runFor(seconds);
  off();

  const all = [...engine.entities.values()];
  const lost = (force: number) => all.filter((e) => e.force === force && e.destroyed).length;
  // "Held" = blue survivors inside the objective and no red survivors in it.
  const inObj = (force: number) => objective !== undefined && all.some((e) => e.force === force && e.alive && pointInPolygon(e, objective.points));
  outcomes.push({ blueLost: lost(1), redLost: lost(2), shots, objectiveHeld: inObj(1) && !inObj(2) });
  process.stdout.write(`run ${String(i + 1).padStart(3)}: blue lost ${lost(1)}, red lost ${lost(2)}, ${shots} shots${objective ? `, objective ${outcomes[i].objectiveHeld ? 'taken' : 'not taken'}` : ''}\n`);
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const sd = (xs: number[]) => Math.sqrt(mean(xs.map((x) => (x - mean(xs)) ** 2)));
const blueTotal = scenario.entities.filter((e) => e.force === 1).length;
const redTotal = scenario.entities.filter((e) => e.force === 2).length;
const b = outcomes.map((o) => o.blueLost);
const r = outcomes.map((o) => o.redLost);

console.log(`\n${scenario.name}: ${runs} runs of ${seconds} s (${((Date.now() - started) / 1000).toFixed(1)} s wall time)`);
console.log(`  Blue losses ${mean(b).toFixed(1)} ± ${sd(b).toFixed(1)} of ${blueTotal}`);
console.log(`  Red losses  ${mean(r).toFixed(1)} ± ${sd(r).toFixed(1)} of ${redTotal}`);
console.log(`  Loss exchange ratio (red/blue) ${(mean(r) / Math.max(0.01, mean(b))).toFixed(2)}`);
if (objective) console.log(`  Objective "${objective.name}" taken in ${outcomes.filter((o) => o.objectiveHeld).length}/${runs} runs`);
