// 2D tactical map: terrain, tactical graphics, entities/units, effects and editing tools.

import { FORCE_NAMES, type Building, type EntitySnapshot, type Graphic, type GraphicKind, type SimEvent, type SimState, type TerrainData, type UnitSnapshot, type Vec2, type Viewshed } from '../src/shared/types.js';
import { base64ToBytes, TerrainGrid } from '../src/shared/terrainGrid.js';
import { drawSymbol, FORCE_COLORS } from './symbols.js';
import { renderTerrain } from './terrainRender.js';
import { reliefImage, TiledGrid } from './tiledGrid.js';
import type { TerrainTile } from '../src/shared/terrainTiles.js';

export type MapMode =
  | { kind: 'select' }
  | { kind: 'place'; label: string; onPlace: (p: Vec2) => void }
  | { kind: 'draw'; graphic: GraphicKind; points: Vec2[]; onDone: (pts: Vec2[]) => void }
  | { kind: 'pickPoint'; label: string; onPick: (p: Vec2) => void }
  | { kind: 'pickEntity'; label: string; onPick: (id: string) => void }
  /** Distance and bearing along clicked points; with two points, line of sight between them. */
  | { kind: 'measure'; points: Vec2[]; los?: boolean | null };

export interface MapCallbacks {
  select(id: string | null): void;
  /** Shift-click: add to or remove from the selection. */
  toggleSelect(id: string): void;
  /** Shift-drag box: select these (added to the selection). */
  selectMany(ids: string[]): void;
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
  /** Everything selected (multi-selection), including selectedId. */
  selectedIds = new Set<string>();
  selectedPath: Vec2[] = [];
  mode: MapMode = { kind: 'select' };
  layers: MapLayers = { labels: true, grid: true, contacts: true, ranges: false, paths: true, aggregate: 'auto' };
  /** A viewshed overlay: seen ground clear, dead ground shaded. */
  private viewshed: { v: Viewshed; image: HTMLCanvasElement } | null = null;

  setViewshed(v: Viewshed | null): void {
    if (!v) {
      this.viewshed = null;
      this.invalidate();
      return;
    }
    const cells = base64ToBytes(v.cellsB64);
    const image = document.createElement('canvas');
    image.width = v.cols;
    image.height = v.rows;
    const ctx = image.getContext('2d')!;
    const img = ctx.createImageData(v.cols, v.rows);
    for (let r = 0; r < v.rows; r++) {
      for (let c = 0; c < v.cols; c++) {
        const val = cells[r * v.cols + c];
        // Image rows run north to south; grid rows south to north.
        const i = ((v.rows - 1 - r) * v.cols + c) * 4;
        if (val === 2) img.data.set([90, 220, 120, 70], i);
        else if (val === 1) img.data.set([200, 40, 40, 120], i);
      }
    }
    ctx.putImageData(img, 0, 0);
    this.viewshed = { v, image };
    this.invalidate();
  }

