// Emission control, direction finding and anti-radiation missiles.
//
// What an entity radiates: its radars (unless switched off), its jammer while jamming, its
// radio for a while after it transmits (contact reports, calls for fire, acknowledging
// orders, codewords), and the control datalink of a radio-linked unmanned system and of the
// ground control station flying it. Emission control (EMCON) keeps a unit quiet: radio
// silence (it transmits nothing, at the price of the radio, see ew.ts) and radars off.
//
// Direction-finding stations (sensors with `df`) take a bearing once a second to each enemy
// emitter they hear within range and line of sight. Bearings from the stations of a force
// are pooled: one station gives a fix along its bearing with a poor range from signal
// strength, two or more cross their bearings (weighted least squares) into a much tighter
// one. A station has to report its bearings, so one that is radio jammed or silent adds
// nothing. Fixes are the force's DF contacts: they can be fired on (call for fire, or a
// fire mission at the fix) and they cue anti-radiation missiles.

import { bearing, DEG, dist2d } from '../shared/math.js';
import type { DfBearing, DfContact, EmissionBand, EntityTypeDef, ForceId, ScenarioFile, SensorDef, TaskSpec } from '../shared/types.js';
import { applyBlast, type Detonation, type Shot } from './combat.js';
import type { Engine } from './engine.js';
import type { Entity } from './entity.js';
import { availableFireUnits, CALL_FOR_FIRE_INTERVAL, covered, dangerClose } from './fires.js';
import { reloadFactor } from './morale.js';
import { DEFAULT_MISSION_ROUNDS } from './tasks.js';

/** Seconds a radio transmission stays on the air for direction finders (a report, a call, an acknowledgement). */
export const RADIO_HEARD_FOR = 10;
/** Bearings older than this (s, behind the newest) are not used in a fix. */
export const DF_KEEP = 10;
/** A DF contact is dropped this long (s) after its last bearing. */
export const DF_TIMEOUT = 30;
/** One-sigma bearing error of a DF sensor that gives none. */
export const DEFAULT_BEARING_ERROR = 2 * DEG;
/** One-sigma error of a single station's range estimate from signal strength, as a log-normal sigma. */
export const RANGE_ESTIMATE_ERROR = 0.35;
/** The uncertainty ellipse is drawn at this many sigma (about 86 % in two dimensions). */
const ELLIPSE_SIGMA = 2;
/** DF stations call for fire on fixes whose ellipse is no longer than this (semi-major, m). */
export const DF_FIRE_ACCURACY = 1000;
/** One-sigma miss (m) of an anti-radiation missile flying on to where its emitter fell silent. */
export const ARM_MEMORY_ERROR = 30;

const radarTypes = new WeakMap<EntityTypeDef, boolean>();
const armTypes = new WeakMap<EntityTypeDef, string[]>();
const dfSensors = new WeakMap<EntityTypeDef, SensorDef[]>();

function hasRadar(engine: Engine, t: EntityTypeDef): boolean {
  let v = radarTypes.get(t);
  if (v === undefined) radarTypes.set(t, (v = t.sensors.some((id) => engine.catalog.sensors.get(id)?.radar)));
  return v;
}

/** The direction-finding sensors of a type. */
export function dfSensorsOf(engine: Engine, t: EntityTypeDef): SensorDef[] {
  let v = dfSensors.get(t);
  if (!v) dfSensors.set(t, (v = t.sensors.map((id) => engine.catalog.sensors.get(id)).filter((s): s is SensorDef => !!s?.df)));
  return v;
}

/** A ground control station with a friendly radio-linked unmanned system within its reach. */
function controlling(engine: Engine, gcs: Entity): boolean {
  const r = gcs.type.groundControl!.range;
  for (const e of engine.entities.values()) {
    if (e.force === gcs.force && e.alive && !e.remote && e.type.unmanned?.link === 'rf' && Math.hypot(e.x - gcs.x, e.y - gcs.y) <= r) return true;
  }
  return false;
}

