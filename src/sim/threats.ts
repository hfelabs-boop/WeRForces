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

export class ThreatMap {
  private cache = new Map<string, { key: string; ids: string; at: number; grid: PostOverlay | null }>();

  constructor(private readonly engine: Engine) {}

  clear(): void {
    this.cache.clear();
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
    if (hit && (hit.key === key || (hit.ids === ids && age >= 0 && age < REBUILD_EVERY))) return hit.grid;
    const grid = threats.length ? this.build(threats) : null;
    this.cache.set(k, { key, ids, at: this.engine.time, grid });
    return grid;
  }

  private build(threats: Threat[]): PostOverlay {
    const t = this.engine.terrain;
    const cs = t.spec.cellSize;
    const cols = t.cols;
    const rows = t.rows;
    const exposure = new PostOverlay(cols, rows, 0);
    for (const th of threats) {
      const reach = Math.ceil(th.range / cs);
      const stride = Math.max(1, Math.ceil((2 * reach) / SAMPLES_ACROSS));
      const c0 = Math.max(0, Math.floor(th.x / cs) - reach);
      const c1 = Math.min(cols - 1, Math.ceil(th.x / cs) + reach);
      const r0 = Math.max(0, Math.floor(th.y / cs) - reach);
      const r1 = Math.min(rows - 1, Math.ceil(th.y / cs) + reach);
      for (let r = r0; r <= r1; r += stride) {
        for (let c = c0; c <= c1; c += stride) {
          // Sample the middle of each stride block.
          const sc = Math.min(c1, c + (stride >> 1));
          const sr = Math.min(r1, r + (stride >> 1));
          const x = sc * cs;
          const y = sr * cs;
          const d = Math.hypot(x - th.x, y - th.y);
          if (d >= th.range) continue;
          const z = t.surfaceHeight(x, y) + 2;
          if (!t.lineOfSight({ x: th.x, y: th.y, z: th.z }, { x, y, z })) continue;
          const w = 1 - d / th.range;
          for (let rr = r; rr < Math.min(r + stride, r1 + 1); rr++) for (let cc = c; cc < Math.min(c + stride, c1 + 1); cc++) exposure.add(rr * cols + cc, w);
        }
      }
    }
    return exposure.map((v) => 1 + THREAT_COST * v);
  }
}
