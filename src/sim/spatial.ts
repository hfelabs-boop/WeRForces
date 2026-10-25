// Uniform grid over entity positions, rebuilt when needed each tick, so sensor
// scans only look at nearby entities instead of every entity in the scenario.

import type { Entity } from './entity.js';

/** One force's entities bucketed by cell: indices into items, in item order within each cell. */
interface ForceGrid {
  force: number;
  /** Cell size: the index's, or coarser when the force is spread very widely (remote entities far away). */
  cs: number;
  /** First cell and size of the covered block of cells. */
  cx0: number;
  cy0: number;
  cols: number;
  rows: number;
  /** Cell c holds members[start[c]] .. members[start[c + 1] - 1]. */
  start: Int32Array;
  members: Int32Array;
}

/** Most cells in one force's grid. */
const MAX_CELLS = 1 << 18;

/** A coordinate fit for indexing (a broken position must not break the grid). */
function finite(v: number): number {
  return Number.isFinite(v) ? Math.max(-1e9, Math.min(1e9, v)) : 0;
}

export class SpatialIndex {
  private items: Entity[] = [];
  private grids: ForceGrid[] = [];
  private builtAt = NaN;
  /** Scratch for query results (item indices). */
  private hits = new Int32Array(0);

  constructor(readonly cellSize = 500) {}

  /** Index entities at their current positions (no-op if already built for `time`). */
  build(entities: Iterable<Entity>, time: number): void {
    if (this.builtAt === time) return;
    this.builtAt = time;
    const items: Entity[] = [];
    for (const e of entities) items.push(e);
    this.items = items;
    // Extent of each force.
    const ext = new Map<number, { x0: number; y0: number; x1: number; y1: number; count: number }>();
    for (const e of items) {
      const x = finite(e.x);
      const y = finite(e.y);
      const b = ext.get(e.force);
      if (!b) ext.set(e.force, { x0: x, y0: y, x1: x, y1: y, count: 1 });
      else {
        b.x0 = Math.min(b.x0, x);
        b.x1 = Math.max(b.x1, x);
        b.y0 = Math.min(b.y0, y);
        b.y1 = Math.max(b.y1, y);
        b.count++;
      }
    }
    const byForce = new Map<number, ForceGrid>();
    for (const [force, b] of ext) {
      let cs = this.cellSize;
      const span = (lo: number, hi: number) => Math.floor(hi / cs) - Math.floor(lo / cs) + 1;
      while (span(b.x0, b.x1) * span(b.y0, b.y1) > MAX_CELLS) cs *= 2;
      const cols = span(b.x0, b.x1);
      const rows = span(b.y0, b.y1);
      byForce.set(force, { force, cs, cx0: Math.floor(b.x0 / cs), cy0: Math.floor(b.y0 / cs), cols, rows, start: new Int32Array(cols * rows + 1), members: new Int32Array(b.count) });
    }
    // Counting sort into cells, filled in item order so each cell's list stays sorted.
    const cell = new Int32Array(items.length);
    for (let i = 0; i < items.length; i++) {
      const e = items[i];
      const g = byForce.get(e.force)!;
      cell[i] = (Math.floor(finite(e.y) / g.cs) - g.cy0) * g.cols + (Math.floor(finite(e.x) / g.cs) - g.cx0);
      g.start[cell[i] + 1]++;
    }
    const next = new Map<number, Int32Array>();
    for (const g of byForce.values()) {
      for (let c = 1; c < g.start.length; c++) g.start[c] += g.start[c - 1];
      next.set(g.force, g.start.slice(0, -1));
    }
    for (let i = 0; i < items.length; i++) {
      const force = items[i].force;
      byForce.get(force)!.members[next.get(force)![cell[i]]++] = i;
    }
    this.grids = [...byForce.values()];
  }

  /** Forget the current build (call after entities are added, removed or moved). */
  invalidate(): void {
    this.builtAt = NaN;
  }

  /**
   * Entities in the grid cells within `radius` of a point (a superset of those within
   * `radius`), optionally leaving out one force. Results keep the order of the iterable
   * passed to build(), so callers that consume random numbers stay deterministic and
   * behave exactly like a full scan.
   */
  query(x: number, y: number, radius: number, skipForce?: number): Entity[] {
    if (this.hits.length < this.items.length) this.hits = new Int32Array(this.items.length);
    const hits = this.hits;
    // A cell further away than the radius (and a metre to spare for rounding) holds no hit.
    const reach2 = (radius + 1) * (radius + 1);
    let n = 0;
    for (const g of this.grids) {
      if (g.force === skipForce) continue;
      const cs = g.cs;
      const c0 = Math.max(0, Math.floor((x - radius) / cs) - g.cx0);
      const c1 = Math.min(g.cols - 1, Math.floor((x + radius) / cs) - g.cx0);
      const r0 = Math.max(0, Math.floor((y - radius) / cs) - g.cy0);
      const r1 = Math.min(g.rows - 1, Math.floor((y + radius) / cs) - g.cy0);
      for (let r = r0; r <= r1; r++) {
        const ylo = (r + g.cy0) * cs;
        const dy = y < ylo ? ylo - y : y > ylo + cs ? y - ylo - cs : 0;
        const row = r * g.cols;
        for (let c = c0; c <= c1; c++) {
          const s = g.start[row + c];
          const e = g.start[row + c + 1];
          if (s === e) continue;
          const xlo = (c + g.cx0) * cs;
          const dx = x < xlo ? xlo - x : x > xlo + cs ? x - xlo - cs : 0;
          if (dx * dx + dy * dy > reach2) continue;
          for (let k = s; k < e; k++) hits[n++] = g.members[k];
        }
      }
    }
    // Each item is in one cell, so there are no duplicates; a typed sort is numeric.
    const sorted = hits.subarray(0, n).sort();
    const out = new Array<Entity>(n);
    for (let k = 0; k < n; k++) out[k] = this.items[sorted[k]];
    return out;
  }
}
