// 2D tactical map: terrain, tactical graphics, entities/units, effects and editing tools.

import { FORCE_NAMES, type EntitySnapshot, type Graphic, type GraphicKind, type SimEvent, type SimState, type TerrainData, type UnitSnapshot, type Vec2 } from '../src/shared/types.js';
import { TerrainGrid } from '../src/shared/terrainGrid.js';
import { drawSymbol, FORCE_COLORS } from './symbols.js';
import { renderTerrain } from './terrainRender.js';

export type MapMode =
  | { kind: 'select' }
  | { kind: 'place'; label: string; onPlace: (p: Vec2) => void }
  | { kind: 'draw'; graphic: GraphicKind; points: Vec2[]; onDone: (pts: Vec2[]) => void }
  | { kind: 'pickPoint'; label: string; onPick: (p: Vec2) => void }
  | { kind: 'pickEntity'; label: string; onPick: (id: string) => void };

export interface MapCallbacks {
  select(id: string | null): void;
  contextMenu(world: Vec2, client: { x: number; y: number }, hitId: string | null): void;
  hover(world: Vec2 | null): void;
  dragEntity(id: string, world: Vec2): void;
  modeChanged(mode: MapMode): void;
}

export interface MapLayers {
  labels: boolean;
  grid: boolean;
  contacts: boolean;
  ranges: boolean;
  paths: boolean;
  aggregate: 'auto' | 'units' | 'entities';
}

interface Effect {
  kind: 'fire' | 'detonation';
  /** Blast radius in metres (area-effect rounds). */
  radius?: number;
  from?: Vec2;
  to: Vec2;
  hit?: boolean;
  start: number;
  duration: number;
}

const AGGREGATE_MPP = 14; // metres per pixel above which units are drawn aggregated

export class MapView {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  terrain: TerrainData | null = null;
  grid: TerrainGrid | null = null;
  terrainImage: HTMLCanvasElement | null = null;
  state: SimState | null = null;
  private entityById = new Map<string, EntitySnapshot>();
  private unitById = new Map<string, UnitSnapshot>();
  selectedId: string | null = null;
  selectedPath: Vec2[] = [];
  mode: MapMode = { kind: 'select' };
  layers: MapLayers = { labels: true, grid: true, contacts: true, ranges: false, paths: true, aggregate: 'auto' };
  /** Weapon/sensor range rings for the selected entity, metres. */
  selectedRanges: { radius: number; label: string; color: string }[] = [];

  /** View centre in world metres and zoom in pixels per metre. */
  private cx = 8000;
  private cy = 8000;
  private scale = 0.05;
  private dpr = 1;
  private width = 0;
  private height = 0;
  private effects: Effect[] = [];
  private dirty = true;
  private mouse: { x: number; y: number } | null = null;
  private drag: { startX: number; startY: number; cx: number; cy: number; entityId?: string; moved: boolean; button: number } | null = null;

