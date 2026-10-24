// The rule-based (doctrinal) commander. Each decision it weighs its combat power
// against what it knows of the enemy and picks a posture:
//
//   advance  no enemy known: scouts go ahead to watch the objective, the main body follows
//   attack   strong enough: one element supports by fire, the rest concentrate on one target
//   defend   holds the objective, a battle position or its ground, facing the enemy; reinforces a threatened sector
//   delay    too weak: screens and falls back to the next phase line
//   hold     nothing to do: defends where it is (on the objective once taken)
//
// Whatever the posture: guns fire on clustered contacts (never danger close), units low on
// fuel or ammunition go to a supply vehicle when out of contact, broken or shattered units
// pull back, helicopters attack armour away from known air defence, supply follows the
// main body. It only sees its force's view, only orders units nobody else is ordering,
// and repeats nothing it has already ordered. Its own random choices come from its seed.

import type { Command, TaskSpec, Vec2 } from '../../shared/types.js';
import type { Rng } from '../rng.js';
import type { withDefaults } from './options.js';
import type { Contact, OwnElement, SitGraphic, Situation } from './situation.js';
import type { CommanderAction, TerrainView } from './types.js';

type Posture = 'advance' | 'attack' | 'defend' | 'delay' | 'hold';

interface Memory {
  posture?: Posture;
  /** Own centroid at the first decision: where "back" is. */
  start?: Vec2;
  /** Objective graphics taken. */
  taken: string[];
  /** Last order given to each element (a key), so nothing is repeated. */
  last: Record<string, string>;
  /** Recent fire missions: where and when. */
  fired: { x: number; y: number; time: number }[];
  /** Element id -> time it last fired a mission. */
  firedBy: Record<string, number>;
  /** Element id -> time it was pulled back. */
  pulledBack: Record<string, number>;
  /** Elements given the halt-on-contact reaction. */
  reacted: string[];
  /** Time the scouts were sent forward. */
  reconSent?: number;
  /** Last known enemy centre. */
  enemyAt?: Vec2;
  /** Which side the support-by-fire position goes (1 or -1). */
  flank?: number;
  /** Contacts remembered after the force has lost sight of them: id -> what and where, and when last seen. */
  seen: Record<string, Omit<Contact, 'age' | 'destroyed'> & { time: number }>;
}

const POSTURE_TEXT: Record<Posture, string> = { advance: 'Advance', attack: 'Attack', defend: 'Defend', delay: 'Delay', hold: 'Hold' };

const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);
const deg = (from: Vec2, to: Vec2) => Math.round((((Math.atan2(to.x - from.x, to.y - from.y) * 180) / Math.PI) % 360 + 360) % 360);
const round = (p: Vec2): Vec2 => ({ x: Math.round(p.x), y: Math.round(p.y) });
const key = (p: Vec2, grid = 150) => `${Math.round(p.x / grid)}:${Math.round(p.y / grid)}`;

function unitVec(from: Vec2, to: Vec2): Vec2 {
  const d = dist(from, to);
  return d < 1 ? { x: 0, y: 1 } : { x: (to.x - from.x) / d, y: (to.y - from.y) / d };
}

function mean(points: Vec2[], weights?: number[]): Vec2 {
  let sx = 0;
  let sy = 0;
  let sw = 0;
  points.forEach((p, i) => {
    const w = weights?.[i] ?? 1;
    sx += p.x * w;
    sy += p.y * w;
    sw += w;
  });
  return sw > 0 ? { x: sx / sw, y: sy / sw } : { x: 0, y: 0 };
}

/** How much a contact still counts: fully for a minute, fading to 30 % over 15 minutes. */
function weight(age: number): number {
  return age <= 60 ? 1 : Math.max(0.3, 1 - (age - 60) / 900);
}

interface Cluster {
  members: Contact[];
  center: Vec2;
  power: number;
  /** Age of its freshest contact. */
  age: number;
}

/** Contacts within 500 m of one another, as groups. */
function clusters(contacts: Contact[]): Cluster[] {
  const left = [...contacts];
  const out: Cluster[] = [];
  while (left.length) {
    const group = [left.shift()!];
    for (let i = 0; i < group.length; i++) {
      for (let j = left.length - 1; j >= 0; j--) if (dist(group[i], left[j]) <= 500) group.push(...left.splice(j, 1));
    }
    out.push({ members: group, center: mean(group), power: group.reduce((s, c) => s + c.power * weight(c.age), 0), age: Math.min(...group.map((c) => c.age)) });
  }
  return out;
}

