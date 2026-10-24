// Datum records WeRForces answers Data Query and Set Data PDUs with: an entity's basic state
// under the SISO-REF-010 datum ids (variable record types). 32-bit values go in fixed datums,
// longer ones (entity type, marking, positions, vectors) in variable datums, whichever list
// the requester put the id in. The mapping is listed in docs/reference/dis.md.

import type { DisEntityType, Vec3 } from '../shared/types.js';
import type { EulerAngles } from './geodesy.js';
import { type DatumRecords, type EntityId, type FixedDatum, float32Bits, type VariableDatum } from './pdu.js';

export const DATUM_ENTITY_TYPE = 11000;
export const DATUM_KIND = 11110;
export const DATUM_DOMAIN = 11120;
export const DATUM_COUNTRY = 11130;
export const DATUM_CATEGORY = 11140;
export const DATUM_SUBCATEGORY = 11150;
export const DATUM_SPECIFIC = 11160;
export const DATUM_EXTRA = 11170;
/** Force ID; SISO-REF-010 lists it under both 11180 and 11200. */
export const DATUM_FORCE_ID = 11200;
export const DATUM_FORCE_ID_ALT = 11180;
export const DATUM_ALTERNATIVE_ENTITY_TYPE = 12000;
export const DATUM_ENTITY_MARKING = 13000;
export const DATUM_DIS_SITE = 15100;
export const DATUM_DIS_HOST = 15200;
export const DATUM_DIS_ENTITY = 15300;
export const DATUM_POSITION = 31000;
export const DATUM_GEOCENTRIC = 31200;
export const DATUM_LATITUDE = 31300;
export const DATUM_LONGITUDE = 31400;
export const DATUM_ALTITUDE = 31600;
export const DATUM_ORIENTATION = 32000;
export const DATUM_HEADING = 32100;
export const DATUM_PITCH = 32200;
export const DATUM_ROLL = 32300;
export const DATUM_APPEARANCE = 33000;
export const DATUM_MOBILITY_KILL = 35100;
export const DATUM_FIREPOWER_KILL = 35200;
export const DATUM_VELOCITY = 36000;
export const DATUM_SPEED = 36400;
/** Exercise description: number of entities (answered for the application as a whole). */
export const DATUM_ENTITIES = 43200;

/** Answered when a Data Query asks for an entity but lists no datum ids. */
export const DEFAULT_ENTITY_QUERY = [DATUM_ENTITY_TYPE, DATUM_FORCE_ID, DATUM_ENTITY_MARKING, DATUM_GEOCENTRIC, DATUM_ORIENTATION, DATUM_VELOCITY, DATUM_APPEARANCE, DATUM_SPEED];

/** The state of one entity, in DIS terms. */
export interface EntitySnapshot {
  id: EntityId;
  type: DisEntityType;
  force: number;
  marking: string;
  /** ECEF (m). */
  location: Vec3;
  /** Geodetic: latitude and longitude (radians), height above the ellipsoid (m). */
  geodetic: { lat: number; lon: number; alt: number };
  orientation: EulerAngles;
  /** Local heading (clockwise from true north), pitch and roll (radians). */
  heading: number;
  pitch: number;
  roll: number;
  appearance: number;
  mobilityKill: boolean;
  firepowerKill: boolean;
  /** ECEF (m/s). */
  velocity: Vec3;
  /** m/s. */
  speed: number;
}

function f64s(...v: number[]): Uint8Array {
  const b = new Uint8Array(8 * v.length);
  const dv = new DataView(b.buffer);
  v.forEach((x, i) => dv.setFloat64(8 * i, x));
  return b;
}

function f32s(...v: number[]): Uint8Array {
  const b = new Uint8Array(4 * v.length);
  const dv = new DataView(b.buffer);
  v.forEach((x, i) => dv.setFloat32(4 * i, x));
  return b;
}