/** What a local entity radiates now. */
export function emissions(engine: Engine, e: Entity): EmissionBand[] {
  if (e.remote || e.destroyed || e.embarkedIn || e.ambient) return [];
  const out: EmissionBand[] = [];
  if (!e.radarOff && hasRadar(engine, e.type)) out.push('radar');
  if (e.type.jammer && e.jamming && !e.firepowerKill) out.push('jammer');
  if (engine.time - e.lastTransmitAt < RADIO_HEARD_FOR) out.push('radio');
  if (e.type.unmanned?.link === 'rf' || (e.type.groundControl && controlling(engine, e))) out.push('datalink');
  return out;
}

/** Normal deviate (Box-Muller) from the engine's random stream. */
function gaussian(engine: Engine): number {
  const u = Math.max(1e-12, engine.rng.next());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * engine.rng.next());
}

interface Track {
  force: ForceId;
  id: string;
  bands: EmissionBand[];
  /** The latest bearing from each station. */
  bearings: DfBearing[];
  fix?: DfContact;
}

export class DirectionFinding {
  private tracks = new Map<string, Track>();

  constructor(private readonly engine: Engine) {}

  /** Once a simulated second: take bearings, cross them, drop stale fixes. */
  update(): void {
    const eng = this.engine;
    const now = eng.time;
    const stations: { e: Entity; sensors: SensorDef[] }[] = [];
    for (const e of eng.entities.values()) {
      if (!e.alive || e.remote || e.embarkedIn || e.ambient) continue;
      const sensors = dfSensorsOf(eng, e.type);
      // Bearings that cannot be reported are no use to the force.
      if (sensors.length && !eng.ew.radioJammed(e)) stations.push({ e, sensors });
    }
    if (!stations.length && !this.tracks.size) return;
    if (stations.length) {
      const emitters: { e: Entity; bands: EmissionBand[] }[] = [];
      for (const e of eng.entities.values()) {
        const bands = emissions(eng, e);
        if (bands.length) emitters.push({ e, bands });
      }
      const heardNow = new Map<Track, Set<EmissionBand>>();
      for (const st of stations) {
        const s = st.e;
        for (const { e: t, bands } of emitters) {
          if (!eng.isHostile(s.force, t.force)) continue;
          const d = Math.hypot(t.x - s.x, t.y - s.y, t.z - s.z);
          if (d < 1) continue;
          const sensor = st.sensors.find((x) => d <= x.maxRange && bands.some((b) => !x.df!.bands || x.df!.bands.includes(b)));
          if (!sensor) continue;
          const heard = bands.filter((b) => !sensor.df!.bands || sensor.df!.bands.includes(b));
          if (!eng.lineOfSight(s.eye, { x: t.x, y: t.y, z: t.z + Math.max(2, t.type.sensorHeight) }, true)) continue;
          const sigma = sensor.df!.bearingError ?? DEFAULT_BEARING_ERROR;
          const b: DfBearing = {
            stationId: s.id,
            x: s.x,
            y: s.y,
            bearing: bearing(s, t) + gaussian(eng) * sigma,
            sigma,
            range: dist2d(s, t) * Math.exp(gaussian(eng) * RANGE_ESTIMATE_ERROR),
            time: now,
          };
          const key = `${s.force}|${t.id}`;
          let tr = this.tracks.get(key);
          if (!tr) this.tracks.set(key, (tr = { force: s.force, id: t.id, bands: [], bearings: [] }));
          tr.bearings = [...tr.bearings.filter((x) => x.stationId !== s.id), b];
          let set = heardNow.get(tr);
          if (!set) heardNow.set(tr, (set = new Set()));
          for (const h of heard) set.add(h);
        }
      }
      for (const [tr, set] of heardNow) tr.bands = ['radar', 'jammer', 'radio', 'datalink'].filter((b) => set.has(b as EmissionBand)) as EmissionBand[];
    }
    for (const [key, tr] of this.tracks) {
      const t = eng.entities.get(tr.id);
      const newest = Math.max(...tr.bearings.map((b) => b.time));
      if (!t || t.destroyed || !tr.bearings.length || now - newest > DF_TIMEOUT) {
        this.tracks.delete(key);
        continue;
      }
      if (!tr.fix || tr.fix.lastSeen !== newest) {
        tr.bearings = tr.bearings.filter((b) => newest - b.time <= DF_KEEP);
        tr.fix = solve(tr);
      }
    }
  }