  constructor(
    readonly container: HTMLElement,
    private readonly cb: MapCallbacks,
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'map-canvas';
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.bindEvents();
    const loop = () => {
      if (this.dirty || this.effects.length > 0 || this.mode.kind !== 'select') this.draw();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  // ------------------------------------------------------------ data

  setTerrain(data: TerrainData): void {
    this.terrain = data;
    this.grid = TerrainGrid.fromData(data);
    this.terrainImage = renderTerrain(this.grid);
    this.fit();
  }

  setState(state: SimState): void {
    this.state = state;
    this.entityById = new Map(state.entities.map((e) => [e.id, e]));
    this.unitById = new Map(state.units.map((u) => [u.id, u]));
    this.dirty = true;
  }

  addEvents(events: SimEvent[]): void {
    const now = performance.now();
    for (const ev of events) {
      if (ev.kind === 'fire' && ev.from && ev.indirect) {
        // Indirect fire: muzzle flash only; the round lands later as a detonation.
        this.effects.push({ kind: 'detonation', to: ev.from, hit: false, start: now, duration: 600 });
      } else if (ev.kind === 'fire' && ev.from && ev.to) {
        this.effects.push({ kind: 'fire', from: ev.from, to: ev.to, start: now, duration: 900 });
      } else if (ev.kind === 'detonation' && ev.to) {
        this.effects.push({ kind: 'detonation', to: ev.to, hit: ev.hit, radius: ev.radius, start: now, duration: ev.radius ? 1600 : 1100 });
      }
    }
    if (this.effects.length > 400) this.effects.splice(0, this.effects.length - 400);
  }

  setMode(mode: MapMode): void {
    this.mode = mode;
    this.canvas.style.cursor = mode.kind === 'select' ? 'default' : 'crosshair';
    this.cb.modeChanged(mode);
    this.dirty = true;
  }

  invalidate(): void {
    this.dirty = true;
  }

  fit(): void {
    if (!this.terrain) return;
    const size = this.terrain.spec.size;
    this.cx = size / 2;
    this.cy = size / 2;
    this.scale = Math.min(this.width, this.height) / size * 0.95 || 0.05;
    this.dirty = true;
  }

  centerOn(p: Vec2): void {
    this.cx = p.x;
    this.cy = p.y;
    this.scale = Math.max(this.scale, 0.15);
    this.dirty = true;
  }

  // ------------------------------------------------------------ transforms

  toScreen(p: Vec2): { x: number; y: number } {
    return { x: (p.x - this.cx) * this.scale + this.width / 2, y: this.height / 2 - (p.y - this.cy) * this.scale };
  }

  toWorld(sx: number, sy: number): Vec2 {
    return { x: (sx - this.width / 2) / this.scale + this.cx, y: (this.height / 2 - sy) / this.scale + this.cy };
  }

  private get metresPerPixel(): number {
    return 1 / this.scale;
  }

  private aggregated(): boolean {
    if (this.layers.aggregate === 'units') return true;
    if (this.layers.aggregate === 'entities') return false;
    return this.metresPerPixel > AGGREGATE_MPP;
  }

  private resize(): void {
    const r = this.container.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.width = r.width;
    this.height = r.height;
    this.canvas.width = Math.max(1, Math.round(r.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * this.dpr));
    this.canvas.style.width = `${r.width}px`;
    this.canvas.style.height = `${r.height}px`;
    this.dirty = true;
  }

  // ------------------------------------------------------------ picking

  /** Objects drawn on screen with their pick positions. */
  private visibleSymbols(): { id: string; pos: Vec2; entity?: EntitySnapshot; unit?: UnitSnapshot }[] {
    const st = this.state;
    if (!st) return [];
    const out: { id: string; pos: Vec2; entity?: EntitySnapshot; unit?: UnitSnapshot }[] = [];
    const agg = this.aggregated();
    for (const e of st.entities) {
      if (e.embarkedIn) continue;
      // Units are drawn as one symbol, except a mounted unit whose leftovers show individually.
      if (agg && e.unitId && this.unitById.has(e.unitId) && !this.entityById.get(this.unitById.get(e.unitId)!.leaderId ?? '')?.embarkedIn) continue;
      out.push({ id: e.id, pos: e, entity: e });
    }
    if (agg) {
      for (const u of st.units) {
        const leader = u.leaderId ? this.entityById.get(u.leaderId) : undefined;
        if (leader?.embarkedIn) continue;
        out.push({ id: u.id, pos: leader ?? u, unit: u });
      }
    }
    return out;
  }

  hitTest(sx: number, sy: number): string | null {
    let best: string | null = null;
    let bestD = 16;
    for (const s of this.visibleSymbols()) {
      const p = this.toScreen(s.pos);
      const d = Math.hypot(p.x - sx, p.y - sy);
      if (d < bestD) {
        bestD = d;
        best = s.id;
      }
    }
    if (best) return best;
    // Graphics: vertices and segments.
    for (const g of this.state?.graphics ?? []) {
      const pts = g.points.map((p) => this.toScreen(p));
      for (let i = 0; i < pts.length; i++) {
        if (Math.hypot(pts[i].x - sx, pts[i].y - sy) < 8) return g.id;
        const j = g.kind === 'area' ? (i + 1) % pts.length : i + 1;
        if (j < pts.length && distToSeg(sx, sy, pts[i], pts[j]) < 5) return g.id;
      }
    }
    return null;
  }

  // ------------------------------------------------------------ input

  private bindEvents(): void {
    const c = this.canvas;
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = c.getBoundingClientRect();
      const sx = e.clientX - r.left;
      const sy = e.clientY - r.top;
      const before = this.toWorld(sx, sy);
      const factor = Math.exp(-e.deltaY * 0.0015);
      this.scale = Math.min(8, Math.max(0.01, this.scale * factor));
      const after = this.toWorld(sx, sy);
      this.cx += before.x - after.x;
      this.cy += before.y - after.y;
      this.dirty = true;
    }, { passive: false });

    c.addEventListener('pointerdown', (e) => {
      const r = c.getBoundingClientRect();
      const sx = e.clientX - r.left;
      const sy = e.clientY - r.top;
      const world = this.toWorld(sx, sy);
      c.setPointerCapture(e.pointerId);
      if (e.button === 2) {
        if (this.mode.kind === 'draw') {
          this.finishDraw();
          return;
        }
        if (this.mode.kind !== 'select') {
          this.setMode({ kind: 'select' });
          return;
        }
        this.cb.contextMenu(world, { x: e.clientX, y: e.clientY }, this.hitTest(sx, sy));
        return;
      }
      if (e.button === 1) {
        this.drag = { startX: sx, startY: sy, cx: this.cx, cy: this.cy, moved: false, button: 1 };
        return;
      }
      const m = this.mode;
      if (m.kind === 'place') {
        m.onPlace(world);
        if (!e.shiftKey) this.setMode({ kind: 'select' });
        return;
      }
      if (m.kind === 'pickPoint') {
        this.setMode({ kind: 'select' });
        m.onPick(world);
        return;
      }
      if (m.kind === 'pickEntity') {
        const hit = this.hitTest(sx, sy);
        if (hit && (this.entityById.has(hit) || this.unitById.has(hit))) {
          const id = this.unitById.get(hit)?.leaderId ?? hit;
          this.setMode({ kind: 'select' });
          m.onPick(this.unitById.has(hit) ? hit : id);
        }
        return;
      }
      if (m.kind === 'draw') {
        if (m.graphic === 'point') {
          this.setMode({ kind: 'select' });
          m.onDone([world]);
          return;
        }
        m.points.push(world);
        this.dirty = true;
        return;
      }
      const hit = this.hitTest(sx, sy);
      this.cb.select(hit);
      const ent = hit ? this.entityById.get(hit) : undefined;
      this.drag = {
        startX: sx,
        startY: sy,
        cx: this.cx,
        cy: this.cy,
        moved: false,
        button: 0,
        entityId: e.altKey && ent && !ent.remote ? ent.id : undefined,
      };
    });

    c.addEventListener('pointermove', (e) => {
      const r = c.getBoundingClientRect();
      const sx = e.clientX - r.left;
      const sy = e.clientY - r.top;
      this.mouse = { x: sx, y: sy };
      this.cb.hover(this.toWorld(sx, sy));
      const d = this.drag;
      if (d) {
        if (Math.hypot(sx - d.startX, sy - d.startY) > 3) d.moved = true;
        if (d.moved && !d.entityId) {
          this.cx = d.cx - (sx - d.startX) / this.scale;
          this.cy = d.cy + (sy - d.startY) / this.scale;
        }
      }
      this.dirty = true;
    });

    c.addEventListener('pointerup', (e) => {
      const d = this.drag;
      this.drag = null;
      if (d?.entityId && d.moved) {
        const r = c.getBoundingClientRect();
        this.cb.dragEntity(d.entityId, this.toWorld(e.clientX - r.left, e.clientY - r.top));
      }
    });

    c.addEventListener('dblclick', () => {
      if (this.mode.kind === 'draw') this.finishDraw();
    });

    c.addEventListener('pointerleave', () => {
      this.mouse = null;
      this.cb.hover(null);
      this.dirty = true;
    });

    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement)?.closest('input, textarea, select')) return;
      if (e.key === 'Escape') this.setMode({ kind: 'select' });
      if (e.key === 'Enter' && this.mode.kind === 'draw') this.finishDraw();
      if (e.key === 'Backspace' && this.mode.kind === 'draw') {
        this.mode.points.pop();
        this.dirty = true;
      }
    });
  }

  private finishDraw(): void {
    const m = this.mode;
    if (m.kind !== 'draw') return;
    const pts = dedupe(m.points);
    const min = m.graphic === 'area' ? 3 : m.graphic === 'point' ? 1 : 2;
    this.setMode({ kind: 'select' });
    if (pts.length >= min) m.onDone(pts);
  }

  // ------------------------------------------------------------ rendering

  private draw(): void {
    this.dirty = false;
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = '#1b1f24';
    ctx.fillRect(0, 0, this.width, this.height);
    if (!this.terrain || !this.terrainImage) {
      ctx.fillStyle = '#9aa';
      ctx.font = '14px system-ui';
      ctx.fillText('Loading terrain…', 20, 30);
      return;
    }
    const size = this.terrain.spec.size;
    const nw = this.toScreen({ x: 0, y: size });
    const span = size * this.scale;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.terrainImage, nw.x, nw.y, span, span);
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth = 1;
    ctx.strokeRect(nw.x, nw.y, span, span);

    if (this.layers.grid) this.drawGrid(size);
    this.drawRoads();
    this.drawTowns();
    this.drawGraphics();
    this.drawSelectionOverlays();
    this.drawSymbols();
    this.drawEffects();
    this.drawModeOverlay();
    this.drawScale();
  }

  private drawGrid(size: number): void {
    const ctx = this.ctx;
    const spacing = this.metresPerPixel > 40 ? 5000 : this.metresPerPixel > 4 ? 1000 : 100;
    ctx.strokeStyle = 'rgba(20,30,60,0.22)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let v = 0; v <= size; v += spacing) {
      const a = this.toScreen({ x: v, y: 0 });
      const b = this.toScreen({ x: v, y: size });
      ctx.moveTo(Math.round(a.x) + 0.5, a.y);
      ctx.lineTo(Math.round(b.x) + 0.5, b.y);
      const c = this.toScreen({ x: 0, y: v });
      const d = this.toScreen({ x: size, y: v });
      ctx.moveTo(c.x, Math.round(c.y) + 0.5);
      ctx.lineTo(d.x, Math.round(d.y) + 0.5);
    }
    ctx.stroke();
    if (spacing >= 1000) {
      ctx.fillStyle = 'rgba(20,30,60,0.55)';
      ctx.font = '10px system-ui';
      ctx.textBaseline = 'top';
      for (let v = 0; v < size; v += spacing) {
        const p = this.toScreen({ x: v, y: size });
        ctx.fillText(String(v / 1000).padStart(2, '0'), p.x + 2, Math.max(2, p.y + 2));
        const q = this.toScreen({ x: 0, y: v });
        ctx.fillText(String(v / 1000).padStart(2, '0'), Math.max(2, q.x + 2), q.y - 12);
      }
    }
  }

  private drawRoads(): void {
    const ctx = this.ctx;
    const w = Math.max(1.5, Math.min(6, 12 * this.scale));
    for (const pass of [0, 1]) {
      ctx.strokeStyle = pass === 0 ? 'rgba(70,40,10,0.85)' : '#f4d27a';
      ctx.lineWidth = pass === 0 ? w + 2 : w;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      for (const road of this.terrain!.roads) {
        road.forEach((p, i) => {
          const s = this.toScreen(p);
          if (i === 0) ctx.moveTo(s.x, s.y);
          else ctx.lineTo(s.x, s.y);
        });
      }
      ctx.stroke();
    }
  }

  private drawTowns(): void {
    const ctx = this.ctx;
    for (const t of this.terrain!.towns) {
      const s = this.toScreen(t);
      const r = Math.max(4, 250 * this.scale);
      ctx.fillStyle = 'rgba(120,70,60,0.55)';
      ctx.strokeStyle = 'rgba(60,30,20,0.9)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.font = 'bold 12px system-ui';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(255,255,255,0.8)';
      ctx.strokeText(t.name, s.x, s.y - r - 2);
      ctx.fillStyle = '#3a2016';
      ctx.fillText(t.name, s.x, s.y - r - 2);
    }
    ctx.textAlign = 'left';
  }

  private drawGraphics(): void {
    const ctx = this.ctx;
    for (const g of this.state?.graphics ?? []) {
      const col = FORCE_COLORS[g.force].fill;
      const sel = g.id === this.selectedId;
      const pts = g.points.map((p) => this.toScreen(p));
      ctx.lineWidth = sel ? 3 : 2;
      ctx.strokeStyle = sel ? '#fff' : g.force === 2 ? '#d02020' : g.force === 3 ? '#1a8a1a' : '#1060d0';
      ctx.setLineDash(g.kind === 'phaseLine' ? [10, 5] : []);
      ctx.beginPath();
      pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      if (g.kind === 'area') {
        ctx.closePath();
        ctx.fillStyle = hexAlpha(col, 0.16);
        ctx.fill();
      }
      ctx.stroke();
      ctx.setLineDash([]);
      if (g.kind === 'route') {
        for (let i = 1; i < pts.length; i++) arrow(ctx, pts[i - 1], pts[i]);
        for (const p of pts) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
          ctx.fillStyle = '#fff';
          ctx.fill();
          ctx.stroke();
        }
      }
      if (g.kind === 'point') {
        const p = pts[0];
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - 7, p.y - 14);
        ctx.lineTo(p.x + 7, p.y - 14);
        ctx.closePath();
        ctx.fillStyle = col;
        ctx.fill();
        ctx.stroke();
      }
      if (this.layers.labels) {
        const anchor = g.kind === 'area' ? centroid(pts) : pts[0];
        label(ctx, g.name, anchor.x + 6, anchor.y - (g.kind === 'point' ? 16 : 4), '#fff', 'bold 11px system-ui');
      }
    }
  }

  private drawSelectionOverlays(): void {
    const ctx = this.ctx;
    const sel = this.selectedId ? this.entityById.get(this.selectedId) ?? leaderOf(this.unitById.get(this.selectedId), this.entityById) : undefined;
    if (!sel) return;
    const s = this.toScreen(sel);
    if (this.layers.ranges) {
      for (const r of this.selectedRanges) {
        ctx.beginPath();
        ctx.arc(s.x, s.y, r.radius * this.scale, 0, Math.PI * 2);
        ctx.strokeStyle = r.color;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([6, 4]);
        ctx.stroke();
        ctx.setLineDash([]);
        label(ctx, r.label, s.x + r.radius * this.scale * 0.7071 + 3, s.y - r.radius * this.scale * 0.7071, r.color, '10px system-ui');
      }
    }
    if (this.layers.paths && this.selectedPath.length) {
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      for (const p of this.selectedPath) {
        const q = this.toScreen(p);
        ctx.lineTo(q.x, q.y);
      }
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (this.layers.contacts) {
      for (const cid of sel.contacts) {
        const t = this.entityById.get(cid);
        if (!t) continue;
        const q = this.toScreen(t);
        ctx.beginPath();
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(q.x, q.y);
        ctx.strokeStyle = cid === sel.engagingId ? 'rgba(255,60,60,0.95)' : 'rgba(255,230,80,0.7)';
        ctx.lineWidth = cid === sel.engagingId ? 2 : 1;
        ctx.stroke();
      }
    }
  }

  private drawSymbols(): void {
    const ctx = this.ctx;
    const symSize = Math.max(7, Math.min(14, 6 + this.scale * 40));
    const agg = this.aggregated();
    const selUnit = this.selectedId ? this.unitById.get(this.selectedId) : undefined;
    const selEntityUnit = this.selectedId ? this.entityById.get(this.selectedId)?.unitId : undefined;
    for (const sym of this.visibleSymbols()) {
      const p = this.toScreen(sym.pos);
      if (p.x < -40 || p.y < -40 || p.x > this.width + 40 || p.y > this.height + 40) continue;
      if (sym.entity) {
        const e = sym.entity;
        if (e.speed > 0.5 && e.damage !== 'destroyed') {
          const len = symSize * 1.2 + Math.min(40, e.speed * 0.6);
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(p.x + Math.sin(e.heading) * len, p.y - Math.cos(e.heading) * len);
          ctx.strokeStyle = '#000';
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
        const inSelUnit = (selUnit && e.unitId === selUnit.id) || (selEntityUnit && e.unitId === selEntityUnit && e.id !== this.selectedId);
        drawSymbol(ctx, p.x, p.y, symSize, e.force, e.domain, e.symbol, {
          selected: e.id === this.selectedId,
          destroyed: e.damage === 'destroyed',
          damaged: e.damage === 'mobility' || e.damage === 'firepower',
          remote: e.remote,
          // Fog of war: contacts fade as they go stale.
          alpha: e.contactAge !== undefined ? (e.contactAge > 5 ? 0.45 : 0.8) : inSelUnit || !selUnit ? 1 : 0.9,
        });
        if (inSelUnit) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, symSize * 1.7, 0, Math.PI * 2);
          ctx.strokeStyle = 'rgba(255,255,255,0.55)';
          ctx.lineWidth = 1;
          ctx.stroke();
        }
        if (this.layers.labels && (!agg || e.id === this.selectedId || this.metresPerPixel < 6)) {
          label(ctx, e.passengers ? `${e.name} +${e.passengers.length}` : e.name, p.x + symSize * 1.5, p.y + 4, FORCE_COLORS[e.force].text, '11px system-ui');
          if (e.domain === 'air') label(ctx, `${Math.round(e.agl)}m`, p.x + symSize * 1.5, p.y + 16, '#ddd', '10px system-ui');
        }
      } else if (sym.unit) {
        const u = sym.unit;
        const leader = u.leaderId ? this.entityById.get(u.leaderId) : undefined;
        const alive = u.memberIds.filter((id) => this.entityById.get(id)?.damage !== 'destroyed').length;
        drawSymbol(ctx, p.x, p.y, symSize * 1.25, u.force, leader?.domain ?? 'ground', leader?.symbol ?? 'generic', {
          selected: u.id === this.selectedId,
          destroyed: alive === 0,
          echelon: u.echelon,
        });
        if (leader && leader.speed > 0.5) {
          const len = symSize * 2 + Math.min(40, leader.speed * 0.6);
          ctx.beginPath();
          ctx.moveTo(p.x, p.y + symSize * 1.1);
          ctx.lineTo(p.x + Math.sin(leader.heading) * len, p.y + symSize * 1.1 - Math.cos(leader.heading) * len);
          ctx.strokeStyle = '#000';
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
        if (this.layers.labels) label(ctx, `${u.name} (${alive}/${u.memberIds.length})`, p.x + symSize * 2, p.y + 4, FORCE_COLORS[u.force].text, 'bold 11px system-ui');
      }
    }
  }

  private drawEffects(): void {
    const ctx = this.ctx;
    const now = performance.now();
    this.effects = this.effects.filter((f) => now - f.start < f.duration);
    for (const f of this.effects) {
      const t = (now - f.start) / f.duration;
      const to = this.toScreen(f.to);
      if (f.kind === 'fire' && f.from) {
        const from = this.toScreen(f.from);
        ctx.beginPath();
        ctx.moveTo(from.x, from.y);
        ctx.lineTo(to.x, to.y);
        ctx.strokeStyle = `rgba(255,${200 - t * 120},60,${1 - t})`;
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(from.x, from.y, 4 + t * 6, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255,240,150,${(1 - t) * 0.9})`;
        ctx.fill();
      } else if (f.radius) {
        // Area burst drawn to scale (at least a few pixels).
        const r = Math.max(6, (f.radius * this.scale) * (0.4 + 0.6 * t));
        ctx.beginPath();
        ctx.arc(to.x, to.y, r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255,${f.hit ? 90 : 170},20,${(1 - t) * 0.55})`;
        ctx.fill();
        ctx.strokeStyle = `rgba(60,40,20,${(1 - t) * 0.8})`;
        ctx.lineWidth = 1;
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.arc(to.x, to.y, 4 + t * (f.hit ? 22 : 12), 0, Math.PI * 2);
        ctx.fillStyle = f.hit ? `rgba(255,90,20,${(1 - t) * 0.8})` : `rgba(200,200,200,${(1 - t) * 0.6})`;
        ctx.fill();
      }
    }
  }

  private drawModeOverlay(): void {
    const ctx = this.ctx;
    const m = this.mode;
    if (m.kind === 'draw' && m.points.length) {
      ctx.beginPath();
      m.points.forEach((p, i) => {
        const s = this.toScreen(p);
        if (i === 0) ctx.moveTo(s.x, s.y);
        else ctx.lineTo(s.x, s.y);
      });
      if (this.mouse) ctx.lineTo(this.mouse.x, this.mouse.y);
      if (m.graphic === 'area') ctx.closePath();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
      for (const p of m.points) {
        const s = this.toScreen(p);
        ctx.fillStyle = '#fff';
        ctx.fillRect(s.x - 3, s.y - 3, 6, 6);
      }
    }
    if (m.kind !== 'select') {
      const text =
        m.kind === 'draw'
          ? `Drawing ${m.graphic}: click to add points, double-click/Enter/right-click to finish, Backspace to undo, Esc to cancel`
          : m.kind === 'place'
            ? `Click to place ${m.label} (Shift+click to keep placing, Esc to cancel)`
            : `${m.label} (Esc to cancel)`;
      ctx.font = '12px system-ui';
      const w = ctx.measureText(text).width + 16;
      ctx.fillStyle = 'rgba(10,14,20,0.8)';
      ctx.fillRect(this.width / 2 - w / 2, 8, w, 24);
      ctx.fillStyle = '#ffd866';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'center';
      ctx.fillText(text, this.width / 2, 20);
      ctx.textAlign = 'left';
    }
  }

  private drawScale(): void {
    const ctx = this.ctx;
    const target = 120 / this.scale;
    const pow = Math.pow(10, Math.floor(Math.log10(target)));
    const nice = [1, 2, 5, 10].map((k) => k * pow).find((v) => v >= target * 0.5) ?? pow;
    const px = nice * this.scale;
    const x = 14;
    const y = this.height - 18;
    ctx.fillStyle = 'rgba(10,14,20,0.7)';
    ctx.fillRect(x - 6, y - 16, px + 60, 26);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, y - 4);
    ctx.lineTo(x, y);
    ctx.lineTo(x + px, y);
    ctx.lineTo(x + px, y - 4);
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.font = '11px system-ui';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(nice >= 1000 ? `${nice / 1000} km` : `${nice} m`, x + px + 6, y + 1);
  }
}

