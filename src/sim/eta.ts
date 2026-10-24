// Travel estimates for moves: distance left on the planned path and the time of arrival,
// at the speed each stretch of ground allows (roads, forest, slopes, weather).

import type { Travel, Vec2 } from '../shared/types.js';
import type { Engine } from './engine.js';
import type { Entity } from './entity.js';
import { environmentAt, groundFactor } from './environment.js';

/** Metres between speed samples along the path. */
const SAMPLE = 100;

/** Distance left and arrival time for an entity's current move, or undefined when it is not moving along a path. */
export function estimateTravel(engine: Engine, e: Entity): Travel | undefined {
  const task = e.task;
  if (!task || task.status !== 'running' || e.destroyed || e.mobilityKill || e.remote) return undefined;
  const path = task.remainingPath;
  if (!path.length) return undefined;
  const t = e.type;
  const wanted = Math.min((task.spec as { speed?: number }).speed ?? e.cruiseSpeed, t.maxSpeed);
  if (wanted <= 0) return undefined;
  const offroad = t.offroadFactor * (e.domain === 'air' || e.domain === 'surface' ? 1 : groundFactor(engine.env));
  const speedAt = (p: Vec2) => (e.domain === 'air' ? wanted : Math.min(wanted, t.maxSpeed * Math.max(engine.terrain.mobilityFactor(p.x, p.y, e.moveDomain, offroad), 0.1)));
  let remaining = 0;
  let seconds = 0;
  let from: Vec2 = { x: e.x, y: e.y };
  for (const to of path) {
    const len = Math.hypot(to.x - from.x, to.y - from.y);
    const n = Math.max(1, Math.ceil(len / SAMPLE));
    for (let i = 0; i < n; i++) {
      const f = (i + 0.5) / n;
      seconds += len / n / speedAt({ x: from.x + (to.x - from.x) * f, y: from.y + (to.y - from.y) * f });
    }
    remaining += len;
    from = to;
  }
  // Out of fuel, it is not getting there.
  if (engine.rules.fuel && t.endurance && e.domain !== 'air' && e.fuel <= 0) return { remaining: Math.round(remaining), stalled: 'out of fuel' };
  // Starting from a stop costs a little.
  if (e.speed < wanted * 0.5 && t.acceleration > 0) seconds += wanted / t.acceleration / 2;
  const eta = Math.round((engine.time + seconds) * 10) / 10;
  return { remaining: Math.round(remaining), eta, etaLocal: environmentAt(engine.environment, engine.terrain.spec.origin.lat, eta).localTime };
}

/** Recomputes at most once a simulated second per entity: snapshots go out ten times a second. */
export class TravelCache {
  private cache = new Map<string, { at: number; travel: Travel | undefined; path: Vec2 | undefined }>();

  constructor(private readonly engine: Engine) {}

  get(e: Entity): Travel | undefined {
    const now = this.engine.time;
    const first = e.task?.status === 'running' ? e.task.remainingPath.at(-1) : undefined;
    const c = this.cache.get(e.id);
    if (c && now - c.at < 1 && now >= c.at && c.path?.x === first?.x && c.path?.y === first?.y) return c.travel;
    const travel = first ? estimateTravel(this.engine, e) : undefined;
    this.cache.set(e.id, { at: now, travel, path: first });
    if (this.cache.size > 20000) this.cache.clear();
    return travel;
  }
}
