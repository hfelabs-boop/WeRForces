// Quick battle: build a ready-to-run scenario from a few choices (mission, the two
// forces and their support, time and weather). Forces are placed on land either side of
// an objective, given the graphics a planner would draw, and a synchronization matrix
// each, so the battle runs as soon as the clock starts.

import { rotateOffset } from '../shared/math.js';
import type { Environment, ForceId, Formation, Phase, PhaseOrder, Precipitation, TaskSpec, TerrainSpec, UnitTemplate, Vec2 } from '../shared/types.js';
import type { Engine } from './engine.js';
import { Rng } from './rng.js';
import type { Unit } from './units.js';

export class WizardError extends Error {}

export type Mission = 'meeting' | 'attack' | 'defend' | 'delay' | 'recon';
export type Composition = 'armor' | 'mech' | 'infantry' | 'combined';
export type ForceSize = 'platoon' | 'company';
export type Support = 'artillery' | 'recon' | 'engineers' | 'supply' | 'air' | 'airDefense' | 'drones';
export type Nation = 'us' | 'ru';
export type Weather = 'clear' | 'haze' | 'fog' | 'rain';

export const MISSIONS: Mission[] = ['meeting', 'attack', 'defend', 'delay', 'recon'];
export const COMPOSITIONS: Composition[] = ['armor', 'mech', 'infantry', 'combined'];
export const SIZES: ForceSize[] = ['platoon', 'company'];
export const SUPPORTS: Support[] = ['artillery', 'recon', 'engineers', 'supply', 'air', 'airDefense', 'drones'];
export const WEATHERS: Weather[] = ['clear', 'haze', 'fog', 'rain'];

export const MISSION_TEXT: Record<Mission, string> = {
  meeting: 'Meeting engagement: both sides advance on the objective',
  attack: 'Blue attacks: seize the objective Red defends',
  defend: 'Blue defends: hold the objective against Red’s attack',
  delay: 'Blue delays: screen, then fall back as Red pushes through',
  recon: 'Blue reconnoitres: find Red’s positions in the named area',
};

export interface WizardSide {
  nation?: Nation;
  composition?: Composition;
  size?: ForceSize;
  support?: Support[];
}

export interface WizardOptions {
  name?: string;
  /** Same seed and options, same battle. Random when left out. */
  seed?: number;
  mission?: Mission;
  blue?: WizardSide;
  red?: WizardSide;
  /** Terrain to fight on; the current terrain when left out. */
  terrain?: Partial<TerrainSpec>;
  /** Metres between the two sides at the start (default by size: 3 km platoon, 5 km company). */
  distance?: number;
  /** Local time at the start, hours (default 10). */
  time?: number;
  weather?: Weather;
  /** Civilian traffic and pedestrians in the towns. */
  civilians?: boolean;
  /** Sides run by the rule-based commander instead of a phase plan. */
  commander?: { blue?: 'none' | 'rules'; red?: 'none' | 'rules' };
}

export interface WizardResult {
  seed: number;
  name: string;
  description: string;
  mission: Mission;
  objective: Vec2;
  /** The top unit of each side (blue, red). */
  blueId: string;
  redId: string;
}

interface SideKit {
  armor: string;
  mech: string;
  squad: string;
  rifleman: string;
  recon: string;
  mortars: string;
  guns: string;
  engineers: string;
  supply: string;
  air: { template?: string; type?: string };
  airDefense: string;
  /** Drones: a recon UAV team (spots for the guns) and loitering munitions (hunt armour), each with its operators. */
  drones: { recon: string; strike: string };
}

