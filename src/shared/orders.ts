// Typed orders: "Team ARMOR move to Calloway covered", "Scout 1 and Viper screen 2 km north
// of Brenham", "Paladin fire 4 rounds on OBJ CALLOWAY". The same parser runs in the
// browser (for completions) and on the server (to carry the order out), with no Node APIs.

import type { Command, EntityTypeDef, ForceId, Roe, SimState, TaskSpec, Vec2 } from './types.js';

export interface OrderObject {
  id: string;
  name: string;
  force: ForceId;
  kind: 'entity' | 'unit';
  x: number;
  y: number;
  /** Units: the leader's domain; entities: their own. */
  domain?: string;
  /** Units: the leader (what an attack on the unit aims at). */
  leaderId?: string;
  /** Cruise and top speed in m/s (units: the leader's), for "fast" and "slowly". */
  cruise?: number;
  maxSpeed?: number;
}

export interface OrderGraphic {
  id: string;
  name: string;
  kind: string;
  points: Vec2[];
}

export interface OrderContext {
  /** Things the speaker may order (own force for a player). */
  own: OrderObject[];
  /** Everything the speaker can see, own and other forces' (targets, places). */
  visible: OrderObject[];
  graphics: OrderGraphic[];
  towns: { name: string; x: number; y: number }[];
  /** Map size in metres (coordinates must be inside). */
  size: number;
}

/**
 * The context for a speaker from a state they may see (a player's state is already
 * filtered): `force` undefined means exercise control, who may order anything.
 */
export function orderContext(state: SimState, towns: { name: string; x: number; y: number }[], size: number, typeOf: (typeId: string) => EntityTypeDef | undefined, force?: ForceId): OrderContext {
  const objects: OrderObject[] = [];
  const byId = new Map(state.entities.map((e) => [e.id, e]));
  for (const u of state.units) {
    const lead = u.leaderId ? byId.get(u.leaderId) : undefined;
    const t = lead ? typeOf(lead.typeId) : undefined;
    objects.push({ id: u.id, name: u.name, force: u.force, kind: 'unit', x: u.x, y: u.y, domain: lead?.domain, leaderId: lead && lead.damage !== 'destroyed' ? lead.id : undefined, cruise: t?.cruiseSpeed, maxSpeed: t?.maxSpeed });
  }
  for (const e of state.entities) {
    if (e.damage === 'destroyed' || e.embarkedIn) continue;
    const t = typeOf(e.typeId);
    objects.push({ id: e.id, name: e.name, force: e.force, kind: 'entity', x: e.x, y: e.y, domain: e.domain, cruise: t?.cruiseSpeed, maxSpeed: t?.maxSpeed });
  }
  return {
    own: objects.filter((o) => (force === undefined || o.force === force) && !byId.get(o.id)?.remote),
    visible: objects,
    graphics: state.graphics.map((g) => ({ id: g.id, name: g.name, kind: g.kind, points: g.points })),
    towns,
    size,
  };
}

export interface ParsedOrder {
  targets: OrderObject[];
  commands: Command[];
  /** The order in words, as understood. */
  description: string;
}

export class OrderError extends Error {}

const DIRECTIONS: Record<string, number> = {
  n: 0, north: 0, nne: 22.5, ne: 45, northeast: 45, ene: 67.5,
  e: 90, east: 90, ese: 112.5, se: 135, southeast: 135, sse: 157.5,
  s: 180, south: 180, ssw: 202.5, sw: 225, southwest: 225, wsw: 247.5,
  w: 270, west: 270, wnw: 292.5, nw: 315, northwest: 315, nnw: 337.5,
};

