import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeCommand } from '../src/server/commands.js';
import { SimRunner } from '../src/server/runner.js';
import { SimServer } from '../src/server/server.js';
import { Engine } from '../src/sim/engine.js';
import { generateBattle, MISSIONS, normalizeWizardOptions, WizardError } from '../src/sim/wizard.js';

const terrain = { seed: 5, size: 12000 };

describe('quick battle', () => {
  it('builds every mission with both forces on land, graphics and a phase plan each', () => {
    for (const mission of MISSIONS) {
      const eng = new Engine({ seed: 1 });
      const r = generateBattle(eng, { seed: 7, mission, terrain, blue: { composition: 'combined', size: 'company', support: ['artillery', 'recon', 'air'] }, red: { composition: 'mech', support: ['engineers'] } });
      const ents = [...eng.entities.values()];
      expect(ents.every((e) => e.domain === 'air' || !eng.terrain.isWater(e.x, e.y))).toBe(true);
      expect(eng.units.get(r.blueId)!.force).toBe(1);
      expect(eng.units.get(r.redId)!.force).toBe(2);
      // A company: an HQ with three platoons under it.
      expect(eng.subordinatesOf(eng.units.get(r.blueId)!)).toHaveLength(3);
      expect([...eng.graphics.values()].some((g) => g.name.startsWith(mission === 'recon' ? 'NAI' : 'OBJ'))).toBe(true);
      expect(eng.sync.get(1)!.phases.length).toBeGreaterThan(0);
      expect(eng.sync.get(2)!.phases.length).toBeGreaterThan(0);
      expect(eng.description).toContain('Seed 7');
      expect(eng.scenarioName).toMatch(/ at /);
      // Saved and loaded, it is the same battle.
      const file = eng.toScenario();
      const again = new Engine({ seed: 1 });
      again.loadScenario(file);
      expect(again.entities.size).toBe(eng.entities.size);
      expect(again.sync.get(1)!.phases).toEqual(eng.sync.get(1)!.phases);
    }
  }, 60000);

  it('is the same battle for the same seed and options, and a different one for another seed', () => {
    const opts = { mission: 'meeting' as const, terrain, blue: { composition: 'armor' as const }, red: { composition: 'armor' as const } };
    const a = new Engine();
    const b = new Engine();
    const c = new Engine();
    generateBattle(a, { ...opts, seed: 11 });
    generateBattle(b, { ...opts, seed: 11 });
    generateBattle(c, { ...opts, seed: 12 });
    const where = (e: Engine) => [...e.entities.values()].map((x) => [x.type.id, Math.round(x.x), Math.round(x.y)]);
    expect(where(a)).toEqual(where(b));
    expect(where(a)).not.toEqual(where(c));
  });

  it('fights: the attack goes through its phases and the defenders dig in behind their minefield', () => {
    const eng = new Engine({ seed: 3 });
    generateBattle(eng, { seed: 21, mission: 'attack', terrain, blue: { composition: 'armor', size: 'company', support: ['artillery'] }, red: { composition: 'mech', support: ['engineers'] }, time: 6, weather: 'haze', civilians: true });
    expect([...eng.graphics.values()].find((g) => g.kind === 'minefield')?.force).toBe(2);
    expect(eng.env.time).toBe(6);
    expect(eng.env.visibility).toBe(6000);
    expect(eng.life.settings.vehicles).toBe(20);
    eng.runFor(5);
    const states = eng.sync.states();
    expect(states.find((m) => m.force === 1)!.current).toBe('P1');
    expect(states.find((m) => m.force === 2)!.current).toBe('P1');
    eng.runFor(1500);
    const blue = eng.sync.states().find((m) => m.force === 1)!;
    expect(Object.keys(blue.started)).toContain('P2');
    const losses = (f: number) => [...eng.entities.values()].filter((e) => e.force === f && !e.ambient && e.destroyed).length;
    expect(losses(1) + losses(2)).toBeGreaterThan(0);
  }, 60000);

  it('checks its options', () => {
    expect(() => normalizeWizardOptions({ mission: 'raid' as never })).toThrow(WizardError);
    expect(() => normalizeWizardOptions({ blue: { size: 'brigade' as never } })).toThrow(/blue.size: one of platoon, company/);
    expect(() => normalizeWizardOptions({ red: { support: ['nukes' as never] } })).toThrow(/red.support/);
    expect(() => normalizeWizardOptions({ distance: 50 })).toThrow(/distance/);
    const o = normalizeWizardOptions({});
    expect(o).toMatchObject({ mission: 'attack', blue: { nation: 'us', composition: 'mech', size: 'platoon', support: [] }, red: { nation: 'ru' }, time: 10, weather: 'clear', civilians: false });
  });

  it('as a command: undoable, and the scenario is left alone when it fails', () => {
    const eng = new Engine();
    eng.newScenario('before', terrain);
    eng.createUnitFromTemplate('us-tank-platoon', 1, 3000, 3000);
    const runner = new SimRunner(eng, 0.1, 20, 10);
    expect(executeCommand(runner, { cmd: 'quickBattle', options: { mission: 'nope' } }).error).toMatch(/mission: one of/);
    expect(eng.scenarioName).toBe('before');
    expect(eng.entities.size).toBe(4);
    const r = executeCommand(runner, { cmd: 'quickBattle', options: { seed: 2, mission: 'defend' } });
    expect(r.ok).toBe(true);
    expect(eng.units.get(r.id!)!.force).toBe(1);
    expect(eng.scenarioName).toMatch(/^Defence at /);
    expect(executeCommand(runner, { cmd: 'undo' }).ok).toBe(true);
    expect(eng.scenarioName).toBe('before');
  });
});

describe('quick battle over REST', () => {
  const eng = new Engine();
  const runner = new SimRunner(eng, 0.1, 20, 0);
  let server: SimServer;
  let url = '';
  const call = (method: string, p: string, key: string, body?: unknown) =>
    fetch(`${url}/api/v1${p}`, { method, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

  beforeAll(async () => {
    eng.newScenario('rest', terrain);
    server = new SimServer(runner, { port: 0, host: '127.0.0.1', webRoot: 'dist/web', scenarioDir: 'scenarios', apiKey: 'control', players: [{ force: 1, key: 'blue' }] });
    await server.listen();
    url = server.address;
  });

  afterAll(async () => {
    await server.close();
  });

  it('lists the choices and builds a battle for exercise control only', async () => {
    const choices = (await (await call('GET', '/scenario/quick-battle', 'control')).json()) as { missions: { id: string }[]; support: string[] };
    expect(choices.missions.map((m) => m.id)).toEqual(MISSIONS);
    expect(choices.support).toContain('airDefense');
    const r = await call('POST', '/scenario/quick-battle', 'control', { mission: 'delay', blue: { composition: 'armor' } });
    expect(r.status).toBe(201);
    const body = (await r.json()) as { scenario: string; seed: number; description: string };
    expect(body.scenario).toMatch(/^Delay at /);
    expect(typeof body.seed).toBe('number');
    expect(body.description).toMatch(/screens on PL 1/);
    expect((await call('POST', '/scenario/quick-battle', 'control', { weather: 'snowstorm' })).status).toBe(400);
    expect((await call('POST', '/scenario/quick-battle', 'blue', {})).status).toBe(403);
  });
});
