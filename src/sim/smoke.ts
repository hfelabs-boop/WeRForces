// Smoke clouds from smoke rounds and vehicle smoke grenades. A cloud blocks sight
// (but not radar) through it until it disperses.

import type { SmokeCloud, Vec2, Vec3 } from '../shared/types.js';
import type { Engine } from './engine.js';

/** Height of a smoke cloud above the ground. */
const CLOUD_HEIGHT = 25;
/** A sight line must pass through at least this much cloud (or the whole cloud, if smaller) to be blocked. */
const MIN_CHORD = 20;

export class Smoke {
  clouds: SmokeCloud[] = [];
  /** Bumped whenever a cloud appears or goes. */
  version = 0;
  private nextId = 1;

  constructor(private readonly engine: Engine) {}

  add(at: Vec2, radius: number, duration: number): SmokeCloud {
    const c = { id: this.nextId++, x: Math.round(at.x), y: Math.round(at.y), radius, until: Math.round((this.engine.time + duration) * 10) / 10 };
    this.clouds.push(c);
    this.version++;
    return c;
  }

  /** Remove clouds that have dispersed, and drift the rest with the wind (called once a second). */
  expire(wind: Vec2 = { x: 0, y: 0 }): void {
    const n = this.clouds.length;
    this.clouds = this.clouds.filter((c) => c.until > this.engine.time);
    if (this.clouds.length !== n) this.version++;
    if (this.clouds.length && (wind.x || wind.y)) {
      for (const c of this.clouds) {
        c.x = Math.round((c.x + wind.x) * 10) / 10;
        c.y = Math.round((c.y + wind.y) * 10) / 10;
      }
      this.version++;
    }
  }

  restore(clouds: SmokeCloud[]): void {
    this.clouds = clouds.map((c) => ({ ...c }));
    this.nextId = Math.max(1, ...this.clouds.map((c) => c.id + 1));
    this.version++;
  }

  clear(): void {
    this.clouds = [];
    this.version++;
  }

  /** True when the sight line a-b passes through a cloud. */
  blocks(a: Vec3, b: Vec3): boolean {
    if (this.clouds.length === 0) return false;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1) return false;
    for (const c of this.clouds) {
      // Closest approach of the line to the cloud's centre.
      const t = ((c.x - a.x) * dx + (c.y - a.y) * dy) / (len * len);
      const px = a.x + dx * t;
      const py = a.y + dy * t;
      const off = Math.hypot(c.x - px, c.y - py);
      if (off >= c.radius) continue;
      const half = Math.sqrt(c.radius * c.radius - off * off) / len;
      const t0 = Math.max(0, t - half);
      const t1 = Math.min(1, t + half);
      if (t1 <= t0 || (t1 - t0) * len < Math.min(MIN_CHORD, c.radius)) continue;
      // Above the cloud (aircraft looking down at the far side) sees over it.
      const tm = Math.max(t0, Math.min(t1, t));
      const z = a.z + (b.z - a.z) * tm;
      if (z < this.engine.terrain.surfaceHeight(px, py) + CLOUD_HEIGHT) return true;
    }
    return false;
  }
}
