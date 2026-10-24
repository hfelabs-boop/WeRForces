import { describe, expect, it } from 'vitest';
import { executeCommand } from '../src/server/commands.js';
import { SimRunner } from '../src/server/runner.js';
import { Engine } from '../src/sim/engine.js';
import { Terrain } from '../src/sim/terrain.js';

const terrain = Terrain.generate({ size: 6000, seed: 5, towns: 2 });

describe('undo and redo', () => {
  it('takes back edits one at a time, and redoes them', () => {
    const engine = new Engine({ terrain });
    engine.newScenario('undo', terrain.spec);
    const runner = new SimRunner(engine);
    const run = (c: unknown) => executeCommand(runner, c);
    const town = terrain.towns[0];
    const a = run({ cmd: 'createEntity', typeId: 'us-m1a2', force: 1, x: town.x, y: town.y });
    run({ cmd: 'rename', id: a.id, name: 'Alpha' });
    run({ cmd: 'createGraphic', kind: 'area', points: [{ x: 100, y: 100 }, { x: 900, y: 100 }, { x: 900, y: 900 }], force: 1 });
    // Running and pausing are not edits.
    run({ cmd: 'pause' });
    expect(runner.state().history).toEqual({ undo: 3, redo: 0 });

    expect(run({ cmd: 'undo' }).ok).toBe(true);
    expect(engine.graphics.size).toBe(0);
    expect(run({ cmd: 'undo' }).ok).toBe(true);
    expect(engine.entities.get(a.id!)!.name).not.toBe('Alpha');
    expect(run({ cmd: 'redo' }).ok).toBe(true);
    expect(engine.entities.get(a.id!)!.name).toBe('Alpha');
    expect(runner.state().history).toEqual({ undo: 2, redo: 1 });
    // A new edit clears what could be redone.
    run({ cmd: 'moveEntity', id: a.id, x: town.x + 100, y: town.y });
    expect(run({ cmd: 'redo' }).error).toMatch(/nothing to redo/);
    // The event log survives undo.
    const log = engine.eventsSince(0).map((e) => e.text);
    expect(log).toContain('Undo');
    expect(log.some((t) => t.includes('created'))).toBe(true);
    // Undo everything.
    while (run({ cmd: 'undo' }).ok);
    expect(engine.entities.size).toBe(0);
  });

  it('undoes a task mid-run, back to the moment before it was given', () => {
    const engine = new Engine({ terrain });
    engine.newScenario('undo2', terrain.spec);
    const runner = new SimRunner(engine);
    const town = terrain.towns[0];
    const a = executeCommand(runner, { cmd: 'createEntity', typeId: 'us-m1a2', force: 1, x: town.x, y: town.y });
    runner.stepFor(10);
    executeCommand(runner, { cmd: 'assignTask', targetId: a.id, task: { type: 'moveTo', target: { x: town.x + 1000, y: town.y } } });
    runner.stepFor(30);
    const moved = engine.entities.get(a.id!)!.x;
    expect(moved).toBeGreaterThan(town.x + 100);
    executeCommand(runner, { cmd: 'undo' });
    expect(engine.time).toBeCloseTo(10, 6);
    expect(engine.entities.get(a.id!)!.task).toBeNull();
    executeCommand(runner, { cmd: 'redo' });
    expect(engine.time).toBeCloseTo(40, 6);
    expect(engine.entities.get(a.id!)!.x).toBeCloseTo(moved, 1); // checkpoints keep positions to 0.1 m
  });
});

describe('batched commands', () => {
  it('are one undo step, all or nothing, and checked one by one for players', async () => {
    const { checkCommand, ForbiddenError } = await import('../src/server/fog.js');
    const engine = new Engine({ terrain });
    engine.newScenario('batch', terrain.spec);
    const runner = new SimRunner(engine);
    const run = (c: unknown) => executeCommand(runner, c);
    const ids = [0, 1, 2].map((i) => run({ cmd: 'createEntity', typeId: 'us-m1a2', force: 1, x: 1000 + i * 100, y: 1000 }).id!);
    const red = run({ cmd: 'createEntity', typeId: 'ru-t72b3', force: 2, x: 4000, y: 4000 }).id!;
    const before = runner.state().history!.undo;
    const move = (id: string, x: number) => ({ cmd: 'assignTask', targetId: id, task: { type: 'moveTo', target: { x, y: 2000 } } });
    expect(run({ cmd: 'batch', commands: ids.map((id, i) => move(id, 1000 + i * 100)) }).ok).toBe(true);
    expect(runner.state().history!.undo).toBe(before + 1);
    expect(ids.every((id) => engine.entities.get(id)!.task?.spec.type === 'moveTo')).toBe(true);
    expect(run({ cmd: 'undo' }).ok).toBe(true);
    expect(ids.every((id) => !engine.entities.get(id)!.task)).toBe(true);
    // One bad command: none of them happen.
    const r = run({ cmd: 'batch', commands: [{ cmd: 'rename', id: ids[0], name: 'Alpha' }, move('E999', 0)] });
    expect(r.error).toMatch(/^commands\[1\]: unknown/);
    expect(engine.entities.get(ids[0])!.name).not.toBe('Alpha');
    expect(run({ cmd: 'batch', commands: [{ cmd: 'undo' }] }).error).toMatch(/cannot be batched/);
    // Deleting a unit and then one of its members is fine.
    const unit = run({ cmd: 'groupUnit', entityIds: ids }).id!;
    expect(run({ cmd: 'batch', commands: [{ cmd: 'deleteObject', id: unit }, { cmd: 'deleteObject', id: ids[0] }] }).ok).toBe(true);
    // A player may not slip an order for the enemy into a batch.
    const blue = { kind: 'player', force: 1 } as const;
    expect(() => checkCommand(engine, blue, { cmd: 'batch', commands: [{ cmd: 'stop', targetId: red }] })).toThrow(ForbiddenError);
  });
});
