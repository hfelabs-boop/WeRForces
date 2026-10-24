// Batch run jobs: Monte Carlo replications of a scenario in a worker thread, with
// progress and results kept for the REST API, MCP and the browser.

import { Worker } from 'node:worker_threads';
import type { Catalog, ScenarioFile, TerrainData } from '../shared/types.js';
import { type BatchOptions, type BatchSummary, type RunOutcome, runOnce, summarise } from '../sim/batch.js';
import { Engine } from '../sim/engine.js';
import type { Terrain } from '../sim/terrain.js';
import { datasetLoader } from '../terrain/store.js';

export interface BatchJobInput {
  scenario: ScenarioFile;
  options: BatchOptions;
  catalog: Catalog;
  terrains: Record<string, TerrainData>;
  /** Where tiled datasets (not sent in terrains) are read from. */
  terrainDir?: string;
}

export interface BatchJob {
  id: string;
  scenario: string;
  status: 'running' | 'done' | 'failed' | 'cancelled';
  runs: number;
  done: number;
  options: BatchOptions;
  started: string;
  error?: string;
  /** Where it runs: a worker thread, or the server thread when workers are unavailable. */
  thread: 'worker' | 'main';
  outcomes: RunOutcome[];
  summary?: BatchSummary;
}

const KEEP = 20;

export class BatchManager {
  private jobs = new Map<string, BatchJob>();
  private cancels = new Map<string, () => void>();
  private next = 1;

  constructor(private readonly useWorkers = true) {}

  list(): Omit<BatchJob, 'outcomes'>[] {
    return [...this.jobs.values()].map(({ outcomes: _o, ...rest }) => rest);
  }

  get(id: string): BatchJob | undefined {
    return this.jobs.get(id);
  }

  cancel(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job || job.status !== 'running') return false;
    this.cancels.get(id)?.();
    job.status = 'cancelled';
    return true;
  }

  start(input: BatchJobInput): BatchJob {
    const id = `B${this.next++}`;
    const job: BatchJob = {
      id,
      scenario: input.scenario.name,
      status: 'running',
      runs: input.options.runs,
      done: 0,
      options: input.options,
      started: new Date().toISOString(),
      thread: 'worker',
      outcomes: [],
    };
    this.jobs.set(id, job);
    for (const old of [...this.jobs.keys()].slice(0, Math.max(0, this.jobs.size - KEEP))) if (this.jobs.get(old)!.status !== 'running') this.jobs.delete(old);
    if (this.useWorkers) this.inWorker(job, input);
    else this.inProcess(job, input);
    return job;
  }

  private inWorker(job: BatchJob, input: BatchJobInput): void {
    let worker: Worker;
    try {
      worker = new Worker(new URL('./batchWorker.js', import.meta.url), { workerData: input });
    } catch {
      this.inProcess(job, input);
      return;
    }
    let heard = false;
    this.cancels.set(job.id, () => void worker.terminate());
    worker.on('message', (m: { type: string; done?: number; outcome?: RunOutcome; summary?: BatchSummary; message?: string }) => {
      heard = true;
      if (job.status !== 'running') return;
      if (m.type === 'progress') {
        job.done = m.done!;
        job.outcomes.push(m.outcome!);
      } else if (m.type === 'done') {
        job.summary = m.summary;
        job.status = 'done';
        void worker.terminate();
      } else if (m.type === 'error') {
        job.error = m.message;
        job.status = 'failed';
      }
    });
    worker.on('error', (err) => {
      // A worker that never started (e.g. no compiled worker file under a test runner): run here instead.
      if (!heard && job.status === 'running') {
        this.inProcess(job, input);
        return;
      }
      if (job.status === 'running') {
        job.status = 'failed';
        job.error = err.message;
      }
    });
  }

  /** Run in this thread, one replication per tick so the server keeps answering. */
  private inProcess(job: BatchJob, input: BatchJobInput): void {
    job.thread = 'main';
    const started = Date.now();
    const engine = new Engine({ catalog: input.catalog, terrainLoader: batchTerrainLoader(input) });
    let cancelled = false;
    this.cancels.set(job.id, () => (cancelled = true));
    const step = (i: number) => {
      if (cancelled || job.status !== 'running') return;
      try {
        if (i < job.runs) {
          job.outcomes.push(runOnce(engine, input.scenario, i, input.options));
          job.done = i + 1;
          setImmediate(() => step(i + 1));
          return;
        }
        job.summary = summarise(input.scenario, job.outcomes, input.options, (Date.now() - started) / 1000);
        job.status = 'done';
      } catch (err) {
        job.status = 'failed';
        job.error = err instanceof Error ? err.message : String(err);
      }
    };
    setImmediate(() => step(0));
  }
}

/** Terrain for batch runs: the datasets sent with the job, else tiled datasets from the terrains folder. */
export function batchTerrainLoader(input: BatchJobInput): (name: string) => TerrainData | Terrain {
  const tiled = input.terrainDir ? datasetLoader(input.terrainDir) : null;
  return (name) => {
    const d = input.terrains[name] ?? tiled?.(name);
    if (!d) throw new Error(`terrain dataset "${name}" is not available to the batch run`);
    return d;
  };
}
