// Explanations for the operator: why an entity or unit is or is not moving, shooting and
// seeing. Everything here reads the engine without changing it, so asking costs nothing
// to the run (the random generator is never touched).

import { angleDiff, bearing, dist2d } from '../shared/math.js';
import type { Explanation, Finding, Vec2, WeaponDef } from '../shared/types.js';
import type { Engine } from './engine.js';
import type { Entity } from './entity.js';
import { groundFactor, sensorRange } from './environment.js';
import { radarRange, sizeFactor } from './sensors.js';
import { emissions } from './emcon.js';
import { AmbushTask, FormationTask, WaitTask } from './tasks.js';
import { autonomyOf, fallbackText, reasonText, warheadOf } from './unmanned.js';
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

const LINK_FIX: Record<string, string> = {
  jammed: "Move it (or the drones relaying for it) out of the jammer's reach, or destroy the jammer.",
  range: 'Move its operator closer, or put a relaying drone between them.',
  terrain: 'Move its operator to higher ground, or put a relaying drone overhead.',
  noController: 'Place a drone operator team, or give it an operator (inspector: Datalink).',
  controllerLost: 'Hand it to another operator (inspector: Datalink).',
  tether: 'A fibre-optic drone cannot fly beyond its cable: it is lost to its operator.',
};

/** Unmanned systems: the state of the control datalink. */
function linkFindings(engine: Engine, e: Entity): Finding[] {
  const st = e.uxs;
  if (!st || st.expended) return [];
  const u = e.type.unmanned!;
  if (u.link === 'autonomous') return [{ code: 'autonomous', severity: 'info', text: 'Autonomous: it needs no datalink.' }];
  if (st.up) {
    const op = st.rootId ? engine.entities.get(st.rootId) : undefined;
    const relayed = (st.hops ?? 1) > 1 ? ` through ${st.hops! - 1} relaying drone${st.hops! > 2 ? 's' : ''}` : '';
    const text = u.satcom ? 'Datalink up (satellite).' : `Datalink up${u.link === 'fiber' ? ' (fibre-optic)' : ''}${op ? ` to ${op.name}` : ''}${relayed}.`;
    return [{ code: 'datalink', severity: 'info', text, aboutId: op?.id }];
  }
  const blocking = autonomyOf(e) === 'remote' || !(e.task && e.task.status === 'running');
  return [
    {
      code: 'linkLost',
      severity: blocking ? 'block' : 'warn',
      text: `Datalink lost (${reasonText(engine, st)}): it ${fallbackText(e)}. Orders sent to it wait until the link is back.`,
      fix: LINK_FIX[st.reason ?? 'noController'],
      aboutId: st.jammerId ?? st.controllerId,
    },
  ];
}

