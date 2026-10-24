// Recordings for playback and after-action review (AAR): sampled entity states plus
// the event log and bookmarks. Shared by the server (recording, reports) and the
// browser (scrubbing and replay).

import type { DamageState, Domain, EntitySnapshot, ForceId, SimEvent, SymbolKind, TerrainSpec, UnitSnapshot, UnitTemplate } from './types.js';

/** Numbers per entity in a frame: index, x, y, z, heading, speed, flags, carrier index (-1 none). */
export const FRAME_STRIDE = 8;
const DAMAGE: DamageState[] = ['none', 'mobility', 'firepower', 'destroyed'];
const FLAG_EMBARKED = 4;

export interface RecordedEntity {
  id: string;
  name: string;
  typeId: string;
  force: ForceId;
  domain: Domain;
  symbol: SymbolKind;
  unitId?: string;
}

export interface RecordedUnit {
  id: string;
  name: string;
  force: ForceId;
  echelon: UnitTemplate['echelon'];
  memberIds: string[];
}

export interface RecordingFrame {
  t: number;
  /** FRAME_STRIDE numbers per entity present at this time. */
  d: ArrayLike<number>;
}

export interface Bookmark {
  id: string;
  time: number;
  text: string;
}

export interface Recording {
  format: 'werforces-recording';
  version: 1;
  scenarioName: string;
  terrain: TerrainSpec;
  /** Seconds of simulated time between frames. */
  interval: number;
  start: number;
  end: number;
  entities: RecordedEntity[];
  units: RecordedUnit[];
  frames: RecordingFrame[];
  events: SimEvent[];
  bookmarks: Bookmark[];
}

export function encodeFlags(damage: DamageState, embarked: boolean): number {
  return DAMAGE.indexOf(damage) | (embarked ? FLAG_EMBARKED : 0);
}

/** Index of the last frame at or before time t (-1 if t is before the first frame). */
export function frameIndexAt(frames: RecordingFrame[], t: number): number {
  let lo = 0;
  let hi = frames.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (frames[mid].t <= t + 1e-9) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

function rows(f: RecordingFrame): Map<number, number> {
  const out = new Map<number, number>();
  for (let i = 0; i < f.d.length; i += FRAME_STRIDE) out.set(f.d[i], i);
  return out;
}

function lerpAngle(a: number, b: number, k: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * k;
}

/**
 * Entity and unit snapshots at time t, interpolating positions between frames.
 * `surface` gives terrain height for above-ground altitude (0 when omitted).
 */
export function stateAt(rec: Recording, t: number, surface: (x: number, y: number) => number = () => 0): { time: number; entities: EntitySnapshot[]; units: UnitSnapshot[] } {
  const i = frameIndexAt(rec.frames, t);
  if (i < 0) return { time: t, entities: [], units: [] };
  const a = rec.frames[i];
  const b = rec.frames[i + 1];
  const k = b ? Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t))) : 0;
  const nextRows = b ? rows(b) : new Map<number, number>();
  const entities: EntitySnapshot[] = [];
  for (let r = 0; r < a.d.length; r += FRAME_STRIDE) {
    const d = a.d;
    const info = rec.entities[d[r]];
    if (!info) continue;
    let x = d[r + 1];
    let y = d[r + 2];
    let z = d[r + 3];
    let heading = d[r + 4];
    const j = nextRows.get(d[r]);
    if (j !== undefined && k > 0) {
      const n = b!.d;
      x += (n[j + 1] - x) * k;
      y += (n[j + 2] - y) * k;
      z += (n[j + 3] - z) * k;
      heading = lerpAngle(heading, n[j + 4], k);
    }
    const flags = d[r + 6];
    const carrier = d[r + 7] >= 0 ? rec.entities[d[r + 7]]?.id : undefined;
    entities.push({
      id: info.id,
      name: info.name,
      typeId: info.typeId,
      force: info.force,
      domain: info.domain,
      symbol: info.symbol,
      x,
      y,
      z,
      agl: z - surface(x, y),
      heading,
      pitch: 0,
      speed: d[r + 5],
      damage: DAMAGE[flags & 3],
      remote: false,
      unitId: info.unitId,
      roe: 'fireAtWill',
      ammo: [],
      contacts: [],
      embarkedIn: flags & FLAG_EMBARKED ? carrier : undefined,
    });
  }
  const byId = new Map(entities.map((e) => [e.id, e]));
  for (const e of entities) {
    if (!e.embarkedIn) continue;
    const c = byId.get(e.embarkedIn);
    if (c) (c.passengers ??= []).push(e.id);
  }
  const units: UnitSnapshot[] = [];
  for (const u of rec.units) {
    const members = u.memberIds.map((m) => byId.get(m)).filter((m): m is EntitySnapshot => !!m);
    if (members.length === 0) continue;
    const alive = members.filter((m) => m.damage !== 'destroyed');
    const list = alive.length ? alive : members;
    for (const m of members) m.isLeader = m === list[0];
    units.push({
      id: u.id,
      name: u.name,
      force: u.force,
      echelon: u.echelon,
      formation: 'column',
      leaderId: list[0].id,
      memberIds: u.memberIds,
      x: list.reduce((s, m) => s + m.x, 0) / list.length,
      y: list.reduce((s, m) => s + m.y, 0) / list.length,
    });
  }
  return { time: t, entities, units };
}

