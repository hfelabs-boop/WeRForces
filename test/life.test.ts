import { describe, expect, it } from 'vitest';
import { Engine } from '../src/sim/engine.js';

describe('pattern of life', () => {
  it('keeps civilians moving between towns, and makes them run from fighting', () => {
    const eng = new Engine();
    eng.newScenario('life');
    eng.life.set({ vehicles: 12, pedestrians: 20 });
    eng.runFor(2);
    const civ = () => [...eng.entities.values()].filter((e) => e.ambient);
    expect(civ().filter((e) => e.type.id === 'civ-car')).toHaveLength(12);
    expect(civ().filter((e) => e.type.id === 'civ-person')).toHaveLength(20);
    expect(civ().every((e) => e.force === 3)).toBe(true);
    // No "created" events for background traffic.
    expect(eng.eventsSince(0).some((e) => e.kind === 'created')).toBe(false);
    const start = new Map(civ().map((e) => [e.id, { x: e.x, y: e.y }]));
    eng.runFor(240);
    const moved = civ().filter((e) => Math.hypot(e.x - start.get(e.id)!.x, e.y - start.get(e.id)!.y) > 50);
    expect(moved.length).toBeGreaterThan(20);
    // A blast near a car: it drives off at speed.
    const car = civ().find((e) => e.type.id === 'civ-car')!;
    eng.log('detonation', 'shell', undefined, undefined, { to: { x: car.x + 100, y: car.y, z: car.z } });
    eng.runFor(2);
    expect(car.task?.spec).toMatchObject({ type: 'moveTo', speed: car.type.maxSpeed });
    const away = car.task!.spec as { target: { x: number } };
    expect(away.target.x).toBeLessThan(car.x);
    // Fewer: removed quietly. None: all gone.
    eng.life.set({ vehicles: 3, pedestrians: 0 });
    eng.runFor(1);
    expect(civ()).toHaveLength(3);
    eng.life.set({ vehicles: 0, pedestrians: 0 });
    eng.runFor(1);
    expect(civ()).toHaveLength(0);
    expect(eng.eventsSince(0).some((e) => e.kind === 'deleted')).toBe(false);
  });

  it('is saved as settings at time 0 and as civilians in checkpoints', () => {
    const eng = new Engine();
    eng.newScenario('life');
    eng.life.set({ vehicles: 5 });
    const authored = eng.toScenario();
    expect(authored.patternOfLife).toEqual({ vehicles: 5, pedestrians: 0 });
    eng.runFor(30);
    expect(authored.entities).toHaveLength(0);
    const ck = eng.toScenario();
    expect(ck.entities.filter((e) => e.state?.ambient)).toHaveLength(5);
    const b = new Engine();
    b.loadScenario(ck);
    b.runFor(5);
    expect([...b.entities.values()].filter((e) => e.ambient)).toHaveLength(5);
    expect(new Set([...b.entities.values()].map((e) => e.name)).size).toBe(5);
    const c = new Engine();
    c.loadScenario(authored);
    c.runFor(1);
    expect([...c.entities.values()].filter((e) => e.ambient)).toHaveLength(5);
  });
});
