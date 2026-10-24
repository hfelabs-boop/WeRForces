import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { checkCommand, filterState, ForbiddenError, parsePlayer } from '../src/server/fog.js';
import { SimRunner } from '../src/server/runner.js';
import { SimServer } from '../src/server/server.js';
import { Engine } from '../src/sim/engine.js';
import { Terrain } from '../src/sim/terrain.js';
import type { ServerMessage } from '../src/shared/types.js';

const base = Terrain.generate({ size: 6000, seed: 9, towns: 2 });
const cols = 81;
const flat = new Terrain({ ...base.spec, size: 4000, cellSize: 50, seed: 4242 }, new Float32Array(cols * cols).fill(20), new Uint8Array(cols * cols), [], []);

function scene() {
  const engine = new Engine({ terrain: flat, seed: 3 });
  engine.newScenario('fog', flat.spec);
  const scout = engine.createEntity({ id: 'E1', typeId: 'us-hmmwv', force: 1, x: 1000, y: 2000 });
  const seen = engine.createEntity({ id: 'E2', typeId: 'ru-brdm2', force: 2, x: 2500, y: 2000 });
  const hidden = engine.createEntity({ id: 'E3', typeId: 'ru-t72b3', force: 2, x: 3900, y: 3900 });
  for (const e of [scout, seen, hidden]) e.roe = 'holdFire';
  engine.addGraphic('route', [{ x: 2600, y: 2000 }, { x: 3000, y: 2500 }], 'Red route', 2, 'G9');
  engine.runFor(5);
  return { engine, scout, seen, hidden };
}

describe('fog of war', () => {
  it('shows own force fully and others only as contacts at their last seen position', () => {
    const { engine, seen } = scene();
    const s = filterState(engine, engine.snapshot(), 1);
    expect(s.entities.map((e) => e.id).sort()).toEqual(['E1', 'E2']);
    const c = s.entities.find((e) => e.id === 'E2')!;
    expect(c.contactAge).toBeLessThan(2);
    expect(c.name).toBe('BRDM-2 (E2)');
    expect(c.ammo).toEqual([]);
    expect(s.graphics.find((g) => g.id === 'G9')).toBeUndefined();
    // Once out of sight, the contact stays where it was last seen until it times out.
    engine.assignTask(seen.id, { type: 'moveTo', target: { x: 3900, y: 200 } });
    engine.runFor(60);
    const later = filterState(engine, engine.snapshot(), 1).entities.find((e) => e.id === 'E2');
    if (later) expect(Math.hypot(later.x - seen.x, later.y - seen.y)).toBeGreaterThan(1);
  });

  it('limits player commands to their own force and what they can see', () => {
    const { engine } = scene();
    const blue = { kind: 'player', force: 1 } as const;
    expect(() => checkCommand(engine, blue, { cmd: 'assignTask', targetId: 'E1', task: { type: 'attack', targetId: 'E2' } })).not.toThrow();
    expect(() => checkCommand(engine, blue, { cmd: 'assignTask', targetId: 'E1', task: { type: 'attack', targetId: 'E3' } })).toThrow(ForbiddenError);
    expect(() => checkCommand(engine, blue, { cmd: 'assignTask', targetId: 'E2', task: { type: 'wait', duration: 5 } })).toThrow(/not under your command/);
    expect(() => checkCommand(engine, blue, { cmd: 'run' })).toThrow(/players cannot run/);
    expect(() => checkCommand(engine, blue, { cmd: 'createEntity', typeId: 'us-m1a2', force: 1, x: 1, y: 1 })).toThrow(ForbiddenError);
    expect(() => checkCommand(engine, blue, { cmd: 'assignTask', targetId: 'E1', task: { type: 'followRoute', routeId: 'G9' } })).toThrow(/unknown graphic/);
    const draw: Record<string, unknown> = { cmd: 'createGraphic', kind: 'point', points: [{ x: 1, y: 1 }], force: 2 };
    checkCommand(engine, blue, draw);
    expect(draw.force).toBe(1);
    expect(() => checkCommand(engine, { kind: 'controller' }, { cmd: 'run' })).not.toThrow();
  });

  it('parses player keys', () => {
    expect(parsePlayer('blue:abc')).toEqual({ force: 1, key: 'abc' });
    expect(parsePlayer('Red:x:y')).toEqual({ force: 2, key: 'x:y' });
    expect(() => parsePlayer('purple:k')).toThrow(/unknown force/);
    expect(() => parsePlayer('blue')).toThrow(/force:key/);
  });
});

