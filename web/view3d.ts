// 3D scene view (Three.js): terrain mesh, entity models, labels, tactical graphics,
// weapon effects, picking and an orbit/follow camera.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { TerrainGrid } from '../src/shared/terrainGrid.js';
import type { EntitySnapshot, ForceId, Graphic, SimEvent, SimState, SymbolKind, TerrainData, Vec2 } from '../src/shared/types.js';

export interface View3DCallbacks {
  select(id: string | null): void;
  contextMenu(world: Vec2, client: { x: number; y: number }, hitId: string | null): void;
}

const FORCE_HEX: Record<ForceId, number> = { 0: 0xe8d84a, 1: 0x3fa9f5, 2: 0xe0473f, 3: 0x45c25a };
const GRAPHIC_HEX: Record<ForceId, number> = { 0: 0xe8d84a, 1: 0x2f7fff, 2: 0xff3030, 3: 0x30c040 };

interface EntityObject {
  group: THREE.Group;
  model: THREE.Group;
  label: THREE.Sprite;
  ring: THREE.Mesh;
  key: string;
  labelKey: string;
}

interface Effect {
  obj: THREE.Object3D;
  material: THREE.Material & { opacity: number };
  start: number;
  duration: number;
  grow?: number;
}

// ------------------------------------------------------------ models

const geo = {
  box: new THREE.BoxGeometry(1, 1, 1),
  cyl: new THREE.CylinderGeometry(0.5, 0.5, 1, 12),
  cone: new THREE.ConeGeometry(0.5, 1, 12),
  sphere: new THREE.SphereGeometry(0.5, 16, 12),
};

function part(g: THREE.BufferGeometry, mat: THREE.Material, sx: number, sy: number, sz: number, x = 0, y = 0, z = 0, rx = 0, rz = 0): THREE.Mesh {
  const m = new THREE.Mesh(g, mat);
  m.scale.set(sx, sy, sz);
  m.position.set(x, y, z);
  m.rotation.set(rx, 0, rz);
  m.castShadow = false;
  return m;
}

