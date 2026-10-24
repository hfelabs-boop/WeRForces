// Explanations for the operator: why an entity or unit is or is not moving, shooting and
// seeing. Everything here reads the engine without changing it, so asking costs nothing
// to the run (the random generator is never touched).

import { angleDiff, bearing, dist2d } from '../shared/math.js';
import type { Explanation, Finding, Vec2, WeaponDef } from '../shared/types.js';
import type { Engine } from './engine.js';
import type { Entity } from './entity.js';
import { groundFactor, sensorRange } from './environment.js';
import { AmbushTask, FormationTask, WaitTask } from './tasks.js';
import type { Unit } from './units.js';

export interface ExplainOptions {
  /**
   * Exercise control sees everything, so it is also told about enemies the entity has
   * not detected (and why not). Players only hear about what their side knows.
   */
  omniscient: boolean;
}

const km = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`);
const pct = (f: number) => `${Math.round(f * 100)}%`;
const where = (p: Vec2) => `(${Math.round(p.x)}, ${Math.round(p.y)})`;
const SEVERITY = { block: 0, warn: 1, info: 2 } as const;

function blockerText(cause: 'terrain' | 'forest' | 'buildings' | 'smoke'): string {
  return cause === 'terrain' ? 'the ground (a crest or ridge)' : cause === 'forest' ? 'forest' : cause === 'buildings' ? 'buildings' : 'smoke';
}

/** What blocks the sight line between two entities, or null when they can see each other. */
export function sightBlocker(engine: Engine, from: Entity, to: Entity, radar = false): { cause: 'terrain' | 'forest' | 'buildings' | 'smoke'; x: number; y: number } | null {
  const aim = { x: to.x, y: to.y, z: to.z + Math.min(2, to.type.sensorHeight || 2) };
  const b = engine.terrain.sightBlocker(from.eye, aim);
  if (b) return b;
  if (!radar && engine.smoke.blocks(from.eye, aim)) {
    const mid = { x: Math.round((from.x + to.x) / 2), y: Math.round((from.y + to.y) / 2) };
    return { cause: 'smoke', ...mid };
  }
  return null;
}

function movement(engine: Engine, e: Entity): Finding[] {
  const out: Finding[] = [];
  const add = (f: Finding) => out.push(f);
  if (e.destroyed) return [{ code: 'destroyed', severity: 'block', text: 'Destroyed.' }];
  if (e.remote) return [{ code: 'remote', severity: 'info', text: 'Owned by another simulation (DIS): it moves as that simulation says.' }];
  if (e.embarkedIn) {
    const c = engine.entities.get(e.embarkedIn);
    return [{ code: 'embarked', severity: 'info', text: `Riding in ${c?.name ?? e.embarkedIn}: it moves with its carrier.`, fix: 'Order the carrier, or dismount.', aboutId: e.embarkedIn }];
  }
  if (e.mobilityKill) add({ code: 'mobilityKill', severity: 'block', text: 'Immobilised (mobility kill): it cannot move again.' });
  const order = engine.pendingOrders.find((o) => o.targetId === e.id || o.targetId === e.unit?.id);
  if (order) add({ code: 'orderPending', severity: 'info', text: `A new order is on its way down the chain of command: it arrives in ${Math.max(0, Math.ceil(order.due - engine.time))} s.` });
  if (engine.ew.radioJammed(e)) add({ code: 'radioJammed', severity: 'warn', text: 'Radio jammed: orders reach it a minute late, and it cannot share contacts with its unit, call for fire or hear codewords.', fix: "Move it out of the jammer's reach, or destroy the jammer." });
  if (engine.rules.fuel && e.type.endurance && e.domain !== 'air') {
    if (e.fuel <= 0) add({ code: 'outOfFuel', severity: 'block', text: 'Out of fuel.', fix: 'Send it to a supply vehicle (Resupply), or turn the fuel model off in Simulation settings.' });
    else if (e.fuel < 0.2) add({ code: 'lowFuel', severity: 'warn', text: `Fuel low: ${pct(e.fuel)} left.`, fix: 'Resupply it soon.' });
  }
  if (e.pinned) add({ code: 'pinned', severity: 'block', text: `Pinned down by incoming fire (suppression ${pct(e.suppression)}): it moves again when the fire slackens.`, fix: 'Suppress or kill whoever is firing at it, or smoke them.' });
  if (e.halted) add({ code: 'halted', severity: 'block', text: 'Halted on contact: its reaction stops it while an enemy is within weapon range, and it carries on when the contact is gone.', fix: 'Set Reactions → On contact to "continue" to keep it moving.' });
  const unitMorale = e.unit ? e.unit.moraleState : e.moraleState;
  if (engine.rules.morale && unitMorale === 'broken') add({ code: 'broken', severity: 'block', text: `${e.unit ? 'Its unit has' : 'It has'} broken and is falling back; it obeys no orders until it rallies.`, fix: 'Get it out of the enemy\'s fire; it rallies after about 20 s without being shot at.' });
  if (e.withdrawn) add({ code: 'withdrawn', severity: 'info', text: 'It withdrew (its withdraw reaction fired) and dropped its plan.' });
  const task = e.task;
  const plan = e.plan && !e.plan.finished ? e.plan : e.unit?.plan && !e.unit.plan.finished ? e.unit.plan : null;
  if (!task || task.status !== 'running') {
    if (plan) {
      const step = plan.describe(engine);
      if (/wait until/i.test(step)) add({ code: 'planWaiting', severity: 'info', text: `Its plan is waiting: ${step}.` });
    } else {
      const last = task && task.status === 'failed' ? `Its last task failed${task.message ? `: ${task.message}` : ''}. ` : task && task.status === 'done' ? 'Its last task is done. ' : '';
      if (e.unit && e.unit.leader !== e) add({ code: 'idle', severity: 'info', text: `${last}It stays with its unit, ${e.unit.name}.` });
      else add({ code: 'idle', severity: 'warn', text: `${last}No task: it waits where it is.`, fix: 'Right-click the map to give it a task.' });
    }
  } else if (task instanceof WaitTask) {
    add({ code: 'waiting', severity: 'info', text: `${task.describe()}: it moves when the wait is over.` });
  } else if (task instanceof FormationTask) {
    const leader = engine.entities.get(task.leaderId);
    add({ code: 'formation', severity: 'info', text: `Keeping its place in formation on ${leader?.name ?? task.leaderId}: it moves when the leader does.`, aboutId: task.leaderId });
  } else if (['defend', 'overwatch', 'ambush', 'screen'].includes(task.spec.type) && task.remainingPath.length === 0) {
    add({ code: 'holding', severity: 'info', text: `${task.describe(engine)}: it holds this position${e.prepared ? (e.prepared === 'dugIn' ? ', dug in' : ', hull-down') : ''}.` });
  }
  if (e.blocked && e.steer && e.steer.speed > 0) add({ code: 'blocked', severity: 'warn', text: 'Stuck: the ground ahead is impassable for it (water, a cliff, an obstacle or buildings). It replans after 3 s.', fix: 'Give it a destination it can reach, or breach the obstacle.' });
  if (e.speed > 0.3 || (e.steer && e.steer.speed > 0)) {
    const slower: string[] = [];
    if (engine.rules.suppression && e.suppression > 0.3) slower.push(`suppression (${pct(e.suppression)})`);
    if (e.domain !== 'air' && e.domain !== 'surface' && groundFactor(engine.env) < 1) slower.push(`${engine.env.precipitation === 'snow' ? 'snow' : 'rain'} off-road`);
    if (e.domain !== 'air' && engine.terrain.isForest(e.x, e.y) && !engine.terrain.isRoad(e.x, e.y)) slower.push('forest');
    if (e.speedOverride !== undefined) slower.push(`a speed limit of ${Math.round(e.speedOverride * 3.6)} km/h from its plan`);
    if (slower.length) add({ code: 'slowed', severity: 'info', text: `Slowed by ${slower.join(', ')}.` });
  }
  return out;
}

function weaponsVerdict(engine: Engine, e: Entity, t: Entity): { ok: boolean; finding?: Finding; weapon?: WeaponDef } {
  const range = Math.hypot(t.x - e.x, t.y - e.y, t.z - e.z);
  const direct = e.type.weapons.map((id) => engine.catalog.weapon(id)).filter((w) => !w.indirect);
  const name = t.name;
  const able = direct.filter((w) => w.targets.includes(t.domain));
  if (!able.length) return { ok: false, finding: { code: 'cannotEngageDomain', severity: 'block', text: `None of its weapons can engage ${t.domain === 'air' ? 'aircraft' : t.domain === 'lifeform' ? 'infantry' : t.domain === 'surface' ? 'boats' : 'vehicles'} like ${name}.`, aboutId: t.id } };
  const loaded = able.filter((w) => (e.ammo.get(w.id) ?? 0) > 0);
  if (!loaded.length) return { ok: false, finding: { code: 'noAmmoFor', severity: 'block', text: `Out of ammunition for the weapons that could hit ${name}.`, fix: 'Resupply it.', aboutId: t.id } };
  const effective = loaded.filter((w) => (w.pk[t.type.armor] ?? 0) >= 0.02);
  if (!effective.length) return { ok: false, finding: { code: 'ineffective', severity: 'block', text: `Its weapons cannot hurt ${name} (${t.type.armor} armour).`, aboutId: t.id } };
  const inRange = effective.filter((w) => range >= w.minRange && range <= w.maxRange);
  if (!inRange.length) {
    const reach = Math.max(...effective.map((w) => w.maxRange));
    const min = Math.min(...effective.map((w) => w.minRange));
    const text = range > reach ? `${name} is ${km(range)} away, beyond its weapons' reach (${km(reach)}).` : `${name} is too close (${km(range)}) for its weapons (at least ${km(min)}).`;
    return { ok: false, finding: { code: range > reach ? 'outOfRange' : 'tooClose', severity: 'block', text, fix: range > reach ? 'Move closer, or attack it (Attack moves into range).' : undefined, aboutId: t.id } };
  }
  const w = inRange[0];
  const b = sightBlocker(engine, e, t);
  if (b) return { ok: false, weapon: w, finding: { code: 'noLineOfSight', severity: 'block', text: `No line of sight to ${name}: blocked by ${blockerText(b.cause)} at ${where(b)}.`, fix: 'Move to higher or open ground, or wait for the smoke to clear.', at: { x: b.x, y: b.y }, aboutId: t.id } };
  const ready = inRange.find((x) => (e.weaponReadyAt.get(x.id) ?? 0) <= engine.time);
  if (!ready) {
    const next = Math.min(...inRange.map((x) => e.weaponReadyAt.get(x.id) ?? 0));
    return { ok: true, weapon: w, finding: { code: 'reloading', severity: 'info', text: `Reloading: ready to fire at ${name} in ${Math.max(1, Math.ceil(next - engine.time))} s.`, aboutId: t.id } };
  }
  return { ok: true, weapon: ready };
}

