// Simplified MIL-STD-2525 style symbology drawn on a 2D canvas.

import type { Domain, ForceId, SymbolKind, UnitTemplate } from '../src/shared/types.js';

export const FORCE_COLORS: Record<ForceId, { fill: string; stroke: string; text: string }> = {
  0: { fill: '#ffff80', stroke: '#000', text: '#ffff9a' },
  1: { fill: '#80e0ff', stroke: '#000', text: '#9fe6ff' },
  2: { fill: '#ff8080', stroke: '#000', text: '#ff9f9f' },
  3: { fill: '#aaffaa', stroke: '#000', text: '#b9ffb9' },
};

function frame(ctx: CanvasRenderingContext2D, force: ForceId, domain: Domain, s: number): void {
  ctx.beginPath();
  const hostile = force === 2;
  const neutral = force === 3;
  if (domain === 'air') {
    if (hostile) {
      ctx.moveTo(-s, s * 0.6);
      ctx.lineTo(-s, -s * 0.1);
      ctx.lineTo(0, -s * 1.1);
      ctx.lineTo(s, -s * 0.1);
      ctx.lineTo(s, s * 0.6);
    } else if (neutral) {
      ctx.moveTo(-s, s * 0.6);
      ctx.lineTo(-s, -s);
      ctx.lineTo(s, -s);
      ctx.lineTo(s, s * 0.6);
    } else {
      ctx.moveTo(-s, s * 0.6);
      ctx.lineTo(-s, 0);
      ctx.arc(0, 0, s, Math.PI, 0);
      ctx.lineTo(s, s * 0.6);
    }
    return;
  }
  if (hostile) {
    const d = s * 1.15;
    ctx.moveTo(0, -d);
    ctx.lineTo(d, 0);
    ctx.lineTo(0, d);
    ctx.lineTo(-d, 0);
    ctx.closePath();
    return;
  }
  if (neutral) {
    ctx.rect(-s * 0.9, -s * 0.9, s * 1.8, s * 1.8);
    return;
  }
  if (domain === 'surface') {
    ctx.arc(0, 0, s * 0.95, 0, Math.PI * 2);
    return;
  }
  if (force === 0) {
    ctx.arc(0, 0, s, 0, Math.PI * 2);
    return;
  }
  ctx.rect(-s * 1.3, -s * 0.85, s * 2.6, s * 1.7);
}

function icon(ctx: CanvasRenderingContext2D, kind: SymbolKind, s: number): void {
  ctx.beginPath();
  const w = s * 0.75;
  const h = s * 0.5;
  switch (kind) {
    case 'armor':
      ctx.ellipse(0, 0, w, h * 0.7, 0, 0, Math.PI * 2);
      break;
    case 'mech':
      ctx.ellipse(0, 0, w * 0.7, h * 0.5, 0, 0, Math.PI * 2);
      ctx.moveTo(-w, -h);
      ctx.lineTo(w, h);
      ctx.moveTo(-w, h);
      ctx.lineTo(w, -h);
      break;
    case 'infantry':
      ctx.moveTo(-w, -h);
      ctx.lineTo(w, h);
      ctx.moveTo(-w, h);
      ctx.lineTo(w, -h);
      break;
    case 'recon':
      ctx.moveTo(-w, h);
      ctx.lineTo(w, -h);
      break;
    case 'wheeled':
      ctx.moveTo(-w, -h * 0.2);
      ctx.lineTo(w, -h * 0.2);
      ctx.moveTo(-w * 0.45 + s * 0.12, h * 0.4);
      ctx.arc(-w * 0.45, h * 0.4, s * 0.12, 0, Math.PI * 2);
      ctx.moveTo(w * 0.45 + s * 0.12, h * 0.4);
      ctx.arc(w * 0.45, h * 0.4, s * 0.12, 0, Math.PI * 2);
      break;
    case 'air-defense':
      ctx.moveTo(-w, h * 0.8);
      ctx.quadraticCurveTo(0, -h * 0.4, w, h * 0.8);
      break;
    case 'artillery':
      ctx.arc(0, 0, s * 0.2, 0, Math.PI * 2);
      break;
    case 'engineer':
      // The NATO engineer sign: a squared-off "E" lying on its back.
      ctx.moveTo(-w * 0.6, h * 0.35);
      ctx.lineTo(-w * 0.6, -h * 0.3);
      ctx.lineTo(w * 0.6, -h * 0.3);
      ctx.lineTo(w * 0.6, h * 0.35);
      ctx.moveTo(0, -h * 0.3);
      ctx.lineTo(0, h * 0.35);
      break;
    case 'supply':
      // Combat service support, supply: a bar across the lower part of the frame.
      ctx.moveTo(-w * 1.2, h * 0.55);
      ctx.lineTo(w * 1.2, h * 0.55);
      break;
    case 'rotary':
      ctx.moveTo(-w, -h * 0.6);
      ctx.lineTo(w, h * 0.6);
      ctx.lineTo(w, -h * 0.6);
      ctx.lineTo(-w, h * 0.6);
      ctx.closePath();
      break;
    case 'fixed-wing':
      ctx.moveTo(0, -h);
      ctx.lineTo(0, h * 0.9);
      ctx.moveTo(-w, 0);
      ctx.lineTo(0, -h * 0.3);
      ctx.lineTo(w, 0);
      ctx.moveTo(-w * 0.4, h * 0.8);
      ctx.lineTo(w * 0.4, h * 0.8);
      break;
    case 'uav':
      ctx.moveTo(-w, -h * 0.4);
      ctx.lineTo(0, h * 0.4);
      ctx.lineTo(w, -h * 0.4);
      break;
    case 'ship':
      ctx.moveTo(-w, -h * 0.2);
      ctx.lineTo(w, -h * 0.2);
      ctx.lineTo(w * 0.6, h * 0.5);
      ctx.lineTo(-w * 0.6, h * 0.5);
      ctx.closePath();
      break;
    case 'boat':
      ctx.moveTo(-w * 0.7, -h * 0.1);
      ctx.lineTo(w * 0.7, -h * 0.1);
      ctx.lineTo(w * 0.35, h * 0.4);
      ctx.lineTo(-w * 0.35, h * 0.4);
      ctx.closePath();
      break;
    case 'generic':
      break;
  }
}

