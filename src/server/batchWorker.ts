// Worker thread for batch runs, so long Monte Carlo studies don't stall the server.

import { parentPort, workerData } from 'node:worker_threads';
import { runBatch } from '../sim/batch.js';
import { type BatchJobInput, batchTerrainLoader } from './batch.js';

const input = workerData as BatchJobInput;
try {
  const { summary } = runBatch(input.scenario, input.options, { catalog: input.catalog, terrainLoader: batchTerrainLoader(input) }, (done, outcome) => {
    parentPort!.postMessage({ type: 'progress', done, outcome });
  });
  parentPort!.postMessage({ type: 'done', summary });
} catch (err) {
  parentPort!.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
}