export interface ForceSummary {
  force: ForceId;
  start: number;
  end: number;
  losses: number;
  shots: number;
  kills: number;
}

export interface KillRecord {
  time: number;
  victimId: string;
  victim: string;
  victimForce: ForceId;
  killerId?: string;
  killer?: string;
  weaponId?: string;
}

export interface AarReport {
  scenarioName: string;
  start: number;
  end: number;
  frames: number;
  forces: ForceSummary[];
  kills: KillRecord[];
  /** Rounds fired per weapon id. */
  shotsByWeapon: Record<string, number>;
  detections: number;
  /** Alive entities per force over time (about 100 samples). */
  strength: { time: number; alive: Partial<Record<ForceId, number>> }[];
  bookmarks: Bookmark[];
}

/** Losses, kills, fires and a strength curve from a recording. */
export function aarReport(rec: Recording): AarReport {
  const info = new Map(rec.entities.map((e) => [e.id, e]));
  const forceOf = (id?: string) => (id ? info.get(id)?.force : undefined);
  const aliveIn = (f: RecordingFrame) => {
    const alive: Partial<Record<ForceId, number>> = {};
    for (let r = 0; r < f.d.length; r += FRAME_STRIDE) {
      const e = rec.entities[f.d[r]];
      if (e && (f.d[r + 6] & 3) !== 3) alive[e.force] = (alive[e.force] ?? 0) + 1;
    }
    return alive;
  };
  const last = rec.frames[rec.frames.length - 1];
  // Each force's starting strength is taken from the first frame it appears in.
  const startAlive: Partial<Record<ForceId, number>> = {};
  for (const f of rec.frames) {
    const alive = aliveIn(f);
    for (const [k, n] of Object.entries(alive)) if (startAlive[Number(k) as ForceId] === undefined) startAlive[Number(k) as ForceId] = n;
  }
  const endAlive = last ? aliveIn(last) : {};

  const kills: KillRecord[] = [];
  const shotsByWeapon: Record<string, number> = {};
  const shotsByForce: Partial<Record<ForceId, number>> = {};
  let detections = 0;
  const lastWeaponOn = new Map<string, string>();
  for (const ev of rec.events) {
    if (ev.kind === 'fire') {
      if (ev.weaponId) shotsByWeapon[ev.weaponId] = (shotsByWeapon[ev.weaponId] ?? 0) + 1;
      const f = forceOf(ev.entityId);
      if (f !== undefined) shotsByForce[f] = (shotsByForce[f] ?? 0) + 1;
    } else if (ev.kind === 'detected') {
      detections++;
    } else if (ev.kind === 'detonation' && ev.weaponId) {
      // Remember the weapon of the last round to land on each victim at this time.
      if (ev.targetId) lastWeaponOn.set(ev.targetId, ev.weaponId);
      if (ev.entityId) lastWeaponOn.set(`by:${ev.entityId}`, ev.weaponId);
    } else if (ev.kind === 'destroyed' && ev.entityId) {
      const victim = info.get(ev.entityId);
      if (!victim) continue;
      kills.push({
        time: ev.time,
        victimId: ev.entityId,
        victim: victim.name,
        victimForce: victim.force,
        killerId: ev.targetId,
        killer: ev.targetId ? info.get(ev.targetId)?.name : undefined,
        weaponId: lastWeaponOn.get(ev.entityId) ?? (ev.targetId ? lastWeaponOn.get(`by:${ev.targetId}`) : undefined),
      });
    }
  }

  const forces = new Set<ForceId>([...Object.keys(startAlive), ...Object.keys(endAlive)].map((f) => Number(f) as ForceId));
  for (const e of rec.entities) forces.add(e.force);
  const summaries: ForceSummary[] = [...forces]
    .sort((a, b) => a - b)
    .map((f) => ({
      force: f,
      start: startAlive[f] ?? 0,
      end: endAlive[f] ?? 0,
      losses: kills.filter((k) => k.victimForce === f).length,
      shots: shotsByForce[f] ?? 0,
      kills: kills.filter((k) => forceOf(k.killerId) === f && k.victimForce !== f).length,
    }));

  const strength: AarReport['strength'] = [];
  const step = Math.max(1, Math.floor(rec.frames.length / 100));
  for (let i = 0; i < rec.frames.length; i += step) strength.push({ time: rec.frames[i].t, alive: aliveIn(rec.frames[i]) });
  if (last && strength[strength.length - 1]?.time !== last.t) strength.push({ time: last.t, alive: endAlive });

  return {
    scenarioName: rec.scenarioName,
    start: rec.start,
    end: rec.end,
    frames: rec.frames.length,
    forces: summaries,
    kills,
    shotsByWeapon,
    detections,
    strength,
    bookmarks: rec.bookmarks,
  };
}
