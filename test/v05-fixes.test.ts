import { describe, expect, it } from 'vitest';
import { parseOrder, type OrderContext } from '../src/shared/orders.js';
import { Engine } from '../src/sim/engine.js';
import { Terrain } from '../src/sim/terrain.js';
import { generateBattle } from '../src/sim/wizard.js';

// Fixes from the v0.5 documentation pass.

const base = Terrain.generate({ size: 6000, seed: 9, towns: 2 });
const cols = 161;
const flat = new Terrain({ ...base.spec, size: 8000, cellSize: 50, seed: 4242 }, new Float32Array(cols * cols).fill(20), new Uint8Array(cols * cols), [], []);

function engine(): Engine {
  const e = new Engine({ terrain: flat });
  e.newScenario('fixes', flat.spec);
  return e;
}

describe('quick battle plans', () => {
  it('posts scouts on their own side of the objective, and support does not hold up the assault', () => {
    for (const seed of [11, 12, 14]) {
      const eng = new Engine({ seed: 1 });
      const r = generateBattle(eng, { seed, mission: 'attack', terrain: { seed: 5, size: 12000 }, blue: { composition: 'combined', support: ['recon'] }, red: { composition: 'mech' } });
      const blue = eng.sync.get(1)!;
      expect(blue.phases.map((p) => p.name)).toEqual(['Deploy', 'Move', 'Assault', 'Consolidate']);
      const post = (blue.phases[0].orders[0].task as { position: { x: number; y: number } }).position;
      const start = eng.units.get(r.blueId)!.centroid();
      expect(Math.hypot(post.x - start.x, post.y - start.y)).toBeLessThan(Math.hypot(r.objective.x - start.x, r.objective.y - start.y));
      expect(blue.phases.every((p) => p.orders.every((o) => o.text === undefined))).toBe(true);
      eng.runFor(900);
      expect(Object.keys(eng.sync.states().find((m) => m.force === 1)!.started)).toContain('P2');
    }
  }, 120000);
});

describe('units with no one left', () => {
  it('count their order as failed, so the next phase can start', () => {
    const eng = engine();
    const u = eng.createUnitFromTemplate('us-scout-section', 1, 1000, 1000);
    eng.assignTask(u.id, { type: 'overwatch', position: { x: 1500, y: 1000 } });
    eng.runFor(2);
    expect(eng.orderStatus(u)).toBe('running');
    for (const m of u.memberList) m.destroyed = true;
    expect(eng.orderStatus(u)).toBe('failed');
  });
});

describe('typed orders', () => {
  it('take a graphic drawn once for each force as one place', () => {
    const pts = [{ x: 5000, y: 5000 }, { x: 6000, y: 5000 }, { x: 6000, y: 6000 }];
    const ctx: OrderContext = {
      own: [{ id: 'U1', name: 'Team ARMOR', force: 1, kind: 'unit', x: 1000, y: 1000 }],
      visible: [],
      graphics: [
        { id: 'G1', name: 'OBJ RAVEN', kind: 'area', points: pts },
        { id: 'G2', name: 'OBJ RAVEN', kind: 'area', points: pts },
        { id: 'G3', name: 'BP 1', kind: 'area', points: pts },
        { id: 'G4', name: 'BP 1', kind: 'area', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }] },
      ],
      towns: [],
      size: 10000,
    };
    ctx.visible = ctx.own;
    expect(parseOrder('Team ARMOR move to OBJ RAVEN', ctx).commands[0]).toMatchObject({ task: { type: 'moveTo' } });
    expect(() => parseOrder('Team ARMOR move to BP 1', ctx)).toThrow();
  });
});

describe('jamming and alerts', () => {
  it('a jammed unit sends its codeword only once its radio is clear; alerts come back after clearing; "radio back" once per unit', () => {
    const eng = engine();
    const blue = eng.createUnitFromTemplate('us-tank-platoon', 1, 1000, 1000);
    const jammer = eng.createEntity({ typeId: 'ru-r330zh', force: 2, x: 7000, y: 7000 });
    const log: string[] = [];
    eng.on('event', (ev) => log.push(ev.text));
    eng.runFor(2);
    eng.assignPlan(blue.id, { statements: [{ kind: 'sendCodeword', codeword: 'GO' }] });
    eng.runFor(5);
    expect(eng.hasCodeword(1, 'GO')).toBe(false);
    const jammed = eng.alerts.open().find((a) => a.kind === 'jammed')!;
    eng.alerts.acknowledge(jammed.id);
    jammer.jamming = false;
    eng.runFor(3);
    expect(eng.hasCodeword(1, 'GO')).toBe(true);
    expect(log.filter((t) => t.endsWith('radio back'))).toHaveLength(1);
    jammer.jamming = true;
    eng.runFor(3);
    expect(eng.alerts.open().some((a) => a.kind === 'jammed' && a.objectId === blue.id)).toBe(true);
  });
});

describe('driving a unit leader', () => {
  it('brings the members holding their own positions along', () => {
    const eng = engine();
    const p = eng.createUnitFromTemplate('us-tank-platoon', 1, 1000, 1000);
    eng.assignTask(p.id, { type: 'defend', position: { x: 1000, y: 1200 }, facing: 0 });
    eng.runFor(60);
    eng.drive(p.leader!, { throttle: 0.5 });
    expect(p.memberList.filter((m) => m !== p.leader).every((m) => m.task?.spec.type === 'formation')).toBe(true);
    const before = p.memberList[1].y;
    eng.runFor(30);
    expect(p.memberList[1].y).toBeGreaterThan(before + 100);
  });
});
