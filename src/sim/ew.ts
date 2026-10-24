// Electronic warfare: jammers switched on deny enemy forces, within range, their radios,
// radars, unmanned systems' control datalinks and satellite navigation. A jammed radio
// cannot take orders on time (they arrive late), share contacts with the unit, call for
// fire or hear codewords; a jammed radar sees only part of its range, burning through as it
// closes on the jammer. What a lost datalink or GNSS means for a platform is up to the
// unmanned-systems and navigation models; this only says who is denied what. A GNSS
// jammer that spoofs gives receivers a false fix instead of none (see navigation.ts).
// Emission control is honoured here too: a unit keeping radio silence cannot use its
// radio any more than a jammed one, and a radar switched off sees nothing.

import type { JamBand } from '../shared/types.js';
import type { Entity } from './entity.js';
import type { Engine } from './engine.js';

/** Extra delay for an order to a unit whose radio is jammed (it gets through in the end, by runner or relay). */
export const JAMMED_ORDER_DELAY = 60;
/** Least share of its range a jammed radar keeps. */
const RADAR_FLOOR = 0.3;

export class Ew {
  /** Entity id -> what is jammed for it, refreshed once a second. */
  private jammed = new Map<string, { radio?: string; radar?: number; datalink?: string; gnss?: string }>();

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
      let datalink: string | undefined;
      let gnss: string | undefined;
      const link = e.type.unmanned?.link === 'rf';
      for (const j of jammers) {
        if (!this.engine.isHostile(j.force, e.force)) continue;
        const d = Math.hypot(j.x - e.x, j.y - e.y);
        const jr = j.type.jammer!;
        if (d > jr.range) continue;
        if (jr.radio && !radio) radio = j.id;
        // Radars burn through closer in: the nearer the jammer, the more range they lose.
        if (jr.radar) radar = Math.min(radar ?? 1, Math.max(RADAR_FLOOR, d / jr.range));
        // Anti-jam datalinks (frequency hopping, directional antennas) hold out farther in.
        if (jr.datalink && link && !datalink && d <= jr.range * (1 - (e.type.unmanned?.antiJam ?? 0))) datalink = j.id;
        // Only what navigates by satellite cares.
        if (jr.gnss && !gnss && (e.type.gnss || e.type.unmanned)) gnss = j.id;
      }
      if (radio || radar !== undefined || datalink || gnss) this.jammed.set(e.id, { radio, radar, datalink, gnss });
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

  /** The unit's leader (or the entity itself) cannot talk on the radio: jammed, or keeping radio silence. */
  radioJammed(e: Entity): boolean {
    const who = e.unit?.leader ?? e;
    return !!this.jammed.get(who.id)?.radio || !!this.jammed.get(e.id)?.radio || who.radioSilent || e.radioSilent;
  }

  /** Keeping radio silence (emission control), as opposed to being jammed. */
  radioSilent(e: Entity): boolean {
    return (e.unit?.leader ?? e).radioSilent || e.radioSilent;
  }

  /** The jammer cutting this unmanned system's control datalink, if any (only `rf` links can be jammed). */
  datalinkJammedBy(e: Entity): string | undefined {
    return this.jammed.get(e.id)?.datalink;
  }

  datalinkJammed(e: Entity): boolean {
    return !!this.jammed.get(e.id)?.datalink;
  }

  /** The jammer denying this entity satellite navigation (GNSS), if any. */
  gnssJammedBy(e: Entity): string | undefined {
    return this.jammed.get(e.id)?.gnss;
  }

  gnssJammed(e: Entity): boolean {
    return !!this.jammed.get(e.id)?.gnss;
  }

  /** The spoofer giving this entity a false satellite fix, if the GNSS jammer denying it spoofs. */
  gnssSpoofedBy(e: Entity): string | undefined {
    const id = this.jammed.get(e.id)?.gnss;
    return id && this.engine.entities.get(id)?.type.jammer?.spoof ? id : undefined;
  }

  /** Multiplier on a radar's range (1 when not jammed, 0 when switched off by emission control). */
  radarFactor(e: Entity): number {
    if (e.radarOff) return 0;
    return this.jammed.get(e.id)?.radar ?? 1;
  }

  clear(): void {
    this.jammed.clear();
  }

  /** For snapshots: what is jammed. */
  status(e: Entity): JamBand[] | undefined {
    const j = this.jammed.get(e.id);
    if (!j) return undefined;
    const out: JamBand[] = [];
    if (j.radio) out.push('radio');
    if (j.radar !== undefined) out.push('radar');
    if (j.datalink) out.push('datalink');
    if (j.gnss) out.push('gnss');
    return out;
  }
}
