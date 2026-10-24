import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SimRunner } from '../src/server/runner.js';
import { SimServer } from '../src/server/server.js';
import { Engine } from '../src/sim/engine.js';
import { Terrain } from '../src/sim/terrain.js';
import type { Alert, SimState } from '../src/shared/types.js';

const base = Terrain.generate({ size: 6000, seed: 9, towns: 2 });
const cols = 81;
const flat = new Terrain({ ...base.spec, size: 4000, cellSize: 50, seed: 4242 }, new Float32Array(cols * cols).fill(20), new Uint8Array(cols * cols), [], []);

function engine(): Engine {
  const e = new Engine({ terrain: flat });
  e.newScenario('alerts', flat.spec);
  return e;
}

const kinds = (eng: Engine) => eng.alerts.open().map((a) => `${a.kind}:${a.objectId}`);

describe('attention queue', () => {
  it('reports a unit that finishes its orders and sits idle', () => {
    const eng = engine();
    const p = eng.createUnitFromTemplate('us-tank-platoon', 1, 1000, 1000);
    eng.runFor(30);
    expect(kinds(eng)).not.toContain(`idle:${p.id}`); // never ordered: not reported
    eng.assignTask(p.id, { type: 'moveTo', target: { x: 1300, y: 1000 } });
    eng.runFor(120);
    const idle = eng.alerts.open().find((a) => a.kind === 'idle')!;
    expect(idle).toMatchObject({ objectId: p.id, severity: 'info', force: 1 });
    expect(idle.text).toMatch(/idle/);
    // A new order clears it.
    eng.assignTask(p.id, { type: 'moveTo', target: { x: 1600, y: 1000 } });
    eng.runFor(2);
    expect(kinds(eng)).not.toContain(`idle:${p.id}`);
  });

  it('raises lasting conditions once, resolves them when they clear, and respects acknowledgement', () => {
    const eng = engine();
    const p = eng.createUnitFromTemplate('us-tank-platoon', 1, 1000, 1000);
    for (const m of p.memberList.slice(0, 2)) m.fuel = 0;
    eng.runFor(3);
    const fuel = eng.alerts.open().filter((a) => a.kind === 'outOfFuel');
    expect(fuel).toHaveLength(1);
    expect(fuel[0]).toMatchObject({ severity: 'critical', text: `${p.name}: 2 of 4 out of fuel`, count: 1 });
    for (const m of p.memberList) m.fuel = 1;
    eng.runFor(2);
    expect(kinds(eng)).not.toContain(`outOfFuel:${p.id}`);
    // Acknowledged: not raised again while the condition lasts.
    p.memberList[0].fuel = 0;
    eng.runFor(2);
    const again = eng.alerts.open().find((a) => a.kind === 'outOfFuel')!;
    eng.alerts.acknowledge(again.id);
    eng.runFor(5);
    expect(kinds(eng)).not.toContain(`outOfFuel:${p.id}`);
  });

  it('reports losses, a lost leader and a broken unit', () => {
    const eng = engine();
    const p = eng.createUnitFromTemplate('us-tank-platoon', 1, 1000, 1000);
    eng.runFor(2);
    const lead = p.leader!;
    lead.destroyed = true;
    eng.log('destroyed', `${lead.name} destroyed`, lead.id);
    eng.runFor(3);
    const open = eng.alerts.open();
    expect(open.find((a) => a.kind === 'losses')?.text).toMatch(/destroyed \(3 left\)/);
    expect(open.find((a) => a.kind === 'leaderLost')?.text).toMatch(/lost its leader/);
    p.moraleState = 'broken';
    eng.alerts.update();
    expect(eng.alerts.open().find((a) => a.kind === 'broken')?.severity).toBe('critical');
  });

  it('does not change how a run plays out', () => {
    const run = (on: boolean) => {
      const eng = engine();
      if (!on) eng.alerts.update = () => undefined;
      const a = eng.createUnitFromTemplate('us-tank-platoon', 1, 1000, 500);
      eng.createUnitFromTemplate('ru-tank-platoon', 2, 1000, 3200);
      eng.assignTask(a.id, { type: 'moveTo', target: { x: 1000, y: 2500 } });
      const log: string[] = [];
      eng.on('event', (ev) => log.push(`${ev.time}|${ev.text}`));
      eng.runFor(300);
      return log.join('\n');
    };
    expect(run(true)).toBe(run(false));
  });
});

describe('alerts over REST', () => {
  const eng = engine();
  let server: SimServer;
  let url = '';
  const call = (method: string, p: string, key: string) => fetch(`${url}/api/v1${p}`, { method, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });

  beforeAll(async () => {
    const runner = new SimRunner(eng, 0.1, 20, 0);
    server = new SimServer(runner, { port: 0, host: '127.0.0.1', webRoot: 'dist/web', scenarioDir: 'scenarios', apiKey: 'control', players: [{ force: 1, key: 'blue' }, { force: 2, key: 'red' }] });
    await server.listen();
    url = server.address;
  });

  afterAll(async () => {
    await server.close();
  });

  it('shows each side its own alerts, and acknowledges them', async () => {
    const b = eng.createEntity({ typeId: 'us-m1a2', force: 1, x: 500, y: 500 });
    const r = eng.createEntity({ typeId: 'ru-t72b3', force: 2, x: 3500, y: 3500 });
    b.fuel = 0;
    r.fuel = 0;
    eng.alerts.update();
    expect(((await (await call('GET', '/alerts', 'control')).json()) as Alert[]).map((a) => a.objectId).sort()).toEqual([b.id, r.id]);
    const blue = (await (await call('GET', '/alerts', 'blue')).json()) as Alert[];
    expect(blue.map((a) => a.objectId)).toEqual([b.id]);
    const state = (await (await call('GET', '/../state', 'blue')).json().catch(() => null)) as SimState | null;
    if (state?.alerts) expect(state.alerts.every((a) => a.force === 1)).toBe(true);
    // Red cannot acknowledge Blue's alert; Blue can.
    expect((await call('POST', `/alerts/${blue[0].id}/acknowledge`, 'red')).status).toBe(400);
    expect((await call('POST', `/alerts/${blue[0].id}/acknowledge`, 'blue')).status).toBe(200);
    expect(((await (await call('GET', '/alerts', 'control')).json()) as Alert[]).map((a) => a.objectId)).toEqual([r.id]);
    // Acknowledge all, as Red: only Red's.
    await call('POST', '/alerts/acknowledge', 'red');
    expect(await (await call('GET', '/alerts', 'control')).json()).toEqual([]);
    expect(((await (await call('GET', '/alerts?all=true', 'control')).json()) as Alert[]).length).toBe(2);
  });
});
