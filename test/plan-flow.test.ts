import { describe, expect, it } from 'vitest';
import { executeCommand, validatePlan } from '../src/server/commands.js';
import { checkCommand, ForbiddenError } from '../src/server/fog.js';
import { SimRunner } from '../src/server/runner.js';
import { Engine } from '../src/sim/engine.js';
import { compilePlan } from '../src/sim/plans.js';
import { Terrain } from '../src/sim/terrain.js';
import type { Plan } from '../src/shared/types.js';

const base = Terrain.generate({ size: 6000, seed: 9, towns: 2 });
const cols = 81;
const flat = new Terrain({ ...base.spec, size: 4000, cellSize: 50, seed: 4242 }, new Float32Array(cols * cols).fill(20), new Uint8Array(cols * cols), [], []);

function engine(): Engine {
  const e = new Engine({ terrain: flat });
  e.newScenario('flow', flat.spec);
  return e;
}

const box = (x0: number, y0: number, x1: number, y1: number) => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];

describe('plan control flow', () => {
  it('compiles flat plans one step per statement, and blocks with jumps', () => {
    expect(compilePlan([{ kind: 'setRoe', roe: 'holdFire' }, { kind: 'setSpeed', speed: 5 }]).map((o) => o.op)).toEqual(['do', 'do']);
    const ops = compilePlan([
      { kind: 'if', condition: { type: 'underFire' }, then: [{ kind: 'setRoe', roe: 'fireAtWill' }], else: [{ kind: 'setRoe', roe: 'holdFire' }] },
      { kind: 'while', condition: { type: 'enemyDetected' }, body: [{ kind: 'task', task: { type: 'wait', duration: 5 } }] },
    ]);
    expect(ops.map((o) => o.op)).toEqual(['test', 'do', 'jump', 'do', 'test', 'do', 'jump']);
    expect(ops[0]).toMatchObject({ else: 3 });
    expect(ops[2]).toMatchObject({ to: 4 });
    expect(ops[4]).toMatchObject({ else: 7 });
    expect(ops[6]).toMatchObject({ to: 4 });
  });

  it('takes the branch the condition says, at the moment it is reached', () => {
    for (const inside of [true, false]) {
      const eng = engine();
      const a = eng.addGraphic('area', box(900, 900, 1100, 1100), 'Here');
      const e = eng.createEntity({ typeId: 'us-m1a2', force: 1, x: inside ? 1000 : 2000, y: inside ? 1000 : 2000 });
      eng.assignPlan(e.id, {
        statements: [{ kind: 'if', condition: { type: 'inArea', areaId: a.id }, then: [{ kind: 'setRoe', roe: 'holdFire' }], else: [{ kind: 'setRoe', roe: 'returnFire' }] }, { kind: 'setSpeed', speed: 3 }],
      });
      eng.step();
      expect(e.roe).toBe(inside ? 'holdFire' : 'returnFire');
      expect(e.speedOverride).toBe(3);
      expect(e.plan!.finished).toBe(true);
    }
  });

  it('coordinates units with codewords: a while loop runs until a codeword stops it', () => {
    const eng = engine();
    const lead = eng.createUnitFromTemplate('us-tank-platoon', 1, 500, 500);
    const follow = eng.createUnitFromTemplate('us-mech-platoon', 1, 500, 1500);
    const red = eng.createUnitFromTemplate('ru-tank-platoon', 2, 3500, 3500);
    eng.setHostilities([]); // no fighting: only the codewords matter here
    const line = eng.addGraphic('area', box(1400, 0, 4000, 4000), 'Past PL');
    eng.assignPlan(lead.id, {
      name: 'Lead',
      statements: [
        { kind: 'task', task: { type: 'moveTo', target: { x: 1600, y: 500 } } },
        { kind: 'waitUntil', condition: { type: 'inArea', areaId: line.id } },
        { kind: 'sendCodeword', codeword: 'phase 2' },
        { kind: 'report', text: 'crossing PL' },
      ],
    });
    eng.assignPlan(follow.id, {
      name: 'Follow',
      statements: [
        { kind: 'while', condition: { type: 'not', condition: { type: 'codeword', codeword: 'PHASE 2' } }, body: [{ kind: 'task', task: { type: 'wait', duration: 5 } }] },
        { kind: 'task', task: { type: 'moveTo', target: { x: 1600, y: 1500 } } },
      ],
    });
    // Red waits for the same codeword on its own net: it never hears Blue's.
    eng.assignPlan(red.id, { statements: [{ kind: 'waitUntil', condition: { type: 'codeword', codeword: 'PHASE 2' } }, { kind: 'setRoe', roe: 'holdFire' }] });
    eng.runFor(30);
    expect(follow.leader!.x).toBeLessThan(520); // still looping
    expect(follow.plan!.describe(eng)).toMatch(/Wait 5s|While not/);
    let sent = 0;
    for (let i = 0; i < 2000 && !sent; i++) {
      eng.step();
      if (eng.hasCodeword(1, 'phase 2')) sent = eng.time;
    }
    expect(sent).toBeGreaterThan(0);
    eng.runFor(120);
    expect(follow.leader!.x).toBeGreaterThan(1000);
    expect(red.leader!.roe).toBe('fireAtWill');
    expect(eng.eventsSince(0).some((e) => e.kind === 'radio' && /codeword PHASE 2/.test(e.text))).toBe(true);
    expect(eng.eventsSince(0).some((e) => e.kind === 'radio' && /crossing PL/.test(e.text))).toBe(true);
    // Checkpoints keep the codewords and the place in a nested plan.
    const ck = eng.toScenario();
    expect(ck.codewords).toEqual([{ force: 1, codeword: 'PHASE 2', time: sent }]);
    const again = engine();
    again.loadScenario(ck);
    expect(again.hasCodeword(1, 'PHASE 2')).toBe(true);
  });

  it('evaluates all, any and not', () => {
    const eng = engine();
    const e = eng.createEntity({ typeId: 'us-m1a2', force: 1, x: 1000, y: 1000 });
    eng.sendCodeword(1, 'alpha');
    const plan = (cond: Plan['statements'][number] & { kind: 'waitUntil' }) => {
      eng.setRoe(e.id, 'fireAtWill');
      eng.assignPlan(e.id, { statements: [cond, { kind: 'setRoe', roe: 'holdFire' }] });
      eng.step();
      return e.roe === 'holdFire';
    };
    expect(plan({ kind: 'waitUntil', condition: { type: 'all', conditions: [{ type: 'codeword', codeword: 'ALPHA' }, { type: 'not', condition: { type: 'underFire' } }] } })).toBe(true);
    expect(plan({ kind: 'waitUntil', condition: { type: 'all', conditions: [{ type: 'codeword', codeword: 'ALPHA' }, { type: 'codeword', codeword: 'BRAVO' }] } })).toBe(false);
    expect(plan({ kind: 'waitUntil', condition: { type: 'any', conditions: [{ type: 'codeword', codeword: 'BRAVO' }, { type: 'codeword', codeword: 'ALPHA' }] } })).toBe(true);
  });

  it('validates nested plans, codewords and who may send them', () => {
    expect(() => validatePlan({ statements: [{ kind: 'sendCodeword', codeword: 'no/slash' }] })).toThrow(/codeword/);
    let deep: unknown[] = [{ kind: 'setSpeed', speed: 1 }];
    for (let i = 0; i < 10; i++) deep = [{ kind: 'while', condition: { type: 'underFire' }, body: deep }];
    expect(() => validatePlan({ statements: deep })).toThrow(/nested too deeply/);
    expect(() => validatePlan({ statements: [{ kind: 'if', condition: { type: 'all', conditions: [] }, then: [] }] })).toThrow(/conditions/);
    expect(validatePlan({ statements: [{ kind: 'if', condition: { type: 'codeword', codeword: ' go ' }, then: [{ kind: 'report', text: 'going' }] }] }).statements[0]).toEqual({
      kind: 'if',
      condition: { type: 'codeword', codeword: 'GO' },
      then: [{ kind: 'report', text: 'going' }],
    });
    const eng = engine();
    const red = eng.createEntity({ typeId: 'ru-t72b3', force: 2, x: 3000, y: 3000 });
    const blue = eng.createEntity({ typeId: 'us-m1a2', force: 1, x: 1000, y: 1000 });
    const player = { kind: 'player', force: 1 } as const;
    expect(() => checkCommand(eng, player, { cmd: 'sendCodeword', force: 2, codeword: 'X' })).toThrow(ForbiddenError);
    expect(() => checkCommand(eng, player, { cmd: 'sendCodeword', force: 1, codeword: 'X' })).not.toThrow();
    // A player's nested plan may not refer to enemies it has not seen.
    expect(() => checkCommand(eng, player, { cmd: 'assignPlan', targetId: blue.id, plan: { statements: [{ kind: 'if', condition: { type: 'entityDestroyed', entityId: red.id }, then: [] }] } })).toThrow(ForbiddenError);
    const runner = new SimRunner(eng, 0.1, 20, 0);
    expect(executeCommand(runner, { cmd: 'sendCodeword', force: 1, codeword: 'execute' }).ok).toBe(true);
    expect(eng.hasCodeword(1, 'EXECUTE')).toBe(true);
    expect(eng.hasCodeword(2, 'EXECUTE')).toBe(false);
  });
});
