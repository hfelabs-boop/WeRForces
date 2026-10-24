import { describe, expect, it } from 'vitest';
import { EXPOSURE, killRate } from '../src/sim/aggregate.js';
import { Engine } from '../src/sim/engine.js';
import { explainUnit } from '../src/sim/explain.js';
import { Recorder } from '../src/sim/recorder.js';
import { ApiV1 } from '../src/server/apiV1.js';
import { executeCommand } from '../src/server/commands.js';
import { SimRunner } from '../src/server/runner.js';
import { createMcpServer } from '../src/mcp/tools.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Terrain } from '../src/sim/terrain.js';
import { filterEvents, filterState } from '../src/server/fog.js';
import type { AggregateSnapshot, ForceId, SimEvent } from '../src/shared/types.js';

const base = Terrain.generate({ size: 6000, seed: 9, towns: 2 });
const cols = 121;
const flat = new Terrain({ ...base.spec, size: 12000, cellSize: 100, seed: 4243 }, new Float32Array(cols * cols).fill(20), new Uint8Array(cols * cols), [], []);

function engine(): Engine {
  const e = new Engine({ terrain: flat });
  e.newScenario('aggregate', flat.spec);
  return e;
}

/** A unit of n entities of one type in a line abreast at (x, y). */
function line(eng: Engine, typeId: string, n: number, force: ForceId, x: number, y: number, heading = 0) {
  const ids = [];
  for (let i = 0; i < n; i++) ids.push(eng.createEntity({ typeId, force, x: x + (i - (n - 1) / 2) * 40, y, heading }).id);
  return eng.groupUnit(ids, `${typeId} x${n}`, 'line', 40, 'company');
}

function agg(eng: Engine, id: string): AggregateSnapshot {
  const u = eng.snapshot().units.find((x) => x.id === id)!;
  expect(u.aggregate).toBeDefined();
  return u.aggregate!;
}

const effective = (a: AggregateSnapshot) => a.strength.reduce((s, g) => s + (g.effective ?? g.alive), 0);

