// What WeRForces' entities radiate, as DIS Electromagnetic Emission emitter systems: one
// system per radar sensor (SensorDef.radar) that is not switched off by emission control,
// and one for a switched-on jammer. Deliberately
// simple: one beam each, with representative parameters by role rather than per-system
// data. The mapping is documented in docs/reference/dis.md. Read-only on the simulation.

import type { Engine } from '../sim/engine.js';
import type { Entity } from '../sim/entity.js';
import type { EmissionBeam, EmitterSystem } from './pdu.js';

// SISO-REF-010 emitter system functions.
export const EMITTER_SURVEILLANCE = 2;
export const EMITTER_FIRE_CONTROL = 4;
export const EMITTER_JAMMER = 42;
// SISO-REF-010 beam functions.
export const BEAM_SEARCH = 1;
export const BEAM_TRACKING = 4;
export const BEAM_JAMMING = 12;

/** SISO-REF-010 emitter names for the catalog types whose real emitter is known (others send 0). */
export const EMITTER_NAMES: Record<string, number> = {
  'us-f16': 1890, // AN/APG-68
  'us-f16cj': 1890,
  'ru-su27': 21881, // N001V
  'us-ddg51': 7260, // AN/SPY-1D
  'ru-sa8': 19260, // Land Roll (target acquisition)
  'ru-krasukha': 19053, // Krasukha-2
  'us-mfew': 21981, // MFEW jammer
};

const DEG = Math.PI / 180;

function beam(b: Partial<EmissionBeam> & Pick<EmissionBeam, 'frequency' | 'frequencyRange' | 'erp' | 'beamFunction'>): EmissionBeam {
  return { beamId: 1, beamParameterIndex: 0, prf: 0, pulseWidth: 0, azimuthCenter: 0, azimuthSweep: Math.PI, elevationCenter: 0, elevationSweep: 15 * DEG, sweepSync: 0, highDensityTrackJam: 0, beamStatus: 0, jammingTechnique: 0, targets: [], ...b };
}

/** All-round search radar: S band, 1 MW. */
function searchBeam(): EmissionBeam {
  return beam({ frequency: 3e9, frequencyRange: 2e8, erp: 90, prf: 1000, pulseWidth: 1, beamFunction: BEAM_SEARCH });
}

/** Sector (fire-control) radar: X band, 100 kW, sweeping its field of view. */
function trackBeam(fov: number): EmissionBeam {
  return beam({ frequency: 9.5e9, frequencyRange: 5e8, erp: 80, prf: 3000, pulseWidth: 0.5, azimuthSweep: fov / 2, elevationSweep: Math.min(fov / 2, 30 * DEG), beamFunction: BEAM_TRACKING });
}

/** A jammer that is switched on and working (as in the EW model). */
function isJamming(e: Entity): boolean {
  return !!e.type.jammer && e.jamming && !e.firepowerKill;
}

/** The emitter systems of a local entity right now; empty if it radiates nothing. */
export function emitterSystems(engine: Engine, e: Entity): EmitterSystem[] {
  if (e.remote || !e.alive || e.embarkedIn) return [];
  const systems: EmitterSystem[] = [];
  const location = { x: 0, y: 0, z: -e.type.sensorHeight }; // entity coordinates: z down
  const name = EMITTER_NAMES[e.type.id] ?? 0;
  for (const sid of e.type.sensors) {
    const s = engine.catalog.sensors.get(sid);
    // Emission control: a radar switched off radiates nothing.
    if (!s?.radar || e.radarOff) continue;
    const allRound = s.fov >= 2 * Math.PI - 1e-6;
    systems.push({
      name,
      function: allRound ? EMITTER_SURVEILLANCE : EMITTER_FIRE_CONTROL,
      number: systems.length + 1,
      location,
      beams: [allRound ? searchBeam() : trackBeam(s.fov)],
    });
  }
  if (isJamming(e)) {
    const j = e.type.jammer!;
    const beams: EmissionBeam[] = [];
    // Radio jammers cover VHF combat net radio (30-88 MHz), radar jammers X band (8-12 GHz).
    if (j.radio) beams.push(beam({ beamId: beams.length + 1, frequency: 59e6, frequencyRange: 58e6, erp: 63, beamFunction: BEAM_JAMMING }));
    if (j.radar) beams.push(beam({ beamId: beams.length + 1, frequency: 10e9, frequencyRange: 4e9, erp: 70, beamFunction: BEAM_JAMMING }));
    // Drone datalink jammers the 2.4 and 5.8 GHz control bands (one beam over both), GNSS jammers L1/L2 (1.2-1.6 GHz).
    if (j.datalink) beams.push(beam({ beamId: beams.length + 1, frequency: 4.1e9, frequencyRange: 3.6e9, erp: 50, beamFunction: BEAM_JAMMING }));
    if (j.gnss) beams.push(beam({ beamId: beams.length + 1, frequency: 1.4e9, frequencyRange: 4e8, erp: 50, beamFunction: BEAM_JAMMING }));
    systems.push({ name, function: EMITTER_JAMMER, number: systems.length + 1, location, beams });
  }
  return systems;
}
