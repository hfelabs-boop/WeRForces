// Minefields and obstacles. Obstacle lines (ditches, wire) stop vehicles and slow
// infantry; minefields damage what crosses them. Engineers breach 30 m lanes through
// either. Route planning avoids obstacles, and the minefields a force knows about.

import { pointInPolygon } from '../shared/math.js';
import type { ForceId, Graphic, Vec2 } from '../shared/types.js';
import type { Engine } from './engine.js';
import type { Entity } from './entity.js';
import { PostOverlay } from './postOverlay.js';

export const LANE_WIDTH = 30;
export const DEFAULT_DENSITY = 0.5;
/** Route cost multiplier for crossing a known minefield (avoided unless there is no way round). */
const MINEFIELD_COST = 25;
/** Route cost multiplier for infantry climbing through an obstacle. */
const OBSTACLE_COST_ON_FOOT = 3;

function distToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}

/** Intersection point of segments p1-p2 and p3-p4, if they cross. */
function segmentsCross(p1: Vec2, p2: Vec2, p3: Vec2, p4: Vec2): Vec2 | null {
  const d = (p2.x - p1.x) * (p4.y - p3.y) - (p2.y - p1.y) * (p4.x - p3.x);
  if (d === 0) return null;
  const t = ((p3.x - p1.x) * (p4.y - p3.y) - (p3.y - p1.y) * (p4.x - p3.x)) / d;
  const u = ((p3.x - p1.x) * (p2.y - p1.y) - (p3.y - p1.y) * (p2.x - p1.x)) / d;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { x: p1.x + (p2.x - p1.x) * t, y: p1.y + (p2.y - p1.y) * t };
}

export function inLane(g: Graphic, p: Vec2, slack = 0): boolean {
  return (g.lanes ?? []).some((l) => distToSegment(p, l.from, l.to) <= LANE_WIDTH / 2 + slack);
}

function knows(g: Graphic, force: ForceId): boolean {
  return g.force === force || (g.knownBy ?? []).includes(force);
}

export class Obstacles {
  /** Bumped whenever obstacles, lanes or knowledge of minefields change. */
  version = 0;
  private overlays = new Map<string, PostOverlay | null>();

  constructor(private readonly engine: Engine) {}

  changed(): void {
    this.version++;
    this.overlays.clear();
  }

  private list(kind: 'minefield' | 'obstacle'): Graphic[] {
    const out: Graphic[] = [];
    for (const g of this.engine.graphics.values()) if (g.kind === kind) out.push(g);
    return out;
  }

  /** The minefield (not breached here) that a point lies in, if any. */
  minefieldAt(p: Vec2): Graphic | undefined {
    for (const g of this.list('minefield')) {
      if (g.points.length >= 3 && pointInPolygon(p, g.points) && !inLane(g, p)) return g;
    }
    return undefined;
  }

  /** The obstacle line a move from a to b crosses outside any lane, if any. */
  crossing(a: Vec2, b: Vec2): Graphic | undefined {
    if (a.x === b.x && a.y === b.y) return undefined;
    for (const g of this.list('obstacle')) {
      for (let i = 1; i < g.points.length; i++) {
        const hit = segmentsCross(a, b, g.points[i - 1], g.points[i]);
        if (hit && !inLane(g, hit)) return g;
      }
    }
    return undefined;
  }

  /**
   * True when a straight move from a to b would hit something routes go round: an
   * obstacle line (vehicles) or a minefield the force knows about, outside any lane.
   */
  barrierBetween(a: Vec2, b: Vec2, force: ForceId, domain: string): boolean {
    if (domain === 'air' || domain === 'surface') return false;
    if (domain !== 'lifeform' && this.crossing(a, b)) return true;
    const fields = this.list('minefield').filter((g) => g.points.length >= 3 && knows(g, force));
    if (!fields.length) return false;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const n = Math.max(1, Math.ceil(len / 10));
    for (let i = 1; i <= n; i++) {
      const p = { x: a.x + ((b.x - a.x) * i) / n, y: a.y + ((b.y - a.y) * i) / n };
      if (fields.some((g) => pointInPolygon(p, g.points) && !inLane(g, p))) return true;
    }
    return false;
  }

  /** True when there are minefields or obstacles at all (most scenarios have none). */
  get any(): boolean {
    for (const g of this.engine.graphics.values()) if (g.kind === 'minefield' || g.kind === 'obstacle') return true;
    return false;
  }