/** Verb phrases, longest first so "fire at will" wins over "fire". */
const VERBS: [string, string][] = [
  ['fire at will', 'fireAtWill'],
  ['weapons free', 'fireAtWill'],
  ['return fire', 'returnFire'],
  ['hold fire', 'holdFire'],
  ['weapons hold', 'holdFire'],
  ['follow route', 'followRoute'],
  ['swarm search', 'swarmSearch'],
  ['swarm attack', 'swarmAttack'],
  ['fire mission', 'fire'],
  ['move to', 'move'],
  ['go to', 'move'],
  ['advance to', 'move'],
  ['move', 'move'],
  ['go', 'move'],
  ['attack', 'attack'],
  ['engage', 'attack'],
  ['follow', 'follow'],
  ['defend', 'defend'],
  ['hold', 'defend'],
  ['overwatch', 'overwatch'],
  ['screen', 'screen'],
  ['ambush', 'ambush'],
  ['search', 'search'],
  ['patrol', 'patrol'],
  ['fire', 'fire'],
  ['smoke', 'smoke'],
  ['orbit', 'orbit'],
  ['strike', 'strike'],
  ['loiter', 'loiter'],
  ['mount', 'mount'],
  ['board', 'mount'],
  ['dismount', 'dismount'],
  ['resupply', 'resupply'],
  ['refuel', 'resupply'],
  ['breach', 'breach'],
  ['stop', 'stop'],
  ['halt', 'stop'],
  ['wait', 'wait'],
];

/** Example orders, shown as help. */
export const ORDER_EXAMPLES = [
  'Team ARMOR move to Calloway covered',
  'Scout 1 screen 2 km north of Brenham facing north',
  'Team ARMOR and Team MECH defend OBJ CALLOWAY facing northwest',
  'Gunslinger attack T-72B3 (E31)',
  'Paladin Platoon fire 4 rounds on 9800 12300',
  'Team MECH hold fire',
  'Viper orbit Brenham radius 3 km',
];

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/** Words of an order, keeping "quoted names" whole. */
function words(text: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push(m[1] !== undefined ? m[1] : m[2]);
  return out;
}

/** Drop copies: graphics of the same name and shape (e.g. an objective drawn once for each force) are one place. */
function distinct<T extends { name: string }>(items: T[]): T[] {
  const shape = (it: T) => ('points' in it ? `${norm(it.name)}|${JSON.stringify((it as { points: unknown }).points)}` : null);
  return items.filter((it, i) => {
    const s = shape(it);
    return s === null || items.findIndex((o) => shape(o) === s) === i;
  });
}

/** Match the longest run of words at the start of `ws` against names. */
function matchName<T extends { name: string; id: string }>(ws: string[], items: T[]): { item: T; used: number } | { ambiguous: T[]; used: number } | null {
  for (let n = ws.length; n >= 1; n--) {
    const phrase = norm(ws.slice(0, n).join(' ')).replace(/,$/, '');
    const exact = distinct(items.filter((it) => norm(it.name) === phrase || it.id.toLowerCase() === phrase || norm(`${it.name} (${it.id})`) === phrase));
    if (exact.length === 1) return { item: exact[0], used: n };
    if (exact.length > 1) return { ambiguous: exact, used: n };
  }
  // A unique name that starts with what was typed ("team arm").
  for (let n = ws.length; n >= 1; n--) {
    const phrase = norm(ws.slice(0, n).join(' '));
    if (phrase.length < 3) continue;
    const pre = items.filter((it) => norm(it.name).startsWith(phrase));
    if (pre.length === 1) return { item: pre[0], used: n };
  }
  return null;
}

function centroid(points: Vec2[]): Vec2 {
  const n = points.length || 1;
  return { x: points.reduce((s, p) => s + p.x, 0) / n, y: points.reduce((s, p) => s + p.y, 0) / n };
}

const round = (p: Vec2): Vec2 => ({ x: Math.round(p.x), y: Math.round(p.y) });

class Reader {
  i = 0;
  constructor(
    readonly ws: string[],
    readonly ctx: OrderContext,
  ) {}

  get done(): boolean {
    return this.i >= this.ws.length;
  }

  peek(n = 0): string | undefined {
    return this.ws[this.i + n]?.toLowerCase();
  }

