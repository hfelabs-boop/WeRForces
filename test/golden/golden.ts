// Golden runs: each sample scenario is run for a fixed time and its outcome compared with
// a stored summary. Any change to the model shows up here; when the change is intended,
// regenerate the files with `npm run golden:update` and review the diff.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { ScenarioFile } from '../../src/shared/types.js';
import { Engine } from '../../src/sim/engine.js';

export const GOLDEN_RUNS = [
  { scenario: 'calloway-crossroads', seconds: 1200 },
  { scenario: 'lakeside-patrol', seconds: 900 },
];

export interface GoldenSummary {
  scenario: string;
  seconds: number;
  alive: Record<string, string>;
  kills: string[];
  events: number;
  /** SHA-256 of every event (time, kind, text): catches changes the summary misses. */
  digest: string;
}

export function goldenRun(scenario: string, seconds: number): GoldenSummary {
  const file = JSON.parse(readFileSync(`scenarios/${scenario}.json`, 'utf8')) as ScenarioFile;
  const engine = new Engine();
  engine.loadScenario(file);
  const lines: string[] = [];
  const kills: string[] = [];
  engine.on('event', (ev) => {
    lines.push(`${ev.time.toFixed(1)}|${ev.kind}|${ev.text}`);
    if (ev.kind === 'destroyed') kills.push(`${ev.time.toFixed(1)} ${ev.text}`);
  });
  engine.runFor(seconds);
  const alive: Record<string, string> = {};
  for (const f of [1, 2, 3]) {
    const list = [...engine.entities.values()].filter((e) => e.force === f);
    if (list.length) alive[f] = `${list.filter((e) => e.alive).length}/${list.length}`;
  }
  return { scenario, seconds, alive, kills, events: lines.length, digest: createHash('sha256').update(lines.join('\n')).digest('hex') };
}