function fire(engine: Engine, e: Entity, opts: ExplainOptions): Finding[] {
  const out: Finding[] = [];
  const add = (f: Finding) => out.push(f);
  if (e.destroyed) return [{ code: 'destroyed', severity: 'block', text: 'Destroyed.' }];
  if (e.remote) return [];
  if (e.embarkedIn) return [{ code: 'embarked', severity: 'block', text: 'Passengers do not fire while mounted.', fix: 'Dismount them.' }];
  const direct = e.type.weapons.map((id) => engine.catalog.weapon(id)).filter((w) => !w.indirect);
  const indirect = e.type.weapons.map((id) => engine.catalog.weapon(id)).filter((w) => w.indirect);
  if (!direct.length) {
    if (indirect.length) return [{ code: 'indirectOnly', severity: 'info', text: `It only has indirect fire (${indirect.map((w) => w.name).join(', ')}): it shoots on fire missions, not at what it sees.`, fix: 'Give it a Fire mission, or an observer that calls for fire.' }];
    return [{ code: 'unarmed', severity: 'info', text: 'Unarmed.' }];
  }
  if (e.firepowerKill) return [{ code: 'firepowerKill', severity: 'block', text: 'Its weapons are knocked out (firepower kill).' }];
  const empty = direct.filter((w) => (e.ammo.get(w.id) ?? 0) <= 0);
  if (empty.length === direct.length) add({ code: 'noAmmo', severity: 'block', text: 'Out of ammunition.', fix: 'Send it to a supply vehicle (Resupply).' });
  else if (empty.length) add({ code: 'someAmmoOut', severity: 'warn', text: `Out of ammunition for ${empty.map((w) => w.name).join(', ')}.` });
  if (e.roe === 'holdFire') {
    if (e.task instanceof AmbushTask && !e.task.sprung) add({ code: 'ambushHolding', severity: 'info', text: 'Holding fire for the ambush: it opens fire when an enemy enters the kill zone, or it is shot at.' });
    else add({ code: 'holdFire', severity: 'block', text: 'Rules of engagement: hold fire. It only shoots at targets it is explicitly ordered to attack.', fix: 'Set ROE to "fire at will".' });
  } else if (e.roe === 'returnFire') {
    add({ code: 'returnFire', severity: 'warn', text: 'Rules of engagement: return fire. It only shoots at enemies that fired at it in the last minute.', fix: 'Set ROE to "fire at will".' });
  }
  if (engine.rules.suppression && e.suppression > 0.3) add({ code: 'suppressed', severity: 'warn', text: `Suppressed (${pct(e.suppression)}): it shoots less accurately and reloads more slowly.` });
  const engaging = e.engagingId ? engine.entities.get(e.engagingId) : undefined;
  if (engaging && engaging.alive) add({ code: 'engaging', severity: 'info', text: `Engaging ${engaging.name} at ${km(dist2d(e, engaging))}.`, aboutId: engaging.id });
  const explicit = e.attackTargetId ? engine.entities.get(e.attackTargetId) : undefined;
  const hostiles = [...e.contacts.keys()]
    .map((id) => engine.entities.get(id))
    .filter((t): t is Entity => !!t && t.alive && !t.embarkedIn && engine.isHostile(e.force, t.force))
    .sort((a, b) => dist2d(e, a) - dist2d(e, b));
  if (explicit && explicit.alive && !hostiles.includes(explicit)) hostiles.unshift(explicit);
  if (!hostiles.length) {
    add({ code: 'noContacts', severity: 'info', text: 'No enemy detected: it can only shoot at what its side has seen.' });
    return out;
  }
  if (!engaging) {
    // Say why it is not shooting at the nearest few contacts.
    for (const t of hostiles.slice(0, 3)) {
      if (e.roe === 'returnFire' && t !== explicit) {
        const last = e.attackers.get(t.id);
        if (last === undefined || engine.time - last > 60) {
          add({ code: 'notFiredUpon', severity: 'info', text: `${t.name} has not fired at it, so return-fire ROE keeps it quiet.`, aboutId: t.id });
          continue;
        }
      }
      const v = weaponsVerdict(engine, e, t);
      if (v.finding) add(v.finding);
      else if (v.ok && e.roe !== 'holdFire') add({ code: 'aboutToFire', severity: 'info', text: `${t.name} is in range and in sight: it fires on the next chance.`, aboutId: t.id });
    }
  }
  return out;
}