/** Simple recognisable models; they face -Z (north) and sit on y = 0. Units are metres. */
function buildModel(symbol: SymbolKind, domain: string, color: number): THREE.Group {
  const body = new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.15 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x2a2f33, roughness: 0.8 });
  const g = new THREE.Group();
  const R = Math.PI / 2;
  if (domain === 'lifeform') {
    g.add(part(geo.cyl, body, 0.6, 1.3, 0.6, 0, 0.65));
    g.add(part(geo.sphere, body, 0.45, 0.45, 0.45, 0, 1.55));
    if (symbol === 'air-defense') g.add(part(geo.cyl, dark, 0.15, 1.6, 0.15, 0.3, 1.5, 0, R * 0.6));
    g.scale.setScalar(2.2); // people are tiny; exaggerate so they read at a distance
    return g;
  }
  if (domain === 'air') {
    if (symbol === 'rotary') {
      g.add(part(geo.sphere, body, 3, 2.6, 7, 0, 0, 0));
      g.add(part(geo.cyl, body, 0.6, 9, 0.6, 0, 0.3, 7, R));
      g.add(part(geo.box, body, 0.3, 2, 1.6, 0, 1, 11.3));
      const rotor = new THREE.MeshBasicMaterial({ color: 0x1c2024, transparent: true, opacity: 0.25, depthWrite: false });
      g.add(part(geo.cyl, rotor, 15, 0.05, 15, 0, 1.7, 0));
      return g;
    }
    const span = symbol === 'uav' ? 20 : 10;
    g.add(part(geo.cyl, body, 1.4, 15, 1.4, 0, 0, 0, R));
    g.add(part(geo.cone, body, 1.4, 2.5, 1.4, 0, 0, -8.7, -R));
    g.add(part(geo.box, body, span, 0.25, symbol === 'uav' ? 1.6 : 4, 0, 0, 0.5));
    g.add(part(geo.box, body, 4.5, 0.2, 1.6, 0, 0, 6.6));
    g.add(part(geo.box, body, 0.2, 3, 2, 0, 1.5, 6.6));
    return g;
  }
  if (domain === 'surface') {
    const big = symbol === 'ship';
    const L = big ? 150 : 25;
    const W = big ? 18 : 5;
    g.add(part(geo.box, body, W, big ? 9 : 2.4, L, 0, big ? 4.5 : 1.2));
    g.add(part(geo.cone, body, W, big ? 20 : 5, 2, 0, big ? 4.5 : 1.2, -L / 2 - (big ? 9 : 2), -R, 0));
    g.add(part(geo.box, body, W * 0.6, big ? 14 : 2.5, L * 0.25, 0, big ? 14 : 3.4, L * 0.05));
    if (big) g.add(part(geo.cyl, dark, 1.2, 14, 1.2, 0, 24, 0));
    return g;
  }
  // Ground vehicles.
  switch (symbol) {
    case 'armor':
      g.add(part(geo.box, body, 3.7, 1.4, 8, 0, 0.9));
      g.add(part(geo.box, dark, 3.9, 0.9, 8.2, 0, 0.45));
      g.add(part(geo.box, body, 2.8, 0.9, 3.4, 0, 2, 0.4));
      g.add(part(geo.cyl, dark, 0.22, 5.5, 0.22, 0, 2.05, -3.8, R));
      break;
    case 'artillery':
      // Self-propelled howitzer: large rear turret, long barrel at a firing elevation.
      g.add(part(geo.box, body, 3.6, 1.4, 7.5, 0, 0.9));
      g.add(part(geo.box, dark, 3.8, 0.9, 7.7, 0, 0.45));
      g.add(part(geo.box, body, 3.2, 1.6, 4.2, 0, 2.3, 1.2));
      g.add(part(geo.cyl, dark, 0.25, 7.5, 0.25, 0, 3.8, -3.4, R - 0.35));
      break;
    case 'mech':
    case 'recon':
      g.add(part(geo.box, body, 3.3, 1.8, 6.6, 0, 1.2));
      g.add(part(geo.box, dark, 3.4, 0.8, 6.8, 0, 0.4));
      g.add(part(geo.box, body, 1.8, 0.8, 2, 0, 2.5, 0));
      g.add(part(geo.cyl, dark, 0.12, 2.6, 0.12, 0, 2.6, -2, R));
      break;
    case 'air-defense':
      g.add(part(geo.box, body, 2.9, 1.8, 7.5, 0, 1.2));
      g.add(part(geo.cyl, dark, 1.2, 1, 1.2, 0, 2.6, 0.5));
      g.add(part(geo.box, body, 0.6, 0.6, 3, 1, 3.4, 0.5, -0.5));
      g.add(part(geo.box, body, 0.6, 0.6, 3, -1, 3.4, 0.5, -0.5));
      break;
    default:
      g.add(part(geo.box, body, 2.3, 1.4, 5, 0, 1.2, 0.3));
      g.add(part(geo.box, body, 2.2, 1.2, 1.8, 0, 2.4, -1.2));
      for (const [x, z] of [
        [-1.15, -1.6],
        [1.15, -1.6],
        [-1.15, 1.6],
        [1.15, 1.6],
      ]) {
        g.add(part(geo.cyl, dark, 0.9, 0.4, 0.9, x, 0.45, z, 0, R));
      }
  }
  return g;
}

function labelTexture(text: string, color: string): { tex: THREE.CanvasTexture; aspect: number } {
  const cv = document.createElement('canvas');
  const ctx = cv.getContext('2d')!;
  const font = 'bold 28px system-ui, sans-serif';
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(text).width) + 16;
  cv.width = w;
  cv.height = 40;
  ctx.font = font;
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 6;
  ctx.strokeStyle = 'rgba(0,0,0,0.85)';
  ctx.strokeText(text, 8, 21);
  ctx.fillStyle = color;
  ctx.fillText(text, 8, 21);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return { tex, aspect: w / 40 };
}

// ------------------------------------------------------------ view

