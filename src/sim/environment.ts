// Time of day and weather. The sun's altitude at the terrain's location sets the light
// level; light, visibility and precipitation limit what each kind of sensor can see.
// Wind drifts smoke; rain and snow slow movement off roads.

import type { Environment, EnvironmentState, Precipitation, SensorDef } from '../shared/types.js';

export const DEFAULT_ENVIRONMENT: Required<Environment> = {
  date: '2026-06-21',
  time: 12,
  visibility: 20000,
  precipitation: 'none',
  windSpeed: 0,
  windFrom: 270,
};

const PRECIPITATION: Precipitation[] = ['none', 'rain', 'heavyRain', 'snow'];

/** Range factors for eyes and image intensifiers, and for thermal imagers. */
const PRECIP_VISUAL: Record<Precipitation, number> = { none: 1, rain: 0.8, heavyRain: 0.55, snow: 0.6 };
const PRECIP_THERMAL: Record<Precipitation, number> = { none: 1, rain: 0.8, heavyRain: 0.6, snow: 0.75 };
/** Off-road speed factor (mud, snow). */
const PRECIP_GROUND: Record<Precipitation, number> = { none: 1, rain: 0.9, heavyRain: 0.75, snow: 0.7 };

/** Light level at night without moon (fraction of daylight sensor range). */
const NIGHT_LIGHT = 0.08;
/** Image intensifiers keep this fraction of their range in full darkness. */
const NIGHT_VISION_LIGHT = 0.6;

export function normalizeEnvironment(env: Environment | undefined, base: Required<Environment> = DEFAULT_ENVIRONMENT): Required<Environment> {
  const out = { ...base };
  if (!env) return out;
  if (typeof env.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(env.date) && !Number.isNaN(Date.parse(env.date))) out.date = env.date;
  if (Number.isFinite(env.time)) out.time = (((env.time as number) % 24) + 24) % 24;
  if (Number.isFinite(env.visibility)) out.visibility = Math.max(50, Math.min(100000, env.visibility as number));
  if (env.precipitation && PRECIPITATION.includes(env.precipitation)) out.precipitation = env.precipitation;
  if (Number.isFinite(env.windSpeed)) out.windSpeed = Math.max(0, Math.min(40, env.windSpeed as number));
  if (Number.isFinite(env.windFrom)) out.windFrom = (((env.windFrom as number) % 360) + 360) % 360;
  return out;
}

/** Day of the year (1-366) of an ISO date, plus whole days elapsed. */
function dayOfYear(date: string, extraDays: number): number {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + extraDays);
  return Math.floor((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86400000) + 1;
}

/** Sun altitude in degrees for a latitude, day of year and local solar time in hours. */
export function sunAltitude(lat: number, doy: number, hours: number): number {
  const rad = Math.PI / 180;
  const decl = -23.44 * Math.cos(((2 * Math.PI) / 365) * (doy + 10));
  const ha = 15 * (hours - 12);
  const s = Math.sin(lat * rad) * Math.sin(decl * rad) + Math.cos(lat * rad) * Math.cos(decl * rad) * Math.cos(ha * rad);
  return Math.asin(Math.max(-1, Math.min(1, s))) / rad;
}

/** Fraction of daylight sensor range available at a sun altitude. */
export function lightLevel(altitude: number): number {
  if (altitude >= 0) return 1;
  // Civil twilight fades to nautical twilight, then night.
  if (altitude >= -6) return 0.3 + 0.7 * (1 + altitude / 6);
  if (altitude >= -12) return NIGHT_LIGHT + (0.3 - NIGHT_LIGHT) * (1 + (altitude + 6) / 6);
  return NIGHT_LIGHT;
}

/** The environment at a simulation time (seconds since the scenario's start time of day). */
export function environmentAt(env: Required<Environment>, lat: number, time: number): EnvironmentState {
  const total = env.time + time / 3600;
  const days = Math.floor(total / 24);
  const hours = total - days * 24;
  const alt = sunAltitude(lat, dayOfYear(env.date, days), hours);
  const light = lightLevel(alt);
  const minutes = Math.floor(hours * 60 + 1e-6);
  const hh = Math.floor(minutes / 60);
  const mm = minutes % 60;
  const d = new Date(`${env.date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return {
    ...env,
    localDate: d.toISOString().slice(0, 10),
    localTime: `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`,
    sunAltitude: Math.round(alt * 10) / 10,
    light: Math.round(light * 1000) / 1000,
    period: alt >= 0 ? 'day' : alt >= -12 ? 'twilight' : 'night',
  };
}

/** Effective range of a sensor in the current light and weather. */
export function sensorRange(s: SensorDef, state: EnvironmentState): number {
  if (s.radar) return s.maxRange;
  if (s.thermal) {
    // Thermal imagers see in the dark and through haze, but fog and rain still cut them down.
    return Math.min(s.maxRange * PRECIP_THERMAL[state.precipitation], Math.max(state.visibility * 3, 300));
  }
  const light = s.nightVision ? Math.max(state.light, NIGHT_VISION_LIGHT) : state.light;
  return Math.min(s.maxRange * light, state.visibility) * PRECIP_VISUAL[state.precipitation];
}

export function groundFactor(state: EnvironmentState): number {
  return PRECIP_GROUND[state.precipitation];
}

/** Wind as a velocity (m/s) towards which things drift. */
export function windVector(state: EnvironmentState): { x: number; y: number } {
  const to = ((state.windFrom + 180) * Math.PI) / 180;
  return { x: Math.sin(to) * state.windSpeed, y: Math.cos(to) * state.windSpeed };
}
