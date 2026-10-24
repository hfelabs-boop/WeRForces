// Batch (Monte Carlo) runs: replicate a scenario with different random seeds and
// summarise the outcomes with confidence intervals.

import { pointInPolygon } from '../shared/math.js';
import type { Catalog, ForceId, ScenarioFile, TerrainData } from '../shared/types.js';
import { Engine } from './engine.js';

export interface BatchOptions {
  runs: number;
  /** Simulated seconds per run. */
  duration: number;
  /** Seed of the first run; run i uses seed + i. */
  seed?: number;
  /** End a run early once a force has nothing left alive. */
  stopWhenDestroyed?: boolean;
}

export interface RunOutcome {
  run: number;
  seed: number;
  /** Simulated time the run ended. */
  endTime: number;
  forces: { force: ForceId; total: number; lost: number }[];
  shots: number;
  /** Area graphics: which force controls each at the end (alive inside, no hostile alive inside), if any. */
  areas: { id: string; name: string; held?: ForceId }[];
  /** Time of the first kill. */
  firstKill?: number;
}

export interface Stats {
  mean: number;
  sd: number;
  min: number;
  max: number;
  /** 95% confidence interval of the mean (normal approximation). */
  ci95: [number, number];
}

export interface BatchSummary {
  scenario: string;
  runs: number;
  duration: number;
  /** Losses per force, and a histogram of how many runs lost each number. */
  losses: { force: ForceId; total: number; stats: Stats; histogram: number[] }[];
  /** Mean red losses / mean blue losses. */
  exchangeRatio?: number;
  /** Share of runs in which each force held each area at the end. */
  areas: { id: string; name: string; held: Partial<Record<ForceId, number>> }[];
  shots: Stats;
  endTime: Stats;
  wallSeconds: number;
}

export function stats(xs: number[]): Stats {
  const n = xs.length;
  if (!n) return { mean: 0, sd: 0, min: 0, max: 0, ci95: [0, 0] };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  const half = n > 1 ? (1.96 * sd) / Math.sqrt(n) : 0;
  const r = (v: number) => Math.round(v * 1000) / 1000;
  return { mean: r(mean), sd: r(sd), min: Math.min(...xs), max: Math.max(...xs), ci95: [r(mean - half), r(mean + half)] };
}

/** Run one replication on an engine (reused across runs: the terrain is kept). */
export function runOnce(engine: Engine, scenario: ScenarioFile, run: number, opts: BatchOptions): RunOutcome {
  const seed = (opts.seed ?? 1000) + run;
  engine.loadScenario(scenario);
  engine.reseed(seed);
  let shots = 0;
  let firstKill: number | undefined;
  const offFire = engine.on('fire', () => shots++);
  const offEvent = engine.on('event', (ev) => {
    if (ev.kind === 'destroyed' && firstKill === undefined) firstKill = ev.time;
  });
  const start = engine.time;
  const forces = [...new Set([...engine.entities.values()].filter((e) => !e.remote).map((e) => e.force))].sort();
  const end = start + opts.duration;
  while (engine.time < end - 1e-9) {
    engine.runFor(Math.min(10, end - engine.time));
    if (opts.stopWhenDestroyed && forces.some((f) => ![...engine.entities.values()].some((e) => e.force === f && e.alive))) break;
  }
  offFire();
  offEvent();
  const all = [...engine.entities.values()].filter((e) => !e.remote);
  const areas = [...engine.graphics.values()]
    .filter((g) => g.kind === 'area' && g.points.length >= 3)
    .map((g) => {
      const inside = new Set(all.filter((e) => e.alive && !e.embarkedIn && pointInPolygon(e, g.points)).map((e) => e.force));
      const holders = [...inside].filter((f) => ![...inside].some((o) => o !== f && engine.isHostile(f, o)));
      return { id: g.id, name: g.name, held: holders.length === 1 ? holders[0] : undefined };
    });
  return {
    run,
    seed,
    endTime: Math.round(engine.time * 10) / 10,
    forces: forces.map((f) => ({ force: f, total: all.filter((e) => e.force === f).length, lost: all.filter((e) => e.force === f && e.destroyed).length })),
    shots,
    areas,
    firstKill: firstKill === undefined ? undefined : Math.round(firstKill * 10) / 10,
  };
}