  /** Consume a phrase (case-insensitive) if it comes next. */
  accept(...phrase: string[]): boolean {
    for (let k = 0; k < phrase.length; k++) if (this.peek(k) !== phrase[k]) return false;
    this.i += phrase.length;
    return true;
  }

  rest(): string[] {
    return this.ws.slice(this.i);
  }

  number(): number | null {
    const v = Number(this.peek()?.replace(/,$/, ''));
    if (this.peek() === undefined || !Number.isFinite(v)) return null;
    this.i++;
    return v;
  }

  /** A distance: "2 km", "800 m", "2km". */
  distance(): number | null {
    const w = this.peek();
    if (!w) return null;
    const glued = /^(\d+(?:\.\d+)?)(km|m)$/.exec(w);
    if (glued) {
      this.i++;
      return Number(glued[1]) * (glued[2] === 'km' ? 1000 : 1);
    }
    const save = this.i;
    const v = this.number();
    if (v === null) return null;
    if (this.accept('km')) return v * 1000;
    if (this.accept('m') || this.accept('metres') || this.accept('meters')) return v;
    this.i = save;
    return null;
  }

  direction(): number | null {
    const w = this.peek();
    if (w === undefined) return null;
    if (w in DIRECTIONS) {
      this.i++;
      return DIRECTIONS[w];
    }
    const deg = /^(\d+(?:\.\d+)?)(°|deg)?$/.exec(w);
    if (deg) {
      this.i++;
      this.accept('degrees');
      return Number(deg[1]) % 360;
    }
    return null;
  }

  /** A place: coordinates, "2 km north of X", a graphic, a town, or an object. Null if none. */
  place(): { at: Vec2; label: string; graphic?: OrderGraphic } | null {
    const save = this.i;
    // "x y" or "x,y"
    const pair = /^(\d+(?:\.\d+)?),(\d+(?:\.\d+)?)$/.exec(this.peek() ?? '');
    if (pair) {
      this.i++;
      return this.checked({ x: Number(pair[1]), y: Number(pair[2]) });
    }
    const x = this.number();
    if (x !== null) {
      const y = this.number();
      if (y !== null) return this.checked({ x, y });
      this.i = save;
    }
    // "2 km north of Brenham"
    const d = this.distance();
    if (d !== null) {
      const dir = this.direction();
      if (dir !== null && this.accept('of')) {
        const base = this.place();
        if (base) {
          const r = (dir * Math.PI) / 180;
          const p = this.checked({ x: base.at.x + Math.sin(r) * d, y: base.at.y + Math.cos(r) * d });
          return { at: p.at, label: `${d >= 1000 ? `${d / 1000} km` : `${d} m`} ${Object.keys(DIRECTIONS).find((k) => k.length > 3 && DIRECTIONS[k] === dir) ?? `${dir}°`} of ${base.label}` };
        }
      }
      this.i = save;
    }
    this.accept('the');
    const ws = this.rest();
    const g = matchName(ws, this.ctx.graphics);
    if (g && 'item' in g) {
      this.i += g.used;
      const p = g.item.kind === 'route' || g.item.kind === 'phaseLine' ? g.item.points[g.item.points.length - 1] : centroid(g.item.points);
      return { at: round(p), label: g.item.name, graphic: g.item };
    }
    const t = matchName(ws, this.ctx.towns.map((tw) => ({ ...tw, id: tw.name })));
    if (t && 'item' in t) {
      this.i += t.used;
      return { at: round(t.item), label: t.item.name };
    }
    const o = matchName(ws, this.ctx.visible);
    if (o && 'item' in o) {
      this.i += o.used;
      return { at: round(o.item), label: o.item.name };
    }
    this.i = save;
    return null;
  }

  private checked(p: Vec2): { at: Vec2; label: string } {
    if (p.x < 0 || p.y < 0 || p.x > this.ctx.size || p.y > this.ctx.size) throw new OrderError(`(${Math.round(p.x)}, ${Math.round(p.y)}) is off the map (0-${this.ctx.size} m)`);
    return { at: round(p), label: `(${Math.round(p.x)}, ${Math.round(p.y)})` };
  }