  private drawViewshed(): void {
    if (!this.viewshed) return;
    const { v, image } = this.viewshed;
    const ctx = this.ctx;
    // Cell centres are at x0 + c*cell: the image spans half a cell beyond them.
    const nw = this.toScreen({ x: v.x0 - v.cell / 2, y: v.y0 + (v.rows - 0.5) * v.cell });
    const w = v.cols * v.cell * this.scale;
    const hgt = v.rows * v.cell * this.scale;
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(image, nw.x, nw.y, w, hgt);
    ctx.restore();
    const eye = this.toScreen(v.eye);
    ctx.beginPath();
    ctx.arc(eye.x, eye.y, v.radius * this.scale, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.setLineDash([3, 5]);
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(eye.x, eye.y, 5, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
  }

  /** Places an explanation points at (what blocks a sight line), with the sight line itself. */
  explainMarks: { at: Vec2; label: string; line?: [Vec2, Vec2] }[] = [];
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
  private drag: { startX: number; startY: number; cx: number; cy: number; entityId?: string; moved: boolean; button: number; box?: boolean } | null = null;

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

  setTerrain(data: TerrainData, grid: TerrainGrid = TerrainGrid.fromData(data)): void {
    this.terrain = data;
    this.grid = grid;
    if (grid instanceof TiledGrid) {
      // Large terrain: the overview tile underneath, finer tiles for the view drawn over it.
      this.terrainImage = this.tileImage(grid, grid.get(0, 0, 0)!);
      grid.listeners.add(() => this.invalidate());
    } else {
      this.terrainImage = renderTerrain(grid);
    }
    this.buildingBuckets = bucketBuildings(data.buildings ?? []);
    this.fit();
  }

  private tileImage(g: TiledGrid, t: TerrainTile): HTMLCanvasElement {
    return reliefImage(g, this.terrain!, t);
  }

  /** The tile level for the zoom: tiles drawn between one and two screen pixels per post. */
  private tileLevel(g: TiledGrid): number {
    const ratio = this.metresPerPixel / g.spec.cellSize;
    return Math.max(0, Math.min(g.pyramid.maxZoom, g.pyramid.maxZoom - Math.ceil(Math.log2(Math.max(1, ratio)))));
  }

  private drawTiles(g: TiledGrid): void {
    const ctx = this.ctx;
    const size = g.spec.size;
    const a = this.toWorld(0, this.height);
    const b = this.toWorld(this.width, 0);
    const nw = this.toScreen({ x: 0, y: size });
    ctx.save();
    ctx.beginPath();
    ctx.rect(nw.x, nw.y, size * this.scale, size * this.scale);
    ctx.clip();
    const want = this.tileLevel(g);
    // Coarser tiles already loaded fill in while the finer ones arrive.
    for (let z = 0; z <= want; z++) {
      const span = g.pyramid.span(z);
      for (const { x, y } of g.tilesIn(z, Math.max(0, a.x), Math.max(0, a.y), Math.min(size, b.x), Math.min(size, b.y))) {
        const t = g.get(z, x, y);
        if (!t) {
          if (z === want) g.request(z, x, y);
          continue;
        }
        const p = this.toScreen({ x: x * span, y: (y + 1) * span });
        const w = span * this.scale;
        ctx.drawImage(this.tileImage(g, t), Math.floor(p.x), Math.floor(p.y), Math.ceil(w + 1), Math.ceil(w + 1));
      }
    }
    ctx.restore();
  }

  /** Roads and buildings of the finest tiles in view (only drawn zoomed in). */
  private tileFeatures(): { roads: Vec2[][]; buildings: Building[] } | null {
    const g = this.grid;
    if (!(g instanceof TiledGrid) || this.tileLevel(g) < g.pyramid.maxZoom) return null;
    const a = this.toWorld(0, this.height);
    const b = this.toWorld(this.width, 0);
    const out = { roads: [] as Vec2[][], buildings: [] as Building[] };
    const z = g.pyramid.maxZoom;
    for (const { x, y } of g.tilesIn(z, a.x, a.y, b.x, b.y)) {
      const f = g.get(z, x, y)?.features;
      if (f?.roads) out.roads.push(...f.roads);
      if (f?.buildings) out.buildings.push(...f.buildings);
    }
    return out;
  }

  /** Line of sight between two ground points, eyes 2 m up (set by the app). */
  losCheck: (a: Vec2, b: Vec2) => Promise<boolean | null> = async () => null;

  /** The entity type's 2525 SIDC pattern (set by the app from the catalog). */
  sidcOf: (typeId: string) => string | undefined = () => undefined;

  /** Buildings grouped into square buckets, for drawing only those in view. */
  private buildingBuckets = new Map<string, Building[]>();

  private drawBuildings(): void {
    // Footprints are only legible when zoomed in.
    if (this.scale < 0.25) return;
    const fromTiles = this.tileFeatures()?.buildings;
    if (fromTiles?.length) this.buildingBuckets = bucketBuildings(fromTiles);
    if (!this.buildingBuckets.size) return;
    const ctx = this.ctx;
    const a = this.toWorld(0, this.height);
    const b = this.toWorld(this.width, 0);
    ctx.fillStyle = 'rgba(96,86,80,0.85)';
    ctx.strokeStyle = 'rgba(40,34,30,0.9)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    // One bucket of margin: a building is filed under its first corner.
    for (let by = Math.floor(a.y / BUCKET) - 1; by <= Math.floor(b.y / BUCKET) + 1; by++) {
      for (let bx = Math.floor(a.x / BUCKET) - 1; bx <= Math.floor(b.x / BUCKET) + 1; bx++) {
        for (const bld of this.buildingBuckets.get(`${bx},${by}`) ?? []) {
          for (let i = 0; i < bld.pts.length; i += 2) {
            const s = this.toScreen({ x: bld.pts[i], y: bld.pts[i + 1] });
            if (i === 0) ctx.moveTo(s.x, s.y);
            else ctx.lineTo(s.x, s.y);
          }
          ctx.closePath();
        }
      }
    }
    ctx.fill();
    if (this.scale >= 0.8) ctx.stroke();
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
        const j = g.kind === 'area' || g.kind === 'minefield' ? (i + 1) % pts.length : i + 1;
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
      const fitAll = this.terrain ? (0.5 * Math.min(this.width, this.height)) / this.terrain.spec.size : 0.01;
      this.scale = Math.min(8, Math.max(Math.min(0.01, fitAll), this.scale * factor));
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
      if (m.kind === 'measure') {
        m.points.push(world);
        m.los = undefined;
        if (m.points.length === 2) {
          const [a, b] = m.points;
          void this.losCheck(a, b).then((v) => {
            if (this.mode === m && m.points.length === 2) {
              m.los = v;
              this.dirty = true;
            }
          });
        }
        this.dirty = true;
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
      if (e.shiftKey) {
        // Shift: toggle what was clicked, or drag a box to select everything inside it.
        if (hit) this.cb.toggleSelect(hit);
        else this.drag = { startX: sx, startY: sy, cx: this.cx, cy: this.cy, moved: false, button: 0, box: true };
        return;
      }
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
        if (d.moved && !d.entityId && !d.box) {
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
      if (d?.box && d.moved) {
        const r = c.getBoundingClientRect();
        const a = this.toWorld(Math.min(d.startX, e.clientX - r.left), Math.max(d.startY, e.clientY - r.top));
        const b = this.toWorld(Math.max(d.startX, e.clientX - r.left), Math.min(d.startY, e.clientY - r.top));
        const ids = this.visibleSymbols()
          .filter((s) => s.pos.x >= a.x && s.pos.x <= b.x && s.pos.y >= a.y && s.pos.y <= b.y)
          .filter((s) => !s.entity || (s.entity.damage !== 'destroyed' && s.entity.contactAge === undefined))
          .map((s) => s.id);
        if (ids.length) this.cb.selectMany(ids);
        this.dirty = true;
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
      if (e.key === 'Backspace' && (this.mode.kind === 'draw' || this.mode.kind === 'measure')) {
        this.mode.points.pop();
        if (this.mode.kind === 'measure') this.mode.los = undefined;
        this.dirty = true;
      }
    });
  }

  private finishDraw(): void {
    const m = this.mode;
    if (m.kind !== 'draw') return;
    const pts = dedupe(m.points);
    const min = m.graphic === 'area' || m.graphic === 'minefield' ? 3 : m.graphic === 'point' ? 1 : 2;
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
    if (this.grid instanceof TiledGrid) this.drawTiles(this.grid);
    else ctx.drawImage(this.terrainImage, nw.x, nw.y, span, span);
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth = 1;
    ctx.strokeRect(nw.x, nw.y, span, span);

    if (this.layers.grid) this.drawGrid(size);
    this.drawRoads();
    this.drawTowns();
    this.drawBuildings();
    this.drawNight();
    this.drawViewshed();
    this.drawJammers();
    this.drawSmoke();
    this.drawGraphics();
    this.drawSelectionOverlays();
    this.drawSymbols();
    this.drawEffects();
    this.drawExplainMarks();
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
      for (const road of [...this.terrain!.roads, ...(this.tileFeatures()?.roads ?? [])]) {
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
      if (g.kind === 'area' || g.kind === 'minefield') {
        ctx.closePath();
        ctx.fillStyle = hexAlpha(col, g.kind === 'minefield' ? 0.22 : 0.16);
        ctx.fill();
      }
      ctx.stroke();
      ctx.setLineDash([]);
      if (g.kind === 'minefield') this.drawMines(g, pts);
      if (g.kind === 'obstacle') {
        // Teeth along the line.
        for (let i = 1; i < pts.length; i++) teeth(ctx, pts[i - 1], pts[i]);
      }
      if (g.lanes?.length) {
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
        for (const l of g.lanes) laneMarker(ctx, this.toScreen(l.from), this.toScreen(l.to), Math.max(4, 15 * this.scale));
      }
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
        const anchor = g.kind === 'area' || g.kind === 'minefield' ? centroid(pts) : pts[0];
        label(ctx, g.name, anchor.x + 6, anchor.y - (g.kind === 'point' ? 16 : 4), '#fff', 'bold 11px system-ui');
      }
    }
  }

  /** Mine symbols scattered inside a minefield (a fixed pattern, so they don't move as you pan). */
  private drawMines(g: Graphic, pts: Vec2[]): void {
    const ctx = this.ctx;
    const xs = g.points.map((p) => p.x);
    const ys = g.points.map((p) => p.y);
    const step = Math.max(40, 18 / this.scale);
    const snap = (v: number) => Math.ceil(v / step) * step;
    ctx.save();
    ctx.beginPath();
    pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.closePath();
    ctx.clip();
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    let n = 0;
    for (let y = snap(Math.min(...ys)); y <= Math.max(...ys) && n < 400; y += step) {
      for (let x = snap(Math.min(...xs)) + ((y / step) % 2 ? step / 2 : 0); x <= Math.max(...xs) && n < 400; x += step, n++) {
        const s = this.toScreen({ x, y });
        ctx.beginPath();
        ctx.arc(s.x, s.y, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  /** Shade the map at night and in twilight (graphics and symbols stay bright). */
  private drawNight(): void {
    const light = this.state?.environment?.light ?? 1;
    if (light >= 1) return;
    this.ctx.fillStyle = `rgba(8, 14, 36, ${(0.55 * (1 - light)).toFixed(3)})`;
    this.ctx.fillRect(0, 0, this.width, this.height);
  }

  private drawSmoke(): void {
    const ctx = this.ctx;
    for (const c of this.state?.smoke ?? []) {
      const s = this.toScreen(c);
      const r = c.radius * this.scale;
      const grad = ctx.createRadialGradient(s.x, s.y, r * 0.2, s.x, s.y, r);
      grad.addColorStop(0, 'rgba(225,225,225,0.75)');
      grad.addColorStop(1, 'rgba(225,225,225,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
      ctx.fill();
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
      // Arrival time at the end of the path.
      const travel = sel.travel ?? (this.selectedId ? this.unitById.get(this.selectedId)?.travel : undefined);
      if (travel?.eta !== undefined) {
        const end = this.toScreen(this.selectedPath[this.selectedPath.length - 1]);
        label(ctx, `ETA ${travel.etaLocal ?? ''}`.trim(), end.x + 8, end.y + 10, '#ffffff', 'bold 11px system-ui');
      }
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

  /** Reach of active jammers: faint dashed circles. */
  private drawJammers(): void {
    if (!this.state) return;
    const ctx = this.ctx;
    for (const e of this.state.entities) {
      if (e.jamming !== true || e.damage === 'destroyed') continue;
      const range = this.jammerRange(e.typeId);
      if (!range) continue;
      const p = this.toScreen(e);
      ctx.beginPath();
      ctx.arc(p.x, p.y, range * this.scale, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(190,120,255,0.55)';
      ctx.fillStyle = 'rgba(190,120,255,0.05)';
      ctx.setLineDash([8, 6]);
      ctx.lineWidth = 1.5;
      ctx.fill();
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  /** Jammer reach by entity type (set by the app from the catalog). */
  jammerRange: (typeId: string) => number | undefined = () => undefined;

  private drawExplainMarks(): void {
    const ctx = this.ctx;
    for (const m of this.explainMarks) {
      const p = this.toScreen(m.at);
      if (m.line) {
        const a = this.toScreen(m.line[0]);
        const b = this.toScreen(m.line[1]);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(p.x, p.y);
        ctx.strokeStyle = 'rgba(120,220,255,0.9)';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(b.x, b.y);
        ctx.strokeStyle = 'rgba(255,90,90,0.8)';
        ctx.setLineDash([5, 4]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.beginPath();
      ctx.moveTo(p.x - 7, p.y - 7);
      ctx.lineTo(p.x + 7, p.y + 7);
      ctx.moveTo(p.x + 7, p.y - 7);
      ctx.lineTo(p.x - 7, p.y + 7);
      ctx.strokeStyle = '#ff5a5a';
      ctx.lineWidth = 3;
      ctx.stroke();
      label(ctx, m.label, p.x + 10, p.y - 8, '#ffd0d0', 'bold 11px system-ui');
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
        if (e.suppression && e.suppression >= 0.15 && e.damage !== 'destroyed') {
          // Red halo: how hard the entity is being suppressed.
          ctx.beginPath();
          ctx.arc(p.x, p.y, symSize * 1.35, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(255,70,50,${Math.min(0.9, e.suppression)})`;
          ctx.lineWidth = e.pinned ? 3 : 2;
          ctx.stroke();
        }
        // Background civilians: small, faint and unlabelled unless selected.
        const bg = e.ambient && e.id !== this.selectedId;
        drawSymbol(ctx, p.x, p.y, bg ? symSize * 0.6 : symSize, e.force, e.domain, e.symbol, {
          selected: e.id === this.selectedId || this.selectedIds.has(e.id) || (this.selectedIds.size > 1 && !!e.unitId && this.selectedIds.has(e.unitId)),
          destroyed: e.damage === 'destroyed',
          damaged: e.damage === 'mobility' || e.damage === 'firepower',
          remote: e.remote,
          sidc: this.sidcOf(e.typeId),
          // Fog of war: contacts fade as they go stale.
          alpha: bg ? 0.6 : e.contactAge !== undefined ? (e.contactAge > 5 ? 0.45 : 0.8) : inSelUnit || !selUnit ? 1 : 0.9,
        });
        if (inSelUnit) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, symSize * 1.7, 0, Math.PI * 2);
          ctx.strokeStyle = 'rgba(255,255,255,0.55)';
          ctx.lineWidth = 1;
          ctx.stroke();
        }
        if (this.layers.labels && !bg && (!agg || e.id === this.selectedId || this.metresPerPixel < 6)) {
          label(ctx, e.passengers ? `${e.name} +${e.passengers.length}` : e.name, p.x + symSize * 1.5, p.y + 4, FORCE_COLORS[e.force].text, '11px system-ui');
          if (e.domain === 'air') label(ctx, `${Math.round(e.agl)}m`, p.x + symSize * 1.5, p.y + 16, '#ddd', '10px system-ui');
        }
      } else if (sym.unit) {
        const u = sym.unit;
        const leader = u.leaderId ? this.entityById.get(u.leaderId) : undefined;
        const alive = u.memberIds.filter((id) => this.entityById.get(id)?.damage !== 'destroyed').length;
        drawSymbol(ctx, p.x, p.y, symSize * 1.25, u.force, leader?.domain ?? 'ground', leader?.symbol ?? 'generic', {
          selected: u.id === this.selectedId || this.selectedIds.has(u.id),
          destroyed: alive === 0,
          echelon: u.echelon,
          sidc: leader ? this.sidcOf(leader.typeId) : undefined,
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

  private drawMeasure(m: Extract<MapMode, { kind: 'measure' }>): void {
    const ctx = this.ctx;
    const pts = [...m.points];
    if (this.mouse) pts.push(this.toWorld(this.mouse.x, this.mouse.y));
    if (!pts.length) return;
    ctx.strokeStyle = m.los === false ? '#ff6060' : m.los === true ? '#70ff90' : '#ffe070';
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 5]);
    ctx.beginPath();
    pts.forEach((p, i) => {
      const s = this.toScreen(p);
      if (i === 0) ctx.moveTo(s.x, s.y);
      else ctx.lineTo(s.x, s.y);
    });
    ctx.stroke();
    ctx.setLineDash([]);
    let total = 0;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const d = Math.hypot(b.x - a.x, b.y - a.y);
      total += d;
      const brg = ((Math.atan2(b.x - a.x, b.y - a.y) * 180) / Math.PI + 360) % 360;
      const sa = this.toScreen(a);
      const sb = this.toScreen(b);
      label(ctx, `${d >= 1000 ? `${(d / 1000).toFixed(2)} km` : `${Math.round(d)} m`}  ${String(Math.round(brg) % 360).padStart(3, '0')}°`, (sa.x + sb.x) / 2 + 6, (sa.y + sb.y) / 2 - 6, '#fff', 'bold 11px system-ui');
    }
    for (const p of m.points) {
      const s = this.toScreen(p);
      ctx.fillStyle = '#ffe070';
      ctx.fillRect(s.x - 3, s.y - 3, 6, 6);
    }
    const end = this.toScreen(pts[pts.length - 1]);
    const lines = [pts.length > 2 ? `total ${(total / 1000).toFixed(2)} km` : ''];
    if (this.grid) lines.push(`elev ${Math.round(Math.max(0, this.grid.elevation(pts[pts.length - 1].x, pts[pts.length - 1].y)))} m`);
    if (m.points.length === 2) lines.push(m.los === undefined ? 'line of sight…' : m.los === null ? '' : m.los ? 'line of sight: clear' : 'line of sight: blocked');
    lines.filter(Boolean).forEach((t, i) => label(ctx, t, end.x + 10, end.y + 16 + i * 13, '#ffe070', '11px system-ui'));
  }

  private drawModeOverlay(): void {
    const ctx = this.ctx;
    const m = this.mode;
    if (m.kind === 'measure') this.drawMeasure(m);
    const d = this.drag;
    if (d?.box && d.moved && this.mouse) {
      ctx.strokeStyle = '#fff';
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 1;
      ctx.fillStyle = 'rgba(255,255,255,0.08)';
      ctx.fillRect(d.startX, d.startY, this.mouse.x - d.startX, this.mouse.y - d.startY);
      ctx.strokeRect(d.startX, d.startY, this.mouse.x - d.startX, this.mouse.y - d.startY);
      ctx.setLineDash([]);
    }
    if (m.kind === 'draw' && m.points.length) {
      ctx.beginPath();
      m.points.forEach((p, i) => {
        const s = this.toScreen(p);
        if (i === 0) ctx.moveTo(s.x, s.y);
        else ctx.lineTo(s.x, s.y);
      });
      if (this.mouse) ctx.lineTo(this.mouse.x, this.mouse.y);
      if (m.graphic === 'area' || m.graphic === 'minefield') ctx.closePath();
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
            : m.kind === 'measure'
              ? 'Measuring: click points for distance and bearing (two points: line of sight), Backspace to undo, Esc to finish'
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

/** Obstacle teeth along a segment. */
function teeth(ctx: CanvasRenderingContext2D, a: Vec2, b: Vec2): void {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len < 4) return;
  const ux = (b.x - a.x) / len;
  const uy = (b.y - a.y) / len;
  ctx.beginPath();
  for (let d = 6; d < len; d += 12) {
    const x = a.x + ux * d;
    const y = a.y + uy * d;
    ctx.moveTo(x - ux * 4, y - uy * 4);
    ctx.lineTo(x - uy * 7, y + ux * 7);
    ctx.lineTo(x + ux * 4, y + uy * 4);
  }
  ctx.stroke();
}

/** A breached lane: two edge lines with arrows through. */
function laneMarker(ctx: CanvasRenderingContext2D, a: Vec2, b: Vec2, half: number): void {
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const nx = (-(b.y - a.y) / len) * half;
  const ny = ((b.x - a.x) / len) * half;
  ctx.beginPath();
  ctx.moveTo(a.x + nx, a.y + ny);
  ctx.lineTo(b.x + nx, b.y + ny);
  ctx.moveTo(a.x - nx, a.y - ny);
  ctx.lineTo(b.x - nx, b.y - ny);
  ctx.stroke();
  arrow(ctx, a, b);
}

const BUCKET = 250;

function bucketBuildings(list: Building[]): Map<string, Building[]> {
  const out = new Map<string, Building[]>();
  for (const b of list) {
    const key = `${Math.floor(b.pts[0] / BUCKET)},${Math.floor(b.pts[1] / BUCKET)}`;
    const l = out.get(key);
    if (l) l.push(b);
    else out.set(key, [b]);
  }
  return out;
}