export class RulesCommander {
  private mem: Memory = { taken: [], last: {}, fired: [], firedBy: {}, pulledBack: {}, reacted: [], seen: {} };

  saveMemory(): Memory {
    return JSON.parse(JSON.stringify(this.mem)) as Memory;
  }

  loadMemory(m: unknown): void {
    if (m && typeof m === 'object') this.mem = { ...this.mem, ...(JSON.parse(JSON.stringify(m)) as Memory) };
  }

  decide(sit: Situation, terrain: TerrainView, rng: Rng, opts: ReturnType<typeof withDefaults>): { summary: string; actions: CommanderAction[] } {
    const m = this.mem;
    const t = sit.time;
    const a = opts.aggressiveness;
    const actions: CommanderAction[] = [];
    const notes: string[] = [];
    const alive = sit.own.filter((o) => o.alive > 0);
    const free = (o: OwnElement) => o.alive > 0 && o.control !== 'other';
    const leaf = (o: OwnElement) => !o.childIds?.length;
    const maneuver = alive.filter((o) => o.role === 'maneuver' && leaf(o));
    const fires = alive.filter((o) => o.role === 'fires');
    const recon = alive.filter((o) => o.role === 'recon');
    const supply = alive.filter((o) => o.role === 'supply' && (o.supplies ?? 0) > 0.5);
    const air = alive.filter((o) => o.role === 'air');
    const body = maneuver.length ? maneuver : alive;
    const center = mean(body, body.map((o) => o.power + 0.1));
    m.start ??= round(center);

    // ------------------------------------------------ what we know of the enemy
    // Contacts drop out of sensor memory; the commander remembers them for 15 minutes.
    for (const c of sit.contacts) {
      if (c.destroyed) delete m.seen[c.id];
      else if (!m.seen[c.id] || t - c.age >= m.seen[c.id].time) m.seen[c.id] = { id: c.id, typeId: c.typeId, type: c.type, domain: c.domain, symbol: c.symbol, x: c.x, y: c.y, speed: c.speed, power: c.power, time: t - c.age };
    }
    for (const [id, c] of Object.entries(m.seen)) if (t - c.time > 900) delete m.seen[id];
    const known: Contact[] = Object.values(m.seen)
      .map(({ time, ...c }) => ({ ...c, age: t - time, destroyed: false }))
      .sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
    const enemyPower = known.reduce((s, c) => s + c.power * weight(c.age), 0);
    const groups = clusters(known.filter((c) => c.age <= 300 && c.domain !== 'air'));
    const ownPower = maneuver.reduce((s, o) => s + o.power, 0) + 0.5 * air.reduce((s, o) => s + o.power, 0) + 0.3 * recon.reduce((s, o) => s + o.power, 0);
    if (known.length) m.enemyAt = round(mean(known, known.map((c) => c.power * weight(c.age) + 0.01)));
    const nearestEnemy = (p: Vec2) => known.reduce((best, c) => Math.min(best, dist(p, c)), Infinity);

    // ------------------------------------------------ objectives and ground
    const objectives = sit.graphics.filter((g) => (g.kind === 'area' || g.kind === 'point') && /^OBJ\b/i.test(g.name)).sort((x, y) => dist(x.center, m.start!) - dist(y.center, m.start!) || (x.id < y.id ? -1 : 1));
    for (const g of objectives) {
      if (m.taken.includes(g.id)) continue;
      const ours = maneuver.some((o) => dist(o, g.center) < 450);
      const theirs = known.some((c) => c.age <= 120 && dist(c, g.center) < 1000);
      if (ours && !theirs) {
        m.taken.push(g.id);
        notes.push(`${g.name} taken`);
      }
    }
    const objective: SitGraphic | undefined = objectives.find((g) => !m.taken.includes(g.id));
    const held = objectives.filter((g) => m.taken.includes(g.id)).at(-1);
    const bp = sit.graphics.filter((g) => g.kind === 'area' && /^BP\b/i.test(g.name)).sort((x, y) => dist(x.center, center) - dist(y.center, center))[0];
    const enemyDir = m.enemyAt ?? objective?.center ?? held?.center;
    const axis = enemyDir ? unitVec(m.start, enemyDir) : unitVec(m.start, { x: sit.mapSize / 2, y: sit.mapSize / 2 });
    const across = { x: axis.y, y: -axis.x };
    m.flank ??= rng.chance(0.5) ? 1 : -1;
    const land = (p: Vec2, r = 400) => {
      const q = terrain.nearestLand({ x: Math.min(Math.max(p.x, 50), sit.mapSize - 50), y: Math.min(Math.max(p.y, 50), sit.mapSize - 50) }, r);
      return q ? round(q) : null;
    };

    // ------------------------------------------------ posture
    // What is seen is rarely all there is: allow for more of the enemy when few are known.
    const estimate = enemyPower * (1 + 1 / (1 + known.length / 2));
    const ratio = ownPower / Math.max(0.01, estimate);
    // Holding ground (an objective taken, or a battle position), it takes more to leave it.
    const anchored = !!held || (!objective && !!bp && dist(bp.center, center) < 1500);
    const tAttack = (2.2 - 1.4 * a) * (anchored ? 1.5 : 1);
    const tDefend = 0.6 - 0.35 * a;
    let posture: Posture;
    if (enemyPower < 0.05) posture = objective && a >= 0.2 ? 'advance' : 'hold';
    else if (ratio >= tAttack * (m.posture === 'attack' ? 0.85 : 1)) posture = 'attack';
    else if (ratio >= tDefend * (m.posture === 'delay' ? 1.15 : 1)) posture = 'defend';
    else posture = 'delay';
    // Strong but with nothing on the ground to attack: go on to the objective.
    const moving: Posture = posture === 'attack' && !groups.length ? (objective ? 'advance' : 'hold') : posture;
    if (posture !== m.posture && m.posture) notes.unshift(`${POSTURE_TEXT[m.posture]} → ${POSTURE_TEXT[posture]}`);
    m.posture = posture;

    // ------------------------------------------------ issuing orders
    const issue = (o: OwnElement, k: string, task: TaskSpec, text: string, again = false) => {
      // Already ordered and still at it (or done, unless it should be given again): leave it.
      if (o.control === 'commander' && m.last[o.id] === k && (o.busy || !again)) return false;
      m.last[o.id] = k;
      actions.push({ command: { cmd: 'assignTask', targetId: o.id, task } as Command, text: `${o.name}: ${text}` });
      return true;
    };
    const halting = (o: OwnElement) => {
      if (m.reacted.includes(o.id)) return;
      m.reacted.push(o.id);
      actions.push({ command: { cmd: 'setReactions', targetId: o.id, reactions: { onContact: 'halt' } } as Command, text: `${o.name}: halt on contact` });
    };
    const weaponsFree = (o: OwnElement) => {
      if (o.roe === 'fireAtWill' || !free(o)) return;
      actions.push({ command: { cmd: 'setRoe', targetId: o.id, roe: 'fireAtWill' } as Command, text: `${o.name}: fire at will` });
    };
    const defendAt = (o: OwnElement, p: Vec2, facingTo: Vec2 | undefined, why: string) => {
      const at = land(p);
      if (!at) return;
      const facing = facingTo && dist(facingTo, at) > 50 ? deg(at, facingTo) : deg(m.start!, at);
      issue(o, `defend:${key(at)}:${Math.round(facing / 20)}`, { type: 'defend', position: at, facing, width: o.kind === 'unit' ? 300 : undefined }, `defend ${why}`);
    };

    // ------------------------------------------------ casualties and supply first
    const handled = new Set<string>();
    for (const o of [...maneuver, ...recon]) {
      if (!free(o)) continue;
      const hurt = o.moraleState === 'broken' || (o.alive / o.total < 0.34 && nearestEnemy(o) < 3000);
      if (hurt) {
        handled.add(o.id);
        if (t - (m.pulledBack[o.id] ?? -Infinity) < 300) continue;
        const away = m.enemyAt ? unitVec(m.enemyAt, o) : { x: -axis.x, y: -axis.y };
        const rear = land({ x: o.x + away.x * 1500, y: o.y + away.y * 1500 }, 600);
        if (rear && issue(o, `back:${key(rear, 300)}`, { type: 'moveTo', target: rear, covered: true }, `pull back to (${rear.x}, ${rear.y}): ${o.moraleState === 'broken' ? 'broken' : `${o.alive} of ${o.total} left`}`)) m.pulledBack[o.id] = t;
        continue;
      }
      const low = (o.fuel !== undefined && o.fuel < 0.25) || o.ammo < 0.3;
      if (low && supply.length && nearestEnemy(o) > 2500) {
        handled.add(o.id);
        issue(o, 'resupply', { type: 'resupply' }, `resupply (${o.fuel !== undefined && o.fuel < 0.25 ? `fuel ${Math.round(o.fuel * 100)}%` : `ammunition ${Math.round(o.ammo * 100)}%`})`, true);
      }
    }
    const fighting = maneuver.filter((o) => free(o) && !handled.has(o.id));

    // ------------------------------------------------ manoeuvre
    const spread = (list: OwnElement[], i: number, gap = 350) => (i - (list.length - 1) / 2) * gap;
    if (moving === 'advance' && objective) {
      // Scouts first: the main body waits until they are forward, or two minutes.
      const scoutsOut = recon.length === 0 || (m.reconSent !== undefined && (t - m.reconSent >= 120 || recon.every((r) => r.control === 'commander' && !r.busy)));
      const order = [...fighting].sort((x, y) => (x.id < y.id ? -1 : 1));
      order.forEach((o, i) => {
        const goal = land({ x: objective.center.x + across.x * spread(order, i), y: objective.center.y + across.y * spread(order, i) });
        if (!goal) return;
        if (dist(o, goal) < 300 && !o.busy) return defendAt(o, goal, enemyDir === objective.center ? { x: goal.x + axis.x * 1000, y: goal.y + axis.y * 1000 } : enemyDir, `on ${objective.name}`);
        if (!scoutsOut) return;
        halting(o);
        issue(o, `move:${objective.id}:${i}`, { type: 'moveTo', target: goal }, `advance on ${objective.name}`);
      });
      if (!scoutsOut) notes.push('scouts forward first');
    } else if (moving === 'attack') {
      // The group that matters: near the objective if there is one, else the nearest.
      const ref = objective?.center ?? center;
      const target = [...groups].sort((x, y) => dist(x.center, ref) - dist(y.center, ref) || y.power - x.power)[0];
      // Attack orders need a contact the force still holds; else close on where it was seen.
      const inSight = new Set(sit.contacts.filter((c) => !c.destroyed && c.age <= 120).map((c) => c.id));
      const primary = [...target.members].sort((x, y) => Number(inSight.has(y.id)) - Number(inSight.has(x.id)) || y.power * weight(y.age) - x.power * weight(x.age) || (x.id < y.id ? -1 : 1))[0];
      let assault = [...fighting].sort((x, y) => (x.id < y.id ? -1 : 1));
      if (assault.length >= 2) {
        // Support by fire: the longest-reaching, strongest element, off to a flank.
        const sbf = [...assault].sort((x, y) => y.directRange * y.power - x.directRange * x.power || (x.id < y.id ? -1 : 1))[0];
        assault = assault.filter((o) => o !== sbf);
        const back = unitVec(target.center, sbf);
        const side = { x: back.y * m.flank, y: -back.x * m.flank };
        const standoff = Math.min(2500, Math.max(800, sbf.directRange * 0.75));
        const pos = dist(sbf, target.center) < standoff + 300 ? round(sbf) : land({ x: target.center.x + back.x * standoff * 0.9 + side.x * standoff * 0.45, y: target.center.y + back.y * standoff * 0.9 + side.y * standoff * 0.45 });
        if (pos) {
          weaponsFree(sbf);
          issue(sbf, `sbf:${key(target.center, 500)}`, { type: 'overwatch', position: pos, facing: deg(pos, target.center) }, `support by fire on the enemy at (${Math.round(target.center.x)}, ${Math.round(target.center.y)})`);
        }
      }
      for (const o of assault) {
        weaponsFree(o);
        halting(o);
        if (inSight.has(primary.id)) issue(o, `attack:${primary.id}`, { type: 'attack', targetId: primary.id }, `attack ${primary.type} (${primary.id})`, true);
        else {
          const goal = land(target.center);
          if (goal) issue(o, `move:${key(goal, 300)}`, { type: 'moveTo', target: goal }, `close on the enemy last seen at (${goal.x}, ${goal.y})`);
        }
      }
      notes.push(`concentrating on ${primary.type} (${primary.id})`);
    } else if (moving === 'defend' || moving === 'hold') {
      const pos = held?.center ?? (objective && dist(objective.center, center) < 1500 ? objective.center : bp?.center);
      const facingTo = m.enemyAt ?? (pos ? { x: pos.x + axis.x * 1500, y: pos.y + axis.y * 1500 } : undefined);
      const order = [...fighting].sort((x, y) => (x.id < y.id ? -1 : 1));
      if (pos) {
        const f = unitVec(pos, facingTo ?? { x: pos.x + axis.x, y: pos.y + axis.y });
        const side = { x: f.y, y: -f.x };
        order.forEach((o, i) => defendAt(o, { x: pos.x + side.x * spread(order, i, 400), y: pos.y + side.y * spread(order, i, 400) }, facingTo, `the position at (${Math.round(pos.x)}, ${Math.round(pos.y)})`));
      } else {
        for (const o of order) if (!o.busy || o.control === 'commander') defendAt(o, o, facingTo, 'where it stands');
      }
      // Reinforce a threatened sector: a group much stronger than the element facing it.
      if (posture === 'defend' && groups.length && order.length >= 2) {
        let worst: { u: OwnElement; g: Cluster; ratio: number } | undefined;
        for (const g of groups) {
          const u = [...order].sort((x, y) => dist(x, g.center) - dist(y, g.center))[0];
          const r = g.power / Math.max(0.1, u.power);
          if (dist(u, g.center) < 3500 && r > 1.5 && (!worst || r > worst.ratio)) worst = { u, g, ratio: r };
        }
        if (worst) {
          const w = worst;
          const reserve = order.filter((o) => o !== w.u).sort((x, y) => nearestEnemyGroup(y, groups) - nearestEnemyGroup(x, groups))[0];
          if (reserve) {
            const f = unitVec(w.u, w.g.center);
            const spot = land({ x: w.u.x + f.y * 300, y: w.u.y - f.x * 300 });
            if (spot) {
              m.last[reserve.id] = '';
              issue(reserve, `reinforce:${w.u.id}:${key(spot, 300)}`, { type: 'defend', position: spot, facing: deg(spot, w.g.center), width: 300 }, `reinforce ${w.u.name}`);
              notes.push(`reinforcing ${w.u.name}`);
            }
          }
        }
      }
    } else if (posture === 'delay') {
      const enemy = m.enemyAt ?? { x: center.x + axis.x * 2000, y: center.y + axis.y * 2000 };
      const lines = sit.graphics.filter((g) => g.kind === 'phaseLine');
      const here = dist(center, enemy);
      const next = lines.filter((g) => dist(g.center, enemy) > here + 400).sort((x, y) => dist(x.center, center) - dist(y.center, center))[0];
      const back = unitVec(enemy, center);
      const goal = next ? next.center : { x: center.x + back.x * 2000, y: center.y + back.y * 2000 };
      const order = [...fighting].sort((x, y) => (x.id < y.id ? -1 : 1));
      order.forEach((o, i) => {
        const fallback = land({ x: goal.x + back.y * spread(order, i, 400), y: goal.y - back.x * spread(order, i, 400) }, 600);
        if (!fallback) return;
        if (dist(o, fallback) < 300) return defendAt(o, fallback, enemy, next ? `on ${next.name}` : 'the delay position');
        issue(o, `screen:${key(fallback, 300)}`, { type: 'screen', position: round(o), facing: deg(o, enemy), fallback }, `delay, then fall back to ${next ? next.name : `(${fallback.x}, ${fallback.y})`}`);
      });
    }

    // ------------------------------------------------ scouts
    for (const r of recon) {
      if (!free(r) || handled.has(r.id)) continue;
      const toward = objective?.center ?? m.enemyAt ?? { x: center.x + axis.x * 3000, y: center.y + axis.y * 3000 };
      const approach = unitVec(toward, m.start);
      let post: Vec2 | null;
      if (posture === 'advance' || posture === 'attack' || (posture === 'hold' && objective)) {
        let d = 1500;
        if (groups.some((g) => dist(g.center, { x: toward.x + approach.x * d, y: toward.y + approach.y * d }) < 1200)) d = 2300;
        post = land({ x: toward.x + approach.x * d, y: toward.y + approach.y * d }, 600);
        if (post && issue(r, `recon:${key(post, 300)}`, { type: 'overwatch', position: post, facing: deg(post, toward) }, `watch ${objective ? objective.name : 'toward the enemy'} from (${post.x}, ${post.y})`)) m.reconSent ??= t;
        m.reconSent ??= t;
      } else {
        const base = held?.center ?? bp?.center ?? center;
        const out = m.enemyAt ? unitVec(base, m.enemyAt) : axis;
        post = land({ x: base.x + out.x * 1500, y: base.y + out.y * 1500 }, 600);
        if (post) issue(r, `screen:${key(post, 300)}`, { type: 'screen', position: post, facing: deg(base, post), fallback: round(base) }, `screen 1.5 km out from (${Math.round(base.x)}, ${Math.round(base.y)})`);
      }
    }

    // ------------------------------------------------ fires
    m.fired = m.fired.filter((f) => t - f.time < 180);
    const ownSpots = alive.map((o) => ({ x: o.x, y: o.y }));
    for (const f of [...fires].sort((x, y) => (x.id < y.id ? -1 : 1))) {
      if (!free(f) || !f.indirectRange || (f.busy && f.control !== 'none') || t - (m.firedBy[f.id] ?? -Infinity) < 45) continue;
      const options = groups
        .filter((g) => g.age <= 90 && dist(f, g.center) <= f.indirectRange! * 0.95)
        // Never danger close, and not where rounds have just gone in.
        .filter((g) => ownSpots.every((p) => dist(p, g.center) > 450) && m.fired.every((x) => dist(x, g.center) > 200 || t - x.time > 90))
        .map((g) => ({ g, score: g.power * (g.members.length >= 2 ? 1.5 : 1) + g.members.length * 0.2 }))
        .sort((x, y) => y.score - x.score);
      const best = options[0];
      if (!best) continue;
      const at = round(best.g.center);
      const rounds = Math.min(6, Math.max(3, 2 + best.g.members.length));
      actions.push({
        command: { cmd: 'assignTask', targetId: f.id, task: { type: 'fireMission', target: at, rounds, radius: f.kind === 'unit' ? 50 : 0 } } as Command,
        text: `${f.name}: fire ${rounds} rounds on ${best.g.members.length} contact${best.g.members.length === 1 ? '' : 's'} at (${at.x}, ${at.y})`,
      });
      m.last[f.id] = `fire:${key(at)}`;
      m.firedBy[f.id] = t;
      m.fired.push({ ...at, time: t });
    }

    // ------------------------------------------------ helicopters
    const airDefence = known.filter((c) => c.symbol === 'air-defense' && c.age <= 600);
    for (const h of air) {
      if (!free(h)) continue;
      if (h.fuel !== undefined && h.fuel < 0.3 && supply.length) {
        issue(h, 'resupply', { type: 'resupply' }, `refuel (fuel ${Math.round(h.fuel * 100)}%)`);
        continue;
      }
      const prey = known
        .filter((c) => c.age <= 120 && c.domain === 'ground' && c.power >= 1 && airDefence.every((d) => dist(d, c) > 4500))
        .sort((x, y) => y.power - x.power || dist(h, x) - dist(h, y) || (x.id < y.id ? -1 : 1))[0];
      if (prey && h.ammo > 0.2 && posture !== 'delay') issue(h, `attack:${prey.id}`, { type: 'attack', targetId: prey.id }, `attack ${prey.type} (${prey.id})`, true);
      else {
        const hold = land({ x: center.x - axis.x * 1500, y: center.y - axis.y * 1500 }, 2000) ?? round(center);
        if (h.busy && h.control === 'commander' && m.last[h.id]?.startsWith('orbit')) continue;
        issue(h, `orbit:${key(hold, 500)}`, { type: 'orbit', center: hold, radius: 1200 }, `hold at (${hold.x}, ${hold.y})`);
      }
    }

    // ------------------------------------------------ supply follows
    for (const s of supply) {
      if (!free(s) || s.busy) continue;
      const spot = land({ x: center.x - axis.x * 1500, y: center.y - axis.y * 1500 }, 800);
      if (spot && dist(s, spot) > 1500 && nearestEnemy(spot) > 2500) issue(s, `supply:${key(spot, 500)}`, { type: 'moveTo', target: spot, covered: true }, `move up behind the main body`);
    }

    const contactsText = known.length ? `${known.length} contact${known.length === 1 ? '' : 's'}, enemy power ${enemyPower.toFixed(1)} (perhaps ${estimate.toFixed(1)}) against our ${ownPower.toFixed(1)}` : `no enemy known, our power ${ownPower.toFixed(1)}`;
    const goalText = posture === 'advance' && objective ? ` toward ${objective.name}` : '';
    return { summary: `${POSTURE_TEXT[posture]}${goalText} (${contactsText})${notes.length ? `; ${notes.join('; ')}` : ''}.`, actions };
  }
}

function nearestEnemyGroup(o: Vec2, groups: Cluster[]): number {
  return groups.reduce((best, g) => Math.min(best, dist(o, g.center)), Infinity);
}