function movement(engine: Engine, e: Entity, opts: ExplainOptions): Finding[] {
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
  for (const f of linkFindings(engine, e)) add(f);
  if (engine.ew.radioSilent(e)) add({ code: 'radioSilence', severity: 'warn', text: 'Radio silence (emission control): enemy direction finders cannot find it by its radio, but orders reach it a minute late, and it cannot share contacts with its unit, call for fire or hear codewords.', fix: 'Lift radio silence (Emission control) when it needs to talk.' });
  else if (engine.ew.radioJammed(e)) add({ code: 'radioJammed', severity: 'warn', text: 'Radio jammed: orders reach it a minute late, and it cannot share contacts with its unit, call for fire or hear codewords.', fix: "Move it out of the jammer's reach, or destroy the jammer." });
  if (e.nav) {
    const err = engine.nav.errorSize(e);
    const since = Math.round(engine.time - e.nav.since);
    if (!e.nav.spoofedBy) add({ code: 'gnssDenied', severity: 'warn', text: `GNSS denied: navigating by inertial for ${since} s, error ~${km(err)}; its moves and routes end that far off.`, fix: "Move it out of the GNSS jammer's reach (the fix comes back at once), or destroy the jammer." });
    else if (opts.omniscient) {
      const s = engine.entities.get(e.nav.spoofedBy);
      add({ code: 'gnssSpoofed', severity: 'warn', text: `GNSS spoofed by ${s?.name ?? e.nav.spoofedBy}: it believes it is ${km(err)} from where it is, and does not know.`, aboutId: e.nav.spoofedBy, at: s ? { x: Math.round(s.x), y: Math.round(s.y) } : undefined });
    }
  }

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
    if (order) {
      // Covered by the "on its way" finding above.
    } else if (plan) {
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

/** Active protection and decoys left. */
function protection(e: Entity, add: (f: Finding) => void): void {
  const aps = e.type.aps;
  if (aps) {
    const arc = aps.arc && aps.arc < 360 ? `the ${aps.arc}° about its front` : 'all round';
    add({ code: e.apsLeft > 0 ? 'activeProtection' : 'activeProtectionSpent', severity: e.apsLeft > 0 ? 'info' : 'warn', text: `Active protection (${aps.name ?? 'APS'}): ${e.apsLeft} of ${aps.charges} charges left, each defeating an incoming missile or rocket from ${arc}${aps.top ? ' or above' : ''} ${pct(aps.pk)} of the time.` });
  }
  const d = e.type.decoys;
  if (d) add({ code: e.decoysLeft > 0 ? 'decoys' : 'decoysSpent', severity: e.decoysLeft > 0 ? 'info' : 'warn', text: `Flares and chaff: ${e.decoysLeft} of ${d.salvos} salvos left, released when a missile is fired at it (its kill chance × ${d.pkFactor}).` });
}

function fire(engine: Engine, e: Entity, opts: ExplainOptions): Finding[] {
  const out: Finding[] = [];
  const add = (f: Finding) => out.push(f);
  if (e.destroyed) return [{ code: 'destroyed', severity: 'block', text: 'Destroyed.' }];
  if (e.remote) return [];
  if (e.embarkedIn) return [{ code: 'embarked', severity: 'block', text: 'Passengers do not fire while mounted.', fix: 'Dismount them.' }];
  const direct = e.type.weapons.map((id) => engine.catalog.weapon(id)).filter((w) => !w.indirect);
  const indirect = e.type.weapons.map((id) => engine.catalog.weapon(id)).filter((w) => w.indirect);
  if (e.uxs && !e.uxs.up) {
    const a = autonomyOf(e);
    if (a === 'remote' && (direct.length || warheadOf(engine, e))) add({ code: 'noLinkFire', severity: 'block', text: 'No datalink: its operator cannot aim or fire it.', fix: LINK_FIX[e.uxs.reason ?? 'noController'] });
    else if (a === 'supervised') add({ code: 'linkSupervised', severity: 'warn', text: 'No datalink: it attacks only the target it was given, nothing new.' });
  }
  const wh = warheadOf(engine, e);
  if (wh && !direct.length) {
    out.push({ code: 'oneWay', severity: 'info', text: `One-way attack drone: it attacks by flying into its target with its ${wh.name}. Give it Strike (attack), Loiter and attack, or a swarm attack.` });
    return out;
  }
  if (!direct.length) {
    if (indirect.length) return [{ code: 'indirectOnly', severity: 'info', text: `It only has indirect fire (${indirect.map((w) => w.name).join(', ')}): it shoots on fire missions, not at what it sees.`, fix: 'Give it a Fire mission, or an observer that calls for fire.' }];
    return [{ code: 'unarmed', severity: 'info', text: 'Unarmed.' }];
  }
  if (e.firepowerKill) return [{ code: 'firepowerKill', severity: 'block', text: 'Its weapons are knocked out (firepower kill).' }];
  protection(e, add);
  const arms = direct.filter((w) => w.antiRadiation && (e.ammo.get(w.id) ?? 0) > 0);
  if (arms.length) {
    const emitters = engine.df.contacts(e.force).filter((c) => engine.time - c.lastSeen <= 2 && (c.bands.includes('radar') || c.bands.includes('jammer'))).length;
    add({ code: 'antiRadiation', severity: 'info', text: `${arms.map((w) => w.name).join(', ')}: fired at radars and jammers its side has located by direction finding (${emitters} heard now); they home on the emission, and miss if it stops.` });
  }
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
  if (e.uxs && !e.uxs.up) {
    if (autonomyOf(e) === 'remote') return [{ code: 'noLinkPicture', severity: 'block', text: 'No datalink: its camera picture does not reach its operator, so it spots nothing.', fix: LINK_FIX[e.uxs.reason ?? 'noController'] }];
    out.push({ code: 'noLinkShare', severity: 'warn', text: 'No datalink: what it sees stays with it, not shared with its side.' });
  }
  const sensors = e.type.sensors.map((id) => engine.catalog.sensors.get(id)!).filter(Boolean);
  if (!sensors.length) return [{ code: 'noSensors', severity: 'warn', text: 'It has no sensors: it only knows what its unit reports.' }];
  const env = engine.env;
  const ranges = sensors.map((s) => ({ s, range: sensorRange(s, env) }));
  const list = ranges.map(({ s, range }) => `${s.name} ${km(range)}${range < s.maxRange * 0.95 ? ` (of ${km(s.maxRange)})` : ''}`).join(', ');
  const reduced = ranges.some(({ s, range }) => range < s.maxRange * 0.95);
  const why = env.period !== 'day' ? `${env.period === 'night' ? 'night' : 'twilight'}${env.visibility < 20000 ? ` and ${km(env.visibility)} visibility` : ''}` : env.visibility < 20000 ? `${km(env.visibility)} visibility` : env.precipitation !== 'none' ? env.precipitation : '';
  out.push({ code: 'sensors', severity: reduced ? 'warn' : 'info', text: `Sees with: ${list}${reduced && why ? `, cut down by ${why}` : ''}.`, fix: reduced && !sensors.some((s) => s.thermal) ? 'Thermal sights see in the dark: use a vehicle that has them.' : undefined });
  const radarJam = engine.ew.radarFactor(e);
  if (e.radarOff && sensors.some((s) => s.radar)) out.push({ code: 'radarOff', severity: 'warn', text: 'Radar off (emission control): it cannot be found by its radar, or hit by anti-radiation missiles, but its radar sees nothing.', fix: 'Switch the radar on (Emission control).' });
  else if (radarJam < 1 && sensors.some((s) => s.radar)) out.push({ code: 'radarJammed', severity: 'warn', text: `Radar jammed: it sees ${pct(radarJam)} of its normal range (more as it closes on the jammer).` });
  if (sensors.some((s) => s.df)) {
    const located = engine.df.contacts(e.force).length;
    if (engine.ew.radioJammed(e)) out.push({ code: 'dfCannotReport', severity: 'warn', text: `Direction finding: it cannot report its bearings with its radio ${engine.ew.radioSilent(e) ? 'silent' : 'jammed'}.` });
    else out.push({ code: 'directionFinding', severity: 'info', text: `Direction finding: its side has located ${located} enemy emitter${located === 1 ? '' : 's'}. One station gives a long ellipse along its bearing; two or more cross bearings into a tight fix.` });
  }
  const radiates = emissions(engine, e);
  if (radiates.length) out.push({ code: 'emitting', severity: 'info', text: `Radiating: ${radiates.join(', ')} (enemy direction finders can locate it).` });
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
    // Radars see big targets further than small ones.
    // Small things (drones) are seen closer in.
    const usable = ranges.filter(({ s }) => s.detects.includes(t.domain)).map((r) => (r.s.radar && r.s.refRange ? { ...r, range: radarRange(engine, r.s, t.type) } : r.s.radar ? r : { ...r, range: r.range * sizeFactor(t.type) }));
    if (!usable.length) {
      out.push({ code: 'cannotDetectDomain', severity: 'info', text: `${t.name} (${km(d)}) is not detected: none of its sensors can see ${t.domain === 'air' ? 'aircraft' : t.domain}.`, aboutId: t.id });
      continue;
    }
    const best = usable.reduce((a, b) => (b.range > a.range ? b : a));
    if (d > best.range) {
      const small = best.s.radar && best.s.refRange && best.range < best.s.maxRange ? ` for a radar return that size (${engine.models.radar.rcs(t.type)} m²)` : !best.s.radar && sizeFactor(t.type) < 1 ? ` for something ${t.type.size} m across` : '';
      out.push({ code: 'beyondSensorRange', severity: 'info', text: `${t.name} is ${km(d)} away, beyond what it can see (${km(best.range)}${small}).`, aboutId: t.id });
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
  // "No task: it waits where it is." already says it: no "No task. No task: …".
  if (worst.text.toLowerCase().startsWith(activity.toLowerCase())) return worst.text;
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
  const m = movement(engine, e, opts);
  const f = fire(engine, e, opts);
  const s = sensing(engine, e, opts);
  return { id: e.id, name: e.name, kind: 'entity', activity, summary: summarize(activity, [m, f]), movement: m, fire: f, sensing: s };
}

/** An aggregated unit: it is one object, so its own state stands for its members'. */
function explainAggregate(engine: Engine, u: Unit, opts: ExplainOptions): Explanation {
  const a = u.aggregate!;
  const ag = engine.aggregates;
  const snap = ag.snapshot(u)!;
  const comp = snap.strength.filter((g) => g.alive).map((g) => `${g.alive} × ${g.name}`).join(', ') || 'no one left';
  const own: Finding[] = [];
  const pol = ag.policy;
  own.push({
    code: 'aggregated',
    severity: 'info',
    text: `Aggregated: simulated as one object, ${snap.alive} of ${snap.total} members fit to fight (${comp}); combat power ${snap.combatPower} kills a minute at short range.`,
    fix: 'Disaggregate it to fight it entity by entity.',
  });
  own.push({
    code: 'aggregationPolicy',
    severity: 'info',
    text: pol.autoDisaggregate ? `It splits into its members when an enemy entity (not aggregated) comes within ${km(pol.disaggregateRange)}.` : 'Automatic disaggregation is off: enemy entities neither see nor fight it until it is disaggregated.',
  });
  if (engine.rules.morale && u.moraleState !== 'steady') own.push({ code: `morale-${u.moraleState}`, severity: u.moraleState === 'broken' ? 'block' : 'warn', text: u.moraleState === 'broken' ? 'Broken: falling back, obeying no orders until it rallies.' : 'Shaken: shooting less accurately.' });
  const order = engine.pendingOrders.find((o) => o.targetId === u.id);
  if (order) own.push({ code: 'orderPending', severity: 'info', text: `A new order is on its way: it arrives in ${Math.max(0, Math.ceil(order.due - engine.time))} s.` });
  const movement: Finding[] = [];
  const task = ag.describeTask(u);
  if (engine.rules.fuel && a.alive().some((m) => m.type.endurance?.km && m.fuel <= 0)) movement.push({ code: 'outOfFuel', severity: 'block', text: 'A vehicle is out of fuel, so the unit cannot move on.', fix: 'Disaggregate it and resupply.' });
  else if (snap.fuel !== undefined && snap.fuel < 0.2) movement.push({ code: 'lowFuel', severity: 'warn', text: `Fuel low: ${pct(snap.fuel)} left (pooled).` });
  if (a.posture === 'moving') movement.push({ code: 'moving', severity: 'info', text: `Moving at ${Math.round(snap.speed * 3.6)} km/h, the speed of its slowest member type on this ground.` });
  else if (a.posture === 'defending' || a.posture === 'dugIn') movement.push({ code: 'holding', severity: 'info', text: `Holding its position${a.posture === 'dugIn' ? ', dug in' : ''}.` });
  else if (!task && !(u.plan && !u.plan.finished)) movement.push({ code: 'idle', severity: 'warn', text: 'No task: it waits where it is.', fix: 'Right-click the map to give it a task.' });
  const fire: Finding[] = [];
  if (snap.ammo !== undefined && snap.ammo <= 0) fire.push({ code: 'noAmmo', severity: 'block', text: 'Out of ammunition.', fix: 'Disaggregate it and resupply.' });
  else if (snap.ammo !== undefined && snap.ammo < 0.25) fire.push({ code: 'lowAmmo', severity: 'warn', text: `Ammunition low: ${pct(snap.ammo)} left (pooled).` });
  const roe = u.leader?.roe ?? 'fireAtWill';
  if (roe === 'holdFire') fire.push({ code: 'holdFire', severity: 'block', text: 'Rules of engagement: hold fire. It only shoots at the target it is ordered to attack.', fix: 'Set ROE to "fire at will".' });
  else if (roe === 'returnFire') fire.push({ code: 'returnFire', severity: 'warn', text: 'Rules of engagement: return fire. It only shoots at aggregates that fired at it in the last minute.', fix: 'Set ROE to "fire at will".' });
  const target = a.engagingId ? engine.units.get(a.engagingId) : undefined;
  if (target?.aggregate) fire.push({ code: 'engaging', severity: 'info', text: `Engaging ${target.name} at ${km(dist2d(a, target.aggregate))} (Lanchester attrition).`, aboutId: target.id });
  else if (!a.contacts.size) fire.push({ code: 'noContacts', severity: 'info', text: 'No enemy aggregate detected: it fires on enemy aggregates it sees, within its weapons\' reach.' });
  const sensing: Finding[] = [{ code: 'sensors', severity: 'info', text: `Sees enemy aggregates within ${km(snap.sensorRange ?? 0)} (its best sensor) where there is line of sight.` }];
  const known = a.contacts.size;
  sensing.push({ code: 'contacts', severity: 'info', text: known ? `It has ${known} enemy aggregate${known === 1 ? '' : 's'} in sight.` : 'No enemy contacts.' });
  if (opts.omniscient) {
    let nearest = Infinity;
    for (const e of engine.entities.values()) if (e.alive && !e.embarkedIn && engine.isHostile(u.force, e.force)) nearest = Math.min(nearest, dist2d(a, e));
    if (Number.isFinite(nearest)) sensing.push({ code: 'nearestEnemyEntity', severity: 'info', text: `The nearest enemy entity is ${km(nearest)} away.` });
  }
  const activity = u.plan && !u.plan.finished ? u.plan.describe(engine) : task ?? (snap.alive ? 'No task' : 'Destroyed');
  const worst = summarize(activity, [own.filter((f) => f.severity !== 'info'), movement, fire]);
  return { id: u.id, name: u.name, kind: 'unit', activity, summary: `Aggregated: ${worst}`, movement, fire, sensing, unit: own };
}

/** A unit: its own state, then its leader's explanation, with what is wrong with the rest of its members. */
export function explainUnit(engine: Engine, u: Unit, opts: ExplainOptions): Explanation {
  if (u.aggregate) return explainAggregate(engine, u, opts);
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
