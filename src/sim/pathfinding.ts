// Grid A* used for road generation and for ground/surface route planning.

import type { Vec2 } from '../shared/types.js';

/** Returns traversal cost multiplier for a grid node, or Infinity when impassable. */
export type NodeCost = (col: number, row: number) => number;

class MinHeap {
  private keys: number[] = [];
  private vals: number[] = [];

  get size(): number {
    return this.keys.length;
  }

  push(val: number, key: number): void {
    const k = this.keys;
    const v = this.vals;
    let i = k.length;
    k.push(key);
    v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p];
      v[i] = v[p];
      i = p;
    }
    k[i] = key;
    v[i] = val;
  }

  pop(): number {
    const k = this.keys;
    const v = this.vals;
    const top = v[0];
    const lastK = k.pop()!;
    const lastV = v.pop()!;
    if (k.length > 0) {
      let i = 0;
      const n = k.length;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const c = r < n && k[r] < k[l] ? r : l;
        if (k[c] >= lastK) break;
        k[i] = k[c];
        v[i] = v[c];
        i = c;
      }
      k[i] = lastK;
      v[i] = lastV;
    }
    return top;
  }
}

const NEIGHBORS: [number, number, number][] = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, Math.SQRT2],
  [1, -1, Math.SQRT2],
  [-1, 1, Math.SQRT2],
  [-1, -1, Math.SQRT2],
];

export interface GridPathResult {
  /** Node indices (row * cols + col) from start to goal inclusive. */
  nodes: number[];
  cost: number;
}

/**
 * 8-connected A* over a cols x rows grid. Edge cost = step length * average node cost.
 * `minCost` is the smallest possible node cost and keeps the heuristic admissible.
 */
export function gridAStar(
  cols: number,
  rows: number,
  start: number,
  goal: number,
  cost: NodeCost,
  minCost = 1,
  maxExpansions = 400_000,
): GridPathResult | null {
  const n = cols * rows;
  const g = new Float64Array(n).fill(Infinity);
  const parent = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const gc = goal % cols;
  const gr = Math.floor(goal / cols);
  const h = (i: number) => {
    const dc = Math.abs((i % cols) - gc);
    const dr = Math.abs(Math.floor(i / cols) - gr);
    // Octile distance.
    return (Math.max(dc, dr) + (Math.SQRT2 - 1) * Math.min(dc, dr)) * minCost;
  };
  const sc = start % cols;
  const sr = Math.floor(start / cols);
  if (!Number.isFinite(cost(sc, sr)) || !Number.isFinite(cost(gc, gr))) return null;

  const open = new MinHeap();
  g[start] = 0;
  open.push(start, h(start));
  let expansions = 0;
  while (open.size > 0) {
    const cur = open.pop();
    if (closed[cur]) continue;
    if (cur === goal) break;
    closed[cur] = 1;
    if (++expansions > maxExpansions) return null;
    const cc = cur % cols;
    const cr = Math.floor(cur / cols);
    const curCost = cost(cc, cr);
    for (const [dc, dr, len] of NEIGHBORS) {
      const nc = cc + dc;
      const nr = cr + dr;
      if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
      const ni = nr * cols + nc;
      if (closed[ni]) continue;
      const c = cost(nc, nr);
      if (!Number.isFinite(c)) continue;
      // Prevent diagonal corner cutting through impassable cells.
      if (dc !== 0 && dr !== 0) {
        if (!Number.isFinite(cost(cc + dc, cr)) || !Number.isFinite(cost(cc, cr + dr))) continue;
      }
      const ng = g[cur] + len * 0.5 * (curCost + c);
      if (ng < g[ni]) {
        g[ni] = ng;
        parent[ni] = cur;
        open.push(ni, ng + h(ni));
      }
    }
  }
  if (!Number.isFinite(g[goal])) return null;
  const nodes: number[] = [];
  for (let i = goal; i !== -1; i = parent[i]) nodes.push(i);
  nodes.reverse();
  return { nodes, cost: g[goal] };
}

/** Ramer-Douglas-Peucker polyline simplification. */
export function simplifyPolyline(pts: Vec2[], tolerance: number): Vec2[] {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let maxD = 0;
    let idx = -1;
    const ax = pts[a].x;
    const ay = pts[a].y;
    const dx = pts[b].x - ax;
    const dy = pts[b].y - ay;
    const len = Math.hypot(dx, dy) || 1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs(dy * (pts[i].x - ax) - dx * (pts[i].y - ay)) / len;
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (idx >= 0 && maxD > tolerance) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}
