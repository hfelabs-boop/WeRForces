// Electronic warfare: jammers switched on deny enemy forces their radios or radars within
// range. A jammed radio cannot take orders on time (they arrive late), share contacts with
// the unit, call for fire or hear codewords; a jammed radar sees only part of its range,
// burning through as it closes on the jammer.

import type { Entity } from './entity.js';
import type { Engine } from './engine.js';

/** Extra delay for an order to a unit whose radio is jammed (it gets through in the end, by runner or relay). */
export const JAMMED_ORDER_DELAY = 60;
/** Least share of its range a jammed radar keeps. */
const RADAR_FLOOR = 0.3;

export class Ew {
  /** Entity id -> what is jammed for it, refreshed once a second. */
  private jammed = new Map<string, { radio?: string; radar?: number }>();

  constructor(private readonly engine: Engine) {}

  /** Active jammers: alive, switched on, not mounted. */
  jammers(): Entity[] {
    const out: Entity[] = [];
    for (const e of this.engine.entities.values()) if (e.type.jammer && e.jamming && e.alive && !e.firepowerKill && !e.embarkedIn && !e.remote) out.push(e);
    return out;
  }

  /** Recompute who is jammed (once a simulated second). */
  update(): void {
    const prev = this.jammed;
    this.jammed = new Map();
    const jammers = this.jammers();
    if (!jammers.length) {
      // The last jammer went off: once per unit (its leader) or loose entity.
      for (const [id, j] of prev) {
        const e = this.engine.entities.get(id);
        if (j.radio && e && (!e.unit || e.unit.leader === e)) this.announce(id, undefined);
      }
      return;
    }
    for (const e of this.engine.entities.values()) {
      if (!e.alive || e.remote || e.ambient) continue;
      let radio: string | undefined;
      let radar: number | undefined;
      for (const j of jammers) {
        if (!this.engine.isHostile(j.force, e.force)) continue;
        const d = Math.hypot(j.x - e.x, j.y - e.y);
        const jr = j.type.jammer!;
        if (d > jr.range) continue;
        if (jr.radio && !radio) radio = j.id;
        // Radars burn through closer in: the nearer the jammer, the more range they lose.
        if (jr.radar) radar = Math.min(radar ?? 1, Math.max(RADAR_FLOOR, d / jr.range));
      }
      if (radio || radar !== undefined) this.jammed.set(e.id, { radio, radar });
    }
    // Say when a unit (or a loose entity) loses or regains its radio.
    for (const e of this.engine.entities.values()) {
      if (e.unit && e.unit.leader !== e) continue;
      const was = prev.get(e.id)?.radio;
      const now = this.jammed.get(e.id)?.radio;
      if (!!was !== !!now) this.announce(e.id, now);
    }
  }

  private announce(id: string, by: string | undefined): void {
    const e = this.engine.entities.get(id);
    if (!e || e.ambient) return;
    const who = e.unit?.name ?? e.name;
    this.engine.log('info', by ? `${who}: radio jammed` : `${who}: radio back`, e.unit?.id ?? e.id);
  }

  /** The jammer denying this entity its radio, if any. */
  radioJammedBy(e: Entity): string | undefined {
    return this.jammed.get(e.id)?.radio;
  }

  /** The unit's leader (or the entity itself) cannot talk on the radio. */
  radioJammed(e: Entity): boolean {
    const who = e.unit?.leader ?? e;
    return !!this.jammed.get(who.id)?.radio || !!this.jammed.get(e.id)?.radio;
  }

  /** Multiplier on a radar's range (1 when not jammed). */
  radarFactor(e: Entity): number {
    return this.jammed.get(e.id)?.radar ?? 1;
  }

  clear(): void {
    this.jammed.clear();
  }

  /** For snapshots: what is jammed. */
  status(e: Entity): ('radio' | 'radar')[] | undefined {
    const j = this.jammed.get(e.id);
    if (!j) return undefined;
    const out: ('radio' | 'radar')[] = [];
    if (j.radio) out.push('radio');
    if (j.radar !== undefined) out.push('radar');
    return out;
  }
}
