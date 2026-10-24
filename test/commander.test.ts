import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { executeCommand } from '../src/server/commands.js';
import { checkCommand, filterEvents, ForbiddenError } from '../src/server/fog.js';
import { httpTransport, llmConfig } from '../src/server/llm.js';
import { SimRunner } from '../src/server/runner.js';
import { SimServer } from '../src/server/server.js';
import type { LlmRequest, LlmResponse, LlmTransport } from '../src/sim/commander/llm.js';
import { Engine } from '../src/sim/engine.js';
import { Terrain } from '../src/sim/terrain.js';
import { generateBattle } from '../src/sim/wizard.js';
import type { ForceId } from '../src/shared/types.js';

const cols = 81;
const flat = new Terrain({ ...Terrain.generate({ size: 4000, seed: 9, towns: 0 }).spec, size: 12000, cellSize: 150, seed: 4242 }, new Float32Array(cols * cols).fill(20), new Uint8Array(cols * cols), [], []);

/** Blue tanks, a Red scout car they can see and a Red tank far away that they cannot. */
function scene() {
  const engine = new Engine({ terrain: flat, seed: 3 });
  engine.newScenario('commanders', flat.spec);
  const tanks = engine.createUnitFromTemplate('us-tank-platoon', 1, 1000, 6000, Math.PI / 2, 'Team Tank');
  const seen = engine.createEntity({ id: 'E50', typeId: 'ru-brdm2', force: 2, x: 2800, y: 6000 });
  const hidden = engine.createEntity({ id: 'E51', typeId: 'ru-t72b3', force: 2, x: 11500, y: 11500, name: 'Hidden Tank' });
  const redUnit = engine.createUnitFromTemplate('ru-mech-platoon', 2, 11500, 500, 0, 'Red Mech');
  for (const e of engine.entities.values()) e.roe = 'holdFire';
  engine.addGraphic('area', [{ x: 2500, y: 5800 }, { x: 2900, y: 5800 }, { x: 2900, y: 6200 }, { x: 2500, y: 6200 }], 'OBJ IRON', 1);
  engine.runFor(3);
  return { engine, tanks, seen, hidden, redUnit };
}

const reply = (content: unknown[], stop = 'tool_use'): LlmResponse => ({ content: content as LlmResponse['content'], stop_reason: stop, usage: { input_tokens: 100, output_tokens: 20 } });
const use = (id: string, name: string, input: unknown) => ({ type: 'tool_use', id, name, input });

/** A transport that plays a script, one step per call, and keeps a copy of every request. */
function scripted(steps: ((req: LlmRequest) => LlmResponse | Promise<LlmResponse>)[]) {
  const requests: LlmRequest[] = [];
  const transport: LlmTransport = {
    async send(req) {
      requests.push(JSON.parse(JSON.stringify(req)));
      const step = steps.shift();
      if (!step) throw new Error('the script ran out');
      return step(req);
    },
  };
  return { transport, requests };
}

/** Let replies arrive and run the simulation a second at a time until the commander is done thinking. */
async function settle(engine: Engine, force: ForceId, max = 30) {
  for (let i = 0; i < max; i++) {
    await new Promise((r) => setTimeout(r, 0));
    engine.runFor(1);
    if (engine.commanders.get(force)?.state !== 'thinking') return;
  }
}

function digest(engine: Engine): string {
  return createHash('sha256')
    .update(engine.eventsSince(0).map((e) => `${e.time.toFixed(1)}|${e.kind}|${e.text}`).join('\n'))
    .digest('hex');
}