  needPlace(what: string): { at: Vec2; label: string; graphic?: OrderGraphic } {
    this.accept('to') || this.accept('at') || this.accept('on') || this.accept('in') || this.accept('from');
    const p = this.place();
    if (!p) throw new OrderError(`${what}: where? Give a town, a graphic, an object, "x y" or "2 km north of …"${this.done ? '' : ` (did not understand "${this.rest().join(' ')}")`}`);
    return p;
  }

  needObject(what: string, among: OrderObject[]): OrderObject {
    this.accept('the');
    const m = matchName(this.rest(), among);
    if (!m) throw new OrderError(`${what}: ${this.done ? 'who?' : `no such object "${this.rest().join(' ')}"`}`);
    if ('ambiguous' in m) throw new OrderError(`${what}: which one? ${m.ambiguous.map((o) => `${o.name} (${o.id})`).join(', ')}`);
    this.i += m.used;
    return m.item;
  }

  needGraphic(what: string, kinds: string[]): OrderGraphic {
    this.accept('the');
    const m = matchName(this.rest(), this.ctx.graphics.filter((g) => kinds.includes(g.kind)));
    if (!m || 'ambiguous' in m) throw new OrderError(`${what}: give the name of ${kinds.length > 1 ? `a ${kinds.join(' or ')}` : `an ${kinds[0]}`}`);
    this.i += m.used;
    return m.item;
  }

  facing(): number | undefined {
    if (!this.accept('facing') && !this.accept('towards') && !this.accept('toward')) return undefined;
    this.accept('towards') || this.accept('toward');
    const dir = this.direction();
    if (dir !== null) return dir;
    throw new OrderError('facing: give a direction (north, NE, 45...)');
  }
}

/** Find the speakers at the start of an order: names joined by "and" or commas. */
function readWho(ws: string[], ctx: OrderContext): { targets: OrderObject[]; used: number } | null {
  const targets: OrderObject[] = [];
  let i = 0;
  while (i < ws.length) {
    const m = matchName(ws.slice(i), ctx.own);
    if (!m || 'ambiguous' in m) return targets.length ? { targets, used: i } : null;
    // Prefer to leave a verb for the rest when a name could swallow it.
    let used = m.used;
    const rest = ws.slice(i);
    if (used > 1 && verbAt(rest.slice(used)) === null) {
      for (let n = used - 1; n >= 1; n--) {
        const shorter = matchName(rest.slice(0, n), ctx.own);
        if (shorter && 'item' in shorter && shorter.used === n && verbAt(rest.slice(n)) !== null) {
          used = n;
          m.item = shorter.item;
          break;
        }
      }
    }
    targets.push(m.item);
    i += used;
    if (ws[i - 1]?.endsWith(',')) continue;
    if (ws[i]?.toLowerCase() === 'and' || ws[i] === ',') {
      i++;
      continue;
    }
    break;
  }
  return targets.length ? { targets, used: i } : null;
}

function verbAt(ws: string[]): { verb: string; used: number } | null {
  const lower = ws.map((w) => w.toLowerCase());
  for (const [phrase, verb] of VERBS) {
    const p = phrase.split(' ');
    if (p.every((w, k) => lower[k] === w)) return { verb, used: p.length };
  }
  return null;
}