  /**
   * Per-post route cost multipliers for a force and domain (null when nothing applies):
   * obstacles are impassable to vehicles and slow on foot; known minefields are avoided.
   */
  overlay(force: ForceId | undefined, domain: string): PostOverlay | null {
    if (domain === 'air' || domain === 'surface') return null;
    const key = `${force}:${domain}`;
    if (this.overlays.has(key)) return this.overlays.get(key)!;
    const t = this.engine.terrain;
    const cs = t.spec.cellSize;
    let grid: PostOverlay | null = null;
    const mark = (i: number, f: number) => {
      grid ??= new PostOverlay(t.cols, t.rows);
      grid.max(i, f);
    };
    for (const g of this.list('obstacle')) {
      for (let k = 1; k < g.points.length; k++) {
        const a = g.points[k - 1];
        const b = g.points[k];
        const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (cs / 3)));
        for (let s = 0; s <= steps; s++) {
          const p = { x: a.x + ((b.x - a.x) * s) / steps, y: a.y + ((b.y - a.y) * s) / steps };
          if (inLane(g, p)) continue;
          const i = t.nearestPost(p.x, p.y);
          // A post a lane runs through stays open (routes are threaded through the lane itself afterwards).
          const post = { x: (i % t.cols) * cs, y: Math.floor(i / t.cols) * cs };
          if (inLane(g, post, cs / 2)) continue;
          mark(i, domain === 'lifeform' ? OBSTACLE_COST_ON_FOOT : Infinity);
        }
      }
    }
    for (const g of this.list('minefield')) {
      if (force === undefined || !knows(g, force) || g.points.length < 3) continue;
      const xs = g.points.map((p) => p.x);
      const ys = g.points.map((p) => p.y);
      // Keep routes a margin away from the edge: a path along it would clip the field.
      const margin = cs * 0.75;
      const nearEdge = (p: Vec2) => g.points.some((a, i) => distToSegment(p, a, g.points[(i + 1) % g.points.length]) < margin);
      for (let r = Math.max(0, Math.floor((Math.min(...ys) - margin) / cs)); r <= Math.min(t.rows - 1, Math.ceil((Math.max(...ys) + margin) / cs)); r++) {
        for (let c = Math.max(0, Math.floor((Math.min(...xs) - margin) / cs)); c <= Math.min(t.cols - 1, Math.ceil((Math.max(...xs) + margin) / cs)); c++) {
          const p = { x: c * cs, y: r * cs };
          if ((pointInPolygon(p, g.points) || nearEdge(p)) && !inLane(g, p, cs / 2)) mark(r * t.cols + c, MINEFIELD_COST);
        }
      }
    }
    this.overlays.set(key, grid);
    return grid;
  }

  /**
   * Make a vehicle route that crosses an obstacle line near a lane go through the lane's
   * centreline (the route grid is coarser than a lane is wide).
   */
  threadLanes(route: Vec2[], from: Vec2): Vec2[] {
    const out: Vec2[] = [];
    let prev = from;
    for (const p of route) {
      const g = this.crossing(prev, p);
      if (g?.lanes?.length) {
        const mid = { x: (prev.x + p.x) / 2, y: (prev.y + p.y) / 2 };
        const lane = g.lanes.reduce((a, b) => (distToSegment(mid, a.from, a.to) <= distToSegment(mid, b.from, b.to) ? a : b));
        const fromFirst = Math.hypot(lane.from.x - prev.x, lane.from.y - prev.y) <= Math.hypot(lane.to.x - prev.x, lane.to.y - prev.y);
        out.push(...(fromFirst ? [lane.from, lane.to] : [lane.to, lane.from]).map((q) => ({ ...q })));
      }
      out.push(p);
      prev = p;
    }
    return out;
  }

  /** After a ground move from prev: stop vehicles at obstacles, slow infantry, and check for mines. */
  afterMove(e: Entity, prev: Vec2): void {
    const g = this.crossing(prev, e);
    if (g) {
      if (e.domain === 'lifeform') {
        // Climbing through takes time.
        e.x = prev.x + (e.x - prev.x) * 0.3;
        e.y = prev.y + (e.y - prev.y) * 0.3;
      } else {
        e.x = prev.x;
        e.y = prev.y;
        e.speed = 0;
        e.blocked = true;
        return;
      }
    }
    const d = Math.hypot(e.x - prev.x, e.y - prev.y);
    if (d <= 0) return;
    const mf = this.minefieldAt(e);
    if (!mf) return;
    // Chance of setting one off grows with the distance driven through the field.
    const p = 1 - Math.exp(-((mf.density ?? DEFAULT_DENSITY) * d) / 100);
    if (this.engine.rng.chance(p)) this.engine.mineStrike(e, mf);
  }

  /** Mark a minefield as known to a force (it found it the hard way, or saw it). */
  reveal(g: Graphic, force: ForceId): void {
    if (knows(g, force)) return;
    g.knownBy = [...(g.knownBy ?? []), force];
    this.changed();
  }

  /** The point on a minefield's or obstacle's edge closest to p. */
  nearestEdge(g: Graphic, p: Vec2): Vec2 {
    const pts = g.kind === 'minefield' ? [...g.points, g.points[0]] : g.points;
    let best = pts[0];
    let bestD = Infinity;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
      const q = { x: a.x + dx * t, y: a.y + dy * t };
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      if (d < bestD) {
        bestD = d;
        best = q;
      }
    }
    return best;
  }

  /** Open a lane through a minefield or obstacle, starting where an engineer stands. */
  breach(g: Graphic, from: Vec2): { from: Vec2; to: Vec2 } {
    const edge = this.nearestEdge(g, from);
    let dir = { x: edge.x - from.x, y: edge.y - from.y };
    let len = Math.hypot(dir.x, dir.y);
    if (len < 1) {
      // Standing on the edge: go across towards the far side (the centre of a minefield).
      const c = g.points.reduce((s, q) => ({ x: s.x + q.x / g.points.length, y: s.y + q.y / g.points.length }), { x: 0, y: 0 });
      dir = { x: c.x - edge.x, y: c.y - edge.y };
      len = Math.hypot(dir.x, dir.y) || 1;
    }
    const u = { x: dir.x / len, y: dir.y / len };
    // The lane runs from just short of the edge to the far side (a line: 40 m beyond).
    let far = 40;
    if (g.kind === 'minefield') {
      for (let s = 10; s < 5000; s += 10) {
        if (!pointInPolygon({ x: edge.x + u.x * s, y: edge.y + u.y * s }, g.points)) {
          far = s + 20;
          break;
        }
      }
    }
    const lane = { from: { x: Math.round(edge.x - u.x * 20), y: Math.round(edge.y - u.y * 20) }, to: { x: Math.round(edge.x + u.x * far), y: Math.round(edge.y + u.y * far) } };
    g.lanes = [...(g.lanes ?? []), lane];
    this.changed();
    return lane;
  }
}
