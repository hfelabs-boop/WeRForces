import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeCommand } from '../src/server/commands.js';
import { SimRunner } from '../src/server/runner.js';
import { SimServer } from '../src/server/server.js';
import { Engine } from '../src/sim/engine.js';
import { Terrain } from '../src/sim/terrain.js';
import type { SyncMatrixState } from '../src/shared/types.js';

const base = Terrain.generate({ size: 6000, seed: 9, towns: 2 });
const cols = 81;
const flat = new Terrain({ ...base.spec, size: 4000, cellSize: 50, seed: 4242 }, new Float32Array(cols * cols).fill(20), new Uint8Array(cols * cols), [], [{ name: 'Alder', x: 3000, y: 3000 }]);

function engine(): Engine {
  const e = new Engine({ terrain: flat });
  e.newScenario('sync', flat.spec);
  e.setHostilities([]);
  return e;
}

describe('synchronization matrix', () => {
  it('runs phases in order on their triggers, giving orders and announcing codewords', () => {
    const eng = engine();
    const runner = new SimRunner(eng, 0.1, 20, 0);
    const a = eng.createUnitFromTemplate('us-tank-platoon', 1, 500, 500);
    const b = eng.createUnitFromTemplate('us-mech-platoon', 1, 500, 1500);
    // A unit outside the matrix whose own plan waits for the phase-2 codeword.
    const c = eng.createUnitFromTemplate('us-scout-section', 1, 500, 2500);
    eng.assignPlan(c.id, { statements: [{ kind: 'waitUntil', condition: { type: 'codeword', codeword: 'PHASE 2 ASSAULT' } }, { kind: 'setRoe', roe: 'holdFire' }] });
    const r = executeCommand(runner, {
      cmd: 'setSyncMatrix',
      force: 1,
      phases: [
        { id: 'p1', name: 'Phase 1 Move', trigger: { type: 'time', time: 10 }, orders: [{ targetId: a.id, task: { type: 'moveTo', target: { x: 900, y: 500 } } }] },
        { id: 'p2', name: 'Phase 2 Assault', trigger: { type: 'previousDone', delay: 5 }, orders: [{ targetId: b.id, task: { type: 'moveTo', target: { x: 900, y: 1500 } } }] },
        { id: 'p3', name: 'Phase 3', trigger: { type: 'manual' }, orders: [{ targetId: a.id, roe: 'returnFire' }] },
      ],
    });
    expect(r.ok).toBe(true);
    eng.runFor(9);
    expect(a.leader!.task).toBeNull();
    eng.runFor(2);
    expect(a.leader!.task?.spec).toMatchObject({ type: 'moveTo' });
    expect(eng.hasCodeword(1, 'PHASE 1 MOVE')).toBe(true);
    let p2 = 0;
    for (let i = 0; i < 3000 && !p2; i++) {
      eng.step();
      if (eng.sync.states()[0].started.p2 !== undefined) p2 = eng.time;
    }
    expect(p2).toBeGreaterThan(20);
    expect(b.leader!.task?.spec).toMatchObject({ type: 'moveTo' });
    eng.runFor(2);
    expect(c.leader!.roe).toBe('holdFire'); // its plan went on when PHASE 2 ASSAULT arrived
    // A manual phase waits for someone to start it.
    eng.runFor(300);
    const st = eng.sync.states()[0];
    expect(st.started.p3).toBeUndefined();
    expect(st.current).toBe('p2');
    expect(executeCommand(runner, { cmd: 'startPhase', force: 1, phaseId: 'p3' }).ok).toBe(true);
    expect(a.leader!.roe).toBe('returnFire');
    // Checkpoints keep the matrix and its progress.
    const again = engine();
    again.loadScenario(eng.toScenario());
    expect(again.sync.states()[0]).toMatchObject({ current: 'p3', started: { p1: 10, p2 } });
  });

  it('starts a phase on a codeword or a condition', () => {
    const eng = engine();
    const runner = new SimRunner(eng, 0.1, 20, 0);
    const a = eng.createUnitFromTemplate('us-tank-platoon', 1, 500, 500);
    const area = eng.addGraphic('area', [{ x: 800, y: 0 }, { x: 4000, y: 0 }, { x: 4000, y: 4000 }, { x: 800, y: 4000 }], 'East');
    executeCommand(runner, {
      cmd: 'setSyncMatrix',
      force: 1,
      phases: [
        { name: 'Go', trigger: { type: 'codeword', codeword: 'execute' }, orders: [{ targetId: a.id, task: { type: 'moveTo', target: { x: 1200, y: 500 } } }] },
        { name: 'Halt', trigger: { type: 'condition', ownerId: a.id, condition: { type: 'inArea', areaId: area.id } }, orders: [{ targetId: a.id, stop: true }] },
      ],
    });
    eng.runFor(5);
    expect(eng.sync.states()[0].started).toEqual({});
    eng.sendCodeword(1, 'EXECUTE');
    eng.runFor(200);
    const st = eng.sync.states()[0];
    expect(Object.keys(st.started)).toEqual(['P1', 'P2']);
    expect(a.leader!.x).toBeLessThan(1000); // stopped soon after crossing into the area
  });

  it('keeps each force\'s phases apart when they share ids', () => {
    const eng = engine();
    const blue = eng.createUnitFromTemplate('us-tank-platoon', 1, 500, 500);
    const red = eng.createUnitFromTemplate('ru-tank-platoon', 2, 3500, 3500);
    eng.sync.set({ force: 1, phases: [{ id: 'P1', name: 'Go', trigger: { type: 'time', time: 1 }, orders: [{ targetId: blue.id, roe: 'holdFire' }] }] });
    eng.sync.set({ force: 2, phases: [{ id: 'P1', name: 'Go', trigger: { type: 'time', time: 3 }, orders: [{ targetId: red.id, roe: 'returnFire' }] }] });
    eng.runFor(2);
    expect(blue.leader!.roe).toBe('holdFire');
    expect(red.leader!.roe).toBe('fireAtWill');
    eng.runFor(2);
    expect(red.leader!.roe).toBe('returnFire');
    expect(eng.sync.states().map((m) => m.started.P1)).toEqual([1, 3]);
  });

  it('refuses orders for another force or unknown objects', () => {
    const eng = engine();
    const runner = new SimRunner(eng, 0.1, 20, 0);
    const red = eng.createEntity({ typeId: 'ru-t72b3', force: 2, x: 3000, y: 3000 });
    expect(executeCommand(runner, { cmd: 'setSyncMatrix', force: 1, phases: [{ name: 'X', orders: [{ targetId: red.id, stop: true }] }] }).error).toMatch(/is not Blue/);
    expect(executeCommand(runner, { cmd: 'setSyncMatrix', force: 1, phases: [{ name: 'X', orders: [{ targetId: 'E999', stop: true }] }] }).error).toMatch(/unknown object/);
    expect(executeCommand(runner, { cmd: 'startPhase', force: 1, phaseId: 'nope' }).ok).toBe(false);
  });
});