describe('commanders', () => {
  it('are off by default: nothing in snapshots or scenario files', () => {
    const { engine } = scene();
    expect(engine.snapshot().commanders).toBeUndefined();
    expect(engine.toScenario().commanders).toBeUndefined();
  });

  it('are set by command, saved with the scenario (settings, no keys) and loaded back', () => {
    const { engine } = scene();
    const runner = new SimRunner(engine, 0.1, 20, 0);
    expect(executeCommand(runner, { cmd: 'setCommander', force: 1, kind: 'rules', options: { aggressiveness: 0.8, interval: 30 } }).ok).toBe(true);
    expect(executeCommand(runner, { cmd: 'setCommander', force: 2, kind: 'rules', options: { interval: 5 } }).error).toMatch(/interval must be a number from 10/);
    expect(executeCommand(runner, { cmd: 'setCommander', force: 2, kind: 'chess' as never }).ok).toBe(false);
    const file = engine.toScenario();
    expect(file.commanders).toEqual([expect.objectContaining({ force: 1, kind: 'rules', options: { aggressiveness: 0.8, interval: 30 } })]);
    expect(JSON.stringify(file.commanders)).not.toMatch(/key/i);
    const again = new Engine({ terrain: flat, seed: 3 });
    again.loadScenario(file);
    expect(again.commanders.get(1)?.options).toEqual({ aggressiveness: 0.8, interval: 30 });
    // Undo takes it back.
    expect(runner.undo()).toBe(true);
    expect(engine.commanders.get(1)).toBeUndefined();
  });

  it('decide on the force view, log for that force only, and leave orders they did not give alone', () => {
    const { engine, tanks } = scene();
    engine.assignTask(tanks.id, { type: 'moveTo', target: { x: 1200, y: 5500 } });
    engine.commanders.set(1, 'rules', { holdOff: 60, interval: 20 });
    engine.runFor(2);
    const d = engine.commanders.get(1)!.decisions;
    expect(d.length).toBe(1);
    expect(d[0].trigger).toBe('start');
    // The tanks were ordered by someone else a moment ago: not touched.
    expect(d[0].orders.some((o) => o.startsWith('Team Tank'))).toBe(false);
    expect(tanks.assignedTask).toEqual({ type: 'moveTo', target: { x: 1200, y: 5500 } });
    const said = engine.eventsSince(0).filter((e) => e.text.startsWith('Blue commander'));
    expect(said.length).toBeGreaterThan(0);
    expect(filterEvents(engine, said, 1)).toHaveLength(said.length);
    expect(filterEvents(engine, said, 2)).toHaveLength(0);
    // After the hold-off it takes them over (they have finished or the time is up).
    engine.runFor(120);
    expect(engine.commanders.get(1)!.decisions.some((x) => x.orders.some((o) => o.startsWith('Team Tank')))).toBe(true);
  });

  it('are deterministic, and continue the same from a checkpoint', () => {
    const run = () => {
      const eng = new Engine({ seed: 1 });
      generateBattle(eng, { seed: 4, mission: 'meeting', terrain: { seed: 5, size: 12000 }, commander: { blue: 'rules', red: 'rules' } });
      eng.runFor(600);
      return eng;
    };
    const a = run();
    const b = run();
    expect(digest(a)).toBe(digest(b));
    expect(a.commanders.get(1)!.decisions.length).toBeGreaterThan(3);
    expect(a.sync.get(1)).toBeUndefined();
    const cp = a.toScenario();
    expect(cp.commanders?.[0].state?.memory).toBeDefined();
    const c1 = new Engine({ seed: 1 });
    const c2 = new Engine({ seed: 1 });
    c1.loadScenario(cp);
    c2.loadScenario(cp);
    c1.runFor(300);
    c2.runFor(300);
    expect(digest(c1)).toBe(digest(c2));
    expect(c1.commanders.get(1)!.decisions.length).toBeGreaterThan(0);
  });

  it('give only commands a player of the force may give', () => {
    const { engine } = scene();
    const blue = { kind: 'player', force: 1 } as const;
    expect(() => checkCommand(engine, blue, { cmd: 'setCommander', force: 2, kind: 'rules' })).toThrow(ForbiddenError);
    expect(() => checkCommand(engine, blue, { cmd: 'setCommander', force: 1, kind: 'llm' })).toThrow(/exercise control/);
    expect(() => checkCommand(engine, blue, { cmd: 'setCommander', force: 1, kind: 'rules' })).not.toThrow();
  });
});

