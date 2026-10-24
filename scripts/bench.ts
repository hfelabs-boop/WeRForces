// Performance benchmark: a mixed scenario of N entities (ground units in formation
// advancing and fighting across 24 km, aircraft, civilians; see bench-scenario.ts), run
// with the recorder attached and state snapshots serialised as the server sends them to a
// GUI at 1x real time (10 Hz, or less when a broadcast would take more than a tenth of the
// time). Reports simulated seconds per wall second and where the time goes.
//   npm run bench                                   1000, 2000 and 5000 entities
//   npx tsx scripts/bench.ts 5000 --seconds 120     one size, longer run (default 60 s after 30 s warm-up)
//   npx tsx scripts/bench.ts 5000 --no-profile      timing only (no CPU profiler)
//   npx tsx scripts/bench.ts 5000 --sim-only        no recorder and no snapshots

import { Session } from 'node:inspector/promises';
import { Recorder } from '../src/sim/recorder.js';
import { buildBenchScenario } from './bench-scenario.js';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string, def: number) => {
  const i = args.indexOf(name);
  return i >= 0 ? Number(args[i + 1]) : def;
};
const sizes = args.filter((a, i) => /^\d+$/.test(a) && !args[i - 1]?.startsWith('--')).map(Number);
const seconds = option('--seconds', 60);
/** Simulated seconds before measuring: the first routes, civilians setting off, first contacts. */
const warmup = option('--warmup', 30);
const profile = !flag('--no-profile');
const simOnly = flag('--sim-only');
/** `--callers <subsystem>`: also list the call chains that spend that subsystem's time. */
const callersOf = args.includes('--callers') ? args[args.indexOf('--callers') + 1] : undefined;

/** Subsystem of a profile frame, or null to charge the time to its caller. */
function subsystem(fn: string, url: string): string | null {
  const file = url.slice(url.lastIndexOf('/') + 1).replace(/\?.*$/, '');
  if (fn === '(garbage collector)') return 'gc';
  if (file === 'terrain.ts') {
    if (/lineOfSight|clearAbove|obstacleTops/.test(fn)) return 'line of sight';
    if (/planRoute|costGrid|nearestPassable|route/i.test(fn)) return 'route planning';
    return null;
  }
  if (file === 'pathfinding.ts') return 'route planning';
  if (file === 'spatial.ts') return 'spatial index';
  if (file === 'sensors.ts') return 'sensors';
  if (file === 'combat.ts' || file === 'fires.ts') return 'combat';
  if (file === 'movement.ts' || file === 'obstacles.ts' || file === 'supply.ts') return 'movement';
  if (file === 'tasks.ts' || file === 'units.ts' || file === 'plans.ts') return 'units/tasks/plans';
  if (file === 'recorder.ts' || file === 'recording.ts') return 'recorder';
  if (file === 'life.ts') return 'pattern of life';
  if (['morale.ts', 'alerts.ts', 'ew.ts', 'sync.ts', 'smoke.ts', 'environment.ts', 'threats.ts', 'eta.ts'].includes(file)) return 'once a second';
  if (file === 'engine.ts') {
    if (/snapshot|schedule/.test(fn)) return 'snapshot';
    if (fn === 'losCached' || fn === 'lineOfSight') return 'line of sight';
    if (/shouldHalt|checkWithdrawals|deliverOrders/.test(fn)) return 'units/tasks/plans';
    if (fn === 'processImpacts' || fn === 'launch' || fn === 'hasShotInFlight') return 'combat';
    return 'engine loop';
  }
  if (file === 'bench.ts') return fn === 'serialise' ? 'serialisation' : 'other';
  return null;
}

interface ProfileNode {
  id: number;
  callFrame: { functionName: string; url: string };
  children?: number[];
}