export class View3D {
  readonly container: HTMLElement;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private raycaster = new THREE.Raycaster();
  private terrainMesh: THREE.Mesh | null = null;
  private waterMesh: THREE.Mesh | null = null;
  private graphicsGroup = new THREE.Group();
  private entityGroup = new THREE.Group();
  private entities = new Map<string, EntityObject>();
  private effects: Effect[] = [];
  private data: TerrainData | null = null;
  private grid: TerrainGrid | null = null;
  private texCanvas: HTMLCanvasElement | null = null;
  private state: SimState | null = null;
  private graphicsKey = '';
  private visible = false;
  private down: { x: number; y: number; button: number } | null = null;
  selectedId: string | null = null;
  exaggeration = 2;
  follow = false;
  labels = true;

  constructor(container: HTMLElement, private readonly cb: View3DCallbacks) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.domElement.className = 'view3d-canvas';
    container.append(this.renderer.domElement);
    this.camera = new THREE.PerspectiveCamera(50, 1, 5, 400000);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.maxPolarAngle = Math.PI * 0.48;
    this.controls.screenSpacePanning = false;
    this.controls.zoomToCursor = true;

    const sky = 0xa9c8e8;
    this.scene.background = new THREE.Color(sky);
    this.scene.add(new THREE.HemisphereLight(0xe8f2ff, 0x4f5b3c, 1.3));
    const sun = new THREE.DirectionalLight(0xffffff, 1.7);
    sun.position.set(-1, 1.6, -0.8);
    this.scene.add(sun, this.graphicsGroup, this.entityGroup);

    this.buildOverlay();
    this.bindPointer();
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  // ------------------------------------------------------------ public API

  setVisible(v: boolean): void {
    this.visible = v;
    if (v) this.resize();
  }

  setTerrain(data: TerrainData, grid: TerrainGrid, terrainImage: HTMLCanvasElement): void {
    this.data = data;
    this.grid = grid;
    this.texCanvas = this.composeTexture(terrainImage);
    this.buildTerrain();
    this.graphicsKey = '';
    for (const o of this.entities.values()) this.entityGroup.remove(o.group);
    this.entities.clear();
    this.resetCamera();
    const fogFar = data.spec.size * 3;
    this.scene.fog = new THREE.Fog(0xa9c8e8, data.spec.size * 0.9, fogFar);
  }

  setState(state: SimState): void {
    this.state = state;
    if (!this.data) return;
    this.syncGraphics(state.graphics);
    this.syncEntities(state.entities);
  }

  addEvents(events: SimEvent[]): void {
    if (!this.data) return;
    const now = performance.now();
    for (const ev of events) {
      if (ev.kind === 'fire' && ev.from && ev.indirect) {
        const mat = new THREE.MeshBasicMaterial({ color: 0xffe08a, transparent: true, opacity: 0.9 });
        const s = new THREE.Mesh(geo.sphere, mat);
        s.position.copy(this.toScene(ev.from.x, ev.from.y, ev.from.z + 2));
        this.scene.add(s);
        this.effects.push({ obj: s, material: mat, start: now, duration: 500, grow: 12 });
      } else if (ev.kind === 'fire' && ev.from && ev.to) {
        const mat = new THREE.LineBasicMaterial({ color: 0xffd34d, transparent: true, opacity: 1, depthTest: false });
        const g = new THREE.BufferGeometry().setFromPoints([this.toScene(ev.from.x, ev.from.y, ev.from.z), this.toScene(ev.to.x, ev.to.y, ev.to.z)]);
        const line = new THREE.Line(g, mat);
        this.scene.add(line);
        this.effects.push({ obj: line, material: mat, start: now, duration: 900 });
      } else if (ev.kind === 'detonation' && ev.to) {
        const mat = new THREE.MeshBasicMaterial({ color: ev.hit ? 0xff6a1a : 0xd8d8d8, transparent: true, opacity: 0.9 });
        const s = new THREE.Mesh(geo.sphere, mat);
        s.position.copy(this.toScene(ev.to.x, ev.to.y, ev.to.z));
        this.scene.add(s);
        this.effects.push({ obj: s, material: mat, start: now, duration: ev.radius ? 1600 : 1100, grow: ev.radius ? ev.radius * 1.5 : ev.hit ? 90 : 40 });
      }
    }
  }

