// Automatic call for fire: observers with the callForFire reaction request fire
// missions on hostiles they can see from the nearest idle friendly artillery in range.

import { dist2d } from '../shared/math.js';
import type { TaskSpec, Vec2 } from '../shared/types.js';
import type { Engine } from './engine.js';
import type { Entity } from './entity.js';
import { DEFAULT_MISSION_ROUNDS, FireMissionTask, FormationTask, indirectWeaponFor } from './tasks.js';
import type { Unit } from './units.js';

/** Seconds an observer waits after a call before calling again. */
export const CALL_FOR_FIRE_INTERVAL = 60;
/** No missions on targets this close to friendly troops. */
export const DANGER_CLOSE = 150;
/** Targets within this distance of an active mission or round in flight are already covered. */
const MISSION_COVERAGE = 150;
/** Sheaf radius when a whole battery fires. */
const BATTERY_SHEAF = 50;

/** Can this entity take a fire mission right now (ignoring range)? */
function ready(e: Entity): boolean {
  if (!e.alive || e.remote || e.embarkedIn || e.firepowerKill || e.roe === 'holdFire') return false;
  if (e.plan && !e.plan.finished) return false;
  const t = e.task;
  return !t || t.status !== 'running' || t instanceof FormationTask;
}

function unitReady(u: Unit): boolean {
  if (u.plan && !u.plan.finished) return false;
  if (u.taskStatus() === 'running') return false;
  return !!u.leader && !(u.leader.task && u.leader.task.status === 'running' && !(u.leader.task instanceof FormationTask));
}

/** True when a mission is already firing at, or rounds are falling on, this point. */
function covered(engine: Engine, p: Vec2): boolean {
  for (const s of engine.shotsInFlight) if (s.weapon.indirect && dist2d(s.to, p) < MISSION_COVERAGE) return true;
  for (const e of engine.entities.values()) {
    if (e.task instanceof FireMissionTask && e.task.status === 'running' && dist2d(e.task.mission.target, p) < MISSION_COVERAGE) return true;
  }
  return false;
}

function dangerClose(engine: Engine, force: number, p: Vec2): boolean {
  for (const e of engine.entities.values()) {
    if (e.force === force && e.alive && !e.embarkedIn && e.domain !== 'air' && dist2d(e, p) < DANGER_CLOSE) return true;
  }
  return false;
}

interface FireUnit {
  id: string;
  name: string;
  /** Distance from the firing unit to the target. */
  range: number;
  tubes: number;
}

/** Idle friendly firing units (whole units or standalone entities) that can reach a point. */
export function availableFireUnits(engine: Engine, force: number, p: Vec2): FireUnit[] {
  const out: FireUnit[] = [];
  for (const u of engine.units.values()) {
    if (u.force !== force || !unitReady(u)) continue;
    const tubes = u.alive().filter((m) => ready(m) && indirectWeaponFor(engine, m, p));
    if (tubes.length) out.push({ id: u.id, name: u.name, range: dist2d(tubes[0], p), tubes: tubes.length });
  }
  for (const e of engine.entities.values()) {
    if (e.force !== force || e.unit || !ready(e) || !indirectWeaponFor(engine, e, p)) continue;
    out.push({ id: e.id, name: e.name, range: dist2d(e, p), tubes: 1 });
  }
  return out.sort((a, b) => a.range - b.range);
}

/** Run once per second: observers call for fire on hostiles they currently see. */
export function checkCallsForFire(engine: Engine): void {
  for (const obs of engine.entities.values()) {
    if (!obs.reactions.callForFire || !obs.alive || obs.remote || obs.embarkedIn) continue;
    if (engine.time < obs.callForFireAt) continue;
    for (const c of obs.contacts.values()) {
      if (engine.time - c.lastSeen > 2) continue;
      const t = engine.entities.get(c.id);
      if (!t || !t.alive || t.domain === 'air' || !engine.isHostile(obs.force, t.force)) continue;
      const p = { x: c.x, y: c.y };
      if (covered(engine, p) || dangerClose(engine, obs.force, p)) continue;
      const fu = availableFireUnits(engine, obs.force, p)[0];
      if (!fu) continue;
      const spec: TaskSpec = { type: 'fireMission', target: { x: Math.round(p.x), y: Math.round(p.y) }, rounds: DEFAULT_MISSION_ROUNDS, radius: fu.tubes > 1 ? BATTERY_SHEAF : 0 };
      engine.log('task', `${obs.name} called for fire on ${t.name}: ${fu.name} firing ${DEFAULT_MISSION_ROUNDS} round${DEFAULT_MISSION_ROUNDS > 1 ? 's' : ''}${fu.tubes > 1 ? ` x ${fu.tubes} tubes` : ''}`, obs.id, t.id);
      engine.assignTask(fu.id, spec);
      obs.callForFireAt = engine.time + CALL_FOR_FIRE_INTERVAL;
      break;
    }
  }
}
