// Checking catalog entries made in the catalog editor or sent through the API: every
// field the simulation relies on is there and in range. Only known fields are kept.

import type { ArmorClass, Catalog, DisEntityType, Domain, EntityTypeDef, Formation, SensorDef, SymbolKind, UnitTemplate, WeaponDef } from '../shared/types.js';

export class CatalogError extends Error {}

export type CatalogSection = 'entityTypes' | 'weapons' | 'sensors' | 'unitTemplates';
export const CATALOG_SECTIONS: CatalogSection[] = ['entityTypes', 'weapons', 'sensors', 'unitTemplates'];

const DOMAINS: Domain[] = ['ground', 'lifeform', 'air', 'surface'];
const ARMOR: ArmorClass[] = ['lifeform', 'soft', 'light', 'armored', 'air', 'ship'];
const SYMBOLS: SymbolKind[] = ['armor', 'mech', 'infantry', 'recon', 'wheeled', 'air-defense', 'artillery', 'engineer', 'supply', 'ew', 'rotary', 'fixed-wing', 'uav', 'ship', 'boat', 'generic'];
const FORMATIONS: Formation[] = ['column', 'line', 'wedge', 'vee', 'echelonRight'];
const ECHELONS: UnitTemplate['echelon'][] = ['team', 'section', 'platoon', 'company', 'flight', 'group'];

type Raw = Record<string, unknown>;

function obj(v: unknown, what: string): Raw {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new CatalogError(`${what} must be an object`);
  return v as Raw;
}

function id(v: unknown): string {
  if (typeof v !== 'string' || !/^[a-z0-9][a-z0-9-]{1,47}$/.test(v)) throw new CatalogError('id: 2-48 lower-case letters, digits and -');
  return v;
}

function text(v: unknown, what: string, max = 120, optional = false): string | undefined {
  if (v === undefined && optional) return undefined;
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw new CatalogError(`${what}: text of 1-${max} characters`);
  return v.trim();
}

function num(v: unknown, what: string, min: number, max: number, optional = false): number | undefined {
  if (v === undefined && optional) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw new CatalogError(`${what}: a number from ${min} to ${max}`);
  return v;
}

function bool(v: unknown, what: string): boolean | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'boolean') throw new CatalogError(`${what}: true or false`);
  return v || undefined;
}

function oneOf<T extends string>(v: unknown, what: string, options: readonly T[]): T {
  if (!options.includes(v as T)) throw new CatalogError(`${what}: one of ${options.join(', ')}`);
  return v as T;
}

function list<T extends string>(v: unknown, what: string, options?: readonly T[], max = 20): T[] {
  if (!Array.isArray(v) || v.length > max) throw new CatalogError(`${what}: a list of at most ${max}`);
  return v.map((x) => {
    if (typeof x !== 'string') throw new CatalogError(`${what}: a list of names`);
    if (options && !options.includes(x as T)) throw new CatalogError(`${what}: each one of ${options.join(', ')}`);
    return x as T;
  });
}

function dis(v: unknown, what: string): DisEntityType {
  const d = obj(v ?? { kind: 1, domain: 1, country: 0, category: 0, subcategory: 0, specific: 0, extra: 0 }, what);
  const f = (k: string, max: number) => num(d[k] ?? 0, `${what}.${k}`, 0, max)!;
  return { kind: f('kind', 255), domain: f('domain', 255), country: f('country', 65535), category: f('category', 255), subcategory: f('subcategory', 255), specific: f('specific', 255), extra: f('extra', 255) };
}

/** Drop the keys left undefined, so stored entries stay tidy. */
function tidy<T extends object>(o: T): T {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined) delete o[k];
  return o;
}

/** Armour by aspect (mm RHA): all four faces, each from 0 to 5000. */
function aspects(p: Raw): NonNullable<EntityTypeDef['protection']> {
  const f = (k: string) => num(p[k], `protection.${k} (mm)`, 0, 5000)!;
  return { front: f('front'), side: f('side'), rear: f('rear'), top: f('top') };
}