describe('LLM commander (scripted transport)', () => {
  it('runs the tool loop: orders carried out, results returned, rationale recorded', async () => {
    const { engine, tanks } = scene();
    const { transport, requests } = scripted([
      () =>
        reply([
          { type: 'text', text: 'Closing on the scout car.' },
          use('t1', 'give_order', { order: `${tanks.id} move to 1500 6000` }),
          use('t2', 'set_roe', { unit: 'Team Tank', roe: 'fireAtWill' }),
          use('t3', 'report', { text: 'One scout car seen at OBJ IRON; advancing to engage it.' }),
        ]),
      (req) => {
        const last = req.messages.at(-1)!;
        expect(last.role).toBe('user');
        const results = last.content as { type: string; tool_use_id: string; is_error?: boolean }[];
        expect(results.map((r) => r.tool_use_id)).toEqual(['t1', 't2', 't3']);
        expect(results.every((r) => r.type === 'tool_result' && !r.is_error)).toBe(true);
        return reply([{ type: 'text', text: 'Orders given.' }], 'end_turn');
      },
    ]);
    engine.commanders.llm = { transport };
    engine.commanders.set(1, 'llm', { interval: 600, intent: 'Take OBJ IRON.' });
    await settle(engine, 1);
    const c = engine.commanders.get(1)!;
    expect(c.state).toBe('ready');
    expect(c.decisions[0].summary).toBe('One scout car seen at OBJ IRON; advancing to engage it.');
    expect(c.decisions[0].orders).toHaveLength(2);
    expect(c.usage).toEqual({ calls: 2, inputTokens: 200, outputTokens: 40 });
    expect(tanks.assignedTask).toEqual({ type: 'moveTo', target: { x: 1500, y: 6000 } });
    expect(tanks.leader!.roe).toBe('fireAtWill');
    // What the model was sent: its own force and what it has seen, never hidden enemies or a model id.
    const first = requests[0];
    expect('model' in first).toBe(false);
    expect(first.tools.map((t) => t.name)).toEqual(['give_order', 'set_roe', 'call_fire', 'start_phase', 'send_codeword', 'report']);
    expect(first.system).toContain('Blue');
    expect(first.system).toContain('Take OBJ IRON.');
    const prompt = first.messages[0].content as string;
    expect(prompt).toContain('E50');
    expect(prompt).toContain('OBJ IRON');
    expect(prompt).not.toContain('E51');
    expect(prompt).not.toContain('Hidden Tank');
    expect(prompt).not.toContain('Red Mech');
    expect(engine.eventsSince(0).some((e) => e.text.startsWith('Blue commander: One scout car'))).toBe(true);
  });

  it('cannot order the enemy, see hidden enemies, or step outside its tools', async () => {
    const { engine, tanks, seen, hidden, redUnit } = scene();
    const { transport, requests } = scripted([
      () =>
        reply([
          use('a', 'give_order', { order: 'Red Mech move to 100 100' }),
          use('b', 'give_order', { order: `${tanks.id} attack ${hidden.id}` }),
          use('c', 'set_roe', { unit: seen.id, roe: 'holdFire' }),
          use('d', 'call_fire', { unit: tanks.id, target: hidden.id }),
          use('e', 'start_phase', { phase: 'P9' }),
          use('f', 'delete_everything', {}),
          use('g', 'give_order', { order: `${tanks.id} attack ${seen.id}` }),
        ]),
      () => reply([{ type: 'text', text: 'Understood.' }], 'end_turn'),
    ]);
    engine.commanders.llm = { transport };
    engine.commanders.set(1, 'llm', { interval: 600 });
    await settle(engine, 1);
    const results = requests[1].messages.at(-1)!.content as { tool_use_id: string; is_error?: boolean; content: string }[];
    const err = Object.fromEntries(results.map((r) => [r.tool_use_id, r.is_error === true]));
    expect(err).toEqual({ a: true, b: true, c: true, d: true, e: true, f: true, g: false });
    expect(redUnit.assignedTask).toBeUndefined();
    expect(seen.roe).toBe('holdFire');
    expect(tanks.assignedTask).toEqual({ type: 'attack', targetId: seen.id });
    const d = engine.commanders.get(1)!.decisions[0];
    expect(d.orders).toHaveLength(1);
    expect(d.rejected!.length).toBeGreaterThanOrEqual(3);
  });

  it('survives failures: errors are logged, the simulation goes on, and it tries again later', async () => {
    const { engine, tanks } = scene();
    let calls = 0;
    const transport: LlmTransport = {
      async send() {
        calls++;
        if (calls === 1) throw new Error('model API 529: overloaded');
        if (calls === 2) return { content: 'nonsense' } as unknown as LlmResponse;
        return reply([use('x', 'give_order', { order: `${tanks.id} hold fire` })], 'tool_use');
      },
    };
    engine.commanders.llm = { transport };
    engine.commanders.set(1, 'llm', { interval: 10 });
    await settle(engine, 1);
    let c = engine.commanders.get(1)!;
    expect(c.state).toBe('error');
    expect(c.error).toMatch(/overloaded/);
    expect(c.decisions[0].summary).toMatch(/No decision: model API 529/);
    expect(engine.eventsSince(0).some((e) => /Blue commander: No decision/.test(e.text))).toBe(true);
    const t = engine.time;
    engine.runFor(25);
    await settle(engine, 1);
    c = engine.commanders.get(1)!;
    expect(engine.time).toBeGreaterThan(t + 20);
    expect(c.error).toMatch(/malformed/);
    engine.runFor(25);
    await settle(engine, 1);
    // Third time lucky; then the script has more replies than the loop needs, which is fine.
    expect(engine.commanders.get(1)!.decisions.some((d) => d.orders.some((o) => /hold fire/.test(o)))).toBe(true);
  });

  it('does not hold up the simulation while the model thinks, and stops cleanly', async () => {
    const { engine } = scene();
    let aborted = false;
    const transport: LlmTransport = {
      send: (_req, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('aborted'));
          });
        }),
    };
    engine.commanders.llm = { transport };
    engine.commanders.set(1, 'llm');
    engine.runFor(1);
    const t = engine.time;
    engine.runFor(30);
    expect(engine.time).toBeCloseTo(t + 30, 5);
    expect(engine.commanders.get(1)!.state).toBe('thinking');
    engine.commanders.set(1, 'none');
    await new Promise((r) => setTimeout(r, 0));
    expect(aborted).toBe(true);
    expect(engine.commanders.get(1)).toBeUndefined();
    engine.runFor(5);
  });

  it('keeps to its call rate and token budget', async () => {
    const { engine } = scene();
    const { transport, requests } = scripted([() => reply([use('r', 'report', { text: 'Watching.' })]), () => reply([], 'end_turn')]);
    engine.commanders.llm = { transport };
    engine.commanders.set(1, 'llm', { maxCallsPerMinute: 1, interval: 10, tokenBudget: 1000 });
    await settle(engine, 1);
    expect(requests).toHaveLength(1);
    expect(engine.commanders.get(1)!.decisions[0].summary).toMatch(/Watching\. \(turn ended early: rate limit/);
    // The budget: 120 tokens a call, so it is not used up yet; give it more and it stops.
    engine.commanders.set(1, 'llm', { maxCallsPerMinute: 60, interval: 10, tokenBudget: 1000 });
    const many = scripted(Array.from({ length: 20 }, () => () => ({ ...reply([{ type: 'text', text: 'ok' }], 'end_turn'), usage: { input_tokens: 600, output_tokens: 10 } })));
    engine.commanders.llm = { transport: many.transport };
    for (let i = 0; i < 6; i++) {
      await settle(engine, 1);
      engine.runFor(11);
    }
    const c = engine.commanders.get(1)!;
    expect(c.error).toMatch(/token budget of 1000 used up/);
    expect(many.requests.length).toBe(2);
  });

  it('is unavailable without a configured model, and never runs on a default one', () => {
    const { engine } = scene();
    engine.commanders.set(1, 'llm');
    engine.runFor(2);
    expect(engine.commanders.get(1)!.state).toBe('unavailable');
    expect(llmConfig({}).unavailable).toMatch(/WERFORCES_AI_API_KEY and WERFORCES_AI_MODEL/);
    expect(llmConfig({ WERFORCES_AI_API_KEY: 'k' }).unavailable).toMatch(/WERFORCES_AI_MODEL is not set/);
    expect(llmConfig({ ANTHROPIC_API_KEY: 'k', ANTHROPIC_MODEL: 'm' } as Record<string, string>).config).toBeUndefined();
    const { config } = llmConfig({ WERFORCES_AI_API_KEY: 'k', WERFORCES_AI_MODEL: '<model id>' }, { baseUrl: 'http://127.0.0.1:9/' });
    expect(config).toMatchObject({ apiKey: 'k', model: '<model id>', baseUrl: 'http://127.0.0.1:9' });
  });

  it('calls the Messages API over HTTP with the configured key and model, and reports errors without the key', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    let status = 200;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response(status === 200 ? JSON.stringify({ content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 1 } }) : JSON.stringify({ error: { message: 'invalid x-api-key secret-key' } }), { status });
    }) as unknown as typeof fetch;
    const t = httpTransport({ apiKey: 'secret-key', model: '<model id>', baseUrl: 'https://example.invalid', version: '2026-10-21', timeoutMs: 5000 }, fakeFetch);
    const r = await t.send({ system: 's', messages: [{ role: 'user', content: 'u' }], tools: [], max_tokens: 100 });
    expect(r.stop_reason).toBe('end_turn');
    expect(seen[0].url).toBe('https://example.invalid/v1/messages');
    const headers = seen[0].init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('secret-key');
    expect(headers['anthropic-version']).toBe('2026-10-21');
    expect(JSON.parse(String(seen[0].init.body))).toMatchObject({ model: '<model id>', max_tokens: 100, system: 's' });
    status = 401;
    const failed = await t.send({ system: 's', messages: [], tools: [], max_tokens: 1 }).catch((e: Error) => e);
    expect(failed).toBeInstanceOf(Error);
    expect((failed as Error).message).toMatch(/model API 401/);
    expect((failed as Error).message).not.toContain('secret-key');
  });
});

