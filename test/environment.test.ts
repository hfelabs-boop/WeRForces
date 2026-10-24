import { describe, expect, it } from 'vitest';
import { executeCommand } from '../src/server/commands.js';
import { SimRunner } from '../src/server/runner.js';
import { Engine } from '../src/sim/engine.js';
import { lightLevel, sunAltitude } from '../src/sim/environment.js';
import { Terrain } from '../src/sim/terrain.js';

const base = Terrain.generate({ size: 6000, seed: 9, towns: 2 });
const cols = 81;
const flat = new Terrain({ ...base.spec, size: 4000, cellSize: 50, seed: 4242, origin: { lat: 50.5, lon: 9.7 } }, new Float32Array(cols * cols).fill(20), new Uint8Array(cols * cols), [], []);

function engine(): Engine {
  const e = new Engine({ terrain: flat });
  e.newScenario('environment', flat.spec);
  return e;
}

/** Seconds of scanning until `observer` has `target` as a contact (or undefined). */
function timeToDetect(eng: Engine, observerId: string, targetId: string, limit = 30): number | undefined {
  const start = eng.time;
  for (let i = 0; i < limit; i++) {
    eng.runFor(1);
    if (eng.entities.get(observerId)!.contacts.has(targetId)) return eng.time - start;
  }
  return undefined;
}

/** A Red observer of the given type, facing a Blue target `range` metres north, both holding fire. */
function pair(eng: Engine, observerType: string, targetType: string, range: number) {
  const obs = eng.createEntity({ typeId: observerType, force: 2, x: 2000, y: 1000, heading: 0 });
  const tgt = eng.createEntity({ typeId: targetType, force: 1, x: 2000, y: 1000 + range, heading: Math.PI });
  obs.roe = 'holdFire';
  tgt.roe = 'holdFire';
  return { obs, tgt };
}

describe('sun and light', () => {
  it('follows the sun through the day', () => {
    // Midsummer at 50.5° N: the sun is about 63° up at noon and below the horizon at midnight.
    expect(sunAltitude(50.5, 172, 12)).toBeCloseTo(63, 0);
    expect(sunAltitude(50.5, 172, 0)).toBeLessThan(-12);
    expect(lightLevel(10)).toBe(1);
    expect(lightLevel(-3)).toBeGreaterThan(0.3);
    expect(lightLevel(-3)).toBeLessThan(1);
    expect(lightLevel(-20)).toBeLessThan(0.1);
  });

  it('keeps a clock that runs past midnight', () => {
    const eng = engine();
    eng.setEnvironment({ date: '2026-12-31', time: 23.5 });
    expect(eng.env.localTime).toBe('23:30');
    expect(eng.env.period).toBe('night');
    eng.runFor(3600);
    expect(eng.env.localTime).toBe('00:30');
    expect(eng.env.localDate).toBe('2027-01-01');
    // A winter morning gets light around 8.
    eng.setEnvironment({ date: '2026-12-21', time: 8.5 });
    expect(eng.env.period).not.toBe('night');
  });
});

describe('night', () => {
  it('blinds eyes and binoculars, not thermal sights', () => {
    const day = engine();
    const a = pair(day, 'ru-rifleman', 'us-m1a2', 1200);
    expect(timeToDetect(day, a.obs.id, a.tgt.id)).toBeDefined();

    const night = engine();
    night.setEnvironment({ time: 1 });
    expect(night.env.light).toBeLessThan(0.1);
    const b = pair(night, 'ru-rifleman', 'us-m1a2', 1200);
    expect(timeToDetect(night, b.obs.id, b.tgt.id)).toBeUndefined();
    // A tank's thermal sight still sees the rifleman's comrades at 1.5 km.
    const c = pair(night, 'ru-t72b3', 'us-rifleman', 1500);
    expect(timeToDetect(night, c.obs.id, c.tgt.id)).toBeDefined();
  });

  it('night-vision goggles keep part of their range', () => {
    const eng = engine();
    eng.setEnvironment({ time: 1 });
    // Blue rifleman with NVGs looking north at a Red rifleman 450 m away.
    const us = eng.createEntity({ typeId: 'us-rifleman', force: 1, x: 2000, y: 1000, heading: 0 });
    const ru = eng.createEntity({ typeId: 'ru-rifleman', force: 2, x: 2000, y: 1450, heading: Math.PI });
    us.roe = 'holdFire';
    ru.roe = 'holdFire';
    eng.runFor(30);
    expect(us.contacts.has(ru.id)).toBe(true);
    expect(ru.contacts.has(us.id)).toBe(false);
  });

  it('muzzle flashes give a shooter away', () => {
    const eng = engine();
    eng.setEnvironment({ time: 1 });
    const { obs, tgt } = pair(eng, 'ru-rifleman', 'us-m1a2', 1200);
    eng.runFor(10);
    expect(obs.contacts.has(tgt.id)).toBe(false);
    tgt.lastFiredAt = eng.time;
    eng.runFor(4);
    expect(obs.contacts.has(tgt.id)).toBe(true);
  });
});

describe('weather', () => {
  it('fog limits sight; thermals see a little further', () => {
    const eng = engine();
    eng.setEnvironment({ visibility: 300 });
    const a = pair(eng, 'ru-rifleman', 'us-m1a2', 600);
    expect(timeToDetect(eng, a.obs.id, a.tgt.id)).toBeUndefined();
    const b = pair(eng, 'ru-t72b3', 'us-m1a2', 700);
    b.obs.x = 500;
    b.tgt.x = 500;
    expect(timeToDetect(eng, b.obs.id, b.tgt.id)).toBeDefined();
  });

  it('rain slows vehicles off roads', () => {
    const dist = (precipitation: 'none' | 'heavyRain') => {
      const eng = engine();
      eng.setEnvironment({ precipitation });
      const t = eng.createEntity({ typeId: 'us-m1a2', force: 1, x: 2000, y: 500 });
      eng.assignTask(t.id, { type: 'moveTo', target: { x: 2000, y: 3500 } });
      eng.runFor(60);
      return t.y - 500;
    };
    const dry = dist('none');
    const wet = dist('heavyRain');
    // Off-road speed drops by a quarter; the tank was already below its top speed off road.
    expect(wet).toBeLessThan(dry * 0.9);
    expect(wet).toBeGreaterThan(dry * 0.7);
  });

  it('wind drifts smoke downwind', () => {
    const eng = engine();
    eng.setEnvironment({ windSpeed: 4, windFrom: 270 });
    const c = eng.smoke.add({ x: 2000, y: 2000 }, 50, 60);
    eng.runFor(10);
    expect(c.x).toBeCloseTo(2040, 0);
    expect(c.y).toBeCloseTo(2000, 0);
  });

  it('is saved with the scenario and validated by the command API', () => {
    const eng = engine();
    eng.setEnvironment({ time: 5.25, visibility: 800, precipitation: 'snow', windSpeed: 6, windFrom: 45 });
    eng.runFor(60);
    const copy = engine();
    copy.loadScenario(eng.toScenario());
    expect(copy.environment).toEqual(eng.environment);
    expect(copy.env.localTime).toBe('05:16');
    const runner = new SimRunner(eng);
    expect(executeCommand(runner, { cmd: 'setEnvironment', environment: { visibility: 10 } } as never).ok).toBe(false);
    expect(executeCommand(runner, { cmd: 'setEnvironment', environment: { precipitation: 'hail' } } as never).ok).toBe(false);
    expect(executeCommand(runner, { cmd: 'setEnvironment', environment: { time: 22 } }).ok).toBe(true);
    expect(eng.env.period).toBe('twilight');
  });
});