/** Self time per subsystem: each sample goes to the innermost frame that names one. */
function breakdown(p: { nodes: ProfileNode[]; samples: number[]; timeDeltas: number[] }): [string, number][] {
  const parent = new Map<number, number>();
  const byId = new Map<number, ProfileNode>();
  for (const n of p.nodes) {
    byId.set(n.id, n);
    for (const c of n.children ?? []) parent.set(c, n.id);
  }
  const memo = new Map<number, string>();
  const classify = (id: number): string => {
    const hit = memo.get(id);
    if (hit) return hit;
    let cur: number | undefined = id;
    let out = 'other';
    while (cur !== undefined) {
      const n = byId.get(cur)!;
      if (n.callFrame.functionName === '(idle)' || n.callFrame.functionName === '(program)') break;
      const s = subsystem(n.callFrame.functionName, n.callFrame.url);
      if (s) {
        out = s;
        break;
      }
      cur = parent.get(cur);
    }
    memo.set(id, out);
    return out;
  };
  const totals = new Map<string, number>();
  const chains = new Map<string, number>();
  p.samples.forEach((id, i) => {
    const k = classify(id);
    const dt = p.timeDeltas[i] ?? 0;
    totals.set(k, (totals.get(k) ?? 0) + dt);
    if (k !== callersOf) return;
    const names: string[] = [];
    for (let cur: number | undefined = id; cur !== undefined && names.length < 5; cur = parent.get(cur)) names.push(byId.get(cur)!.callFrame.functionName || '(anonymous)');
    const chain = names.join(' < ');
    chains.set(chain, (chains.get(chain) ?? 0) + dt);
  });
  if (callersOf) for (const [chain, us] of [...chains].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`       ${(us / 1000).toFixed(0).padStart(7)} ms  ${chain}`);
  return [...totals].sort((a, b) => b[1] - a[1]);
}

let snapshotBytes = 0;
function serialise(json: unknown): void {
  snapshotBytes = JSON.stringify(json).length;
}

const session = profile ? new Session() : null;
if (session) {
  session.connect();
  await session.post('Profiler.enable');
  await session.post('Profiler.setSamplingInterval', { interval: 500 });
}

for (const n of sizes.length ? sizes : [1000, 2000, 5000]) {
  const t0 = performance.now();
  const { engine, counts } = buildBenchScenario(n);
  const setupMs = performance.now() - t0;
  const recorder = simOnly ? null : new Recorder(engine);
  // At 1x a step is 100 ms of wall time; like the server (STATE_BUDGET in server.ts), a
  // broadcast may use at most a tenth of the time until the next one.
  let steps = 0;
  let stateDue = 0;
  let states = 0;
  if (!simOnly) {
    engine.on('step', () => {
      if (++steps < stateDue) return;
      const ts = performance.now();
      serialise(engine.snapshot());
      states++;
      stateDue = steps + Math.max(1, Math.ceil((performance.now() - ts) / 0.1 / 100));
    });
  }
  engine.runFor(warmup);
  if (session) await session.post('Profiler.start');
  const t1 = performance.now();
  states = 0;
  engine.runFor(seconds);
  const wall = (performance.now() - t1) / 1000;
  const prof = session ? ((await session.post('Profiler.stop')) as { profile: Parameters<typeof breakdown>[0] }).profile : null;
  recorder?.detach();
  const alive = [...engine.entities.values()].filter((e) => e.alive);
  const contacts = alive.reduce((s, e) => s + e.contacts.size, 0);
  const lost = (f: number) => [...engine.entities.values()].filter((e) => e.force === f && !e.alive).length;
  console.log(
    `${String(counts.entities).padStart(5)} entities (${counts.units} units, ${counts.air} aircraft, ${counts.civilians} civilians): ` +
      `${(seconds / wall).toFixed(2)}x real time, ${((wall * 1000) / seconds).toFixed(1)} ms per simulated second` +
      `${simOnly ? ' (simulation only)' : `, state ${(snapshotBytes / 1e6).toFixed(2)} MB at ${(states / seconds).toFixed(1)} Hz`}`,
  );
  console.log(`       setup ${(setupMs / 1000).toFixed(1)} s; after ${seconds + warmup + 1} s: ${alive.length} alive, losses blue ${lost(1)} red ${lost(2)}, ${Math.round(contacts / Math.max(1, alive.length))} contacts per entity`);
  if (prof) {
    const rows = breakdown(prof);
    const total = rows.reduce((s, [, us]) => s + us, 0);
    for (const [name, us] of rows) {
      if (us / total < 0.005) continue;
      console.log(`       ${name.padEnd(20)} ${((us / total) * 100).toFixed(1).padStart(5)} %  ${(us / 1000 / seconds).toFixed(1).padStart(7)} ms/sim-s`);
    }
  }
}
session?.disconnect();