  setSelected(id: string | null): void {
    this.selectedId = id;
    for (const [eid, o] of this.entities) o.ring.visible = this.isSelected(eid);
  }

  focus(id: string): void {
    const p = this.positionOf(id);
    if (!p) return;
    const delta = p.clone().sub(this.controls.target);
    this.controls.target.add(delta);
    this.camera.position.add(delta);
    // Come in reasonably close.
    const off = this.camera.position.clone().sub(this.controls.target);
    if (off.length() > 2500) this.camera.position.copy(this.controls.target).add(off.setLength(2500));
  }

  resetCamera(): void {
    if (!this.data) return;
    const s = this.data.spec.size;
    this.controls.target.set(0, 0, 0);
    this.camera.position.set(0, s * 0.55, s * 0.72);
    this.camera.near = 5;
    this.camera.far = s * 6;
    this.camera.updateProjectionMatrix();
    this.controls.maxDistance = s * 2.5;
    this.controls.minDistance = 40;
  }

  // ------------------------------------------------------------ coordinates

  /** Local (x east, y north, z MSL) -> scene coordinates. */
  toScene(x: number, y: number, z: number): THREE.Vector3 {
    const half = (this.data?.spec.size ?? 0) / 2;
    return new THREE.Vector3(x - half, z * this.exaggeration, -(y - half));
  }

  fromScene(v: THREE.Vector3): Vec2 {
    const half = (this.data?.spec.size ?? 0) / 2;
    return { x: v.x + half, y: -v.z + half };
  }

  // ------------------------------------------------------------ terrain

  private composeTexture(terrainImage: HTMLCanvasElement): HTMLCanvasElement {
    const data = this.data!;
    const cv = document.createElement('canvas');
    cv.width = terrainImage.width;
    cv.height = terrainImage.height;
    const ctx = cv.getContext('2d')!;
    ctx.drawImage(terrainImage, 0, 0);
    const k = cv.width / data.spec.size;
    const px = (p: Vec2) => [p.x * k, (data.spec.size - p.y) * k] as const;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const [w, col] of [
      [4, 'rgba(70,40,10,0.9)'],
      [2, '#f4d27a'],
    ] as const) {
      ctx.lineWidth = w;
      ctx.strokeStyle = col;
      ctx.beginPath();
      for (const road of data.roads) road.forEach((p, i) => (i ? ctx.lineTo(...px(p)) : ctx.moveTo(...px(p))));
      ctx.stroke();
    }
    for (const t of data.towns) {
      const [x, y] = px(t);
      ctx.fillStyle = 'rgba(150,90,70,0.85)';
      ctx.beginPath();
      ctx.arc(x, y, 250 * k, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(90,60,50,0.9)';
      for (let i = 0; i < 14; i++) {
        const a = (i * 2.4) % (Math.PI * 2);
        const r = (40 + ((i * 53) % 190)) * k;
        ctx.fillRect(x + Math.cos(a) * r - 3, y + Math.sin(a) * r - 3, 6, 6);
      }
    }
    return cv;
  }

