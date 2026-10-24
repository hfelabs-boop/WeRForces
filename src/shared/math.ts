import type { Vec2 } from './types.js';

export const TWO_PI = Math.PI * 2;
export const DEG = Math.PI / 180;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function dist2d(a: Vec2, b: Vec2): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** Bearing from a to b, radians clockwise from north in [0, 2PI). */
export function bearing(a: Vec2, b: Vec2): number {
  return normalizeAngle(Math.atan2(b.x - a.x, b.y - a.y));
}

/** Normalize an angle to [0, 2PI). */
export function normalizeAngle(a: number): number {
  a %= TWO_PI;
  return a < 0 ? a + TWO_PI : a;
}

/** Signed smallest difference to - from in (-PI, PI]. */
export function angleDiff(from: number, to: number): number {
  let d = (to - from) % TWO_PI;
  if (d > Math.PI) d -= TWO_PI;
  if (d <= -Math.PI) d += TWO_PI;
  return d;
}

/** Rotate a body-frame offset (x=right, y=forward) into the local frame for a heading. */
export function rotateOffset(offset: Vec2, heading: number): Vec2 {
  const s = Math.sin(heading);
  const c = Math.cos(heading);
  return { x: offset.x * c + offset.y * s, y: -offset.x * s + offset.y * c };
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Ray-casting point in polygon test. */
export function pointInPolygon(p: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/** Distance from point p to segment ab. */
export function distToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / len2, 0, 1);
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export function polylineLength(pts: Vec2[]): number {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += dist2d(pts[i - 1], pts[i]);
  return len;
}