/** Parse an order into commands. Throws OrderError with a helpful message. */
export function parseOrder(text: string, ctx: OrderContext): ParsedOrder {
  const ws = words(text.trim().replace(/[.!]$/, ''));
  if (!ws.length) throw new OrderError(`Type an order, e.g. "${ORDER_EXAMPLES[0]}"`);
  const who = readWho(ws, ctx);
  if (!who) throw new OrderError(`Who? Start with the name of one of your units or entities (e.g. "${ORDER_EXAMPLES[0]}")`);
  const v = verbAt(ws.slice(who.used));
  if (!v) throw new OrderError(`${who.targets.map((t) => t.name).join(' and ')}: do what? (move, attack, defend, overwatch, screen, fire, hold fire, stop…)`);
  const r = new Reader(ws, ctx);
  r.i = who.used + v.used;
  const names = who.targets.map((t) => t.name).join(' and ');
  const ids = who.targets.map((t) => t.id);
  const each = (task: TaskSpec): Command[] => ids.map((id) => ({ cmd: 'assignTask', targetId: id, task }));
  let commands: Command[] = [];
  let what = '';
  switch (v.verb) {
    case 'move': {
      const p = r.needPlace('Move');
      let covered = false;
      let speed: number | undefined;
      let speedText = '';
      for (;;) {
        if (r.accept('covered') || r.accept('by', 'a', 'covered', 'route') || r.accept('by', 'covered', 'route') || r.accept('under', 'cover')) covered = true;
        else if (r.accept('fast') || r.accept('quickly') || r.accept('at', 'full', 'speed')) speedText = ' at full speed';
        else if (r.accept('slowly') || r.accept('slow')) speedText = ' slowly';
        else if (r.accept('at')) {
          const kmh = r.number();
          if (kmh === null || !(r.accept('km/h') || r.accept('kph') || r.accept('kmh'))) throw new OrderError('Move: speed as "at 30 km/h"');
          speed = kmh / 3.6;
          speedText = ` at ${kmh} km/h`;
        } else break;
      }
      commands = ids.map((id, k) => {
        const t = who.targets[k];
        // Several movers keep their spacing around the destination.
        const c = centroid(who.targets);
        const target = who.targets.length > 1 ? round({ x: p.at.x + t.x - c.x, y: p.at.y + t.y - c.y }) : p.at;
        // "fast" and "slowly" are relative to each mover's own speeds.
        const s = speedText === ' slowly' && t.cruise ? t.cruise * 0.5 : speedText === ' at full speed' && t.maxSpeed ? t.maxSpeed : speed;
        return { cmd: 'assignTask', targetId: id, task: { type: 'moveTo', target, ...(s !== undefined ? { speed: Math.round(s * 10) / 10 } : {}), ...(covered ? { covered: true } : {}) } } as Command;
      });
      what = `move to ${p.label}${covered ? ' by a covered route' : ''}${speedText}`;
      break;
    }
    case 'attack': {
      const t = r.needObject('Attack', ctx.visible.filter((o) => !ids.includes(o.id)));
      const aim = t.kind === 'unit' ? t.leaderId : t.id;
      if (!aim) throw new OrderError(`Attack: ${t.name} has nobody left to attack`);
      commands = each({ type: 'attack', targetId: aim });
      what = `attack ${t.name}`;
      break;
    }
    case 'strike': {
      const t = r.needObject('Strike', ctx.visible.filter((o) => !ids.includes(o.id)));
      const aim = t.kind === 'unit' ? t.leaderId : t.id;
      if (!aim) throw new OrderError(`Strike: ${t.name} has nobody left to strike`);
      commands = each({ type: 'strike', targetId: aim });
      what = `strike ${t.name}`;
      break;
    }
    case 'loiter':
    case 'swarmSearch': {
      const label = v.verb === 'loiter' ? 'Loiter' : 'Swarm search';
      r.accept('over') || r.accept('above');
      const p = r.needPlace(label);
      let radius: number | undefined;
      if (r.accept('radius')) radius = r.distance() ?? undefined;
      const attack = r.accept('and', 'attack') || r.accept('and', 'strike');
      const area = p.graphic?.kind === 'area' ? p.graphic : undefined;
      if (v.verb === 'swarmSearch' && !area) throw new OrderError('Swarm search: give the name of an area');
      const task: TaskSpec =
        v.verb === 'swarmSearch'
          ? { type: 'swarmSearch', areaId: area!.id, ...(attack ? { attack: true } : {}) }
          : { type: 'loiter', ...(area ? { areaId: area.id } : { center: p.at, radius: radius ?? 1000 }), ...(attack ? { attack: true } : {}) };
      commands = each(task);
      what = `${v.verb === 'loiter' ? 'loiter over' : 'swarm search'} ${p.label}${attack ? ' and attack' : ''}`;
      break;
    }
    case 'swarmAttack': {
      r.accept('in') || r.accept('on');
      const save = r.i;
      const zone = matchName(r.rest(), ctx.graphics.filter((g) => g.kind === 'area'));
      if (zone && 'item' in zone) {
        r.i += zone.used;
        commands = each({ type: 'swarmAttack', areaId: zone.item.id });
        what = `swarm attack in ${zone.item.name}`;
        break;
      }
      r.i = save;
      const t = r.needObject('Swarm attack', ctx.visible.filter((o) => !ids.includes(o.id)));
      const aim = t.kind === 'unit' ? t.leaderId : t.id;
      if (!aim) throw new OrderError(`Swarm attack: ${t.name} has nobody left to attack`);
      commands = each({ type: 'swarmAttack', targetIds: [aim] });
      what = `swarm attack ${t.name}`;
      break;
    }
    case 'follow': {
      const t = r.needObject('Follow', ctx.visible.filter((o) => !ids.includes(o.id)));
      commands = each({ type: 'follow', targetId: t.id });
      what = `follow ${t.name}`;
      break;
    }
    case 'defend':
    case 'overwatch':
    case 'screen': {
      const p = r.needPlace(v.verb[0].toUpperCase() + v.verb.slice(1));
      const facing = r.facing();
      let width: number | undefined;
      if (r.accept('width') || r.accept('frontage')) width = r.distance() ?? r.number() ?? undefined;
      const task = { type: v.verb, position: p.at, ...(facing !== undefined ? { facing } : {}), ...(width ? { width } : {}) } as TaskSpec;
      if (who.targets.length > 1) {
        // Several: side by side across the facing, 300 m apart for units.
        const c = centroid(who.targets);
        const f = facing ?? (Math.atan2(p.at.x - c.x, p.at.y - c.y) * 180) / Math.PI;
        const h = (f * Math.PI) / 180;
        const gap = who.targets.some((t) => t.kind === 'unit') ? 300 : 60;
        const side = (q: Vec2) => (q.x - c.x) * Math.cos(h) - (q.y - c.y) * Math.sin(h);
        const order = who.targets.map((t, k) => ({ k, s: side(t) })).sort((a, b) => a.s - b.s);
        commands = new Array(ids.length);
        order.forEach((o, n) => {
          const off = (n - (order.length - 1) / 2) * gap;
          commands[o.k] = { cmd: 'assignTask', targetId: ids[o.k], task: { ...task, position: round({ x: p.at.x + Math.cos(h) * off, y: p.at.y - Math.sin(h) * off }), facing: Math.round(((f % 360) + 360) % 360) } as TaskSpec };
        });
      } else commands = each(task);
      what = `${v.verb} ${p.label}${facing !== undefined ? ` facing ${facing}°` : ''}`;
      break;
    }
    case 'ambush': {
      const zone = r.needGraphic('Ambush', ['area']);
      let from: Vec2 | undefined;
      if (r.accept('from')) from = r.needPlace('Ambush from').at;
      commands = ids.map((id, k) => ({ cmd: 'assignTask', targetId: id, task: { type: 'ambush', killZoneId: zone.id, position: from ?? round(who.targets[k]) } }));
      what = `ambush ${zone.name}${from ? ` from (${from.x}, ${from.y})` : ' from where they are'}`;
      break;
    }
    case 'search': {
      const zone = r.needGraphic('Search', ['area']);
      commands = each({ type: 'search', areaId: zone.id });
      what = `search ${zone.name}`;
      break;
    }
    case 'patrol':
    case 'followRoute': {
      const route = r.needGraphic(v.verb === 'patrol' ? 'Patrol' : 'Follow route', ['route', 'phaseLine']);
      const reverse = r.accept('reversed') || r.accept('in', 'reverse') || r.accept('backwards');
      commands = each(v.verb === 'patrol' ? { type: 'patrol', routeId: route.id } : { type: 'followRoute', routeId: route.id, ...(reverse ? { reverse: true } : {}) });
      what = `${v.verb === 'patrol' ? 'patrol' : 'follow route'} ${route.name}${reverse ? ' in reverse' : ''}`;
      break;
    }
    case 'fire':
    case 'smoke': {
      let rounds = v.verb === 'smoke' ? 2 : 3;
      const n = r.number();
      if (n !== null) {
        rounds = Math.max(1, Math.min(20, Math.round(n)));
        r.accept('rounds') || r.accept('round');
      }
      if (v.verb === 'fire') r.accept('smoke') && (v.verb = 'smoke');
      const p = r.needPlace(v.verb === 'smoke' ? 'Smoke' : 'Fire');
      commands = ids.map((id, k) => ({ cmd: 'assignTask', targetId: id, task: { type: 'fireMission', target: p.at, rounds, radius: who.targets[k].kind === 'unit' ? (v.verb === 'smoke' ? 60 : 50) : 0, ...(v.verb === 'smoke' ? { smoke: true } : {}) } }));
      what = `${v.verb === 'smoke' ? 'smoke' : 'fire'} ${rounds} round${rounds === 1 ? '' : 's'} on ${p.label}`;
      break;
    }
    case 'orbit': {
      const p = r.needPlace('Orbit');
      let radius = 2000;
      if (r.accept('radius') || r.accept('at')) radius = r.distance() ?? radius;
      commands = each({ type: 'orbit', center: p.at, radius });
      what = `orbit ${p.label} at ${radius / 1000} km`;
      break;
    }
    case 'mount': {
      const c = r.needObject('Mount', ctx.own.filter((o) => !ids.includes(o.id)));
      commands = each({ type: 'mount', carrierId: c.id });
      what = `mount ${c.name}`;
      break;
    }
    case 'dismount':
      commands = each({ type: 'dismount' });
      what = 'dismount';
      break;
    case 'resupply': {
      let supplierId: string | undefined;
      if (r.accept('from') || r.accept('at')) supplierId = r.needObject('Resupply from', ctx.own).id;
      commands = each({ type: 'resupply', ...(supplierId ? { supplierId } : {}) });
      what = supplierId ? `resupply from ${ctx.own.find((o) => o.id === supplierId)!.name}` : 'resupply at the nearest supply vehicle';
      break;
    }
    case 'breach': {
      const g = r.needGraphic('Breach', ['minefield', 'obstacle']);
      commands = each({ type: 'breach', graphicId: g.id });
      what = `breach a lane through ${g.name}`;
      break;
    }
    case 'wait': {
      r.accept('for');
      const n = r.number();
      if (n === null) throw new OrderError('Wait: for how long? ("wait 2 min")');
      const secs = r.accept('min') || r.accept('minutes') || r.accept('minute') ? n * 60 : r.accept('h') || r.accept('hours') || r.accept('hour') ? n * 3600 : (r.accept('s') || r.accept('seconds') || r.accept('sec'), n);
      commands = each({ type: 'wait', duration: secs });
      what = `wait ${secs} s`;
      break;
    }
    case 'stop':
      commands = ids.map((id) => ({ cmd: 'stop', targetId: id }));
      what = 'stop';
      break;
    case 'holdFire':
    case 'returnFire':
    case 'fireAtWill':
      commands = ids.map((id) => ({ cmd: 'setRoe', targetId: id, roe: v.verb as Roe }));
      what = v.verb === 'holdFire' ? 'hold fire' : v.verb === 'returnFire' ? 'return fire only' : 'fire at will';
      break;
  }
  if (!r.done) throw new OrderError(`Did not understand "${r.rest().join(' ')}" after "${what}"`);
  return { targets: who.targets, commands, description: `${names}: ${what}` };
}