export function validateEntityType(v: unknown): EntityTypeDef {
  const t = obj(v, 'entity type');
  const key = id(t.id);
  const domain = oneOf(t.domain, 'domain', DOMAINS);
  const maxSpeed = num(t.maxSpeed, 'maxSpeed', 0.1, 1000)!;
  const cruiseSpeed = num(t.cruiseSpeed, 'cruiseSpeed', 0.1, maxSpeed)!;
  const endurance = t.endurance === undefined ? undefined : obj(t.endurance, 'endurance');
  const supply = t.supply === undefined ? undefined : obj(t.supply, 'supply');
  const jammer = t.jammer === undefined ? undefined : obj(t.jammer, 'jammer');
  if (jammer && !jammer.radio && !jammer.radar) throw new CatalogError('jammer: jams radio, radar or both');
  const protection = t.protection === undefined ? undefined : obj(t.protection, 'protection');
  if (t.sidc !== undefined && (typeof t.sidc !== 'string' || !/^[A-Z*-]{10,15}$/.test(t.sidc))) throw new CatalogError('sidc: a MIL-STD-2525C letter code such as S-G-UCFM--');
  return tidy({
    id: key,
    name: text(t.name, 'name')!,
    description: text(t.description ?? t.name, 'description', 400)!,
    domain,
    symbol: oneOf(t.symbol ?? 'generic', 'symbol', SYMBOLS),
    sidc: t.sidc as string | undefined,
    armor: oneOf(t.armor, 'armor', ARMOR),
    protection: protection ? aspects(protection) : undefined,
    rcs: num(t.rcs, 'rcs (m²)', 0.0001, 1e6, true),
    dis: dis(t.dis, 'dis'),
    maxSpeed,
    cruiseSpeed,
    minSpeed: num(t.minSpeed, 'minSpeed', 0, cruiseSpeed, true),
    acceleration: num(t.acceleration, 'acceleration', 0.01, 100)!,
    turnRate: num(t.turnRate, 'turnRate (rad/s)', 0.001, 10)!,
    offroadFactor: num(t.offroadFactor ?? 1, 'offroadFactor', 0, 1)!,
    cruiseAltitude: num(t.cruiseAltitude, 'cruiseAltitude', 0, 20000, true),
    climbRate: num(t.climbRate, 'climbRate', 0, 500, true),
    sensorHeight: num(t.sensorHeight ?? 2, 'sensorHeight', 0, 100)!,
    sensors: list(t.sensors ?? [], 'sensors'),
    weapons: list(t.weapons ?? [], 'weapons'),
    crew: num(t.crew ?? 1, 'crew', 0, 10000)!,
    capacity: num(t.capacity, 'capacity', 0, 500, true),
    smokeGrenades: num(t.smokeGrenades, 'smokeGrenades', 0, 50, true),
    breachTime: num(t.breachTime, 'breachTime', 1, 36000, true),
    endurance: endurance ? tidy({ km: num(endurance.km, 'endurance.km', 1, 100000, true), hours: num(endurance.hours, 'endurance.hours', 0.1, 1000, true) }) : undefined,
    supply: supply ? { capacity: num(supply.capacity, 'supply.capacity', 0.1, 1000)! } : undefined,
    jammer: jammer ? tidy({ range: num(jammer.range, 'jammer.range', 100, 500000)!, radio: bool(jammer.radio, 'jammer.radio'), radar: bool(jammer.radar, 'jammer.radar') }) : undefined,
  } as EntityTypeDef);
}

