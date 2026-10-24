import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { SimRunner } from '../src/server/runner.js';
import { SimServer } from '../src/server/server.js';
import { Engine } from '../src/sim/engine.js';
import { Terrain } from '../src/sim/terrain.js';
import type { ServerMessage } from '../src/shared/types.js';

const terrain = Terrain.generate({ size: 6000, seed: 5, towns: 2 });

describe('sessions', () => {
  const engine = new Engine({ terrain });
  let server: SimServer;
  let base = '';
  const call = (method: string, p: string, body?: unknown) =>
    fetch(`${base}${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? (method === 'POST' ? '{}' : undefined) : JSON.stringify(body) });

  beforeAll(async () => {
    engine.newScenario('Main exercise', terrain.spec);
    const runner = new SimRunner(engine, 0.1, 20, 0);
    runner.start();
    server = new SimServer(runner, { port: 0, host: '127.0.0.1', webRoot: 'dist/web', scenarioDir: 'scenarios' });
    await server.listen();
    base = server.address;
  });

  afterAll(async () => {
    server.runner.stop();
    await server.close();
  });

  it('runs a second exercise side by side under /s/{id}', async () => {
    const created = await call('POST', '/api/v1/sessions', { id: 'alpha', scenario: 'calloway-crossroads' });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ id: 'alpha', path: '/s/alpha/', scenario: 'Calloway Crossroads' });
    const alpha = (await (await call('GET', '/s/alpha/api/v1/simulation')).json()) as { scenario: string; entities: number };
    const main = (await (await call('GET', '/api/v1/simulation')).json()) as { scenario: string; entities: number };
    expect(alpha.scenario).toBe('Calloway Crossroads');
    expect(alpha.entities).toBeGreaterThan(20);
    expect(main.scenario).toBe('Main exercise');
    expect(main.entities).toBe(0);
    // Commands go to their own session only.
    await call('POST', '/s/alpha/api/v1/simulation/step', { seconds: 60 });
    expect(((await (await call('GET', '/s/alpha/api/v1/simulation')).json()) as { time: number }).time).toBeCloseTo(60, 6);
    expect(((await (await call('GET', '/api/v1/simulation')).json()) as { time: number }).time).toBe(0);
    // The GUI endpoints and the WebSocket are per session too.
    const state = (await (await call('GET', '/s/alpha/api/state')).json()) as { scenarioName: string };
    expect(state.scenarioName).toBe('Calloway Crossroads');
    const hello = await new Promise<ServerMessage>((resolve, reject) => {
      const ws = new WebSocket(`${base.replace('http', 'ws')}/s/alpha/ws`);
      ws.on('message', (d) => {
        resolve(JSON.parse(d.toString()));
        ws.close();
      });
      ws.on('error', reject);
    });
    expect(hello).toMatchObject({ type: 'hello', scenarioName: 'Calloway Crossroads' });
    const list = (await (await call('GET', '/api/v1/sessions')).json()) as { id: string }[];
    expect(list.map((s) => s.id)).toEqual(['main', 'alpha']);
  });

  it('rejects bad ids, unknown sessions and deleting main', async () => {
    expect((await call('POST', '/api/v1/sessions', { id: 'Bad Id!' })).status).toBe(400);
    expect((await call('POST', '/api/v1/sessions', { id: 'alpha' })).status).toBe(409);
    expect((await call('GET', '/s/nope/api/v1/simulation')).status).toBe(404);
    expect((await call('DELETE', '/api/v1/sessions/main')).status).toBe(400);
    expect((await call('DELETE', '/api/v1/sessions/alpha')).status).toBe(204);
    expect((await call('GET', '/s/alpha/api/v1/simulation')).status).toBe(404);
    // A session page without the trailing slash is redirected (its assets are relative).
    await call('POST', '/api/v1/sessions', { id: 'beta' });
    const r = await fetch(`${base}/s/beta`, { redirect: 'manual' });
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('/s/beta/');
  });
});