const ECHELON_DOTS: Record<UnitTemplate['echelon'], string> = {
  team: 'Ø',
  section: '••',
  platoon: '•••',
  company: 'I',
  flight: '✈',
  group: 'II',
};

export interface SymbolOptions {
  selected?: boolean;
  destroyed?: boolean;
  damaged?: boolean;
  remote?: boolean;
  echelon?: UnitTemplate['echelon'];
  alpha?: number;
}

/** Draw a symbol centred at (x, y) in screen pixels. `s` is the half-height. */
export function drawSymbol(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  s: number,
  force: ForceId,
  domain: Domain,
  kind: SymbolKind,
  opts: SymbolOptions = {},
): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.globalAlpha = opts.alpha ?? 1;
  const c = FORCE_COLORS[force];
  if (opts.selected) {
    ctx.beginPath();
    ctx.arc(0, 0, s * 1.9, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.setLineDash([4, 3]);
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.setLineDash([]);
  }
  frame(ctx, force, domain, s);
  ctx.fillStyle = opts.destroyed ? '#555' : c.fill;
  ctx.fill();
  ctx.lineWidth = Math.max(1.2, s * 0.13);
  ctx.strokeStyle = opts.remote ? '#ffe066' : c.stroke;
  if (opts.remote) ctx.setLineDash([3, 2]);
  ctx.stroke();
  ctx.setLineDash([]);
  icon(ctx, kind, s);
  ctx.lineWidth = Math.max(1, s * 0.11);
  ctx.strokeStyle = '#000';
  ctx.stroke();
  if (kind === 'artillery') {
    ctx.fillStyle = '#000';
    ctx.fill();
  }
  if (opts.echelon) {
    ctx.fillStyle = '#fff';
    ctx.font = `bold ${Math.round(s * 0.9)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    const top = force === 2 ? -s * 1.2 : domain === 'air' ? -s * 1.05 : -s * 0.9;
    ctx.fillText(ECHELON_DOTS[opts.echelon], 0, top - 1);
  }
  if (opts.damaged && !opts.destroyed) {
    ctx.beginPath();
    ctx.moveTo(-s, s * 1.15);
    ctx.lineTo(s, s * 1.15);
    ctx.strokeStyle = '#ffb000';
    ctx.lineWidth = 3;
    ctx.stroke();
  }
  if (opts.destroyed) {
    ctx.beginPath();
    ctx.moveTo(-s * 1.4, -s * 1.1);
    ctx.lineTo(s * 1.4, s * 1.1);
    ctx.moveTo(-s * 1.4, s * 1.1);
    ctx.lineTo(s * 1.4, -s * 1.1);
    ctx.strokeStyle = '#ff3030';
    ctx.lineWidth = 2.5;
    ctx.stroke();
  }
  ctx.restore();
}

/** Render a symbol into a small standalone canvas (for palettes and lists). */
export function symbolCanvas(force: ForceId, domain: Domain, kind: SymbolKind, size = 28, echelon?: UnitTemplate['echelon']): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  const dpr = window.devicePixelRatio || 1;
  cv.width = size * 1.4 * dpr;
  cv.height = size * dpr;
  cv.style.width = `${size * 1.4}px`;
  cv.style.height = `${size}px`;
  const ctx = cv.getContext('2d')!;
  ctx.scale(dpr, dpr);
  drawSymbol(ctx, size * 0.7, size * (echelon ? 0.6 : 0.5), size * 0.3, force, domain, kind, { echelon });
  return cv;
}