export function validateWeapon(v: unknown): WeaponDef {
  const w = obj(v, 'weapon');
  const key = id(w.id);
  const minRange = num(w.minRange ?? 0, 'minRange', 0, 1e6)!;
  const pkRaw = obj(w.pk ?? {}, 'pk');
  const pk: WeaponDef['pk'] = {};
  for (const [k, p] of Object.entries(pkRaw)) pk[oneOf(k, 'pk class', ARMOR)] = num(p, `pk.${k}`, 0, 1)!;
  const smoke = w.smoke === undefined ? undefined : obj(w.smoke, 'smoke');
  return tidy({
    id: key,
    name: text(w.name, 'name')!,
    munition: dis(w.munition, 'munition'),
    minRange,
    maxRange: num(w.maxRange, 'maxRange', minRange + 1, 1e6)!,
    reloadTime: num(w.reloadTime, 'reloadTime', 0.05, 3600)!,
    ammo: num(w.ammo, 'ammo', 1, 100000)!,
    projectileSpeed: num(w.projectileSpeed, 'projectileSpeed', 1, 20000)!,
    pk,
    targets: list(w.targets ?? [], 'targets', DOMAINS),
    guided: bool(w.guided, 'guided'),
    commandGuided: bool(w.commandGuided, 'commandGuided'),
    indirect: bool(w.indirect, 'indirect'),
    blastRadius: num(w.blastRadius, 'blastRadius', 0, 5000, true),
    dispersion: num(w.dispersion, 'dispersion', 0, 5000, true),
    smoke: smoke ? { radius: num(smoke.radius, 'smoke.radius', 1, 1000)!, duration: num(smoke.duration, 'smoke.duration', 1, 3600)! } : undefined,
    penetration: num(w.penetration, 'penetration (mm)', 0, 5000, true),
    topAttack: bool(w.topAttack, 'topAttack'),
    spreadMrad: num(w.spreadMrad, 'spreadMrad', 0, 100, true),
    rangeError: num(w.rangeError, 'rangeError', 0, 1, true),
  } as WeaponDef);
}

export function validateSensor(v: unknown): SensorDef {
  const s = obj(v, 'sensor');
  const key = id(s.id);
  return tidy({
    id: key,
    name: text(s.name, 'name')!,
    maxRange: num(s.maxRange, 'maxRange', 1, 1e6)!,
    fov: num(s.fov ?? Math.PI * 2, 'fov (rad)', 0.01, Math.PI * 2)!,
    detects: list(s.detects ?? [], 'detects', DOMAINS),
    radar: bool(s.radar, 'radar'),
    thermal: bool(s.thermal, 'thermal'),
    nightVision: bool(s.nightVision, 'nightVision'),
    refRange: num(s.refRange, 'refRange', 1, 1e6, true),
    refRcs: num(s.refRcs, 'refRcs (m²)', 0.0001, 1e6, true),
  } as SensorDef);
}

export function validateUnitTemplate(v: unknown): UnitTemplate {
  const u = obj(v, 'unit template');
  const key = id(u.id);
  const members = list(u.members, 'members', undefined, 50);
  if (!members.length) throw new CatalogError('members: at least one entity type');
  return tidy({
    id: key,
    name: text(u.name, 'name')!,
    echelon: oneOf(u.echelon ?? 'platoon', 'echelon', ECHELONS),
    members,
    formation: oneOf(u.formation ?? 'wedge', 'formation', FORMATIONS),
    spacing: num(u.spacing ?? 50, 'spacing', 1, 5000)!,
    subunits: u.subunits === undefined ? undefined : list(u.subunits, 'subunits', undefined, 10),
  } as UnitTemplate);
}

export const VALIDATORS: Record<CatalogSection, (v: unknown) => { id: string }> = {
  entityTypes: validateEntityType,
  weapons: validateWeapon,
  sensors: validateSensor,
  unitTemplates: validateUnitTemplate,
};

/** A catalog extension with every entry checked. */
export function validateCatalogExtension(v: unknown): Partial<Catalog> {
  const c = obj(v, 'catalog');
  const out: Partial<Catalog> = {};
  for (const s of CATALOG_SECTIONS) {
    if (c[s] === undefined) continue;
    if (!Array.isArray(c[s])) throw new CatalogError(`${s} must be a list`);
    (out as Record<string, unknown[]>)[s] = (c[s] as unknown[]).map((e, i) => {
      try {
        return VALIDATORS[s](e);
      } catch (err) {
        throw new CatalogError(`${s}[${i}]: ${(err as Error).message}`);
      }
    });
  }
  return out;
}
