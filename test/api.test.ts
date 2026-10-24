import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SimRunner } from '../src/server/runner.js';
import { SimServer } from '../src/server/server.js';
import { Engine } from '../src/sim/engine.js';
import { Terrain } from '../src/sim/terrain.js';

const terrain = Terrain.generate({ size: 6000, seed: 11, towns: 3 });
const KEY = 'test-key-123';

let server: SimServer;
let base: string;
const engine = new Engine({ terrain });

const auth = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = auth) {
  const r = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? (method === 'GET' || method === 'DELETE' ? undefined : '{}') : JSON.stringify(body) });
  const text = await r.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: r.status, json: json as any, text, type: r.headers.get('content-type') };
}

beforeAll(async () => {
  engine.newScenario('api-v1', terrain.spec);
  const runner = new SimRunner(engine, 0.1, 20);
  runner.start();
  server = new SimServer(runner, { port: 0, host: '127.0.0.1', webRoot: 'dist/web', scenarioDir: 'scenarios', apiKey: KEY });
  await server.listen();
  base = server.address;
});

afterAll(async () => {
  server.runner.stop();
  await server.close();
});

describe('security', () => {
  it('requires the API key', async () => {
    expect((await api('GET', '/api/v1/simulation', undefined, {})).status).toBe(401);
    expect((await api('GET', '/api/v1/simulation', undefined, { 'X-API-Key': 'wrong' })).status).toBe(401);
    expect((await api('GET', '/api/v1/simulation', undefined, { 'X-API-Key': KEY })).status).toBe(200);
    expect((await api('GET', `/api/v1/simulation?api_key=${KEY}`, undefined, {})).status).toBe(200);
    // The docs page itself is public; it fetches the spec with the key.
    expect((await api('GET', '/api/docs', undefined, {})).status).toBe(200);
  });

  it('rejects non-JSON POSTs (cross-site form posts)', async () => {
    const r = await fetch(`${base}/api/v1/simulation/run`, { method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'text/plain' }, body: '{}' });
    expect(r.status).toBe(415);
  });

  it('rejects foreign Host headers (DNS rebinding)', async () => {
    const port = new URL(base).port;
    const status = await new Promise<number>((resolve) => {
      http.get({ host: '127.0.0.1', port, path: '/api/v1/simulation', headers: { Host: 'evil.example:80', Authorization: `Bearer ${KEY}` } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
    });
    expect(status).toBe(403);
  });
});

describe('REST API v1', () => {
  it('describes itself with OpenAPI', async () => {
    const r = await api('GET', '/api/v1/openapi.json');
    expect(r.json.openapi).toBe('3.1.0');
    expect(Object.keys(r.json.paths)).toContain('/api/v1/entities/{id}/task');
  });

  it('creates and queries entities using towns and lat/lon', async () => {
    const town = terrain.towns[0];
    const created = await api('POST', '/api/v1/entities', { typeId: 'us-m1a2', force: 1, position: { town: town.name }, name: 'Alpha' });
    expect(created.status).toBe(201);
    expect(created.json.name).toBe('Alpha');
    expect(created.json.x).toBeCloseTo(town.x, 0);
    const byLatLon = await api('POST', '/api/v1/entities', { typeId: 'us-hmmwv', force: 1, position: { lat: created.json.lat, lon: created.json.lon + 0.001 } });
    expect(byLatLon.status).toBe(201);
    expect(Math.abs(byLatLon.json.x - town.x - 70)).toBeLessThan(5); // ~70 m per 0.001° lon at 50.7°N
    const list = await api('GET', '/api/v1/entities?force=blue');
    expect(list.json).toHaveLength(2);
    expect((await api('GET', '/api/v1/entities/E999')).status).toBe(404);
    const bad = await api('POST', '/api/v1/entities', { typeId: 'us-m1a2', force: 1, position: { town: 'Atlantis' } });
    expect(bad.status).toBe(400);
    expect(bad.json.error.message).toMatch(/unknown town/);
  });

  it('creates units, tasks them and advances time', async () => {
    const [a, b] = terrain.towns;
    const u = await api('POST', '/api/v1/units', { templateId: 'us-scout-section', force: 1, position: { x: a.x, y: a.y } });
    expect(u.status).toBe(201);
    expect(u.json.members).toHaveLength(2);
    const t = await api('POST', `/api/v1/units/${u.json.id}/task`, { type: 'moveTo', target: { town: b.name } });
    expect(t.status).toBe(200);
    expect(t.json.task).toMatch(/Move to/);
    const before = await api('GET', `/api/v1/units/${u.json.id}`);
    const stepped = await api('POST', '/api/v1/simulation/step', { seconds: 60 });
    expect(stepped.json.time).toBeGreaterThanOrEqual(60);
    const after = await api('GET', `/api/v1/units/${u.json.id}`);
    expect(Math.hypot(after.json.x - before.json.x, after.json.y - before.json.y)).toBeGreaterThan(100);
    const patched = await api('PATCH', `/api/v1/units/${u.json.id}`, { formation: 'line', roe: 'holdFire' });
    expect(patched.json.formation).toBe('line');
    expect((await api('POST', `/api/v1/units/${u.json.id}/task`, { type: 'fly' })).status).toBe(400);
  });

  it('answers terrain queries', async () => {
    const t = terrain.towns[1];
    const pt = await api('GET', `/api/v1/terrain/point?town=${encodeURIComponent(t.name)}`);
    expect(pt.json.road).toBe(true);
    expect(pt.json.water).toBe(false);
    const los = await api('POST', '/api/v1/terrain/line-of-sight', { from: { x: t.x, y: t.y }, to: { x: t.x + 50, y: t.y, height: 2 } });
    expect(los.json.visible).toBe(true);
    const route = await api('POST', '/api/v1/terrain/route', { from: { town: terrain.towns[0].name }, to: { town: t.name } });
    expect(route.json.waypoints.length).toBeGreaterThan(0);
  });

  it('manages graphics and plans', async () => {
    const [a, b] = terrain.towns;
    const g = await api('POST', '/api/v1/graphics', { kind: 'route', name: 'R', points: [{ town: a.name }, { town: b.name }] });
    expect(g.status).toBe(201);
    const e = await api('POST', '/api/v1/entities', { typeId: 'us-hmmwv', force: 1, position: { x: a.x, y: a.y } });
    const plan = await api('POST', `/api/v1/entities/${e.json.id}/plan`, {
      name: 'P',
      statements: [{ kind: 'setRoe', roe: 'returnFire' }, { kind: 'task', task: { type: 'followRoute', routeId: g.json.id } }],
    });
    expect(plan.status).toBe(200);
    await api('POST', '/api/v1/simulation/step', { seconds: 1 });
    expect((await api('GET', `/api/v1/entities/${e.json.id}`)).json.roe).toBe('returnFire');
    expect((await api('DELETE', `/api/v1/graphics/${g.json.id}`)).status).toBe(204);
  });

  it('exports GeoJSON and KML', async () => {
    const gj = await api('GET', '/api/v1/export/entities.geojson');
    expect(gj.type).toContain('geo+json');
    expect(gj.json.type).toBe('FeatureCollection');
    const f = gj.json.features[0];
    expect(f.geometry.type).toBe('Point');
    expect(f.geometry.coordinates[1]).toBeCloseTo(terrain.spec.origin.lat, 0);
    expect(f.properties.cotType).toMatch(/^a-f-/);
    const kml = await api('GET', '/api/v1/export/scene.kml');
    expect(kml.type).toContain('kml');
    expect(kml.text).toContain('<Placemark');
    const live = await api('GET', '/api/v1/export/live.kml?refresh=3');
    expect(live.text).toContain('<refreshInterval>3</refreshInterval>');
  });

  it('configures integrations', async () => {
    const bad = await api('PUT', '/api/v1/integrations/cot', { enabled: true, url: 'http://nope' });
    expect(bad.status).toBe(400);
    const ok = await api('PUT', '/api/v1/integrations/cot', { enabled: false, url: 'udp://127.0.0.1:16969', interval: 1 });
    expect(ok.json.url).toBe('udp://127.0.0.1:16969');
    expect((await api('POST', '/api/v1/webhooks', { url: 'ftp://x' })).status).toBe(400);
    const hook = await api('POST', '/api/v1/webhooks', { url: 'http://127.0.0.1:9/hook', format: 'slack' });
    expect(hook.status).toBe(201);
    expect((await api('GET', '/api/v1/integrations')).json.webhooks).toHaveLength(1);
    expect((await api('DELETE', `/api/v1/webhooks/${hook.json.id}`)).status).toBe(204);
  });
});

describe('MCP', () => {
  it('exposes tools over the streamable HTTP endpoint', async () => {
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${KEY}` } } }));
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['get_situation', 'create_unit', 'assign_task', 'advance_time', 'check_line_of_sight']));
    const sit = await client.callTool({ name: 'get_situation', arguments: {} });
    const sitText = (sit.content as { text: string }[])[0].text;
    expect(JSON.parse(sitText).scenario).toBe('api-v1');

    const town = terrain.towns[2];
    const created = await client.callTool({ name: 'create_unit', arguments: { templateId: 'ru-recon-patrol', force: 2, position: { town: town.name } } });
    const unit = JSON.parse((created.content as { text: string }[])[0].text);
    expect(unit.id).toMatch(/^U/);
    const task = await client.callTool({ name: 'assign_task', arguments: { targetId: unit.id, type: 'moveTo', to: { town: terrain.towns[0].name } } });
    expect((task.content as { text: string }[])[0].text).toMatch(/Move to/);
    const adv = await client.callTool({ name: 'advance_time', arguments: { seconds: 30 } });
    expect(JSON.parse((adv.content as { text: string }[])[0].text).time).toBeDefined();
    const err = await client.callTool({ name: 'assign_task', arguments: { targetId: unit.id, type: 'moveTo' } });
    expect(err.isError).toBe(true);
    const res = await client.readResource({ uri: 'werforces://scenario' });
    expect(JSON.parse((res.contents[0] as { text: string }).text).format).toBe('werforces-scenario');
    await client.close();
  });

  it('rejects MCP calls without the API key', async () => {
    const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: '{}' });
    expect(r.status).toBe(401);
  });

  it('works as a stdio bridge to a running server', async () => {
    const client = new Client({ name: 'test-stdio', version: '1.0.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', 'src/mcp/stdio.ts', '--url', base, '--api-key', KEY],
      stderr: 'ignore',
    });
    await client.connect(transport);
    const r = await client.callTool({ name: 'list_entities', arguments: { force: 1 } });
    const rows = JSON.parse((r.content as { text: string }[])[0].text);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toHaveProperty('lat');
    await client.close();
  }, 20000);
});