describe('aggregate-level units', () => {
  it('attrition follows the closed-form Lanchester square law for two homogeneous aggregates', () => {
    const eng = engine();
    eng.setRules({ morale: false });
    const blue = line(eng, 'us-m1a2', 10, 1, 5000, 6000, Math.PI / 2);
    const red = line(eng, 'ru-t72b3', 16, 2, 7000, 6000, -Math.PI / 2);
    eng.aggregates.aggregate(blue);
    eng.aggregates.aggregate(red);
    // Both halted 2 km apart: each side's kill rate per shooter, as the model defines it.
    const r = 2000;
    const alpha = killRate(eng.catalog.weapon('gun-120mm'), 'armored', r) * EXPOSURE.halted;
    const beta = killRate(eng.catalog.weapon('gun-125mm'), 'armored', r) * EXPOSURE.halted;
    eng.runFor(2);
    const t0 = eng.time;
    const a0 = effective(agg(eng, blue.id));
    const b0 = effective(agg(eng, red.id));
    expect(a0).toBeLessThan(10);
    const g = Math.sqrt(alpha * beta);
    const closed = (t: number) => ({
      a: a0 * Math.cosh(g * t) - Math.sqrt(beta / alpha) * b0 * Math.sinh(g * t),
      b: b0 * Math.cosh(g * t) - Math.sqrt(alpha / beta) * a0 * Math.sinh(g * t),
    });
    for (const t of [20, 40, 60, 75]) {
      eng.runFor(t - (eng.time - t0));
      const want = closed(eng.time - t0);
      const a = agg(eng, blue.id);
      const b = agg(eng, red.id);
      expect(effective(a)).toBeCloseTo(want.a, 1);
      expect(effective(b)).toBeCloseTo(want.b, 1);
      // Whole members are lost as the losses add up.
      expect(Math.abs(a.alive - want.a)).toBeLessThan(1);
      expect(Math.abs(b.alive - want.b)).toBeLessThan(1);
    }
    // Fought to the end: the square law's survivors, sqrt(B0^2 - (alpha/beta) A0^2).
    for (let i = 0; i < 600 && blue.alive().length; i++) eng.runFor(1);
    expect(blue.alive().length).toBe(0);
    const survivors = Math.sqrt(b0 * b0 - (alpha / beta) * a0 * a0);
    expect(Math.abs(red.alive().length - survivors)).toBeLessThan(1);
    // Losses are specific members, left on the map as wrecks.
    const wrecks = blue.memberList.filter((m) => eng.entities.has(m.id));
    expect(wrecks.length).toBe(10);
    expect(wrecks.every((m) => m.destroyed)).toBe(true);
    expect(red.memberList.filter((m) => m.destroyed).length).toBe(16 - red.alive().length);
  });

  it('is repeatable: the seeded generator picks the same members', () => {
    const run = () => {
      const eng = engine();
      const blue = line(eng, 'us-m1a2', 4, 1, 5000, 6000);
      const red = line(eng, 'ru-t72b3', 6, 2, 7000, 6000);
      eng.aggregates.aggregate(blue);
      eng.aggregates.aggregate(red);
      eng.runFor(240);
      return [...blue.memberList, ...red.memberList].map((m) => `${m.id}:${m.destroyed}:${m.ammo.get(m.type.weapons[0])}`).join(' ');
    };
    expect(run()).toBe(run());
  });

  it('round trip aggregate -> entities -> aggregate keeps strength, position, ammunition and fuel', () => {
    const eng = engine();
    const u = eng.createUnitFromTemplate('us-tank-platoon', 1, 3000, 3000, 0.6);
    u.memberList[1].ammo.set('gun-120mm', 17);
    u.memberList[2].fuel = 0.5;
    u.memberList[3].destroyed = true;
    const before = u.centroid();
    const state = () => u.memberList.map((m) => `${m.id}:${m.damage}:${m.ammo.get('gun-120mm')}:${m.fuel.toFixed(4)}`).join(' ');
    const s0 = state();
    eng.aggregates.aggregate(u);
    const a = agg(eng, u.id);
    expect(a.alive).toBe(3);
    expect(a.total).toBe(4);
    expect(a.strength).toEqual([{ typeId: 'us-m1a2', name: 'M1A2 Abrams', alive: 3, effective: 3, total: 4 }]);
    // Members are out of the entity-level simulation; the wreck stays where it was.
    const snap = eng.snapshot();
    expect(snap.entities.map((e) => e.id)).toEqual([u.memberList[3].id]);
    const su = snap.units.find((x) => x.id === u.id)!;
    expect(su.x).toBeCloseTo(before.x, 6);
    expect(su.y).toBeCloseTo(before.y, 6);
    eng.aggregates.disaggregate(u);
    expect(u.aggregate).toBeNull();
    expect(state()).toBe(s0);
    const mid = u.centroid();
    expect(mid.x).toBeCloseTo(before.x, 6);
    expect(mid.y).toBeCloseTo(before.y, 6);
    // In formation, facing the unit's way.
    for (const m of u.alive()) expect(m.heading).toBeCloseTo(0.6, 6);
    expect(new Set(u.alive().map((m) => `${Math.round(m.x)},${Math.round(m.y)}`)).size).toBe(3);
    eng.aggregates.aggregate(u);
    const again = eng.snapshot().units.find((x) => x.id === u.id)!;
    expect(again.x).toBeCloseTo(before.x, 6);
    expect(again.y).toBeCloseTo(before.y, 6);
    expect(again.aggregate!.alive).toBe(3);
    expect(state()).toBe(s0);
  });

  it('moves at the speed of its slowest member type, burning each member\'s fuel', () => {
    const eng = engine();
    const tanks = line(eng, 'us-m1a2', 2, 1, 2000, 2000);
    const ifv = eng.createEntity({ typeId: 'us-m2a3', force: 1, x: 2100, y: 2000 });
    const u = eng.groupUnit([...tanks.memberList.map((m) => m.id), ifv.id], 'Team', 'line', 40, 'platoon');
    eng.aggregates.aggregate(u);
    eng.assignTask(u.id, { type: 'moveTo', target: { x: 8000, y: 2000 } });
    eng.runFor(30);
    const a = agg(eng, u.id);
    expect(a.posture).toBe('moving');
    const c0 = u.centroid();
    const slowest = Math.min(...u.alive().map((m) => Math.min(m.type.cruiseSpeed, m.type.maxSpeed * flat.mobilityFactor(c0.x, c0.y, m.domain, m.type.offroadFactor))));
    expect(a.speed).toBeCloseTo(slowest, 6);
    expect(a.unitSpeed).toBeCloseTo(slowest, 2);
    expect(u.alive().every((m) => m.fuel < 1)).toBe(true);
    const c = u.centroid();
    expect(c.x).toBeGreaterThan(2000 + 30 * a.speed * 0.9);
    eng.runFor(900);
    expect(u.taskStatus()).toBe('done');
    const end = eng.snapshot().units.find((x) => x.id === u.id)!;
    expect(end.x).toBeCloseTo(8000, 0);
    expect(end.aggregate!.posture).toBe('halted');
    // Disaggregated at the objective, the members stand around it.
    eng.aggregates.disaggregate(u);
    expect(u.centroid().x).toBeCloseTo(8000, 0);
  });

  it('disaggregates automatically at the threshold distance from enemy entities, and joins up again later', () => {
    const eng = engine();
    eng.aggregates.setPolicy({ disaggregateRange: 3000, reaggregateRange: 5000, reaggregateDelay: 60 });
    const blue = eng.createUnitFromTemplate('us-tank-platoon', 1, 1000, 6000, Math.PI / 2);
    const red = eng.createEntity({ typeId: 'ru-t72b3', force: 2, x: 9000, y: 6000 });
    eng.setRoe(blue.id, 'holdFire');
    red.roe = 'holdFire';
    eng.aggregates.aggregate(blue);
    eng.assignTask(blue.id, { type: 'moveTo', target: { x: 8500, y: 6000 } });
    let at = -1;
    const log: string[] = [];
    eng.on('event', (ev) => log.push(ev.text));
    for (let i = 0; i < 1200 && at < 0; i++) {
      eng.runFor(1);
      if (!blue.aggregate) at = eng.time;
    }
    expect(at).toBeGreaterThan(0);
    const d = 9000 - blue.centroid().x;
    expect(d).toBeLessThanOrEqual(3000);
    expect(d).toBeGreaterThan(3000 - 2 * 12);
    expect(log.some((t) => /disaggregated \(enemy within 3 km\)/.test(t))).toBe(true);
    // The move carries on at entity level.
    expect(blue.taskSpec?.type).toBe('moveTo');
    expect(blue.leader!.task?.status).toBe('running');
    // Back out of the way: beyond 5 km for a minute, it aggregates again.
    eng.assignTask(blue.id, { type: 'moveTo', target: { x: 1000, y: 6000 } });
    let back = -1;
    for (let i = 0; i < 1500 && back < 0; i++) {
      eng.runFor(1);
      if (blue.aggregate) back = eng.time;
    }
    expect(back).toBeGreaterThan(0);
    expect(9000 - blue.centroid().x).toBeGreaterThan(5000);
    // Still on its way home.
    expect(blue.taskSpec?.type).toBe('moveTo');
    eng.runFor(1);
    expect(eng.snapshot().units.find((x) => x.id === blue.id)!.aggregate!.posture).toBe('moving');
  });

  it('splits up for orders an aggregate cannot carry out, and on command', () => {
    const eng = engine();
    const u = eng.createUnitFromTemplate('us-tank-platoon', 1, 3000, 3000);
    eng.aggregates.aggregate(u);
    const g = eng.addGraphic('route', [{ x: 3000, y: 3000 }, { x: 4000, y: 3000 }, { x: 4000, y: 4000 }]);
    eng.assignTask(u.id, { type: 'patrol', routeId: g.id });
    expect(u.aggregate).toBeNull();
    expect(u.reaggregate).not.toBeNull();
    expect(u.leader!.task?.spec.type).toBe('patrol');
    expect(eng.aggregates.refusal(u)).toMatch(/patrol/);
  });

  it('saves and loads an aggregate, at the start and as a checkpoint', () => {
    const eng = engine();
    const u = eng.createUnitFromTemplate('us-tank-platoon', 1, 3000, 3000, 1);
    eng.aggregates.setPolicy({ disaggregateRange: 2500 });
    eng.aggregates.aggregate(u);
    // Authored (time 0): aggregated, at its place.
    const s0 = eng.toScenario();
    const rec = s0.units.find((x) => x.id === u.id)!;
    expect(rec.aggregate).toBeDefined();
    expect(s0.entities.filter((r) => u.memberList.some((m) => m.id === r.id)).length).toBe(4);
    expect(s0.aggregation).toEqual({ autoDisaggregate: true, disaggregateRange: 2500, autoReaggregate: true, reaggregateRange: 5000, reaggregateDelay: 120 });
    const e2 = engine();
    e2.loadScenario(JSON.parse(JSON.stringify(s0)));
    const u2 = e2.units.get(u.id)!;
    expect(u2.aggregate).not.toBeNull();
    expect(e2.entities.size).toBe(0);
    expect(e2.aggregates.policy.disaggregateRange).toBe(2500);
    // A checkpoint part-way through a move.
    eng.assignTask(u.id, { type: 'moveTo', target: { x: 9000, y: 3000 } });
    eng.runFor(40);
    u.memberList[0].ammo.set('gun-120mm', 12);
    const s1 = eng.toScenario();
    const e3 = engine();
    e3.loadScenario(JSON.parse(JSON.stringify(s1)));
    const u3 = e3.units.get(u.id)!;
    const a1 = agg(eng, u.id);
    const a3 = agg(e3, u.id);
    expect(a3.alive).toBe(a1.alive);
    expect(a3.heading).toBeCloseTo(a1.heading, 6);
    const p1 = eng.snapshot().units.find((x) => x.id === u.id)!;
    const p3 = e3.snapshot().units.find((x) => x.id === u.id)!;
    expect(p3.x).toBeCloseTo(p1.x, 6);
    expect(p3.y).toBeCloseTo(p1.y, 6);
    expect(p3.task).toBe(p1.task);
    expect(u3.memberList[0].ammo.get('gun-120mm')).toBe(12);
    expect(u3.memberList[0].fuel).toBeCloseTo(u.memberList[0].fuel, 9);
    // It carries on and arrives.
    e3.runFor(900);
    expect(u3.taskStatus()).toBe('done');
    expect(e3.snapshot().units.find((x) => x.id === u.id)!.x).toBeCloseTo(9000, 0);
    // Undo-style restore of the same checkpoint twice gives the same state.
    const e4 = engine();
    e4.loadScenario(JSON.parse(JSON.stringify(s1)));
    e4.runFor(900);
    expect(JSON.stringify(e4.toScenario().units)).toBe(JSON.stringify(e3.toScenario().units));
  });

  it('fog of war: enemy aggregates are seen as units once detected, their members never', () => {
    const eng = engine();
    eng.setRules({ morale: false });
    const blue = line(eng, 'us-m1a2', 4, 1, 3000, 6000);
    const red = line(eng, 'ru-t72b3', 4, 2, 9000, 6000);
    eng.setRoe(blue.id, 'holdFire');
    eng.setRoe(red.id, 'holdFire');
    eng.aggregates.aggregate(blue);
    eng.aggregates.aggregate(red);
    eng.runFor(2);
    // 6 km apart: beyond their sensors.
    let view = filterState(eng, eng.snapshot(), 2);
    expect(view.units.map((u) => u.id)).toEqual([red.id]);
    expect(view.entities.length).toBe(0);
    eng.assignTask(blue.id, { type: 'moveTo', target: { x: 5500, y: 6000 } });
    eng.runFor(300);
    view = filterState(eng, eng.snapshot(), 2);
    const seen = view.units.find((u) => u.id === blue.id)!;
    expect(seen).toBeDefined();
    expect(seen.name).toBe(`enemy company (${blue.id})`);
    expect(seen.memberIds).toEqual([]);
    expect(seen.aggregate!.contactAge).toBeLessThanOrEqual(1);
    expect(seen.aggregate!.ammo).toBeUndefined();
    expect(seen.aggregate!.strength).toEqual([{ typeId: 'us-m1a2', name: 'M1A2 Abrams', alive: 4, total: 4 }]);
    expect(view.entities.some((e) => e.force === 1)).toBe(false);
    // Blue's own view has the full aggregate.
    expect(filterState(eng, eng.snapshot(), 1).units.find((u) => u.id === blue.id)!.aggregate!.ammo).toBe(1);
    // Fight: each side hears of its own losses, with the enemy named as a contact.
    eng.setRoe(blue.id, 'fireAtWill');
    eng.setRoe(red.id, 'fireAtWill');
    const events: SimEvent[] = [];
    eng.on('event', (ev) => events.push(ev));
    eng.runFor(240);
    const redLosses = filterEvents(eng, events, 2).filter((ev) => ev.kind === 'destroyed');
    expect(redLosses.length).toBe(red.memberList.filter((m) => m.destroyed).length);
    expect(redLosses.length).toBeGreaterThan(0);
    for (const ev of redLosses) expect(ev.text).not.toContain(blue.name);
    // Players cannot name members of an aggregate they have not seen.
    const far = line(eng, 'us-m1a2', 2, 1, 1000, 1000);
    eng.aggregates.aggregate(far);
    eng.runFor(1);
    expect(filterState(eng, eng.snapshot(), 2).units.some((u) => u.id === far.id)).toBe(false);
  });

  it('explains an aggregate and records it for the after-action review', () => {
    const eng = engine();
    const u = eng.createUnitFromTemplate('us-tank-platoon', 1, 3000, 3000);
    eng.aggregates.aggregate(u);
    const ex = explainUnit(eng, u, { omniscient: true });
    expect(ex.summary).toMatch(/^Aggregated: /);
    expect(ex.unit![0].text).toMatch(/^Aggregated: simulated as one object, 4 of 4 members fit to fight \(4 × M1A2 Abrams\)/);
    const rec = new Recorder(eng);
    eng.assignTask(u.id, { type: 'moveTo', target: { x: 6000, y: 3000 } });
    eng.runFor(20);
    const st = rec.stateAt(eng.time);
    expect(st.entities.length).toBe(0);
    const ru = st.units.find((x) => x.id === u.id)!;
    expect(ru.aggregate).toMatchObject({ alive: 4, total: 4, posture: 'moving' });
    expect(ru.x).toBeCloseTo(u.centroid().x, 0);
    expect(rec.report().forces.find((f) => f.force === 1)!.end).toBe(4);
    eng.aggregates.disaggregate(u);
    eng.runFor(2);
    expect(rec.stateAt(eng.time).entities.length).toBe(4);
    rec.detach();
  });

  it('is driven by commands, REST and MCP, and undone like any edit', async () => {
    const eng = engine();
    const runner = new SimRunner(eng, 0.1, 20, 0);
    const api = new ApiV1({ runner, integrations: {} as never, scenarioDir: '/tmp' });
    const call = async (method: string, path: string, body?: unknown) => {
      const [p, q] = path.split('?');
      const r = await api.dispatch({ method, path: p, query: new URLSearchParams(q ?? ''), body, baseUrl: '' });
      return { status: r.status ?? 200, json: r.json };
    };
    const hq = eng.createUnitFromTemplate('us-tank-company', 1, 4000, 4000);
    const subs = eng.subordinatesOf(hq);
    expect(subs.length).toBe(3);
    // A company aggregates with its platoons, each its own aggregate.
    let r = await call('POST', `/api/v1/units/${hq.id}/aggregate`);
    expect(r.status).toBe(200);
    expect((r.json as { aggregate?: unknown }).aggregate).toBeDefined();
    expect(subs.every((u) => u.aggregate)).toBe(true);
    expect(eng.entities.size).toBe(0);
    r = await call('POST', `/api/v1/units/${hq.id}/aggregate`);
    expect(r.status).toBe(400);
    // Orders pass down to aggregated subordinates.
    await call('POST', `/api/v1/units/${hq.id}/task`, { type: 'moveTo', target: { x: 6000, y: 4000 } });
    expect(subs.every((u) => u.aggregate!.activeTask()?.spec.type === 'moveTo')).toBe(true);
    r = await call('PUT', '/api/v1/simulation/aggregation', { disaggregateRange: 2000, reaggregateRange: 1000 });
    expect(r.json).toMatchObject({ disaggregateRange: 2000, reaggregateRange: 2000 });
    expect((await call('PUT', '/api/v1/simulation/aggregation', { bogus: 1 })).status).toBe(400);
    // Undo puts the entities back.
    expect(executeCommand(runner, { cmd: 'disaggregate', unitId: subs[0].id }).ok).toBe(true);
    expect(subs[0].aggregate).toBeNull();
    expect(executeCommand(runner, { cmd: 'undo' }).ok).toBe(true);
    expect(eng.units.get(subs[0].id)!.aggregate).not.toBeNull();
    // MCP.
    const server = createMcpServer(async (method, path, body) => call(method, path, body));
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(b);
    const res = (await client.callTool({ name: 'aggregate_unit', arguments: { unitId: hq.id, aggregate: false } })) as { content: { text: string }[]; isError?: boolean };
    expect(res.isError).toBeFalsy();
    expect([...eng.units.values()].every((u) => !u.aggregate)).toBe(true);
    const pol = (await client.callTool({ name: 'set_aggregation_policy', arguments: { autoReaggregate: false } })) as { content: { text: string }[] };
    expect(JSON.parse(pol.content[0].text).autoReaggregate).toBe(false);
    await client.close();
  });
});