const KITS: Record<Nation, SideKit> = {
  us: {
    armor: 'us-tank-platoon',
    mech: 'us-mech-platoon',
    squad: 'us-rifle-squad',
    rifleman: 'us-rifleman',
    recon: 'us-scout-section',
    mortars: 'us-mortar-section',
    guns: 'us-paladin-platoon',
    engineers: 'us-engineer-squad',
    supply: 'us-supply-section',
    air: { template: 'us-attack-team' },
    airDefense: 'us-stinger-team',
    drones: { recon: 'us-raven-team', strike: 'us-switchblade-section' },
  },
  ru: {
    armor: 'ru-tank-platoon',
    mech: 'ru-mech-platoon',
    squad: 'ru-rifle-squad',
    rifleman: 'ru-rifleman',
    recon: 'ru-recon-patrol',
    mortars: 'ru-mortar-battery',
    guns: 'ru-msta-battery',
    engineers: 'ru-sapper-squad',
    supply: 'ru-supply-section',
    air: { type: 'ru-mi24' },
    airDefense: 'ru-sa8',
    drones: { recon: 'ru-orlan-team', strike: 'ru-lancet-section' },
  },
};

const OBJECTIVES = ['IRON', 'ANVIL', 'COBRA', 'FALCON', 'GRANITE', 'HAMMER', 'LANCE', 'MAPLE', 'ONYX', 'RAVEN'];
const WEATHER_ENV: Record<Weather, { visibility: number; precipitation: Precipitation }> = {
  clear: { visibility: 30000, precipitation: 'none' },
  haze: { visibility: 6000, precipitation: 'none' },
  fog: { visibility: 800, precipitation: 'none' },
  rain: { visibility: 5000, precipitation: 'rain' },
};

/** A force organisation: a catalog template, or an HQ with subordinate organisations. */
type Org = { template: string } | { name: string; echelon: UnitTemplate['echelon']; hq: string; formation: Formation; spacing: number; children: Org[] };

const ORDINAL = ['1st', '2nd', '3rd', '4th', '5th'];
const LABEL: Record<Composition, string> = { armor: 'Armor', mech: 'Mech', infantry: 'Rifle', combined: 'Combined Arms' };

function firstMember(engine: Engine, template: string): string {
  return engine.catalog.templates.get(template)!.members[0];
}

function organisation(engine: Engine, nation: Nation, composition: Composition, size: ForceSize): Org {
  const k = KITS[nation];
  const N = nation.toUpperCase();
  const rifle = (name: string): Org => ({ name, echelon: 'platoon', hq: k.rifleman, formation: 'line', spacing: 150, children: [0, 1, 2].map(() => ({ template: k.squad })) });
  if (size === 'platoon') {
    if (composition === 'armor') return { template: k.armor };
    if (composition === 'mech') return { template: k.mech };
    if (composition === 'infantry') return rifle(`${N} Rifle Platoon`);
    return { name: `${N} Combined Arms Team`, echelon: 'company', hq: firstMember(engine, k.armor), formation: 'line', spacing: 350, children: [{ template: k.armor }, { template: k.mech }] };
  }
  const name = `${N} ${LABEL[composition]} Company`;
  if (composition === 'infantry') return { name, echelon: 'company', hq: k.rifleman, formation: 'line', spacing: 450, children: [0, 1, 2].map((i) => rifle(`${name} ${ORDINAL[i]} Platoon`)) };
  const platoons = composition === 'armor' ? [k.armor, k.armor, k.armor] : composition === 'mech' ? [k.mech, k.mech, k.mech] : [k.armor, k.mech, k.mech];
  return { name, echelon: 'company', hq: firstMember(engine, composition === 'mech' ? k.mech : k.armor), formation: 'line', spacing: 450, children: platoons.map((template) => ({ template })) };
}

function pick<T>(v: unknown, options: readonly T[], fallback: T, what: string): T {
  if (v === undefined) return fallback;
  if (!options.includes(v as T)) throw new WizardError(`${what}: one of ${options.join(', ')}`);
  return v as T;
}

