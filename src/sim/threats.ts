// Threat-aware route planning. Known enemies (a force's sensor contacts) that can fire on
// a domain make the ground they can see within weapon range costly to cross, so covered
// routes go round, or behind cover, rather than through their fields of fire.

import type { Domain, ForceId } from '../shared/types.js';
import type { Engine } from './engine.js';
import { PostOverlay } from './postOverlay.js';

/** Extra route cost per unit of exposure (1 = in sight at point-blank range of one enemy). */
const THREAT_COST = 8;
/** Longest direct-fire reach considered. */
const MAX_REACH = 5000;
/** At most this many line-of-sight samples across a threat's range. */
const SAMPLES_ACROSS = 120;
/**
 * Most sight lines one rebuild traces: a large set of threats (a big battle) is sampled
 * more coarsely, halving the samples across down to a quarter, to keep rebuilds quick.
 */
const LOS_BUDGET = 2_000_000;
/** Threats from which a set counts as large (see mostlySame). */
const LARGE_SET = 50;
/** A threat map is rebuilt at most this often, or when the threats change. */
const REBUILD_EVERY = 10;

export interface Threat {
  id: string;
  x: number;
  y: number;
  /** Eye height above sea level. */
  z: number;
  /** Direct-fire reach against the domain. */
  range: number;
}

/** Most threat viewsheds kept (each a bit per sample, under 2 kB). */
const MAX_VIEWSHEDS = 8000;

export class ThreatMap {
  private cache = new Map<string, { key: string; ids: string; idSet: Set<string>; at: number; grid: PostOverlay | null }>();
  /**
   * Which samples each threat position sees, by exact position, eye height and reach:
   * enemies that hold still are not traced again on the next rebuild.
   */
  private viewsheds = new Map<string, Uint8Array>();
  private viewshedTerrain = -1;

  constructor(private readonly engine: Engine) {}

  clear(): void {
    this.cache.clear();
    this.viewsheds.clear();
  }

  /** Enemies a force knows about that can shoot at a domain, where it last saw them. */
  threats(force: ForceId, domain: Domain): Threat[] {
    const engine = this.engine;
    const seen = new Map<string, { x: number; y: number; z: number; t: number }>();
    for (const e of engine.entities.values()) {
      if (e.force !== force || !e.alive) continue;
      for (const c of e.contacts.values()) {
        const prev = seen.get(c.id);
        if (!prev || c.lastSeen > prev.t) seen.set(c.id, { x: c.x, y: c.y, z: c.z, t: c.lastSeen });
      }
    }
    const out: Threat[] = [];
    for (const [id, c] of seen) {
      const t = engine.entities.get(id);
      if (!t || !t.alive || !engine.isHostile(force, t.force)) continue;
      let range = 0;
      for (const wid of t.type.weapons) {
        const w = engine.catalog.weapon(wid);
        if (!w.indirect && w.targets.includes(domain) && (t.ammo.get(wid) ?? 0) > 0) range = Math.max(range, w.maxRange);
      }
      if (range <= 0) continue;
      const ground = engine.terrain.surfaceHeight(c.x, c.y);
      out.push({ id, x: c.x, y: c.y, z: Math.max(c.z, ground) + (t.type.sensorHeight || 2), range: Math.min(range, MAX_REACH) });
    }
    return out;
  }

  /** Per-post route cost multipliers for a force crossing ground in a domain (null: no known threats). */
  overlay(force: ForceId, domain: Domain): PostOverlay | null {
    if (domain === 'air' || domain === 'surface') return null;
    const threats = this.threats(force, domain);
    const key = threats.map((t) => `${t.id}:${Math.round(t.x / 25)}:${Math.round(t.y / 25)}`).sort().join('|');
    const ids = threats.map((t) => t.id).sort().join('|');
    const k = `${force}:${domain}`;
    const hit = this.cache.get(k);
    // The same threats, moved a little since the last build a few seconds ago, keep the old map.
    const age = this.engine.time - (hit?.at ?? -Infinity);
    if (hit && (hit.key === key || ((hit.ids === ids || this.mostlySame(hit.idSet, threats)) && age >= 0 && age < REBUILD_EVERY))) return hit.grid;
    const grid = threats.length ? this.build(threats) : null;
    this.cache.set(k, { key, ids, idSet: new Set(threats.map((t) => t.id)), at: this.engine.time, grid });
    return grid;
  }

  /**
   * In a big battle the known threats change every second; a map built from a large set
   * that differs by at most a tenth is still good enough to route by for a few seconds.
   */
  private mostlySame(before: Set<string>, now: Threat[]): boolean {
    if (now.length < LARGE_SET || before.size < LARGE_SET) return false;
    let changed = 0;
    let kept = 0;
    for (const t of now) {
      if (before.has(t.id)) kept++;
      else changed++;
    }
    changed += before.size - kept;
    return changed <= Math.max(before.size, now.length) / 10;
  }

  private build(threats: Threat[]): PostOverlay {
    const t = this.engine.terrain;
    const cs = t.spec.cellSize;
    const cols = t.cols;
    const rows = t.rows;
    const exposure = new PostOverlay(cols, rows, 0);
    if (this.viewshedTerrain !== this.engine.terrainVersion || this.viewsheds.size > MAX_VIEWSHEDS) {
      this.viewsheds.clear();
      this.viewshedTerrain = this.engine.terrainVersion;
    }
    let across = SAMPLES_ACROSS;
    while (across > SAMPLES_ACROSS / 4 && threats.length * across * across > LOS_BUDGET) across /= 2;
    for (const th of threats) {
      const reach = Math.ceil(th.range / cs);
      const stride = Math.max(1, Math.ceil((2 * reach) / across));
      const c0 = Math.max(0, Math.floor(th.x / cs) - reach);
      const c1 = Math.min(cols - 1, Math.ceil(th.x / cs) + reach);
      const r0 = Math.max(0, Math.floor(th.y / cs) - reach);
      const r1 = Math.min(rows - 1, Math.ceil(th.y / cs) + reach);
      const vkey = `${th.x}:${th.y}:${th.z}:${th.range}:${stride}`;
      const known = this.viewsheds.get(vkey);
      const seen = known ?? new Uint8Array(Math.ceil((Math.ceil((r1 - r0 + 1) / stride) * Math.ceil((c1 - c0 + 1) / stride)) / 8));
      if (!known) this.viewsheds.set(vkey, seen);
      let bit = -1;
      for (let r = r0; r <= r1; r += stride) {
        for (let c = c0; c <= c1; c += stride) {
          bit++;
          // Sample the middle of each stride block.
          const sc = Math.min(c1, c + (stride >> 1));
          const sr = Math.min(r1, r + (stride >> 1));
          const x = sc * cs;
          const y = sr * cs;
          const d = Math.hypot(x - th.x, y - th.y);
          if (d >= th.range) continue;
          if (known) {
            if (!(seen[bit >> 3] & (1 << (bit & 7)))) continue;
          } else {
            const z = t.surfaceHeight(x, y) + 2;
            if (!t.lineOfSight({ x: th.x, y: th.y, z: th.z }, { x, y, z })) continue;
            seen[bit >> 3] |= 1 << (bit & 7);
          }
          const w = 1 - d / th.range;
          for (let rr = r; rr < Math.min(r + stride, r1 + 1); rr++) for (let cc = c; cc < Math.min(c + stride, c1 + 1); cc++) exposure.add(rr * cols + cc, w);
        }
      }
    }
    return exposure.map((v) => 1 + THREAT_COST * v);
  }
}