function sensing(engine: Engine, e: Entity, opts: ExplainOptions): Finding[] {
  const out: Finding[] = [];
  if (e.destroyed || e.remote) return out;
  if (e.embarkedIn) return [{ code: 'embarked', severity: 'info', text: 'Passengers do not look out; the carrier\'s crew does.' }];
  const sensors = e.type.sensors.map((id) => engine.catalog.sensors.get(id)!).filter(Boolean);
  if (!sensors.length) return [{ code: 'noSensors', severity: 'warn', text: 'It has no sensors: it only knows what its unit reports.' }];
  const env = engine.env;
  const ranges = sensors.map((s) => ({ s, range: sensorRange(s, env) }));
  const list = ranges.map(({ s, range }) => `${s.name} ${km(range)}${range < s.maxRange * 0.95 ? ` (of ${km(s.maxRange)})` : ''}`).join(', ');
  const reduced = ranges.some(({ s, range }) => range < s.maxRange * 0.95);
  const why = env.period !== 'day' ? `${env.period === 'night' ? 'night' : 'twilight'}${env.visibility < 20000 ? ` and ${km(env.visibility)} visibility` : ''}` : env.visibility < 20000 ? `${km(env.visibility)} visibility` : env.precipitation !== 'none' ? env.precipitation : '';
  out.push({ code: 'sensors', severity: reduced ? 'warn' : 'info', text: `Sees with: ${list}${reduced && why ? `, cut down by ${why}` : ''}.`, fix: reduced && !sensors.some((s) => s.thermal) ? 'Thermal sights see in the dark: use a vehicle that has them.' : undefined });
  const radarJam = engine.ew.radarFactor(e);
  if (radarJam < 1 && sensors.some((s) => s.radar)) out.push({ code: 'radarJammed', severity: 'warn', text: `Radar jammed: it sees ${pct(radarJam)} of its normal range (more as it closes on the jammer).` });
  if (opts.omniscient) {
    const by = engine.ew.radioJammedBy(e.unit?.leader ?? e) ?? engine.ew.radioJammedBy(e);
    const j = by ? engine.entities.get(by) : undefined;
    if (j) out.push({ code: 'jammer', severity: 'info', text: `Jammed by ${j.name}, ${km(dist2d(e, j))} away (reach ${km(j.type.jammer!.range)}).`, aboutId: j.id, at: { x: Math.round(j.x), y: Math.round(j.y) } });
  }
  if (engine.rules.suppression && e.suppression > 0.3) out.push({ code: 'suppressedSpotting', severity: 'warn', text: `Suppressed: it spots ${pct(0.5 * e.suppression)} less often.` });
  const known = [...e.contacts.keys()].filter((id) => {
    const t = engine.entities.get(id);
    return t && t.alive && engine.isHostile(e.force, t.force);
  }).length;
  out.push({ code: 'contacts', severity: 'info', text: known ? `Its side knows of ${known} enem${known === 1 ? 'y' : 'ies'} it can see.` : 'No enemy contacts.' });
  if (!opts.omniscient) return out;
  // Exercise control: the nearest enemies it has not detected, and why not.
  const reach = Math.max(...ranges.map((r) => r.range));
  const unseen = [...engine.entities.values()]
    .filter((t) => t.alive && !t.embarkedIn && engine.isHostile(e.force, t.force) && !e.contacts.has(t.id))
    .map((t) => ({ t, d: Math.hypot(t.x - e.x, t.y - e.y, t.z - e.z) }))
    .filter(({ d }) => d < Math.max(reach * 1.5, 3000))
    .sort((a, b) => a.d - b.d)
    .slice(0, 3);
  for (const { t, d } of unseen) {
    const usable = ranges.filter(({ s }) => s.detects.includes(t.domain));
    if (!usable.length) {
      out.push({ code: 'cannotDetectDomain', severity: 'info', text: `${t.name} (${km(d)}) is not detected: none of its sensors can see ${t.domain === 'air' ? 'aircraft' : t.domain}.`, aboutId: t.id });
      continue;
    }
    const best = usable.reduce((a, b) => (b.range > a.range ? b : a));
    if (d > best.range) {
      out.push({ code: 'beyondSensorRange', severity: 'info', text: `${t.name} is ${km(d)} away, beyond what it can see (${km(best.range)}).`, aboutId: t.id });
      continue;
    }
    const inView = usable.filter(({ s }) => s.fov >= Math.PI * 2 - 1e-6 || Math.abs(angleDiff(e.heading, bearing(e, t))) <= s.fov / 2);
    if (!inView.length) {
      out.push({ code: 'outsideFieldOfView', severity: 'info', text: `${t.name} (${km(d)}) is outside its sensors' field of view.`, aboutId: t.id });
      continue;
    }
    const b = sightBlocker(engine, e, t, inView.every(({ s }) => s.radar));
    if (b) {
      out.push({ code: 'hidden', severity: 'info', text: `${t.name} (${km(d)}) is hidden from it by ${blockerText(b.cause)} at ${where(b)}.`, at: { x: b.x, y: b.y }, aboutId: t.id });
      continue;
    }
    const cover = engine.terrain.isForest(t.x, t.y) ? ' It is in forest, which makes it much harder to spot.' : engine.terrain.isBuiltUp(t.x, t.y) ? ' It is among buildings, which makes it harder to spot.' : t.prepared ? ' It is in a prepared position, which makes it harder to spot.' : '';
    out.push({ code: 'notYetSpotted', severity: 'info', text: `${t.name} (${km(d)}) is in sight but not spotted yet: each scan only has a chance to detect it.${cover}`, aboutId: t.id });
  }
  return out;
}

