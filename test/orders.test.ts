import { describe, expect, it } from 'vitest';
import { completeOrder, type OrderContext, OrderError, parseOrder } from '../src/shared/orders.js';
import type { Command, TaskSpec } from '../src/shared/types.js';

const ctx: OrderContext = {
  own: [
    { id: 'U1', name: 'Team ARMOR', force: 1, kind: 'unit', x: 1000, y: 1000, leaderId: 'E1', cruise: 10, maxSpeed: 18 },
    { id: 'U2', name: 'Team MECH', force: 1, kind: 'unit', x: 1400, y: 1000, leaderId: 'E5', cruise: 10, maxSpeed: 18 },
    { id: 'U3', name: 'Paladin Platoon', force: 1, kind: 'unit', x: 500, y: 500 },
    { id: 'E9', name: 'Fire Team 1', force: 1, kind: 'entity', x: 600, y: 600 },
  ],
  visible: [],
  graphics: [
    { id: 'G1', name: 'OBJ CALLOWAY', kind: 'area', points: [{ x: 5000, y: 5000 }, { x: 6000, y: 5000 }, { x: 6000, y: 6000 }, { x: 5000, y: 6000 }] },
    { id: 'G2', name: 'Route IRON', kind: 'route', points: [{ x: 1000, y: 1000 }, { x: 3000, y: 3000 }] },
    { id: 'G3', name: 'MF 1', kind: 'minefield', points: [{ x: 2000, y: 2000 }, { x: 2100, y: 2000 }, { x: 2100, y: 2100 }] },
  ],
  towns: [
    { name: 'Calloway', x: 5500, y: 5600 },
    { name: 'Brenham', x: 3000, y: 2000 },
  ],
  size: 10000,
};
ctx.visible = [...ctx.own, { id: 'E31', name: 'T-72B3 (E31)', force: 2, kind: 'entity', x: 5500, y: 5500 }, { id: 'U8', name: 'Tank Plt 1', force: 2, kind: 'unit', x: 5600, y: 5600, leaderId: 'E40' }];

const tasks = (cs: Command[]) => cs.map((c) => (c as { task?: TaskSpec }).task);

describe('typed orders', () => {
  it('moves to a town by a covered route', () => {
    const o = parseOrder('Team ARMOR move to Calloway covered', ctx);
    expect(o.description).toBe('Team ARMOR: move to Calloway by a covered route');
    expect(o.commands).toEqual([{ cmd: 'assignTask', targetId: 'U1', task: { type: 'moveTo', target: { x: 5500, y: 5600 }, covered: true } }]);
  });

  it('is forgiving: case, partial names, "go to", trailing full stop', () => {
    expect(parseOrder('team arm go to brenham.', ctx).commands[0]).toMatchObject({ targetId: 'U1', task: { type: 'moveTo', target: { x: 3000, y: 2000 } } });
  });

  it('places relative to a town, and faces a direction', () => {
    const o = parseOrder('Team MECH defend 2 km north of Brenham facing north', ctx);
    expect(tasks(o.commands)[0]).toEqual({ type: 'defend', position: { x: 3000, y: 4000 }, facing: 0 });
    expect(o.description).toMatch(/2 km north of Brenham/);
  });

  it('orders several at once, keeping them apart', () => {
    const o = parseOrder('Team ARMOR and Team MECH move to 5000 5000', ctx);
    expect(o.targets.map((t) => t.id)).toEqual(['U1', 'U2']);
    expect(tasks(o.commands).map((t) => (t as { target: { x: number } }).target.x)).toEqual([4800, 5200]);
    const d = parseOrder('Team ARMOR, Team MECH defend OBJ CALLOWAY facing east', ctx);
    const pos = tasks(d.commands).map((t) => (t as { position: { x: number; y: number } }).position);
    expect(pos[0].y).not.toBe(pos[1].y); // side by side across an eastward facing
  });

  it('does fire missions, smoke, attacks on units, ROE, routes, breaching and speeds', () => {
    expect(tasks(parseOrder('Paladin Platoon fire 4 rounds on OBJ CALLOWAY', ctx).commands)[0]).toEqual({ type: 'fireMission', target: { x: 5500, y: 5500 }, rounds: 4, radius: 50 });
    expect(tasks(parseOrder('Paladin Platoon smoke Brenham', ctx).commands)[0]).toMatchObject({ smoke: true, rounds: 2 });
    expect(tasks(parseOrder('Team ARMOR attack Tank Plt 1', ctx).commands)[0]).toEqual({ type: 'attack', targetId: 'E40' });
    expect(parseOrder('Team MECH hold fire', ctx).commands[0]).toEqual({ cmd: 'setRoe', targetId: 'U2', roe: 'holdFire' });
    expect(parseOrder('Team MECH fire at will', ctx).commands[0]).toMatchObject({ roe: 'fireAtWill' });
    expect(tasks(parseOrder('Team ARMOR follow route Route IRON in reverse', ctx).commands)[0]).toEqual({ type: 'followRoute', routeId: 'G2', reverse: true });
    expect(tasks(parseOrder('Team ARMOR breach MF 1', ctx).commands)[0]).toEqual({ type: 'breach', graphicId: 'G3' });
    expect(tasks(parseOrder('Team ARMOR move to Brenham fast', ctx).commands)[0]).toMatchObject({ speed: 18 });
    expect(tasks(parseOrder('Team ARMOR move to Brenham at 36 km/h', ctx).commands)[0]).toMatchObject({ speed: 10 });
    expect(tasks(parseOrder('Team ARMOR wait 2 min', ctx).commands)[0]).toEqual({ type: 'wait', duration: 120 });
  });

  it('handles names that contain a verb', () => {
    expect(parseOrder('Fire Team 1 move to Brenham', ctx).targets[0].id).toBe('E9');
  });

  it('explains what it does not understand', () => {
    const err = (t: string) => {
      try {
        parseOrder(t, ctx);
      } catch (e) {
        expect(e).toBeInstanceOf(OrderError);
        return (e as Error).message;
      }
      throw new Error('no error');
    };
    expect(err('Bravo move to Calloway')).toMatch(/^Who\?/);
    expect(err('Team ARMOR dance')).toMatch(/do what/);
    expect(err('Team ARMOR move to Atlantis')).toMatch(/where\?/);
    expect(err('Team ARMOR move to Brenham now please')).toMatch(/Did not understand "now please"/);
    expect(err('Team ARMOR move to 20000 5')).toMatch(/off the map/);
    // Players cannot order the other side: it is not in their "own" list.
    expect(err('Tank Plt 1 move to Brenham')).toMatch(/^Who\?/);
  });

  it('completes names, verbs and places', () => {
    expect(completeOrder('team a', ctx).map((c) => c.text)).toEqual(['Team ARMOR ']);
    expect(completeOrder('Team ARMOR mo', ctx).map((c) => c.label)).toContain('move to');
    expect(completeOrder('Team ARMOR move to Cal', ctx).map((c) => c.text)).toContain('Team ARMOR move to Calloway ');
    expect(completeOrder('Team ARMOR attack ', ctx).map((c) => c.label)).toContain('T-72B3 (E31)');
  });
});