/** Check and fill in the options, with the defaults for anything left out. */
export interface NormalizedWizardOptions extends Required<Omit<WizardOptions, 'terrain' | 'distance' | 'blue' | 'red' | 'commander'>> {
  blue: Required<WizardSide>;
  red: Required<WizardSide>;
  commander: { blue: 'none' | 'rules'; red: 'none' | 'rules' };
  terrain?: Partial<TerrainSpec>;
  distance?: number;
}

export function normalizeWizardOptions(o: WizardOptions): NormalizedWizardOptions {
  const side = (s: WizardSide | undefined, nation: Nation, what: string): Required<WizardSide> => {
    if (s !== undefined && (typeof s !== 'object' || s === null)) throw new WizardError(`${what} must be an object`);
    const support = s?.support ?? [];
    if (!Array.isArray(support)) throw new WizardError(`${what}.support must be a list`);
    return {
      nation: pick(s?.nation, ['us', 'ru'] as Nation[], nation, `${what}.nation`),
      composition: pick(s?.composition, COMPOSITIONS, 'mech', `${what}.composition`),
      size: pick(s?.size, SIZES, 'platoon', `${what}.size`),
      support: [...new Set(support.map((x) => pick(x, SUPPORTS, 'recon', `${what}.support`)))],
    };
  };
  if (o.distance !== undefined && (typeof o.distance !== 'number' || !(o.distance >= 1000 && o.distance <= 20000))) throw new WizardError('distance: 1000 to 20000 m');
  if (o.time !== undefined && (typeof o.time !== 'number' || !(o.time >= 0 && o.time < 24))) throw new WizardError('time: hours from 0 to 24');
  if (o.seed !== undefined && (typeof o.seed !== 'number' || !Number.isFinite(o.seed))) throw new WizardError('seed must be a number');
  if (o.name !== undefined && (typeof o.name !== 'string' || o.name.length > 80)) throw new WizardError('name: up to 80 characters');
  if (o.commander !== undefined && (typeof o.commander !== 'object' || o.commander === null)) throw new WizardError('commander must be an object, e.g. {"red": "rules"}');
  return {
    name: o.name?.trim() ?? '',
    seed: o.seed === undefined ? Math.floor(Math.random() * 1e6) : Math.floor(o.seed),
    mission: pick(o.mission, MISSIONS, 'attack', 'mission'),
    blue: side(o.blue, 'us', 'blue'),
    red: side(o.red, 'ru', 'red'),
    terrain: o.terrain,
    distance: o.distance,
    time: o.time ?? 10,
    weather: pick(o.weather, WEATHERS, 'clear', 'weather'),
    civilians: o.civilians === true,
    commander: {
      blue: pick(o.commander?.blue, ['none', 'rules'] as const, 'none', 'commander.blue'),
      red: pick(o.commander?.red, ['none', 'rules'] as const, 'none', 'commander.red'),
    },
  };
}

