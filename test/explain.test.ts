import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SimRunner } from '../src/server/runner.js';
import { SimServer } from '../src/server/server.js';
import { Engine } from '../src/sim/engine.js';
import { explainEntity, explainUnit } from '../src/sim/explain.js';
import { Terrain } from '../src/sim/terrain.js';
import type { Explanation } from '../src/shared/types.js';

const base = Terrain.generate({ size: 6000, seed: 9, towns: 2 });
const cols = 81;
const heights = new Float32Array(cols * cols).fill(20);
// A ridge 60 m high along y = 2000 (row 40) on 4 km of open ground.
for (let i = 0; i < cols; i++) for (const r of [39, 40, 41]) heights[r * cols + i] = r === 40 ? 80 : 60;
const ridged = new Terrain({ ...base.spec, size: 4000, cellSize: 50, seed: 77 }, heights, new Uint8Array(cols * cols), [], []);

function engine(): Engine {
  const e = new Engine({ terrain: ridged });
  e.newScenario('explain', ridged.spec);
  return e;
}

const codes = (ex: Explanation, group: 'movement' | 'fire' | 'sensing' | 'unit') => (ex[group] ?? []).map((f) => f.code);

describe('explanations', () => {
  it('names what blocks the line of sight to a known enemy, and where', () => {
    const eng = engine();
    const blue = eng.createEntity({ typeId: 'us-m1a2', force: 1, x: 2000, y: 1500 });
    const red = eng.createEntity({ typeId: 'ru-t72b3', force: 2, x: 2000, y: 2500 });
    // Its side knows where the enemy is (e.g. reported by a scout), but it cannot see it.
    blue.contacts.set(red.id, { id: red.id, firstSeen: 0, lastSeen: 0, x: red.x, y: red.y, z: red.z });
    const before = eng.rng.state;
    const ex = explainEntity(eng, blue, { omniscient: true });
    expect(eng.rng.state).toBe(before);
    const los = ex.fire.find((f) => f.code === 'noLineOfSight')!;
    expect(los.severity).toBe('block');
    expect(los.text).toMatch(/the ground/);
    expect(los.at!.y).toBeGreaterThan(1900);
    expect(los.at!.y).toBeLessThan(2100);
    expect(los.aboutId).toBe(red.id);
    expect(ex.summary).toMatch(/No line of sight to/);
  });

  it('tells exercise control why an enemy is not detected, but not a player', () => {
    const eng = engine();
    const blue = eng.createEntity({ typeId: 'us-m1a2', force: 1, x: 2000, y: 1500 });
    eng.createEntity({ typeId: 'ru-t72b3', force: 2, x: 2000, y: 2500 });
    const control = explainEntity(eng, blue, { omniscient: true });
    expect(codes(control, 'fire')).toContain('noContacts');
    expect(control.sensing.find((f) => f.code === 'hidden')?.text).toMatch(/hidden from it by the ground/);
    const player = explainEntity(eng, blue, { omniscient: false });
    expect(codes(player, 'sensing')).not.toContain('hidden');
    expect(JSON.stringify(player)).not.toMatch(/T-72/);
  });

  it('explains ROE, range, ammunition and fuel', () => {
    const eng = engine();
    const blue = eng.createEntity({ typeId: 'us-m1a2', force: 1, x: 100, y: 100 });
    const red = eng.createEntity({ typeId: 'ru-t72b3', force: 2, x: 3900, y: 3900 });
    blue.contacts.set(red.id, { id: red.id, firstSeen: 0, lastSeen: 0, x: red.x, y: red.y, z: red.z });
    expect(codes(explainEntity(eng, blue, { omniscient: true }), 'fire')).toContain('outOfRange');
    eng.setRoe(blue.id, 'holdFire');
    const held = explainEntity(eng, blue, { omniscient: true });
    expect(held.fire.find((f) => f.code === 'holdFire')?.fix).toMatch(/fire at will/);
    for (const w of blue.type.weapons) blue.ammo.set(w, 0);
    expect(codes(explainEntity(eng, blue, { omniscient: true }), 'fire')).toContain('noAmmo');
    blue.fuel = 0;
    eng.assignTask(blue.id, { type: 'moveTo', target: { x: 900, y: 900 } });
    const stuck = explainEntity(eng, blue, { omniscient: true });
    expect(stuck.movement.find((f) => f.code === 'outOfFuel')?.severity).toBe('block');
    expect(stuck.summary).toMatch(/Out of fuel/);
    const idle = explainEntity(eng, eng.createEntity({ typeId: 'us-m1a2', force: 1, x: 700, y: 700 }), { omniscient: true });
    expect(idle.movement.find((f) => f.code === 'idle')?.fix).toMatch(/give it a task/i);
  });

  it('counts the problems of a unit\'s members', () => {
    const eng = engine();
    const p = eng.createUnitFromTemplate('us-tank-platoon', 1, 1000, 1000);
    for (const m of p.memberList.slice(0, 3)) m.fuel = 0;
    eng.assignTask(p.id, { type: 'moveTo', target: { x: 1200, y: 1200 } });
    const ex = explainUnit(eng, p, { omniscient: true });
    expect(ex.kind).toBe('unit');
    expect(ex.unit!.find((f) => f.code === 'outOfFuel')?.text).toMatch(/^3 of 4: Out of fuel/);
    expect(ex.unit!.find((f) => f.code === 'strength')?.text).toMatch(/4 of 4 members/);
  });
});

describe('explanations over REST', () => {
  const eng = engine();
  let server: SimServer;
  let base = '';
  const get = (p: string, key: string) => fetch(`${base}/api/v1${p}`, { headers: { Authorization: `Bearer ${key}` } });

  beforeAll(async () => {
    const runner = new SimRunner(eng, 0.1, 20, 0);
    server = new SimServer(runner, { port: 0, host: '127.0.0.1', webRoot: 'dist/web', scenarioDir: 'scenarios', apiKey: 'control', players: [{ force: 1, key: 'blue' }, { force: 2, key: 'red' }] });
    await server.listen();
    base = server.address;
  });

  afterAll(async () => {
    await server.close();
  });

  it('serves explanations to control and to the owning side only', async () => {
    const e = eng.createEntity({ typeId: 'us-m1a2', force: 1, x: 2000, y: 1500 });
    const u = eng.createUnitFromTemplate('us-tank-platoon', 1, 1000, 1000);
    const r = await get(`/entities/${e.id}/explain`, 'control');
    expect(r.status).toBe(200);
    expect(((await r.json()) as Explanation).summary).toMatch(/No task/);
    expect((await get(`/units/${u.id}/explain`, 'blue')).status).toBe(200);
    expect((await get(`/entities/${e.id}/explain`, 'blue')).status).toBe(200);
    expect((await get(`/entities/${e.id}/explain`, 'red')).status).toBe(404);
    expect((await get(`/units/${u.id}/explain`, 'red')).status).toBe(404);
  });
});