export function summarise(scenario: ScenarioFile, outcomes: RunOutcome[], opts: BatchOptions, wallSeconds: number): BatchSummary {
  const forces = [...new Set(outcomes.flatMap((o) => o.forces.map((f) => f.force)))].sort();
  const losses = forces.map((force) => {
    const xs = outcomes.map((o) => o.forces.find((f) => f.force === force)?.lost ?? 0);
    const total = Math.max(...outcomes.map((o) => o.forces.find((f) => f.force === force)?.total ?? 0));
    const histogram = new Array(total + 1).fill(0);
    for (const x of xs) histogram[x]++;
    return { force, total, stats: stats(xs), histogram };
  });
  const blue = losses.find((l) => l.force === 1)?.stats.mean;
  const red = losses.find((l) => l.force === 2)?.stats.mean;
  const areaIds = outcomes[0]?.areas ?? [];
  return {
    scenario: scenario.name,
    runs: outcomes.length,
    duration: opts.duration,
    losses,
    // Undefined when Blue lost nothing: the ratio would be meaningless.
    exchangeRatio: blue && red !== undefined ? Math.round((red / blue) * 100) / 100 : undefined,
    areas: areaIds.map((a) => {
      const held: Partial<Record<ForceId, number>> = {};
      for (const o of outcomes) {
        const h = o.areas.find((x) => x.id === a.id)?.held;
        if (h !== undefined) held[h] = (held[h] ?? 0) + 1;
      }
      for (const k of Object.keys(held)) held[Number(k) as ForceId] = Math.round((held[Number(k) as ForceId]! / outcomes.length) * 1000) / 1000;
      return { id: a.id, name: a.name, held };
    }),
    shots: stats(outcomes.map((o) => o.shots)),
    endTime: stats(outcomes.map((o) => o.endTime)),
    wallSeconds: Math.round(wallSeconds * 10) / 10,
  };
}

/** Per-run outcomes as CSV: one row per run, losses per force and area control. */
export function outcomesCsv(outcomes: RunOutcome[]): string {
  const forces = [...new Set(outcomes.flatMap((o) => o.forces.map((f) => f.force)))].sort();
  const areas = outcomes[0]?.areas ?? [];
  const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const head = ['run', 'seed', 'end_time', ...forces.flatMap((f) => [`force${f}_total`, `force${f}_lost`]), 'shots', 'first_kill', ...areas.map((a) => esc(`held_${a.name}`))];
  const rows = outcomes.map((o) => [
    o.run,
    o.seed,
    o.endTime,
    ...forces.flatMap((f) => {
      const x = o.forces.find((q) => q.force === f);
      return [x?.total ?? 0, x?.lost ?? 0];
    }),
    o.shots,
    o.firstKill ?? '',
    ...areas.map((a) => o.areas.find((x) => x.id === a.id)?.held ?? ''),
  ]);
  return [head.join(','), ...rows.map((r) => r.join(','))].join('\n') + '\n';
}

/** Run a whole batch in this thread, reporting progress after each run. */
export function runBatch(
  scenario: ScenarioFile,
  opts: BatchOptions,
  env: { catalog?: Catalog; terrainLoader?: (name: string) => TerrainData } = {},
  progress?: (done: number, outcome: RunOutcome) => boolean | void,
): { outcomes: RunOutcome[]; summary: BatchSummary } {
  const started = Date.now();
  const engine = new Engine({ catalog: env.catalog, terrainLoader: env.terrainLoader });
  const outcomes: RunOutcome[] = [];
  for (let i = 0; i < opts.runs; i++) {
    const o = runOnce(engine, scenario, i, opts);
    outcomes.push(o);
    // Returning false cancels.
    if (progress?.(i + 1, o) === false) break;
  }
  return { outcomes, summary: summarise(scenario, outcomes, opts, (Date.now() - started) / 1000) };
}