function entityTypeBytes(t: DisEntityType): Uint8Array {
  return Uint8Array.of(t.kind, t.domain, t.country >> 8, t.country & 0xff, t.category, t.subcategory, t.specific, t.extra);
}

/** Entity marking record: character set 1 (ASCII) and 11 characters. */
function markingBytes(marking: string): Uint8Array {
  const b = new Uint8Array(12);
  b[0] = 1;
  for (let i = 0; i < 11 && i < marking.length; i++) {
    const c = marking.charCodeAt(i);
    b[i + 1] = c < 128 ? c : 63;
  }
  return b;
}

/** One datum about an entity, or null if the id is not one WeRForces answers. */
export function entityDatum(s: EntitySnapshot, id: number): { fixed: FixedDatum } | { variable: VariableDatum } | null {
  const fixed = (value: number) => ({ fixed: { id, value: value >>> 0 } });
  const variable = (data: Uint8Array) => ({ variable: { id, data } });
  const DEG = 180 / Math.PI;
  switch (id) {
    case DATUM_ENTITY_TYPE:
    case DATUM_ALTERNATIVE_ENTITY_TYPE:
      return variable(entityTypeBytes(s.type));
    case DATUM_KIND:
      return fixed(s.type.kind);
    case DATUM_DOMAIN:
      return fixed(s.type.domain);
    case DATUM_COUNTRY:
      return fixed(s.type.country);
    case DATUM_CATEGORY:
      return fixed(s.type.category);
    case DATUM_SUBCATEGORY:
      return fixed(s.type.subcategory);
    case DATUM_SPECIFIC:
      return fixed(s.type.specific);
    case DATUM_EXTRA:
      return fixed(s.type.extra);
    case DATUM_FORCE_ID:
    case DATUM_FORCE_ID_ALT:
      return fixed(s.force);
    case DATUM_ENTITY_MARKING:
      return variable(markingBytes(s.marking));
    case DATUM_DIS_SITE:
      return fixed(s.id.site);
    case DATUM_DIS_HOST:
      return fixed(s.id.application);
    case DATUM_DIS_ENTITY:
      return fixed(s.id.entity);
    case DATUM_POSITION:
    case DATUM_GEOCENTRIC:
      return variable(f64s(s.location.x, s.location.y, s.location.z));
    case DATUM_LATITUDE:
      return variable(f64s(s.geodetic.lat * DEG));
    case DATUM_LONGITUDE:
      return variable(f64s(s.geodetic.lon * DEG));
    case DATUM_ALTITUDE:
      return variable(f64s(s.geodetic.alt));
    case DATUM_ORIENTATION:
      return variable(f32s(s.orientation.psi, s.orientation.theta, s.orientation.phi));
    case DATUM_HEADING:
      return fixed(float32Bits(s.heading));
    case DATUM_PITCH:
      return fixed(float32Bits(s.pitch));
    case DATUM_ROLL:
      return fixed(float32Bits(s.roll));
    case DATUM_APPEARANCE:
      return fixed(s.appearance);
    case DATUM_MOBILITY_KILL:
      return fixed(s.mobilityKill ? 1 : 0);
    case DATUM_FIREPOWER_KILL:
      return fixed(s.firepowerKill ? 1 : 0);
    case DATUM_VELOCITY:
      return variable(f32s(s.velocity.x, s.velocity.y, s.velocity.z));
    case DATUM_SPEED:
      return fixed(float32Bits(s.speed));
    default:
      return null;
  }
}

/** The datums WeRForces knows among `ids`, about one entity (or, without one, about the application). */
export function datumsFor(s: EntitySnapshot | null, ids: number[], entityCount: number): DatumRecords {
  const out: DatumRecords = { fixed: [], variable: [] };
  for (const id of new Set(ids)) {
    const d = s ? entityDatum(s, id) : id === DATUM_ENTITIES ? { fixed: { id, value: entityCount } } : null;
    if (!d) continue;
    if ('fixed' in d) out.fixed.push(d.fixed);
    else out.variable.push(d.variable);
  }
  return out;
}