  private buildTerrain(): void {
    const data = this.data!;
    const grid = this.grid!;
    if (this.terrainMesh) {
      this.scene.remove(this.terrainMesh);
      this.terrainMesh.geometry.dispose();
    }
    if (this.waterMesh) this.scene.remove(this.waterMesh);
    const size = data.spec.size;
    const seg = Math.min(grid.cols - 1, 256);
    const g = new THREE.PlaneGeometry(size, size, seg, seg);
    const pos = g.attributes.position as THREE.BufferAttribute;
    const half = size / 2;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i) + half;
      const y = pos.getY(i) + half;
      const h = grid.elevation(x, y);
      pos.setZ(i, (h < 0 ? h * 0.5 - 3 : h) * this.exaggeration);
    }
    g.rotateX(-Math.PI / 2);
    g.computeVertexNormals();
    const tex = new THREE.CanvasTexture(this.texCanvas!);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    this.terrainMesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95, metalness: 0 }));
    this.terrainMesh.name = 'terrain';
    this.scene.add(this.terrainMesh);
    const water = new THREE.Mesh(
      new THREE.PlaneGeometry(size, size),
      new THREE.MeshStandardMaterial({ color: 0x3b78b8, transparent: true, opacity: 0.78, roughness: 0.2, metalness: 0.1 }),
    );
    water.rotation.x = -Math.PI / 2;
    water.position.y = 0.2;
    this.waterMesh = water;
    this.scene.add(water);
  }

  // ------------------------------------------------------------ graphics

  private drape(points: Vec2[], closed: boolean, lift = 10): THREE.Vector3[] {
    const grid = this.grid!;
    const pts = closed ? [...points, points[0]] : points;
    const out: THREE.Vector3[] = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      out.push(this.toScene(a.x, a.y, grid.surfaceHeight(a.x, a.y) + lift));
      if (!b) break;
      const n = Math.floor(Math.hypot(b.x - a.x, b.y - a.y) / 80);
      for (let k = 1; k < n; k++) {
        const x = a.x + ((b.x - a.x) * k) / n;
        const y = a.y + ((b.y - a.y) * k) / n;
        out.push(this.toScene(x, y, grid.surfaceHeight(x, y) + lift));
      }
    }
    return out;
  }

  private syncGraphics(graphics: Graphic[]): void {
    const key = JSON.stringify(graphics) + this.exaggeration;
    if (key === this.graphicsKey) return;
    this.graphicsKey = key;
    for (const c of [...this.graphicsGroup.children]) {
      this.graphicsGroup.remove(c);
      (c as THREE.Line).geometry?.dispose();
    }
    for (const g of graphics) {
      const color = GRAPHIC_HEX[g.force];
      if (g.kind === 'point') {
        const p = g.points[0];
        const cone = new THREE.Mesh(geo.cone, new THREE.MeshStandardMaterial({ color }));
        cone.scale.set(60, 120, 60);
        cone.rotation.x = Math.PI;
        cone.position.copy(this.toScene(p.x, p.y, this.grid!.surfaceHeight(p.x, p.y) + 60));
        this.graphicsGroup.add(cone);
        continue;
      }
      const pts = this.drape(g.points, g.kind === 'area');
      const geom = new THREE.BufferGeometry().setFromPoints(pts);
      const mat =
        g.kind === 'phaseLine'
          ? new THREE.LineDashedMaterial({ color, dashSize: 120, gapSize: 80 })
          : new THREE.LineBasicMaterial({ color });
      const line = new THREE.Line(geom, mat);
      if (g.kind === 'phaseLine') line.computeLineDistances();
      this.graphicsGroup.add(line);
      if (g.kind === 'area') {
        // Translucent "curtain" so objectives read in 3D.
        const curtain: number[] = [];
        for (let i = 0; i < pts.length - 1; i++) {
          const a = pts[i];
          const b = pts[i + 1];
          const top = 120 * this.exaggeration;
          curtain.push(a.x, a.y, a.z, b.x, b.y, b.z, b.x, b.y + top, b.z, a.x, a.y, a.z, b.x, b.y + top, b.z, a.x, a.y + top, a.z);
        }
        const cg = new THREE.BufferGeometry();
        cg.setAttribute('position', new THREE.Float32BufferAttribute(curtain, 3));
        this.graphicsGroup.add(new THREE.Mesh(cg, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false })));
      }
      const anchor = g.kind === 'area' ? pts.reduce((s, p) => s.add(p), new THREE.Vector3()).divideScalar(pts.length) : pts[0];
      const { tex, aspect } = labelTexture(g.name, '#ffffff');
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, sizeAttenuation: false }));
      sprite.scale.set(0.03 * aspect, 0.03, 1);
      sprite.center.set(0, 0);
      sprite.position.copy(anchor).add(new THREE.Vector3(0, 40, 0));
      sprite.visible = this.labels;
      sprite.userData.label = true;
      this.graphicsGroup.add(sprite);
    }
  }

  // ------------------------------------------------------------ entities

  private syncEntities(list: EntitySnapshot[]): void {
    const seen = new Set<string>();
    for (const e of list) {
      if (e.embarkedIn) continue;
      seen.add(e.id);
      const dead = e.damage === 'destroyed';
      const key = `${e.typeId}|${e.force}|${dead}`;
      let o = this.entities.get(e.id);
      if (!o || o.key !== key) {
        if (o) this.entityGroup.remove(o.group);
        o = this.createEntityObject(e, key, dead);
        this.entities.set(e.id, o);
        this.entityGroup.add(o.group);
      }
      const labelKey = `${e.name}|${e.damage}|${e.remote}`;
      if (o.labelKey !== labelKey) {
        const text = `${e.name}${e.remote ? ' (DIS)' : ''}${e.damage !== 'none' ? ` [${e.damage}]` : ''}`;
        const { tex, aspect } = labelTexture(text, dead ? '#ff8080' : '#ffffff');
        (o.label.material as THREE.SpriteMaterial).map?.dispose();
        (o.label.material as THREE.SpriteMaterial).map = tex;
        o.label.scale.set(0.024 * aspect, 0.024, 1);
        o.labelKey = labelKey;
      }
      o.group.position.copy(this.toScene(e.x, e.y, e.z));
      // Wrecks sit slightly askew.
      o.model.rotation.set(dead ? 0.15 : e.pitch, -e.heading, dead ? 0.3 : 0, 'YXZ');
      o.ring.visible = this.isSelected(e.id);
    }
    for (const [id, o] of this.entities) {
      if (seen.has(id)) continue;
      this.entityGroup.remove(o.group);
      this.entities.delete(id);
    }
  }

  private createEntityObject(e: EntitySnapshot, key: string, dead: boolean): EntityObject {
    const group = new THREE.Group();
    group.userData.entityId = e.id;
    const model = buildModel(e.symbol, e.domain, dead ? 0x303030 : FORCE_HEX[e.force]);
    model.userData.entityId = e.id;
    // Invisible pick sphere makes small models easy to click.
    const pick = new THREE.Mesh(geo.sphere, new THREE.MeshBasicMaterial({ visible: false }));
    pick.scale.setScalar(e.domain === 'surface' && e.symbol === 'ship' ? 160 : 14);
    pick.userData.entityId = e.id;
    model.add(pick);
    const ring = new THREE.Mesh(new THREE.RingGeometry(9, 11, 40), new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, depthTest: false, transparent: true, opacity: 0.9 }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.5;
    ring.visible = false;
    model.add(ring);
    const label = new THREE.Sprite(new THREE.SpriteMaterial({ depthTest: false, sizeAttenuation: false }));
    label.center.set(0.5, 0);
    label.visible = this.labels;
    group.add(model, label);
    return { group, model, label, ring, key, labelKey: '' };
  }

  private isSelected(id: string): boolean {
    if (!this.selectedId) return false;
    if (id === this.selectedId) return true;
    const u = this.state?.units.find((x) => x.id === this.selectedId);
    return !!u && u.memberIds.includes(id);
  }

  private positionOf(id: string): THREE.Vector3 | null {
    const st = this.state;
    if (!st) return null;
    const u = st.units.find((x) => x.id === id);
    const e = st.entities.find((x) => x.id === (u?.leaderId ?? id));
    if (e) return this.toScene(e.x, e.y, e.z);
    const g = st.graphics.find((x) => x.id === id);
    if (g) return this.toScene(g.points[0].x, g.points[0].y, this.grid?.surfaceHeight(g.points[0].x, g.points[0].y) ?? 0);
    return null;
  }

  // ------------------------------------------------------------ frame

  private frame(): void {
    if (!this.visible) return;
    if (this.follow && this.selectedId) {
      const p = this.positionOf(this.selectedId);
      if (p) {
        const delta = p.sub(this.controls.target).multiplyScalar(0.15);
        this.controls.target.add(delta);
        this.camera.position.add(delta);
      }
    }
    this.controls.update();
    // Scale models with distance so they stay visible; labels sit above them.
    for (const o of this.entities.values()) {
      const d = this.camera.position.distanceTo(o.group.position);
      const s = Math.min(60, Math.max(1, d / 300));
      o.model.scale.setScalar(s);
      o.label.position.set(0, 14 * s, 0);
      o.label.visible = this.labels;
    }
    const now = performance.now();
    this.effects = this.effects.filter((f) => {
      const t = (now - f.start) / f.duration;
      if (t >= 1) {
        this.scene.remove(f.obj);
        f.material.dispose();
        return false;
      }
      f.material.opacity = 1 - t;
      if (f.grow) f.obj.scale.setScalar(5 + t * f.grow * Math.max(1, this.camera.position.distanceTo(f.obj.position) / 1500));
      return true;
    });
    for (const c of this.graphicsGroup.children) if (c.userData.label) c.visible = this.labels;
    this.renderer.render(this.scene, this.camera);
  }

  private resize(): void {
    const r = this.container.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    this.renderer.setSize(r.width, r.height, false);
    this.renderer.domElement.style.width = `${r.width}px`;
    this.renderer.domElement.style.height = `${r.height}px`;
    this.camera.aspect = r.width / r.height;
    this.camera.updateProjectionMatrix();
  }

  // ------------------------------------------------------------ input

  private pick(clientX: number, clientY: number): { entityId: string | null; ground: THREE.Vector3 | null } {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    let entityId: string | null = null;
    const hits = this.raycaster.intersectObjects(this.entityGroup.children, true);
    for (const h of hits) {
      let o: THREE.Object3D | null = h.object;
      while (o && !o.userData.entityId) o = o.parent;
      if (o) {
        entityId = o.userData.entityId as string;
        break;
      }
    }
    const ground = this.terrainMesh ? this.raycaster.intersectObject(this.terrainMesh, false)[0]?.point ?? null : null;
    return { entityId, ground };
  }

  private bindPointer(): void {
    const el = this.renderer.domElement;
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('pointerdown', (e) => (this.down = { x: e.clientX, y: e.clientY, button: e.button }));
    el.addEventListener('pointerup', (e) => {
      const d = this.down;
      this.down = null;
      if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) return; // a drag, not a click
      const { entityId, ground } = this.pick(e.clientX, e.clientY);
      if (d.button === 0) this.cb.select(entityId);
      if (d.button === 2 && ground) this.cb.contextMenu(this.fromScene(ground), { x: e.clientX, y: e.clientY }, entityId);
    });
    el.addEventListener('dblclick', (e) => {
      const { entityId } = this.pick(e.clientX, e.clientY);
      if (entityId) this.focus(entityId);
    });
  }

  private buildOverlay(): void {
    const bar = document.createElement('div');
    bar.className = 'view3d-bar';
    const follow = document.createElement('label');
    follow.innerHTML = '<input type="checkbox"> Follow selected';
    follow.querySelector('input')!.addEventListener('change', (e) => (this.follow = (e.target as HTMLInputElement).checked));
    const exag = document.createElement('select');
    for (const v of [1, 2, 3, 5]) exag.append(new Option(`Vertical ×${v}`, String(v), v === 2, v === 2));
    exag.addEventListener('change', () => {
      this.exaggeration = Number(exag.value);
      if (this.data) {
        this.buildTerrain();
        this.graphicsKey = '';
        if (this.state) this.setState(this.state);
      }
    });
    const focus = document.createElement('button');
    focus.textContent = 'Focus selection';
    focus.addEventListener('click', () => this.selectedId && this.focus(this.selectedId));
    const reset = document.createElement('button');
    reset.textContent = 'Reset view';
    reset.addEventListener('click', () => this.resetCamera());
    const hint = document.createElement('span');
    hint.className = 'hint';
    hint.textContent = 'Drag: orbit · Right-drag: pan · Wheel: zoom · Double-click: focus · Right-click: task';
    bar.append(follow, exag, focus, reset, hint);
    this.container.append(bar);
  }
}