// Against the real API only when a key and model are configured (never in CI by default).
const live = llmConfig(process.env).config;
describe.skipIf(!live)('LLM commander against the live API', () => {
  it('decides on a quick battle and gives orders through the tools', async () => {
    const engine = new Engine({ seed: 1 });
    generateBattle(engine, { seed: 3, mission: 'meeting', terrain: { seed: 5, size: 12000 } });
    engine.sync.set({ force: 2, phases: [] });
    engine.commanders.llm = { transport: httpTransport(live!) };
    engine.commanders.set(2, 'llm', { maxToolCalls: 6, tokenBudget: 60000 });
    for (let i = 0; i < 240 && engine.commanders.get(2)!.decisions.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 500));
      engine.runFor(1);
    }
    const c = engine.commanders.get(2)!;
    expect(c.error).toBeUndefined();
    expect(c.decisions[0].orders.length + (c.decisions[0].rejected?.length ?? 0)).toBeGreaterThan(0);
  }, 180_000);
});

describe('commanders over REST and MCP', () => {
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

  it('assigns and reads commanders, with player limits', async () => {
    expect((await call('GET', '/api/v1/forces/red/commander', KEY)).json).toMatchObject({ force: 2, kind: 'none', llm: { available: false } });
    const set = await call('PUT', '/api/v1/forces/red/commander', KEY, { kind: 'rules', options: { aggressiveness: 0.3 } });
    expect(set.status).toBe(200);
    expect(set.json).toMatchObject({ force: 2, kind: 'rules', options: { aggressiveness: 0.3 }, state: 'ready' });
    expect((await call('PUT', '/api/v1/forces/red/commander', KEY, { kind: 'rules', options: { aggressiveness: 3 } })).status).toBe(400);
    expect((await call('PUT', '/api/v1/forces/red/commander', BLUE, { kind: 'rules' })).status).toBe(403);
    expect((await call('GET', '/api/v1/forces/red/commander', BLUE)).status).toBe(403);
    expect((await call('PUT', '/api/v1/forces/blue/commander', BLUE, { kind: 'llm' })).status).toBe(403);
    expect((await call('PUT', '/api/v1/forces/blue/commander', BLUE, { kind: 'rules' })).status).toBe(200);
    expect((await call('POST', '/api/v1/forces/blue/commander/decide', BLUE)).status).toBe(202);
    expect((await call('GET', '/api/v1/commanders', BLUE)).json.map((c: { force: number }) => c.force)).toEqual([1]);
    expect((await call('GET', '/api/v1/commanders', KEY)).json.map((c: { force: number }) => c.force)).toEqual([1, 2]);
    const spec = (await call('GET', '/api/v1/openapi.json', KEY)).json;
    expect(spec.paths['/api/v1/forces/{force}/commander'].put).toBeDefined();
  });

  it('is an MCP tool', async () => {
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${KEY}` } } }));
    const r = await client.callTool({ name: 'set_commander', arguments: { force: 'red', kind: 'none' } });
    expect(r.isError).toBeFalsy();
    const g = await client.callTool({ name: 'get_commander', arguments: { force: 'red' } });
    expect(JSON.parse((g.content as { text: string }[])[0].text)).toMatchObject({ kind: 'none' });
    await client.close();
  });
});