  /** A force's DF contacts (all forces' when `force` is undefined). */
  contacts(force?: ForceId): DfContact[] {
    const out: DfContact[] = [];
    for (const tr of this.tracks.values()) if (tr.fix && (force === undefined || tr.force === force)) out.push(tr.fix);
    return out;
  }

  contact(force: ForceId, id: string): DfContact | undefined {
    return this.tracks.get(`${force}|${id}`)?.fix;
  }

  clear(): void {
    this.tracks.clear();
  }

  /** Checkpoints: the bearings behind every fix. */
  record(): ScenarioFile['df'] {
    if (!this.tracks.size) return undefined;
    return [...this.tracks.values()].map((t) => ({ force: t.force, id: t.id, bands: [...t.bands], bearings: t.bearings.map((b) => ({ ...b })) }));
  }

  restore(list: NonNullable<ScenarioFile['df']>): void {
    this.tracks.clear();
    for (const r of list) {
      if (!r || !Array.isArray(r.bearings) || !r.bearings.length || typeof r.id !== 'string') continue;
      const tr: Track = { force: r.force, id: r.id, bands: [...(r.bands ?? [])], bearings: r.bearings.map((b) => ({ ...b })) };
      tr.fix = solve(tr);
      this.tracks.set(`${r.force}|${r.id}`, tr);
    }
  }
}

/** The fix from a track's bearings: crossed when two or more stations have one, else along the single bearing. */
export function solve(tr: { force: ForceId; id: string; bands: EmissionBand[]; bearings: DfBearing[] }): DfContact {
  const bs = tr.bearings;
  const lastSeen = Math.max(...bs.map((b) => b.time));
  const base = { id: tr.id, force: tr.force, bands: tr.bands, stations: bs.length, lastSeen };
  if (bs.length >= 2) {
    const crossed = cross(bs);
    if (crossed) return { ...base, ...crossed };
  }
  // One station (or bearings too nearly parallel to cross): along the bearing at the estimated range.
  const b = bs.reduce((a, x) => (x.range * x.sigma < a.range * a.sigma ? x : a));
  const x = b.x + Math.sin(b.bearing) * b.range;
  const y = b.y + Math.cos(b.bearing) * b.range;
  const along = ELLIPSE_SIGMA * RANGE_ESTIMATE_ERROR * b.range;
  const across = ELLIPSE_SIGMA * b.range * b.sigma;
  return { ...base, stations: 1, x: round(x), y: round(y), major: round(Math.max(along, across)), minor: round(Math.min(along, across)), orientation: along >= across ? b.bearing : b.bearing + Math.PI / 2 };
}

const round = (v: number) => Math.round(v * 10) / 10;

/**
 * Weighted least-squares crossing of bearing lines: each bearing is a line through its
 * station, weighted by 1 / (range × sigma)², the cross-track error it implies. Two passes,
 * the second with the ranges to the first estimate. Null when the lines do not cross ahead
 * of the stations.
 */
