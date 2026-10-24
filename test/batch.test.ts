import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SimRunner } from '../src/server/runner.js';
import { SimServer } from '../src/server/server.js';
import { outcomesCsv, runBatch, stats } from '../src/sim/batch.js';
import { Engine } from '../src/sim/engine.js';
import { Terrain } from '../src/sim/terrain.js';
import type { ScenarioFile } from '../src/shared/types.js';

const calloway = JSON.parse(readFileSync('scenarios/calloway-crossroads.json', 'utf8')) as ScenarioFile;

describe('batch statistics', () => {
  it('computes mean, sample standard deviation and a 95% interval', () => {
    const s = stats([2, 4, 4, 4, 5, 5, 7, 9]);
    expect(s.mean).toBe(5);
    expect(s.sd).toBeCloseTo(2.138, 3);
    expect(s.ci95[0]).toBeCloseTo(5 - (1.96 * 2.138) / Math.sqrt(8), 2);
    expect([s.min, s.max]).toEqual([2, 9]);
  });

  it('replicates a scenario with different seeds, repeatably', { timeout: 60000 }, () => {
    const opts = { runs: 3, duration: 600, seed: 7 };
    const a = runBatch(calloway, opts);
    const b = runBatch(calloway, opts);
    expect(a.outcomes.map((o) => o.forces)).toEqual(b.outcomes.map((o) => o.forces));
    expect(a.outcomes.map((o) => o.seed)).toEqual([7, 8, 9]);
    expect(a.summary.runs).toBe(3);
    const blue = a.summary.losses.find((l) => l.force === 1)!;
    expect(blue.histogram.reduce((x, y) => x + y, 0)).toBe(3);
    expect(blue.total).toBe(calloway.entities.filter((e) => e.force === 1).length);
    expect(a.summary.areas.length).toBe(calloway.graphics.filter((g) => g.kind === 'area').length);
    const csv = outcomesCsv(a.outcomes).trim().split('\n');
    expect(csv).toHaveLength(4);
    expect(csv[0]).toMatch(/^run,seed,end_time,force1_total,force1_lost,force2_total,force2_lost,force3_total,force3_lost,shots,first_kill/);
  });
});

describe('batch and AAR export over REST', () => {
  const terrain = Terrain.generate({ size: 6000, seed: 5, towns: 2 });
  const engine = new Engine({ terrain });
  let server: SimServer;
  let base = '';
  const call = async (method: string, p: string, body?: unknown) => {
    const r = await fetch(`${base}${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return r;
  };

  beforeAll(async () => {
    engine.newScenario('batch', terrain.spec);
    const runner = new SimRunner(engine, 0.1, 20);
    runner.start();
    server = new SimServer(runner, { port: 0, host: '127.0.0.1', webRoot: 'dist/web', scenarioDir: 'scenarios', recordingDir: mkdtempSync(path.join(tmpdir(), 'wf-rec-')) });
    await server.listen();
    base = server.address;
  });

  afterAll(async () => {
    server.runner.stop();
    await server.close();
  });

  it('runs a batch in the background and reports the summary and per-run CSV', async () => {
    const start = await call('POST', '/api/v1/batch', { scenario: 'calloway-crossroads', runs: 2, duration: 600 });
    expect(start.status).toBe(202);
    const { id } = (await start.json()) as { id: string };
    let job: { status: string; done: number; summary?: { runs: number; losses: unknown[] } } = { status: 'running', done: 0 };
    for (let i = 0; i < 300 && job.status === 'running'; i++) {
      await new Promise((r) => setTimeout(r, 100));
      job = await (await call('GET', `/api/v1/batch/${id}`)).json();
    }
    expect(job.status).toBe('done');
    expect(job.summary!.runs).toBe(2);
    expect(job.summary!.losses.length).toBe(3); // blue, red and neutral civilians
    const csv = await (await call('GET', `/api/v1/batch/${id}/runs.csv`)).text();
    expect(csv.trim().split('\n')).toHaveLength(3);
    expect(((await (await call('GET', '/api/v1/batch')).json()) as unknown[]).length).toBeGreaterThan(0);
    expect((await call('POST', '/api/v1/batch', { runs: 0 })).status).toBe(400);
  });

  it('exports the AAR as CSV and PDF', async () => {
    await call('POST', '/api/v1/scenarios/calloway-crossroads/load');
    await call('POST', '/api/v1/simulation/step', { seconds: 900 });
    const kills = await call('GET', '/api/v1/recording/kills.csv');
    expect(kills.headers.get('content-disposition')).toMatch(/kills\.csv/);
    const lines = (await kills.text()).trim().split('\n');
    expect(lines[0]).toBe('time,victim_id,victim,victim_force,killer_id,killer,weapon');
    expect(lines.length).toBeGreaterThan(1);
    expect((await (await call('GET', '/api/v1/recording/events.csv')).text()).split('\n')[0]).toBe('time,kind,text,entity,target');
    expect((await (await call('GET', '/api/v1/recording/strength.csv')).text()).split('\n')[0]).toBe('time,blue_alive,red_alive,neutral_alive');
    const pdf = await call('GET', '/api/v1/recording/report.pdf');
    expect(pdf.headers.get('content-type')).toBe('application/pdf');
    const bytes = new Uint8Array(await pdf.arrayBuffer());
    const head = new TextDecoder('latin1').decode(bytes.slice(0, 8));
    const tail = new TextDecoder('latin1').decode(bytes.slice(-6));
    expect(head).toBe('%PDF-1.4');
    expect(tail).toBe('%%EOF\n');
    const text = new TextDecoder('latin1').decode(bytes);
    expect(text).toContain('After-action report');
    // The cross-reference table points at each object.
    const xref = Number(/startxref\n(\d+)/.exec(text)![1]);
    expect(text.slice(xref, xref + 4)).toBe('xref');
    const first = /0000000000 65535 f \n(\d{10}) 00000 n/.exec(text)!;
    expect(text.slice(Number(first[1]), Number(first[1]) + 7)).toBe('1 0 obj');
  });
});
