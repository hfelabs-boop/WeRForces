// Uniform grid over entity positions, rebuilt when needed each tick, so sensor
// scans only look at nearby entities instead of every entity in the scenario.

import type { Entity } from './entity.js';

export class SpatialIndex {
  private items: Entity[] = [];
  /** Per force: cell key -> indices into items. */
  private forces = new Map<number, Map<number, number[]>>();
  private builtAt = NaN;
  /** Scratch for query results (item indices). */
  private hits = new Int32Array(0);

  constructor(readonly cellSize = 1000) {}

  private key(cx: number, cy: number): number {
    // Offset so negative cells (entities just off the map) still get unique keys.
    return (cx + 32768) * 65536 + (cy + 32768);
  }

  /** Index entities at their current positions (no-op if already built for `time`). */
  build(entities: Iterable<Entity>, time: number): void {
    if (this.builtAt === time) return;
    this.builtAt = time;
    this.items = [];
    this.forces.clear();
    for (const e of entities) {
      const i = this.items.push(e) - 1;
      let cells = this.forces.get(e.force);
      if (!cells) this.forces.set(e.force, (cells = new Map()));
      const k = this.key(Math.floor(e.x / this.cellSize), Math.floor(e.y / this.cellSize));
      let cell = cells.get(k);
      if (!cell) cells.set(k, (cell = []));
      cell.push(i);
    }
  }

  /** Forget the current build (call after entities are added, removed or moved). */
  invalidate(): void {
    this.builtAt = NaN;
  }

  /**
   * Entities in the grid cells overlapping a square of half-width `radius` around a
   * point (a superset of those within `radius`), optionally leaving out one force.
   * Results keep the order of the iterable passed to build(), so callers that consume
   * random numbers stay deterministic and behave exactly like a full scan.
   */
  query(x: number, y: number, radius: number, skipForce?: number): Entity[] {
    const cs = this.cellSize;
    const x0 = Math.floor((x - radius) / cs);
    const x1 = Math.floor((x + radius) / cs);
    const y0 = Math.floor((y - radius) / cs);
    const y1 = Math.floor((y + radius) / cs);
    const span = (x1 - x0 + 1) * (y1 - y0 + 1);
    if (this.hits.length < this.items.length) this.hits = new Int32Array(this.items.length);
    const hits = this.hits;
    let n = 0;
    for (const [force, cells] of this.forces) {
      if (force === skipForce) continue;
      if (span > cells.size) {
        // The box covers more cells than are occupied: walk the occupied ones instead.
        for (const [k, cell] of cells) {
          const cx = Math.floor(k / 65536) - 32768;
          const cy = (k % 65536) - 32768;
          if (cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1) for (const i of cell) hits[n++] = i;
        }
      } else {
        for (let cx = x0; cx <= x1; cx++) {
          for (let cy = y0; cy <= y1; cy++) {
            const cell = cells.get(this.key(cx, cy));
            if (cell) for (const i of cell) hits[n++] = i;
          }
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