describe('synchronization matrix over REST', () => {
  const eng = engine();
  let server: SimServer;
  let url = '';
  const call = (method: string, p: string, key: string, body?: unknown) =>
    fetch(`${url}/api/v1${p}`, { method, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: body === undefined ? (method === 'GET' ? undefined : '{}') : JSON.stringify(body) });

  beforeAll(async () => {
    const runner = new SimRunner(eng, 0.1, 20, 0);
    server = new SimServer(runner, { port: 0, host: '127.0.0.1', webRoot: 'dist/web', scenarioDir: 'scenarios', apiKey: 'control', players: [{ force: 1, key: 'blue' }, { force: 2, key: 'red' }] });
    await server.listen();
    url = server.address;
  });

  afterAll(async () => {
    await server.close();
  });

  it('takes orders in words, and keeps each side to its own matrix', async () => {
    const tanks = eng.createUnitFromTemplate('us-tank-platoon', 1, 500, 500, 0, 'Team ARMOR');
    const r = await call('PUT', '/sync-matrix/blue', 'blue', { phases: [{ name: 'Phase 1', orders: [{ targetId: tanks.id, text: 'move to Alder covered' }, { targetId: tanks.id, text: 'hold fire' }] }] });
    expect(r.status).toBe(200);
    const m = (await r.json()) as SyncMatrixState;
    expect(m.phases[0].orders[0]).toMatchObject({ task: { type: 'moveTo', target: { x: 3000, y: 3000 }, covered: true } });
    expect(m.phases[0].orders[1]).toMatchObject({ roe: 'holdFire' });
    const bad = await call('PUT', '/sync-matrix/blue', 'blue', { phases: [{ name: 'Phase 1', orders: [{ targetId: tanks.id, text: 'move to Atlantis' }] }] });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { message: string } }).error.message).toMatch(/Team ARMOR in Phase 1: Move: where/);
    expect((await call('PUT', '/sync-matrix/blue', 'red', { phases: [] })).status).toBe(403);
    expect(await (await call('GET', '/sync-matrix', 'red')).json()).toEqual([]);
    expect(((await (await call('GET', '/sync-matrix', 'control')).json()) as unknown[]).length).toBe(1);
    expect((await call('POST', '/sync-matrix/blue/phases/P1/start', 'blue')).status).toBe(200);
    expect(tanks.leader!.roe).toBe('holdFire');
  });
});