function summarize(activity: string, groups: Finding[][]): string {
  const all = groups.flat();
  const worst = [...all].sort((a, b) => SEVERITY[a.severity] - SEVERITY[b.severity])[0];
  if (!worst || worst.severity === 'info') {
    const engaging = all.find((f) => f.code === 'engaging');
    return engaging ? `${activity}. ${engaging.text}` : `${activity}.`;
  }
  return `${activity}. ${worst.text}`;
}

function activityOf(engine: Engine, e: Entity): string {
  if (e.destroyed) return 'Destroyed';
  if (e.plan && !e.plan.finished) return e.plan.describe(engine);
  if (e.task && e.task.status === 'running') return e.task.describe(engine);
  if (e.unit && e.unit.leader !== e) return `With ${e.unit.name}`;
  return 'No task';
}

export function explainEntity(engine: Engine, e: Entity, opts: ExplainOptions): Explanation {
  const activity = activityOf(engine, e);
  const m = movement(engine, e);
  const f = fire(engine, e, opts);
  const s = sensing(engine, e, opts);
  return { id: e.id, name: e.name, kind: 'entity', activity, summary: summarize(activity, [m, f]), movement: m, fire: f, sensing: s };
}

/** A unit: its own state, then its leader's explanation, with what is wrong with the rest of its members. */
export function explainUnit(engine: Engine, u: Unit, opts: ExplainOptions): Explanation {
  const alive = u.alive();
  const members = u.members();
  const own: Finding[] = [];
  own.push({ code: 'strength', severity: alive.length === 0 ? 'block' : alive.length < members.length / 2 ? 'warn' : 'info', text: `${alive.length} of ${members.length} members fit to fight${u.leader ? `; ${u.leader.name} leads` : ''}.` });
  if (engine.rules.morale && u.moraleState !== 'steady') own.push({ code: `morale-${u.moraleState}`, severity: u.moraleState === 'broken' ? 'block' : 'warn', text: u.moraleState === 'broken' ? 'Broken: falling back, obeying no orders until it rallies.' : 'Shaken: shooting less accurately.' });
  const order = engine.pendingOrders.find((o) => o.targetId === u.id);
  if (order) own.push({ code: 'orderPending', severity: 'info', text: `A new order is on its way: it arrives in ${Math.max(0, Math.ceil(order.due - engine.time))} s.` });
  const subs = engine.subordinatesOf(u);
  if (subs.length) own.push({ code: 'subordinates', severity: 'info', text: `Commands ${subs.map((s) => s.name).join(', ')}: its orders are passed down to them.` });
  // What is wrong with the members, counted.
  const counts = new Map<string, { n: number; f: Finding }>();
  for (const m of alive) {
    const ex = explainEntity(engine, m, opts);
    for (const f of [...ex.movement, ...ex.fire]) {
      if (f.severity === 'info' || ['idle', 'formation'].includes(f.code)) continue;
      const c = counts.get(f.code);
      if (c) c.n++;
      else counts.set(f.code, { n: 1, f });
    }
  }
  for (const { n, f } of counts.values()) {
    if (n > 1 || alive.length > 1) own.push({ ...f, text: `${n} of ${alive.length}: ${f.text}`, aboutId: undefined, at: undefined });
  }
  const lead = u.leader && u.leader.alive ? explainEntity(engine, u.leader, opts) : null;
  const activity = u.plan && !u.plan.finished ? u.plan.describe(engine) : lead?.activity ?? (alive.length ? 'No task' : 'Destroyed');
  const movementF = lead?.movement ?? [];
  const fireF = lead?.fire ?? [];
  return {
    id: u.id,
    name: u.name,
    kind: 'unit',
    activity,
    summary: summarize(activity, [own.filter((f) => f.code !== 'strength' || f.severity !== 'info'), movementF, fireF]),
    movement: movementF,
    fire: fireF,
    sensing: lead?.sensing ?? [],
    unit: own,
  };
}
