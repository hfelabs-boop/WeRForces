// Rasterises the terrain grid into a shaded relief image with water, forest and contours.

import { LAND_COVER, type TerrainGrid } from '../src/shared/terrainGrid.js';

/** Land cover tints (blended over the relief tint), by class. */
const COVER_TINT: Partial<Record<number, [[number, number, number], number]>> = {
  [LAND_COVER.shrub]: [[128, 140, 80], 0.35],
  [LAND_COVER.builtUp]: [[176, 168, 160], 0.6],
  [LAND_COVER.wetland]: [[110, 160, 150], 0.45],
  [LAND_COVER.bare]: [[210, 196, 170], 0.4],
  [LAND_COVER.snow]: [[245, 248, 252], 0.8],
};

const TINTS: [number, [number, number, number]][] = [
  [0, [164, 190, 128]],
  [60, [182, 196, 132]],
  [130, [196, 184, 136]],
  [200, [186, 160, 122]],
  [280, [214, 202, 184]],
  [400, [240, 236, 228]],
];

function tint(h: number): [number, number, number] {
  if (h <= TINTS[0][0]) return TINTS[0][1];
  for (let i = 1; i < TINTS.length; i++) {
    const [h1, c1] = TINTS[i];
    const [h0, c0] = TINTS[i - 1];
    if (h <= h1) {
      const t = (h - h0) / (h1 - h0);
      return [c0[0] + (c1[0] - c0[0]) * t, c0[1] + (c1[1] - c0[1]) * t, c0[2] + (c1[2] - c0[2]) * t];
    }
  }
  return TINTS[TINTS.length - 1][1];
}

/** Render to a canvas where pixel (0,0) is the north-west corner of the terrain. */
export function renderTerrain(grid: TerrainGrid, pxPerPost = 3, contourInterval = 20): HTMLCanvasElement {
  const n = (grid.cols - 1) * pxPerPost;
  const cv = document.createElement('canvas');
  cv.width = n;
  cv.height = n;
  const ctx = cv.getContext('2d')!;
  const img = ctx.createImageData(n, n);
  const size = grid.spec.size;
  const mPerPx = size / n;
  const heights = new Float32Array(n * n);
  let lo = Infinity;
  let hi = -Infinity;
  for (let py = 0; py < n; py++) {
    const y = size - (py + 0.5) * mPerPx;
    for (let px = 0; px < n; px++) {
      const h = grid.elevation((px + 0.5) * mPerPx, y);
      heights[py * n + px] = h;
      if (h >= 0) {
        lo = Math.min(lo, h);
        hi = Math.max(hi, h);
      }
    }
  }
  // Real terrain can sit hundreds of metres up: spread its own range over the tints.
  const relative = lo > 60 || hi > 450;
  const tintOf = (h: number) => tint(relative ? ((h - lo) / Math.max(1, hi - lo)) * 400 : h);
  if (relative && hi - lo > 600) contourInterval = hi - lo > 1500 ? 100 : 50;
  // Light from the north-west, 45 degrees up.
  const lx = -0.5;
  const ly = 0.5;
  const lz = 0.7071;
  const zScale = 2.2;
  for (let py = 0; py < n; py++) {
    for (let px = 0; px < n; px++) {
      const i = py * n + px;
      const h = heights[i];
      const hl = heights[py * n + Math.max(0, px - 1)];
      const hr = heights[py * n + Math.min(n - 1, px + 1)];
      const hu = heights[Math.max(0, py - 1) * n + px];
      const hd = heights[Math.min(n - 1, py + 1) * n + px];
      const o = i * 4;
      const x = (px + 0.5) * mPerPx;
      const y = size - (py + 0.5) * mPerPx;
      if (h < 0 || grid.isWater(x, y)) {
        const depth = h < 0 ? Math.min(1, -h / 40) : 0.3;
        img.data[o] = 92 - depth * 40;
        img.data[o + 1] = 145 - depth * 50;
        img.data[o + 2] = 200 - depth * 40;
        img.data[o + 3] = 255;
        continue;
      }
      const dx = ((hr - hl) / (2 * mPerPx)) * zScale;
      const dy = ((hu - hd) / (2 * mPerPx)) * zScale; // north is up
      const len = Math.hypot(dx, dy, 1);
      const shade = Math.max(0, (-dx * lx - dy * ly + lz) / len);
      let [r, g, b] = tintOf(h);
      const cover = grid.landCover ? COVER_TINT[grid.coverAt(x, y)] : undefined;
      if (cover) {
        const [[cr, cg, cb], a] = cover;
        r = r * (1 - a) + cr * a;
        g = g * (1 - a) + cg * a;
        b = b * (1 - a) + cb * a;
      }
      if (grid.isForest(x, y)) {
        r = r * 0.45 + 50 * 0.55;
        g = g * 0.45 + 110 * 0.55;
        b = b * 0.45 + 52 * 0.55;
      }
      const k = 0.55 + shade * 0.6;
      r *= k;
      g *= k;
      b *= k;
      // Contour where the contour band changes towards the right or below.
      const band = Math.floor(h / contourInterval);
      if (band !== Math.floor(hr / contourInterval) || band !== Math.floor(hd / contourInterval)) {
        const major = band % 5 === 4 || Math.floor(hr / contourInterval) % 5 === 0;
        const f = major ? 0.72 : 0.86;
        r *= f;
        g *= f;
        b *= f;
      }
      img.data[o] = r;
      img.data[o + 1] = g;
      img.data[o + 2] = b;
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return cv;
}