export interface Completion {
  /** What to show. */
  label: string;
  /** The whole input after choosing it. */
  text: string;
}

/** Suggestions for the next words of a partly typed order. */
export function completeOrder(text: string, ctx: OrderContext, max = 8): Completion[] {
  const endsWithSpace = /\s$/.test(text);
  const ws = words(text);
  const head = endsWithSpace ? ws : ws.slice(0, -1);
  const frag = endsWithSpace ? '' : (ws[ws.length - 1] ?? '').toLowerCase();
  const prefix = head.join(' ') + (head.length ? ' ' : '');
  const out: Completion[] = [];
  const offer = (phrases: string[]) => {
    for (const p of phrases) {
      if (out.length >= max) break;
      const lp = p.toLowerCase();
      // Multi-word fragments: match on the whole typed tail.
      if (!lp.startsWith(frag)) continue;
      out.push({ label: p, text: `${prefix}${p} ` });
    }
  };
  const who = head.length ? readWho(head, ctx) : null;
  // Still naming who: complete the name (which may have several words).
  if (!who || who.used < head.length && !verbAt(head.slice(who.used))) {
    const start = who ? who.used + (head[who.used]?.toLowerCase() === 'and' ? 1 : 0) : 0;
    const typed = norm([...head.slice(start), frag].join(' '));
    const before = head.slice(0, start).join(' ') + (start ? ' ' : '');
    for (const o of ctx.own) {
      if (out.length >= max) break;
      if (norm(o.name).startsWith(typed)) out.push({ label: `${o.name}${o.kind === 'unit' ? '' : ` (${o.id})`}`, text: `${before}${o.name} ` });
    }
    if (who && who.used === head.length) offer(['and', ...VERBS.map(([p]) => p)]);
    return out;
  }
  const v = verbAt(head.slice(who.used));
  if (!v) {
    offer(['and', ...new Set(VERBS.map(([p]) => p))]);
    return out;
  }
  const after = head.length - who.used - v.used;
  const places = [...ctx.towns.map((t) => t.name), ...ctx.graphics.map((g) => g.name)];
  switch (v.verb) {
    case 'move':
      if (after === 0) offer(['to', ...places]);
      else offer(['covered', 'fast', 'slowly', 'at', ...places]);
      break;
    case 'attack':
    case 'strike':
    case 'follow':
      offer(ctx.visible.filter((o) => !who.targets.includes(o)).map((o) => o.name));
      break;
    case 'loiter':
    case 'swarmSearch':
      offer(after === 0 ? ['over', ...ctx.graphics.filter((g) => g.kind === 'area').map((g) => g.name)] : ['and attack', ...ctx.graphics.filter((g) => g.kind === 'area').map((g) => g.name)]);
      break;
    case 'swarmAttack':
      offer([...ctx.graphics.filter((g) => g.kind === 'area').map((g) => g.name), ...ctx.visible.filter((o) => !who.targets.includes(o)).map((o) => o.name)]);
      break;
    case 'mount':
    case 'resupply':
      offer(['from', ...ctx.own.filter((o) => !who.targets.includes(o)).map((o) => o.name)]);
      break;
    case 'search':
    case 'ambush':
      offer([...ctx.graphics.filter((g) => g.kind === 'area').map((g) => g.name), 'from']);
      break;
    case 'patrol':
    case 'followRoute':
      offer(ctx.graphics.filter((g) => g.kind === 'route' || g.kind === 'phaseLine').map((g) => g.name));
      break;
    case 'breach':
      offer(ctx.graphics.filter((g) => g.kind === 'minefield' || g.kind === 'obstacle').map((g) => g.name));
      break;
    case 'defend':
    case 'overwatch':
    case 'screen':
      offer(after === 0 ? places : ['facing', 'north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest', 'width', ...places]);
      break;
    default:
      offer(places);
  }
  return out;
}