/** Replace the scenario with a generated battle. */
export function generateBattle(engine: Engine, options: WizardOptions): WizardResult {
  const o = normalizeWizardOptions(options);
  const rng = new Rng(o.seed ^ 0xba771e);
  const terrain = o.terrain ?? (engine.terrain.spec.dataset ? { dataset: engine.terrain.spec.dataset } : engine.terrain.spec);
  engine.newScenario('Quick battle', terrain);
  const S = engine.terrain.spec.size;
  const margin = Math.min(600, S * 0.05);
  const big = o.blue.size === 'company' || o.red.size === 'company';
  let D = Math.min(o.distance ?? (big ? 5000 : 3000), S * 0.8);

  // The objective: a town near the middle if there is one, else a point near the middle.
  const mid = { x: S / 2, y: S / 2 };
  const towns = engine.terrain.towns.filter((t) => Math.hypot(t.x - mid.x, t.y - mid.y) < S * 0.3);
  const town = towns.length ? towns[rng.int(0, towns.length)] : undefined;
  const land = (p: Vec2, r = 1500): Vec2 | null => engine.findValidPosition({ x: clamp(p.x, margin, S - margin), y: clamp(p.y, margin, S - margin) }, 'ground', r);
  const objective = land(town ?? { x: mid.x + rng.range(-0.1, 0.1) * S, y: mid.y + rng.range(-0.1, 0.1) * S }, S / 4);
  if (!objective) throw new WizardError('no dry land near the middle of this terrain');

  // The axis: blue comes from -u, red from +u. Try directions until both sides are on land in the map.
  const inside = (p: Vec2) => p.x >= margin && p.y >= margin && p.x <= S - margin && p.y <= S - margin;
  let theta = rng.range(0, Math.PI * 2);
  let blueStart: Vec2 | null = null;
  let redStart: Vec2 | null = null;
  const [bFrac, rFrac] = o.mission === 'meeting' ? [0.5, 0.5] : o.mission === 'attack' || o.mission === 'recon' ? [1, 0] : [0, 1];
  for (let attempt = 0; attempt < 80 && !(blueStart && redStart); attempt++) {
    if (attempt && attempt % 16 === 0) D *= 0.8;
    if (attempt) theta = rng.range(0, Math.PI * 2);
    const u = { x: Math.sin(theta), y: Math.cos(theta) };
    const b = { x: objective.x - u.x * D * bFrac, y: objective.y - u.y * D * bFrac };
    const r = { x: objective.x + u.x * D * rFrac, y: objective.y + u.y * D * rFrac };
    if (!inside(b) || !inside(r)) continue;
    blueStart = bFrac ? land(b, 500) : objective;
    redStart = rFrac ? land(r, 500) : objective;
    // Both sides must be able to drive to the objective (not cut off by a lake).
    const reach = (p: Vec2 | null) => !!p && (p === objective || !!engine.terrain.planRoute(p, objective, 'ground', 0.6));
    if (!reach(blueStart) || !reach(redStart)) blueStart = redStart = null;
  }
  if (!blueStart || !redStart) throw new WizardError('could not fit the two forces on this terrain; try a shorter distance or a bigger map');
  const u = { x: Math.sin(theta), y: Math.cos(theta) };
  const along = (p: Vec2, d: number): Vec2 => ({ x: clamp(p.x + u.x * d, margin, S - margin), y: clamp(p.y + u.y * d, margin, S - margin) });
  const across = (p: Vec2, d: number): Vec2 => ({ x: p.x + u.y * d, y: p.y - u.x * d });
  const blueHeading = theta;
  const redHeading = theta + Math.PI;
  const deg = (h: number) => Math.round(((((h * 180) / Math.PI) % 360) + 360) % 360);

  // ---------------------------------------------------------------- forces
  const build = (org: Org, force: ForceId, p: Vec2, heading: number, name?: string): Unit => {
    const at = land(p, 600) ?? p;
    if ('template' in org) return engine.createUnitFromTemplate(org.template, force, at.x, at.y, heading, name);
    const own = name ?? org.name;
    const hqAt = land({ x: at.x + rotateOffset({ x: 0, y: -org.spacing * 0.6 }, heading).x, y: at.y + rotateOffset({ x: 0, y: -org.spacing * 0.6 }, heading).y }, 400) ?? at;
    const hqEntity = engine.createEntity({ typeId: org.hq, force, x: hqAt.x, y: hqAt.y, heading });
    const hq = engine.groupUnit([hqEntity.id], own, org.formation, 80, org.echelon);
    hqEntity.name = `${own} HQ`;
    const n = org.children.length;
    org.children.forEach((child, k) => {
      const off = rotateOffset({ x: (k - (n - 1) / 2) * org.spacing, y: 0 }, heading);
      const sub = build(child, force, { x: at.x + off.x, y: at.y + off.y }, heading, `${own} ${ORDINAL[k]} ${'template' in child ? echelonName(engine, child.template) : 'Platoon'}`);
      sub.parentId = hq.id;
    });
    return hq;
  };
  const blue = build(organisation(engine, o.blue.nation, o.blue.composition, o.blue.size), 1, blueStart, blueHeading);
  const red = build(organisation(engine, o.red.nation, o.red.composition, o.red.size), 2, redStart, redHeading);

  // ---------------------------------------------------------------- graphics
  const objName = OBJECTIVES[rng.int(0, OBJECTIVES.length)];
  const ring = (c: Vec2, r: number, n = 8): Vec2[] => Array.from({ length: n }, (_, i) => ({ x: c.x + Math.sin((i / n) * Math.PI * 2) * r, y: c.y + Math.cos((i / n) * Math.PI * 2) * r }));
  const line = (c: Vec2, half: number): Vec2[] => [across(c, -half), across(c, half)];
  const width = (size: ForceSize) => (size === 'company' ? 1400 : 500);
  const both = (kind: 'area' | 'point' | 'phaseLine', points: Vec2[], name: string) => {
    engine.addGraphic(kind, points, name, 1);
    engine.addGraphic(kind, points, name, 2);
  };
  engine.addGraphic('area', ring(objective, 400), `OBJ ${objName}`, 1);
  engine.addGraphic('area', ring(objective, 400), `OBJ ${objName}`, 2);

  const phases: Record<number, Phase[]> = { 1: [], 2: [] };
  // Given as tasks, not text: the sync matrix dialog shows them as their description.
  const order = (u: Unit | { id: string }, task: TaskSpec): PhaseOrder => ({ targetId: u.id, task });
  const opener = { type: 'time', time: 1 } as const;
  const lines: string[] = [];
  const sideName = (s: Required<WizardSide>, top: Unit) => `${top.name}${s.support.length ? ` with ${s.support.map(supportName).join(', ')}` : ''}`;

  /** An attack by `att` (force fa) from `start` on the objective, which `def` holds. */
  const attack = (fa: ForceId, att: Unit, attSide: Required<WizardSide>, start: Vec2, toward: number) => {
    const attackPos = land(along(objective, (fa === 1 ? -1 : 1) * Math.min(1500, D * 0.45)), 400) ?? start;
    engine.addGraphic('point', [attackPos], 'ATK POS', fa);
    engine.addGraphic('phaseLine', line(attackPos, width(attSide.size)), 'PL LD', fa);
    const subs = engine.subordinatesOf(att);
    const assault: PhaseOrder[] = [];
    if (subs.length >= 3) {
      // Support by fire with one platoon while the others assault: for about as long as the
      // assault takes to cross to the objective (at ~5 m/s), so the next phase can start.
      const cross = Math.hypot(objective.x - attackPos.x, objective.y - attackPos.y);
      assault.push(order(subs[0], { type: 'overwatch', position: attackPos, facing: deg(toward), duration: Math.round(cross / 5 + 120) }));
      for (const s of subs.slice(1)) assault.push(order(s, { type: 'moveTo', target: objective }));
    } else {
      assault.push(order(att, { type: 'moveTo', target: objective }));
    }
    phases[fa].push(
      { id: 'P1', name: 'Move', trigger: opener, orders: [order(att, { type: 'moveTo', target: attackPos })] },
      { id: 'P2', name: 'Assault', trigger: { type: 'previousDone', delay: 30 }, orders: assault },
      { id: 'P3', name: 'Consolidate', trigger: { type: 'previousDone', delay: 10 }, orders: [order(att, { type: 'defend', position: objective, facing: deg(toward), width: width(attSide.size) })] },
    );
    return attackPos;
  };
  const defend = (fd: ForceId, def: Unit, defSide: Required<WizardSide>, facing: number) => {
    engine.addGraphic('area', ring(objective, width(defSide.size) / 2 + 150, 6), 'BP 1', fd);
    phases[fd].push({ id: 'P1', name: 'Defend', trigger: { type: 'time', time: 0 }, orders: [order(def, { type: 'defend', position: objective, facing: deg(facing), width: width(defSide.size) })] });
    if (defSide.support.includes('engineers')) {
      // A minefield the defence laid in front of its position.
      const c = along(objective, (fd === 1 ? 1 : -1) * 700);
      const half = width(defSide.size) / 2 + 200;
      const f = engine.addGraphic('minefield', [across(along(c, -40), -half), across(along(c, -40), half), across(along(c, 40), half), across(along(c, 40), -half)], 'MINEFIELD 1', fd);
      f.density = 0.5;
      engine.obstacles.changed();
    }
  };

  switch (o.mission) {
    case 'meeting': {
      both('phaseLine', line(objective, Math.max(width(o.blue.size), width(o.red.size))), 'PL CONTACT');
      phases[1].push({ id: 'P1', name: 'Advance', trigger: opener, orders: [order(blue, { type: 'moveTo', target: objective })] });
      phases[2].push({ id: 'P1', name: 'Advance', trigger: opener, orders: [order(red, { type: 'moveTo', target: objective })] });
      lines.push(`Both sides advance on OBJ ${objName}${town ? ` (${town.name})` : ''}, ${km(D)} apart at the start. Blue: ${sideName(o.blue, blue)}. Red: ${sideName(o.red, red)}.`);
      break;
    }
    case 'attack':
      defend(2, red, o.red, redHeading);
      attack(1, blue, o.blue, blueStart, blueHeading);
      lines.push(`Blue (${sideName(o.blue, blue)}) attacks from ${km(D)} out to seize OBJ ${objName}${town ? ` at ${town.name}` : ''}. Red (${sideName(o.red, red)}) defends it.`);
      break;
    case 'defend':
      defend(1, blue, o.blue, blueHeading);
      attack(2, red, o.red, redStart, redHeading);
      lines.push(`Red (${sideName(o.red, red)}) attacks from ${km(D)} out to seize OBJ ${objName}${town ? ` at ${town.name}` : ''}. Blue (${sideName(o.blue, blue)}) holds it.`);
      break;
    case 'delay': {
      const rear = land(along(objective, -D * 0.7), 800) ?? objective;
      engine.addGraphic('phaseLine', line(objective, width(o.blue.size) + 300), 'PL 1', 1);
      engine.addGraphic('phaseLine', line(rear, width(o.blue.size) + 300), 'PL 2', 1);
      engine.addGraphic('point', [rear], `OBJ ${objName} 2`, 2);
      phases[1].push({ id: 'P1', name: 'Screen', trigger: { type: 'time', time: 0 }, orders: [order(blue, { type: 'screen', position: objective, facing: deg(blueHeading), width: width(o.blue.size), fallback: rear })] });
      phases[2].push({ id: 'P1', name: 'Advance', trigger: opener, orders: [order(red, { type: 'moveTo', target: rear })] });
      lines.push(`Blue (${sideName(o.blue, blue)}) screens on PL 1 at OBJ ${objName} and falls back to PL 2 when Red closes. Red (${sideName(o.red, red)}) pushes through from ${km(D)} out.`);
      break;
    }
    case 'recon': {
      const nai = engine.addGraphic('area', ring(objective, Math.min(D * 0.35, 2000), 8), 'NAI 1', 1);
      phases[1].push({ id: 'P1', name: 'Reconnoitre', trigger: opener, orders: [order(blue, { type: 'search', areaId: nai.id })] });
      // Red is spread through the area in hidden positions.
      const parts = engine.subordinatesOf(red).length ? engine.subordinatesOf(red) : [red];
      phases[2].push({
        id: 'P1',
        name: 'Hide',
        trigger: { type: 'time', time: 0 },
        orders: parts.map((p, i) => {
          const spot = land(ring(objective, parts.length > 1 ? Math.min(D * 0.25, 1400) : 0, parts.length)[i], 400) ?? objective;
          return order(p, { type: 'defend', position: spot, facing: deg(redHeading), width: 300 });
        }),
      });
      for (const p of parts) engine.setRoe(p.id, 'returnFire');
      lines.push(`Blue (${sideName(o.blue, blue)}) searches NAI 1 around ${town ? town.name : `OBJ ${objName}`} for Red (${sideName(o.red, red)}), which lies hidden in it and only returns fire.`);
      break;
    }
  }

  // ---------------------------------------------------------------- support
  const support = (force: ForceId, s: Required<WizardSide>, top: Unit, start: Vec2, heading: number, attacking: boolean) => {
    const k = KITS[s.nation];
    const back = force === 1 ? -1 : 1;
    const at = (d: number, side = 0) => land(across(along(start, back * d), side), 1000) ?? start;
    const extra: PhaseOrder[] = [];
    if (s.support.includes('artillery')) {
      const guns = s.size === 'company' ? k.guns : k.mortars;
      const battery = build({ template: guns }, force, at(s.size === 'company' ? 4000 : 1200), heading);
      if (attacking) {
        const fire = phases[force].find((p) => p.name === 'Assault');
        fire?.orders.push(order(battery, { type: 'fireMission', target: objective, rounds: 4, radius: 150 }));
      }
    }
    if (s.support.includes('recon')) {
      const scouts = build({ template: k.recon }, force, at(-600, 300), heading);
      // Attacking: watch the objective from 1.5 km short of it, on this side. Defending: screen 1.5 km out in front.
      const forward = land(along(objective, back * (attacking || o.mission === 'meeting' ? 1500 : -1500)), 600) ?? objective;
      extra.push(
        attacking || o.mission === 'meeting'
          ? order(scouts, { type: 'overwatch', position: forward, facing: deg(heading) })
          : order(scouts, { type: 'screen', position: forward, facing: deg(heading), width: 600, fallback: objective }),
      );
    }
    if (s.support.includes('engineers') && attacking) {
      const sappers = build({ template: k.engineers }, force, at(300, -200), heading);
      extra.push(order(sappers, { type: 'follow', targetId: top.leader!.id, distance: 250 }));
    }
    if (s.support.includes('supply')) build({ template: k.supply }, force, at(1500), heading);
    if (s.support.includes('air')) {
      const p = at(3000);
      const team = k.air.template
        ? build({ template: k.air.template }, force, p, heading)
        : engine.groupUnit([0, 1].map((i) => engine.createEntity({ typeId: k.air.type!, force, x: p.x + i * 150, y: p.y, heading }).id), `${s.nation.toUpperCase()} Attack Helicopter Team`, 'echelonRight', 200, 'team');
      const holding = { x: (start.x + objective.x) / 2, y: (start.y + objective.y) / 2 };
      extra.push(order(team, { type: 'orbit', center: holding, radius: 1200 }));
    }
    if (s.support.includes('airDefense')) {
      const p = at(700, 250);
      engine.createEntity({ typeId: k.airDefense, force, x: p.x, y: p.y, heading });
    }
    if (s.support.includes('drones')) {
      // The recon UAV circles the objective (and calls for fire on what it sees); the
      // loitering munitions hunt over it, or in front of it when defending.
      const recon = build({ template: k.drones.recon }, force, at(900, -300), heading);
      const strike = build({ template: k.drones.strike }, force, at(900, 300), heading);
      // Operators take the high ground nearby, to see their drones over the hills.
      for (const u of [recon, strike]) {
        const op = engine.entities.get(u.memberList[0].uxs?.controllerId ?? '');
        if (!op) continue;
        let best = { x: op.x, y: op.y, z: engine.terrain.elevation(op.x, op.y) };
        for (let dx = -800; dx <= 800; dx += 100) {
          for (let dy = -800; dy <= 800; dy += 100) {
            const p = { x: clamp(op.x + dx, margin, S - margin), y: clamp(op.y + dy, margin, S - margin) };
            const z = engine.terrain.elevation(p.x, p.y);
            if (z > best.z && Math.hypot(dx, dy) <= 800 && engine.canStand(op.domain, p)) best = { ...p, z };
          }
        }
        op.x = best.x;
        op.y = best.y;
        op.z = best.z;
      }
      const ahead = force === 1 ? 1 : -1;
      const ea = engine.addGraphic('area', ring(attacking ? objective : along(objective, ahead * Math.min(1500, D * 0.4)), 900, 8), 'EA DRONES', force);
      extra.push(order(recon, { type: 'orbit', center: objective, radius: 900 }));
      extra.push(order(strike, { type: 'loiter', areaId: ea.id, attack: true, prefer: ['armored', 'artillery', 'air-defense', 'any'] }));
    }
    // Support gets its orders in a phase of its own first: scouts watching or helicopters
    // holding never finish, and must not hold up a phase that waits for the one before.
    if (extra.length) phases[force].unshift({ id: 'P0', name: 'Deploy', trigger: { type: 'time', time: 0 }, orders: extra });
  };
  const blueAttacks = o.mission === 'attack' || o.mission === 'recon';
  const redAttacks = o.mission === 'defend' || o.mission === 'delay';
  support(1, o.blue, blue, blueStart, blueHeading, blueAttacks || o.mission === 'meeting');
  support(2, o.red, red, redStart, redHeading, redAttacks || o.mission === 'meeting');

  // A side with a commander has no phase plan: the commander runs it from the graphics.
  const commanded = (f: ForceId) => o.commander[f === 1 ? 'blue' : 'red'] === 'rules';
  for (const f of [1, 2] as ForceId[]) {
    if (commanded(f)) {
      engine.commanders.set(f, 'rules', {}, true);
      lines.push(`${f === 1 ? 'Blue' : 'Red'} is run by the rule-based commander.`);
    } else if (phases[f].length) engine.sync.set({ force: f, phases: phases[f] });
  }

  // ---------------------------------------------------------------- setting
  const env: Environment = { time: o.time, ...WEATHER_ENV[o.weather] };
  engine.setEnvironment({ ...engine.env, ...env });
  if (o.civilians) engine.life.set({ vehicles: 20, pedestrians: engine.terrain.towns.length ? 40 : 0 });
  const name = o.name || `${missionTitle(o.mission)} at ${town ? town.name : `OBJ ${objName}`}`;
  engine.scenarioName = name;
  const description = [
    MISSION_TEXT[o.mission] + '.',
    ...lines,
    `Starts at ${String(Math.floor(o.time)).padStart(2, '0')}:${String(Math.round((o.time % 1) * 60)).padStart(2, '0')}, ${o.weather}. ${commanded(1) && commanded(2) ? 'Both sides are run by commanders' : commanded(1) || commanded(2) ? "The other side's plan is in its synchronization matrix (Phases)" : "Each side's plan is in its synchronization matrix (Phases)"}. Seed ${o.seed}.`,
  ].join(' ');
  engine.description = description;
  engine.markRewindPoint();
  engine.log('info', `Quick battle generated: ${name}`);
  return { seed: o.seed, name, description, mission: o.mission, objective, blueId: blue.id, redId: red.id };
}

function echelonName(engine: Engine, template: string): string {
  const e = engine.catalog.templates.get(template)!.echelon;
  return e[0].toUpperCase() + e.slice(1);
}

function supportName(s: Support): string {
  return { artillery: 'artillery', recon: 'scouts', engineers: 'engineers', supply: 'supply', air: 'attack helicopters', airDefense: 'air defence', drones: 'drones' }[s];
}

function missionTitle(m: Mission): string {
  return { meeting: 'Meeting engagement', attack: 'Attack', defend: 'Defence', delay: 'Delay', recon: 'Reconnaissance' }[m];
}

function km(m: number): string {
  return `${(m / 1000).toFixed(1)} km`;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}