describe('player keys on the server', () => {
  let server: SimServer;
  let url: string;
  const KEY = 'control-key';
  const BLUE = 'blue-key';
  const call = async (method: string, path: string, key: string, body?: unknown) => {
    const r = await fetch(`${url}${path}`, { method, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: body === undefined ? (method === 'GET' ? undefined : '{}') : JSON.stringify(body) });
    return { status: r.status, json: (await r.json().catch(() => null)) as any };
  };

  beforeAll(async () => {
    const { engine } = scene();
    const runner = new SimRunner(engine, 0.1, 20);
    runner.start();
    server = new SimServer(runner, { port: 0, host: '127.0.0.1', webRoot: 'dist/web', scenarioDir: 'scenarios', apiKey: KEY, players: [{ force: 1, key: BLUE }] });
    await server.listen();
    url = server.address;
  });

  afterAll(async () => {
    server.runner.stop();
    await server.close();
  });

  it('gives players a fogged REST view and refuses exercise-control routes', async () => {
    const ents = await call('GET', '/api/v1/entities', BLUE);
    expect(ents.json.map((e: { id: string }) => e.id).sort()).toEqual(['E1', 'E2']);
    expect((await call('GET', '/api/v1/entities/E3', BLUE)).status).toBe(404);
    expect((await call('GET', '/api/v1/entities', KEY)).json).toHaveLength(3);
    expect((await call('POST', '/api/v1/simulation/run', BLUE)).status).toBe(403);
    expect((await call('GET', '/api/v1/scenario', BLUE)).status).toBe(403);
    expect((await call('GET', '/api/v1/recording/report', BLUE)).status).toBe(403);
    expect((await call('POST', '/api/v1/entities/E1/task', BLUE, { type: 'moveTo', target: { x: 1200, y: 2000 } })).status).toBe(200);
    expect((await call('POST', '/api/v1/entities/E2/task', BLUE, { type: 'wait', duration: 5 })).status).toBe(403);
    expect((await call('PATCH', '/api/v1/entities/E1', BLUE, { position: { x: 100, y: 100 } })).status).toBe(403);
    expect((await call('GET', '/api/v1/entities', 'wrong')).status).toBe(401);
  });

  it('sends players their own view over the WebSocket and checks their commands', async () => {
    const ws = new WebSocket(`${url.replace('http', 'ws')}/ws?api_key=${BLUE}`);
    const msgs: ServerMessage[] = [];
    ws.on('message', (d) => msgs.push(JSON.parse(d.toString())));
    await new Promise((r) => ws.on('open', r));
    await new Promise((r) => setTimeout(r, 200));
    const hello = msgs.find((m) => m.type === 'hello');
    expect(hello && hello.type === 'hello' && hello.role).toEqual({ kind: 'player', force: 1 });
    const state = msgs.find((m) => m.type === 'state');
    expect(state && state.type === 'state' && state.state.entities.every((e) => e.id !== 'E3')).toBe(true);
    ws.send(JSON.stringify({ type: 'command', reqId: 7, command: { cmd: 'deleteObject', id: 'E2' } }));
    await new Promise((r) => setTimeout(r, 200));
    const res = msgs.find((m) => m.type === 'result');
    expect(res && res.type === 'result' && res.result.ok).toBe(false);
    ws.close();
  });

  it('applies the player role to MCP tools', async () => {
    const client = new Client({ name: 'player', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${BLUE}` } } }));
    const r = await client.callTool({ name: 'list_entities', arguments: {} });
    const rows = JSON.parse((r.content as { text: string }[])[0].text);
    expect(rows.map((e: { id: string }) => e.id).sort()).toEqual(['E1', 'E2']);
    const denied = await client.callTool({ name: 'control_simulation', arguments: { action: 'run' } });
    expect(denied.isError).toBe(true);
    await client.close();
  });
});

describe('fogged event log', () => {
  it('keeps own unit events and names other forces by type', async () => {
    const { filterEvents } = await import('../src/server/fog.js');
    const { engine } = scene();
    const unit = engine.createUnitFromTemplate('us-scout-section', 1, 500, 500);
    engine.assignTask(unit.id, { type: 'moveTo', target: { x: 600, y: 600 } });
    const evs = filterEvents(engine, engine.eventsSince(0), 1);
    expect(evs.some((e) => e.entityId === unit.id)).toBe(true);
    const det = evs.find((e) => e.kind === 'detected' && e.targetId === 'E2');
    expect(det?.text).toContain('BRDM-2 (E2)');
    expect(evs.some((e) => e.entityId === 'E3' || e.targetId === 'E3')).toBe(false);
  });

  it("hides another force's radio traffic and detections, even about this force", async () => {
    const { filterEvents } = await import('../src/server/fog.js');
    const { engine } = scene();
    const red = engine.createUnitFromTemplate('ru-tank-platoon', 2, 2500, 2400, 0, 'Red Tigers');
    const from = engine.eventsSince(0).length;
    // Red reports and detects Blue's scout, then shoots at it.
    engine.radio(red.leader!, 'Red Tigers: contact, HMMWV at 1000 2000', 'E1');
    engine.log('detected', `${red.leader!.name} detected Scout`, red.leader!.id, 'E1');
    engine.log('fire', `${red.leader!.name} (Red Tigers) fired at Scout`, red.leader!.id, 'E1');
    const blue = filterEvents(engine, engine.eventsSince(0).slice(from), 1);
    expect(blue.map((e) => e.kind)).toEqual(['fire']);
    expect(blue[0].text).not.toMatch(/Red Tigers/);
    expect(blue[0].text).toContain(`enemy unit (${red.id})`);
  });
});

describe('fire missions', () => {
  it('are refused for units and entities without artillery', async () => {
    const { executeCommand } = await import('../src/server/commands.js');
    const { engine } = scene();
    const runner = new SimRunner(engine, 0.1, 20, 0);
    const tanks = engine.createUnitFromTemplate('us-tank-platoon', 1, 500, 500);
    const r = executeCommand(runner, { cmd: 'assignTask', targetId: tanks.id, task: { type: 'fireMission', target: { x: 2000, y: 2000 } } });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no artillery or mortars/);
    const guns = engine.createUnitFromTemplate('us-paladin-platoon', 1, 500, 800);
    expect(executeCommand(runner, { cmd: 'assignTask', targetId: guns.id, task: { type: 'fireMission', target: { x: 2000, y: 2000 } } }).ok).toBe(true);
  });
});
