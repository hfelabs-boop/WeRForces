import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { executeCommand } from '../src/server/commands.js';
import { SimRunner } from '../src/server/runner.js';
import { SimServer } from '../src/server/server.js';
import { Engine } from '../src/sim/engine.js';
import { Terrain } from '../src/sim/terrain.js';
import type { ServerMessage } from '../src/shared/types.js';

const terrain = Terrain.generate({ size: 6000, seed: 5, towns: 2 });

describe('command validation', () => {
  const engine = new Engine({ terrain });
  engine.newScenario('cmd', terrain.spec);
  const runner = new SimRunner(engine);
  const town = terrain.towns[0];

  it('creates entities and reports their ids', () => {
    const r = executeCommand(runner, { cmd: 'createEntity', typeId: 'us-m1a2', force: 1, x: town.x, y: town.y });
    expect(r).toEqual({ ok: true, id: 'E1' });
  });

  it('rejects malformed commands without throwing', () => {
    expect(executeCommand(runner, null).ok).toBe(false);
    expect(executeCommand(runner, { cmd: 'nope' }).error).toMatch(/unknown command/);
    expect(executeCommand(runner, { cmd: 'createEntity', typeId: 'us-m1a2', force: 9, x: 0, y: 0 }).error).toMatch(/force/);
    expect(executeCommand(runner, { cmd: 'createEntity', typeId: 'us-m1a2', force: 1, x: 'a', y: 0 }).error).toMatch(/x must be/);
    expect(executeCommand(runner, { cmd: 'assignTask', targetId: 'E1', task: { type: 'teleport' } }).error).toMatch(/unknown task/);
    expect(executeCommand(runner, { cmd: 'assignTask', targetId: 'E99', task: { type: 'wait', duration: 1 } }).error).toMatch(/unknown entity/);
    expect(executeCommand(runner, { cmd: 'setTimeScale', scale: 0 }).ok).toBe(false);
  });

  it('keeps the previous scenario when a load fails', () => {
    const before = engine.entities.size;
    const r = executeCommand(runner, {
      cmd: 'loadScenario',
      scenario: { format: 'werforces-scenario', version: 1, name: 'bad', terrain: terrain.spec, entities: [{ id: 'X', typeId: 'no-such-type', force: 1, x: 0, y: 0, heading: 0, name: 'x' }], units: [], graphics: [] },
    });
    expect(r.ok).toBe(false);
    expect(engine.entities.size).toBe(before);
    expect(engine.scenarioName).toBe('cmd');
  });
});

describe('HTTP and WebSocket API', () => {
  let server: SimServer;
  let base: string;
  const engine = new Engine({ terrain });

  beforeAll(async () => {
    engine.newScenario('api', terrain.spec);
    const runner = new SimRunner(engine, 0.1, 20);
    runner.start();
    server = new SimServer(runner, { port: 0, host: '127.0.0.1', webRoot: 'dist/web', scenarioDir: 'scenarios' });
    await server.listen();
    base = server.address;
  });

  afterAll(async () => {
    server.runner.stop();
    await server.close();
  });

  it('serves state, catalog and terrain', async () => {
    const state = await (await fetch(`${base}/api/state`)).json();
    expect(state.scenarioName).toBe('api');
    const catalog = await (await fetch(`${base}/api/catalog`)).json();
    expect(catalog.entityTypes.length).toBeGreaterThan(10);
    const t = await (await fetch(`${base}/api/terrain`)).json();
    expect(t.cols).toBe(terrain.cols);
    const list = await (await fetch(`${base}/api/scenarios`)).json();
    expect(list.some((s: { name: string }) => s.name === 'calloway-crossroads')).toBe(true);
  });

  it('accepts commands over REST', async () => {
    const town = terrain.towns[1];
    const r = await fetch(`${base}/api/command`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cmd: 'createEntity', typeId: 'ru-bmp2', force: 2, x: town.x, y: town.y }) });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.ok).toBe(true);
    expect(engine.entities.has(body.id)).toBe(true);
    const bad = await fetch(`${base}/api/command`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{not json' });
    expect(bad.status).toBe(400);
  });

  it('rejects path traversal in scenario names', async () => {
    const r = await fetch(`${base}/api/scenarios/..%2Fpackage`);
    expect(r.status).toBe(400);
  });

  it('streams hello/state and answers commands over WebSocket', async () => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`);
    const messages: ServerMessage[] = [];
    await new Promise<void>((resolve, reject) => {
      ws.on('message', (d) => {
        const msg = JSON.parse(d.toString()) as ServerMessage;
        messages.push(msg);
        if (msg.type === 'hello') ws.send(JSON.stringify({ type: 'command', reqId: 7, command: { cmd: 'run' } }));
        if (msg.type === 'result') resolve();
      });
      ws.on('error', reject);
    });
    const result = messages.find((m) => m.type === 'result');
    expect(result && result.type === 'result' && result.reqId).toBe(7);
    expect(messages[0].type).toBe('hello');
    expect(messages.some((m) => m.type === 'state')).toBe(true);
    ws.close();
  });
});
