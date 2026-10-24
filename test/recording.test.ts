import { describe, expect, it } from 'vitest';
import { Engine } from '../src/sim/engine.js';
import { Recorder } from '../src/sim/recorder.js';
import { Terrain } from '../src/sim/terrain.js';
import { aarReport, frameIndexAt, stateAt } from '../src/shared/recording.js';

const base = Terrain.generate({ size: 6000, seed: 9, towns: 2 });
const cols = 81;
const flat = new Terrain({ ...base.spec, size: 4000, cellSize: 50, seed: 4242 }, new Float32Array(cols * cols).fill(20), new Uint8Array(cols * cols), [], []);

function setup() {
  const eng = new Engine({ terrain: flat, seed: 2 });
  eng.newScenario('recorded', flat.spec);
  const rec = new Recorder(eng);
  const tanks = eng.createUnitFromTemplate('us-tank-platoon', 1, 600, 2000, Math.PI / 2);
  const enemy = eng.createUnitFromTemplate('ru-mech-platoon', 2, 3200, 2000, -Math.PI / 2);
  eng.assignTask(tanks.id, { type: 'moveTo', target: { x: 2000, y: 2000 } });
  return { eng, rec, tanks, enemy };
}

describe('recording', () => {
  it('samples frames at the interval and interpolates between them', () => {
    const { eng, rec, tanks } = setup();
    eng.runFor(30);
    const json = rec.toJSON();
    expect(json.frames.length).toBeGreaterThanOrEqual(30);
    expect(json.frames[frameIndexAt(json.frames, 10.5)].t).toBe(10);
    const lead = tanks.memberList[0];
    const s = stateAt(json, json.end);
    const e = s.entities.find((x) => x.id === lead.id)!;
    expect(Math.abs(e.x - lead.x)).toBeLessThan(0.2);
    // Half-way between two frames is half-way between the positions.
    const a = stateAt(json, 20).entities.find((x) => x.id === lead.id)!;
    const b = stateAt(json, 21).entities.find((x) => x.id === lead.id)!;
    const m = stateAt(json, 20.5).entities.find((x) => x.id === lead.id)!;
    expect(m.x).toBeCloseTo((a.x + b.x) / 2, 3);
    expect(s.units.find((u) => u.id === tanks.id)?.memberIds).toHaveLength(4);
  });

  it('builds an after-action report of losses, kills and fires', () => {
    const { eng, rec } = setup();
    eng.runFor(240);
    rec.addBookmark('first engagement over');
    const r = rec.report();
    const blue = r.forces.find((f) => f.force === 1)!;
    const red = r.forces.find((f) => f.force === 2)!;
    expect(blue.start).toBe(4);
    expect(red.start).toBe(3);
    expect(blue.losses + red.losses).toBeGreaterThan(0);
    expect(r.kills.length).toBe(blue.losses + red.losses);
    expect(r.kills.every((k) => k.killer && k.weaponId)).toBe(true);
    expect(Object.values(r.shotsByWeapon).reduce((a, b) => a + b, 0)).toBe(blue.shots + red.shots);
    expect(r.strength[0].alive[1]).toBe(4);
    expect(r.bookmarks[0].text).toBe('first engagement over');
    // The JSON form gives the same report.
    expect(aarReport(rec.toJSON()).kills).toEqual(r.kills);
  });

  it('rewind cuts the recording back; a new scenario starts afresh', () => {
    const { eng, rec } = setup();
    eng.runFor(20);
    eng.markRewindPoint();
    eng.runFor(40);
    expect(rec.summary().end).toBe(60);
    eng.rewind();
    expect(rec.summary().end).toBe(20);
    expect(rec.toJSON().events.every((e) => e.time <= 20)).toBe(true);
    eng.newScenario('other', flat.spec);
    expect(rec.summary().frames).toBe(1);
    expect(rec.summary().entities).toBe(0);
  });

  it('reviews a saved recording without live sampling, then goes back to live', () => {
    const { eng, rec } = setup();
    eng.runFor(10);
    const saved = JSON.parse(JSON.stringify(rec.toJSON()));
    eng.runFor(10);
    rec.load(saved);
    expect(rec.summary().end).toBe(10);
    expect(rec.summary().live).toBe(false);
    eng.runFor(10);
    expect(rec.summary().end).toBe(10);
    rec.clear();
    expect(rec.summary().live).toBe(true);
    expect(() => rec.load({} as never)).toThrow(/not a WeRForces recording/);
  });

  it('stays within its memory budget by halving the frame rate', () => {
    const eng = new Engine({ terrain: flat, seed: 2 });
    eng.newScenario('budget', flat.spec);
    const rec = new Recorder(eng, { maxBytes: 20_000 });
    eng.createUnitFromTemplate('us-rifle-squad', 1, 600, 2000);
    eng.runFor(120);
    const s = rec.summary();
    expect(s.bytes!).toBeLessThanOrEqual(20_000);
    expect(s.interval).toBeGreaterThan(1);
    expect(s.end).toBe(120);
  });
});