function cross(bs: DfBearing[]): { x: number; y: number; major: number; minor: number; orientation: number } | null {
  let p: { x: number; y: number } | undefined;
  let a11 = 0;
  let a12 = 0;
  let a22 = 0;
  let det = 0;
  for (let pass = 0; pass < 2; pass++) {
    a11 = a12 = a22 = 0;
    let b1 = 0;
    let b2 = 0;
    for (const b of bs) {
      // Normal to the bearing line (bearings are clockwise from north: direction (sin, cos)).
      const nx = Math.cos(b.bearing);
      const ny = -Math.sin(b.bearing);
      const r = p ? Math.max(50, Math.hypot(p.x - b.x, p.y - b.y)) : b.range;
      const w = 1 / (r * b.sigma) ** 2;
      const c = nx * b.x + ny * b.y;
      a11 += w * nx * nx;
      a12 += w * nx * ny;
      a22 += w * ny * ny;
      b1 += w * nx * c;
      b2 += w * ny * c;
    }
    det = a11 * a22 - a12 * a12;
    if (!(det > 1e-9 * (a11 + a22) ** 2)) return null;
    p = { x: (a22 * b1 - a12 * b2) / det, y: (a11 * b2 - a12 * b1) / det };
  }
  // Every bearing has to point at the fix, not away from it.
  for (const b of bs) if ((p!.x - b.x) * Math.sin(b.bearing) + (p!.y - b.y) * Math.cos(b.bearing) <= 0) return null;
  // Covariance is the inverse of the normal matrix; its eigenvectors are the ellipse axes.
  const cxx = a22 / det;
  const cxy = -a12 / det;
  const cyy = a11 / det;
  const mid = (cxx + cyy) / 2;
  const rad = Math.sqrt(((cxx - cyy) / 2) ** 2 + cxy * cxy);
  const l1 = mid + rad;
  const l2 = Math.max(0, mid - rad);
  // Angle of the major axis from east, counter-clockwise; as a bearing, from north clockwise.
  const phi = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
  return { x: round(p!.x), y: round(p!.y), major: round(ELLIPSE_SIGMA * Math.sqrt(l1)), minor: round(ELLIPSE_SIGMA * Math.sqrt(l2)), orientation: Math.PI / 2 - phi };
}

/** Once a second: DF stations with the call-for-fire reaction call fire on good enough fixes of ground emitters. */
export function checkDfCallsForFire(engine: Engine): void {
  if (!engine.df.contacts().length) return;
  for (const obs of engine.entities.values()) {
    if (!obs.reactions.callForFire || !obs.alive || obs.remote || obs.embarkedIn || engine.time < obs.callForFireAt) continue;
    if (!dfSensorsOf(engine, obs.type).length || engine.ew.radioJammed(obs)) continue;
    for (const c of engine.df.contacts(obs.force)) {
      if (engine.time - c.lastSeen > 2 || c.major > DF_FIRE_ACCURACY) continue;
      const t = engine.entities.get(c.id);
      if (!t || !t.alive || t.domain === 'air') continue;
      const p = { x: c.x, y: c.y };
      if (covered(engine, p) || dangerClose(engine, obs.force, p)) continue;
      const fu = availableFireUnits(engine, obs.force, p).find((f) => {
        const lead = engine.units.get(f.id)?.leader ?? engine.entities.get(f.id);
        return !lead || !engine.ew.radioJammed(lead);
      });
      if (!fu) continue;
      // Spread the rounds over the uncertainty.
      const spec: TaskSpec = { type: 'fireMission', target: { x: Math.round(p.x), y: Math.round(p.y) }, rounds: DEFAULT_MISSION_ROUNDS, radius: Math.round(Math.max(fu.tubes > 1 ? 50 : 0, c.major / 2)) };
      const what = c.bands.includes('jammer') ? 'jammer' : c.bands.includes('radar') ? 'radar' : c.bands.includes('datalink') ? 'drone control' : 'radio';
      engine.radio(obs, `${obs.name}: fire mission, ${what} emitter located at ${spec.target.x} ${spec.target.y} (±${Math.round(c.major)} m), ${DEFAULT_MISSION_ROUNDS} rounds, over`, t.id);
      engine.log('task', `${obs.name} called for fire on a ${what} emitter located by direction finding: ${fu.name} firing ${DEFAULT_MISSION_ROUNDS} round${DEFAULT_MISSION_ROUNDS > 1 ? 's' : ''}${fu.tubes > 1 ? ` x ${fu.tubes} tubes` : ''}`, obs.id, t.id);
      engine.assignTask(fu.id, spec);
      obs.callForFireAt = engine.time + CALL_FOR_FIRE_INTERVAL;
      break;
    }
  }
}

// ---------------------------------------------------------------- anti-radiation missiles

/** Emitting what an anti-radiation missile homes on. */
function radiating(engine: Engine, e: Entity): boolean {
  const b = emissions(engine, e);
  return b.includes('radar') || b.includes('jammer');
}

/**
 * Fire an anti-radiation missile at a radar or jammer the shooter's force has located by
 * direction finding and still hears. Returns true if it fired.
 */
