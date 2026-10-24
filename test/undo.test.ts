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
