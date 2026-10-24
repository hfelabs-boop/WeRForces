// WGS-84 geodesy and DIS orientation conversions.
//
// DIS carries positions as geocentric (ECEF) coordinates in metres and orientation
// as Euler angles (psi, theta, phi) of the body frame (x forward, y right, z down)
// relative to the ECEF axes, applied in Z-Y-X order.

import type { Vec3 } from '../shared/types.js';

export const WGS84_A = 6378137.0;
export const WGS84_F = 1 / 298.257223563;
export const WGS84_E2 = WGS84_F * (2 - WGS84_F);

export interface Geodetic {
  /** Radians. */
  lat: number;
  /** Radians. */
  lon: number;
  /** Metres above the ellipsoid. */
  alt: number;
}

export interface EulerAngles {
  psi: number;
  theta: number;
  phi: number;
}

export function geodeticToEcef(g: Geodetic): Vec3 {
  const sinLat = Math.sin(g.lat);
  const cosLat = Math.cos(g.lat);
  const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
  return {
    x: (n + g.alt) * cosLat * Math.cos(g.lon),
    y: (n + g.alt) * cosLat * Math.sin(g.lon),
    z: (n * (1 - WGS84_E2) + g.alt) * sinLat,
  };
}

export function ecefToGeodetic(p: Vec3): Geodetic {
  const lon = Math.atan2(p.y, p.x);
  const r = Math.hypot(p.x, p.y);
  // Iterative solution; converges to sub-millimetre in a few iterations.
  let lat = Math.atan2(p.z, r * (1 - WGS84_E2));
  let alt = 0;
  for (let i = 0; i < 6; i++) {
    const sinLat = Math.sin(lat);
    const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
    alt = r / Math.cos(lat) - n;
    lat = Math.atan2(p.z, r * (1 - (WGS84_E2 * n) / (n + alt)));
  }
  return { lat, lon, alt };
}

/** Unit vectors of the local north/east/down frame at a geodetic position, in ECEF. */
export function nedBasis(lat: number, lon: number): { n: Vec3; e: Vec3; d: Vec3 } {
  const sl = Math.sin(lat);
  const cl = Math.cos(lat);
  const so = Math.sin(lon);
  const co = Math.cos(lon);
  return {
    n: { x: -sl * co, y: -sl * so, z: cl },
    e: { x: -so, y: co, z: 0 },
    d: { x: -cl * co, y: -cl * so, z: -sl },
  };
}

function comb(b: { n: Vec3; e: Vec3; d: Vec3 }, n: number, e: number, d: number): Vec3 {
  return {
    x: b.n.x * n + b.e.x * e + b.d.x * d,
    y: b.n.y * n + b.e.y * e + b.d.y * d,
    z: b.n.z * n + b.e.z * e + b.d.z * d,
  };
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

/** Body axes in the NED frame for heading/pitch/roll (aerospace Z-Y-X convention). */
function bodyAxesNed(heading: number, pitch: number, roll: number) {
  const cps = Math.cos(heading);
  const sps = Math.sin(heading);
  const cth = Math.cos(pitch);
  const sth = Math.sin(pitch);
  const cph = Math.cos(roll);
  const sph = Math.sin(roll);
  return {
    x: [cth * cps, cth * sps, -sth],
    y: [sph * sth * cps - cph * sps, sph * sth * sps + cph * cps, sph * cth],
    z: [cph * sth * cps + sph * sps, cph * sth * sps - sph * cps, cph * cth],
  };
}

/** Convert local heading/pitch/roll (radians) at a position into DIS Euler angles. */
export function headingPitchRollToEuler(lat: number, lon: number, heading: number, pitch: number, roll: number): EulerAngles {
  const b = nedBasis(lat, lon);
  const ax = bodyAxesNed(heading, pitch, roll);
  const x = comb(b, ax.x[0], ax.x[1], ax.x[2]);
  const y = comb(b, ax.y[0], ax.y[1], ax.y[2]);
  const z = comb(b, ax.z[0], ax.z[1], ax.z[2]);
  const theta = Math.asin(Math.max(-1, Math.min(1, -x.z)));
  const psi = Math.atan2(x.y, x.x);
  const phi = Math.atan2(y.z, z.z);
  return { psi, theta, phi };
}

/** Convert DIS Euler angles at a position into local heading/pitch/roll (radians). */
export function eulerToHeadingPitchRoll(lat: number, lon: number, eu: EulerAngles): { heading: number; pitch: number; roll: number } {
  const cps = Math.cos(eu.psi);
  const sps = Math.sin(eu.psi);
  const cth = Math.cos(eu.theta);
  const sth = Math.sin(eu.theta);
  const cph = Math.cos(eu.phi);
  const sph = Math.sin(eu.phi);
  const x: Vec3 = { x: cth * cps, y: cth * sps, z: -sth };
  const y: Vec3 = { x: sph * sth * cps - cph * sps, y: sph * sth * sps + cph * cps, z: sph * cth };
  const z: Vec3 = { x: cph * sth * cps + sph * sps, y: cph * sth * sps - sph * cps, z: cph * cth };
  const b = nedBasis(lat, lon);
  const fn = dot(x, b.n);
  const fe = dot(x, b.e);
  const fd = dot(x, b.d);
  let heading = Math.atan2(fe, fn);
  if (heading < 0) heading += Math.PI * 2;
  const pitch = Math.asin(Math.max(-1, Math.min(1, -fd)));
  const roll = Math.atan2(dot(y, b.d), dot(z, b.d));
  return { heading, pitch, roll };
}

/** ENU velocity (east, north, up) to ECEF at a position. */
export function enuToEcefVector(lat: number, lon: number, v: Vec3): Vec3 {
  return comb(nedBasis(lat, lon), v.y, v.x, -v.z);
}

/** ECEF vector to ENU (x = east, y = north, z = up) at a position. */
export function ecefToEnuVector(lat: number, lon: number, v: Vec3): Vec3 {
  const b = nedBasis(lat, lon);
  return { x: dot(v, b.e), y: dot(v, b.n), z: -dot(v, b.d) };
}

/**
 * Maps the simulation's flat local frame (x east, y north metres from an origin,
 * z metres above sea level) onto the WGS-84 ellipsoid using the local radii of
 * curvature at the origin. Accurate to well under a metre over tens of km.
 */
export class LocalFrame {
  private readonly lat0: number;
  private readonly lon0: number;
  private readonly m: number;
  private readonly n: number;

  constructor(originLatDeg: number, originLonDeg: number) {
    this.lat0 = (originLatDeg * Math.PI) / 180;
    this.lon0 = (originLonDeg * Math.PI) / 180;
    const s = Math.sin(this.lat0);
    const w = Math.sqrt(1 - WGS84_E2 * s * s);
    this.m = (WGS84_A * (1 - WGS84_E2)) / (w * w * w);
    this.n = WGS84_A / w;
  }

  toGeodetic(p: Vec3): Geodetic {
    return {
      lat: this.lat0 + p.y / this.m,
      lon: this.lon0 + p.x / (this.n * Math.cos(this.lat0)),
      alt: p.z,
    };
  }

  fromGeodetic(g: Geodetic): Vec3 {
    return {
      x: (g.lon - this.lon0) * this.n * Math.cos(this.lat0),
      y: (g.lat - this.lat0) * this.m,
      z: g.alt,
    };
  }

  toEcef(p: Vec3): Vec3 {
    return geodeticToEcef(this.toGeodetic(p));
  }

  fromEcef(p: Vec3): Vec3 {
    return this.fromGeodetic(ecefToGeodetic(p));
  }
}
