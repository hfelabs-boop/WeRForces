// Pattern of life: civilian cars driving between towns along the roads and people walking
// about in the towns, so the battlefield is not empty and targets must be told from
// bystanders. Civilians flee from fighting. They are neutral (force 3) "ambient" entities
// the engine adds and removes itself to keep the numbers asked for.

import type { PatternOfLife, Vec2 } from '../shared/types.js';
import type { Engine } from './engine.js';
import type { Entity } from './entity.js';
import { createTask } from './tasks.js';

const CAR = 'civ-car';
const PERSON = 'civ-person';
/** Civilians this close to a shot or a blast flee. */
const DANGER_RADIUS = 700;
/** How far they run, and for how long they keep away. */
const FLEE_DISTANCE = 1500;
const FLEE_TIME = 120;
/** How far people wander from their town's centre. */
const WANDER = 250;
/** Longest trip a car sets out on (only matters on large maps). */
const MAX_TRIP = 25000;

export const MAX_AMBIENT = 300;

export class Life {
  settings: Required<PatternOfLife> = { vehicles: 0, pedestrians: 0 };
  /** Entity id -> when it may set off again, its home town (people), and when it stops fleeing. */
  private state = new Map<string, { resumeAt: number; home?: Vec2; fleeUntil: number }>();
  /** Recent shots and blasts: where and when. */
  private danger: { x: number; y: number; t: number }[] = [];
  private seq = 0;

  constructor(private readonly engine: Engine) {
    engine.on('event', (ev) => {
      if (!this.active || (ev.kind !== 'fire' && ev.kind !== 'detonation')) return;
      const p = ev.kind === 'fire' ? ev.from : ev.to;
      if (p) this.danger.push({ x: p.x, y: p.y, t: ev.time });
    });
  }

  get active(): boolean {
    return this.settings.vehicles > 0 || this.settings.pedestrians > 0 || this.state.size > 0;
  }

  /** A new scenario: no civilians until asked for. */
  clear(): void {
    this.settings = { vehicles: 0, pedestrians: 0 };
    this.state.clear();
    this.danger = [];
    this.seq = 0;
  }

  set(p: PatternOfLife): void {
    this.settings = { vehicles: Math.max(0, Math.min(MAX_AMBIENT, Math.round(p.vehicles ?? 0))), pedestrians: Math.max(0, Math.min(MAX_AMBIENT, Math.round(p.pedestrians ?? 0))) };
  }

  /** Civilians already in a loaded scenario are taken back under management. */
  adopt(e: Entity): void {
    e.ambient = true;
    const n = Number(/(\d+)$/.exec(e.name)?.[1]);
    if (n > this.seq) this.seq = n;
    this.state.set(e.id, { resumeAt: this.engine.time, home: e.type.id === PERSON ? this.nearestTown(e) : undefined, fleeUntil: -Infinity });
  }

  private ambient(typeId: string): Entity[] {
    const out: Entity[] = [];
    for (const e of this.engine.entities.values()) if (e.ambient && e.type.id === typeId) out.push(e);
    return out;
  }

  /** Keep the numbers, send idle civilians on their way, and make them flee fighting (once a second). */
  update(): void {
    if (!this.active) return;
    const eng = this.engine;
    const now = eng.time;
    this.danger = this.danger.filter((d) => now - d.t < 5);
    this.keepCount(CAR, this.settings.vehicles);
    this.keepCount(PERSON, this.settings.pedestrians);
    for (const e of eng.entities.values()) {
      if (!e.ambient) continue;
      let s = this.state.get(e.id);
      if (!s) {
        s = { resumeAt: now, fleeUntil: -Infinity };
        this.state.set(e.id, s);
      }
      if (!e.alive || e.mobilityKill) continue;
      // Run from shots and blasts nearby.
      const near = this.danger.find((d) => Math.hypot(d.x - e.x, d.y - e.y) < DANGER_RADIUS);
      if (near && s.fleeUntil < now) {
        const away = Math.atan2(e.x - near.x, e.y - near.y);
        const target = this.reachable(e, { x: e.x + Math.sin(away) * FLEE_DISTANCE, y: e.y + Math.cos(away) * FLEE_DISTANCE });
        if (target) {
          eng.setEntityTask(e, createTask({ type: 'moveTo', target, speed: e.type.maxSpeed }));
          s.fleeUntil = now + FLEE_TIME;
          s.resumeAt = now + FLEE_TIME;
        }
        continue;
      }
      const busy = e.task?.status === 'running';
      if (busy || now < s.resumeAt) continue;
      // Arrived (or just made): pause, then set off somewhere else.
      if (!s.home && e.type.id === PERSON) s.home = this.nearestTown(e);
      const dest = e.type.id === CAR ? this.carDestination(e) : this.walkDestination(e, s.home);
      if (dest) eng.setEntityTask(e, createTask({ type: 'moveTo', target: dest }));
      s.resumeAt = now + (e.type.id === CAR ? eng.rng.range(10, 60) : eng.rng.range(20, 120));
    }
    for (const id of [...this.state.keys()]) if (!eng.entities.has(id)) this.state.delete(id);
  }