// ------------------------------------------------------------ helpers

function leaderOf(u: UnitSnapshot | undefined, byId: Map<string, EntitySnapshot>): EntitySnapshot | undefined {
  return u?.leaderId ? byId.get(u.leaderId) : undefined;
}

function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string, font: string): void {
  ctx.font = font;
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(0,0,0,0.75)';
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

function arrow(ctx: CanvasRenderingContext2D, a: { x: number; y: number }, b: { x: number; y: number }): void {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const ang = Math.atan2(b.y - a.y, b.x - a.x);
  if (Math.hypot(b.x - a.x, b.y - a.y) < 24) return;
  ctx.beginPath();
  ctx.moveTo(mx + Math.cos(ang) * 6, my + Math.sin(ang) * 6);
  ctx.lineTo(mx + Math.cos(ang + 2.5) * 6, my + Math.sin(ang + 2.5) * 6);
  ctx.lineTo(mx + Math.cos(ang - 2.5) * 6, my + Math.sin(ang - 2.5) * 6);
  ctx.closePath();
  ctx.fillStyle = ctx.strokeStyle as string;
  ctx.fill();
}

function centroid(pts: { x: number; y: number }[]): { x: number; y: number } {
  let x = 0;
  let y = 0;
  for (const p of pts) {
    x += p.x;
    y += p.y;
  }
  return { x: x / pts.length, y: y / pts.length };
}

function distToSeg(px: number, py: number, a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / l2));
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
}

function dedupe(pts: Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(last.x - p.x, last.y - p.y) > 1) out.push(p);
  }
  return out;
}

function hexAlpha(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

export function forceName(f: number): string {
  return FORCE_NAMES[f as 0 | 1 | 2 | 3] ?? String(f);
}

export type { Graphic };