export function fireAntiRadiation(engine: Engine, shooter: Entity): boolean {
  let carried = armTypes.get(shooter.type);
  if (!carried) armTypes.set(shooter.type, (carried = shooter.type.weapons.filter((id) => engine.catalog.weapons.get(id)?.antiRadiation)));
  if (!carried.length) return false;
  const arms = carried.filter((id) => (shooter.ammo.get(id) ?? 0) > 0);
  if (!arms.length) return false;
  if (shooter.roe !== 'fireAtWill' && !shooter.attackTargetId) return false;
  const now = engine.time;
  const contacts = engine.df
    .contacts(shooter.force)
    .filter((c) => now - c.lastSeen <= 2 && (c.bands.includes('radar') || c.bands.includes('jammer')) && (shooter.roe === 'fireAtWill' || c.id === shooter.attackTargetId))
    .sort((a, b) => (a.id === shooter.attackTargetId ? -1 : b.id === shooter.attackTargetId ? 1 : dist2d(shooter, a) - dist2d(shooter, b)));
  for (const c of contacts) {
    const t = engine.entities.get(c.id);
    if (!t || !t.alive || !engine.isHostile(shooter.force, t.force)) continue;
    const z = engine.terrain.surfaceHeight(c.x, c.y);
    const range = Math.hypot(c.x - shooter.x, c.y - shooter.y, z - shooter.z);
    for (const wid of arms) {
      const w = engine.catalog.weapon(wid);
      if (!w.targets.includes(t.domain) || range < w.minRange || range > w.maxRange) continue;
      if ((shooter.weaponReadyAt.get(wid) ?? 0) > now || engine.hasShotInFlight(shooter.id, t.id, w)) continue;
      shooter.ammo.set(wid, (shooter.ammo.get(wid) ?? 0) - 1);
      shooter.weaponReadyAt.set(wid, now + w.reloadTime * engine.rng.range(0.9, 1.1) * reloadFactor(engine, shooter));
      shooter.lastFiredAt = now;
      const flight = Math.max(0.1, range / w.projectileSpeed);
      engine.launch({
        eventNumber: engine.nextEventNumber(),
        shooterId: shooter.id,
        targetId: t.id,
        weapon: w,
        from: { x: shooter.x, y: shooter.y, z: shooter.z + shooter.type.sensorHeight },
        to: { x: c.x, y: c.y, z },
        fireTime: now,
        impactTime: now + flight,
        range,
      });
      return true;
    }
  }
  return false;
}

/** Once a second: anti-radiation missiles in flight home on their emitter while it radiates. */
export function updateAntiRadiation(engine: Engine): void {
  for (const s of engine.shotsInFlight) {
    if (!s.weapon.antiRadiation || !s.targetId) continue;
    const t = engine.entities.get(s.targetId);
    if (t && t.alive && !t.remote && radiating(engine, t)) s.to = { x: t.x, y: t.y, z: t.z };
  }
}

/**
 * An anti-radiation missile arriving. Still radiating, the emitter is hit as by any guided
 * missile (undefined: the usual adjudication). Fallen silent, the missile flies on to where
 * it last heard it and bursts there, with a 30 m error of its own.
 */
export function resolveAntiRadiation(engine: Engine, shot: Shot): Detonation | undefined {
  const t = shot.targetId ? engine.entities.get(shot.targetId) : undefined;
  if (!t || t.destroyed || t.remote) return undefined;
  if (radiating(engine, t)) {
    shot.to = { x: t.x, y: t.y, z: t.z };
    return undefined;
  }
  const x = shot.to.x + gaussian(engine) * ARM_MEMORY_ERROR;
  const y = shot.to.y + gaussian(engine) * ARM_MEMORY_ERROR;
  const location = { x, y, z: engine.terrain.surfaceHeight(x, y) };
  const effects = shot.weapon.blastRadius ? applyBlast(engine, shot.weapon, location, shot.shooterId) : [];
  const outcome = effects.some((f) => f.outcome === 'kill') ? 'kill' : (effects[0]?.outcome ?? 'noEffect');
  return { shot, location, hit: effects.length > 0, outcome, effects, emitterLost: true };
}