  private keepCount(typeId: string, want: number): void {
    const eng = this.engine;
    const have = this.ambient(typeId).filter((e) => e.alive);
    // Too many: remove the ones that are not doing anything first.
    for (let i = have.length - 1; i >= want && i >= 0; i--) {
      const e = have[i];
      this.state.delete(e.id);
      eng.removeEntity(e.id);
    }
    for (let n = have.length; n < want; n++) {
      const at = typeId === CAR ? this.roadPoint() : this.townPoint();
      if (!at) return;
      const e = eng.createEntity({ typeId, force: 3, x: at.x, y: at.y, heading: eng.rng.range(0, Math.PI * 2), name: `${typeId === CAR ? 'Civilian car' : 'Civilian'} ${++this.seq}`, quiet: true });
      e.ambient = true;
      e.roe = 'holdFire';
      this.state.set(e.id, { resumeAt: eng.time + eng.rng.range(0, 30), home: typeId === PERSON ? this.nearestTown(e) : undefined, fleeUntil: -Infinity });
    }
  }

  private roadPoint(): Vec2 | null {
    const t = this.engine.terrain;
    const roads = t.roads.filter((r) => r.length > 1);
    for (let tries = 0; tries < 20; tries++) {
      let p: Vec2;
      if (roads.length) {
        const r = roads[Math.floor(this.engine.rng.next() * roads.length)];
        const i = Math.floor(this.engine.rng.next() * (r.length - 1));
        const f = this.engine.rng.next();
        p = { x: r[i].x + (r[i + 1].x - r[i].x) * f, y: r[i].y + (r[i + 1].y - r[i].y) * f };
      } else p = { x: this.engine.rng.range(0, t.spec.size), y: this.engine.rng.range(0, t.spec.size) };
      if (this.engine.canStand('ground', p)) return { x: Math.round(p.x), y: Math.round(p.y) };
    }
    return null;
  }

  private townPoint(): Vec2 | null {
    const towns = this.engine.terrain.towns;
    for (let tries = 0; tries < 20; tries++) {
      const c = towns.length ? towns[Math.floor(this.engine.rng.next() * towns.length)] : { x: this.engine.rng.range(0, this.engine.terrain.spec.size), y: this.engine.rng.range(0, this.engine.terrain.spec.size) };
      const a = this.engine.rng.range(0, Math.PI * 2);
      const r = this.engine.rng.range(0, WANDER);
      const p = { x: Math.round(c.x + Math.sin(a) * r), y: Math.round(c.y + Math.cos(a) * r) };
      if (this.engine.terrain.inBounds(p.x, p.y) && this.engine.canStand('lifeform', p)) return p;
    }
    return null;
  }

  private carDestination(e: Entity): Vec2 | null {
    // Another town, or another stretch of road, at least a kilometre away (and on a large map, not too far).
    const towns = this.engine.terrain.towns.filter((t) => Math.hypot(t.x - e.x, t.y - e.y) > 1000 && Math.hypot(t.x - e.x, t.y - e.y) < MAX_TRIP);
    if (towns.length && this.engine.rng.chance(0.6)) {
      const t = towns[Math.floor(this.engine.rng.next() * towns.length)];
      return this.reachable(e, t);
    }
    for (let tries = 0; tries < 5; tries++) {
      const p = this.roadPoint();
      if (p && Math.hypot(p.x - e.x, p.y - e.y) > 1000 && Math.hypot(p.x - e.x, p.y - e.y) < MAX_TRIP) return p;
    }
    return null;
  }

  private walkDestination(e: Entity, home: Vec2 | undefined): Vec2 | null {
    const c = home ?? { x: e.x, y: e.y };
    const a = this.engine.rng.range(0, Math.PI * 2);
    const r = this.engine.rng.range(20, WANDER);
    return this.reachable(e, { x: c.x + Math.sin(a) * r, y: c.y + Math.cos(a) * r });
  }

  /** A point it can stand on near p, inside the map. */
  private reachable(e: Entity, p: Vec2): Vec2 | null {
    const size = this.engine.terrain.spec.size;
    const q = { x: Math.max(0, Math.min(size, p.x)), y: Math.max(0, Math.min(size, p.y)) };
    const ok = this.engine.findValidPosition(q, e.domain, 300);
    return ok ? { x: Math.round(ok.x), y: Math.round(ok.y) } : null;
  }

  private nearestTown(p: Vec2): Vec2 | undefined {
    let best: Vec2 | undefined;
    let d = Infinity;
    for (const t of this.engine.terrain.towns) {
      const dt = Math.hypot(t.x - p.x, t.y - p.y);
      if (dt < d) {
        d = dt;
        best = { x: t.x, y: t.y };
      }
    }
    return best;
  }
}
