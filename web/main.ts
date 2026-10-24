// WeRForces front-end: scenario editor, tasking and monitoring GUI.

import { LocalFrame } from '../src/dis/geodesy.js';
import { TerrainGrid } from '../src/shared/terrainGrid.js';
import type {
  Catalog,
  Command,
  CommandResult,
  EntitySnapshot,
  EntityTypeDef,
  EnvironmentState,
  ForceId,
  Formation,
  Graphic,
  GraphicKind,
  Plan,
  PlanStatement,
  Precipitation,
  Roe,
  Role,
  SimEvent,
  SimState,
  TaskSpec,
  TerrainData,
  UnitSnapshot,
  UnitTemplate,
  Vec2,
} from '../src/shared/types.js';
import { FORCE_NAMES } from '../src/shared/types.js';
import { Api, BASE } from './api.js';
import { $, clear, fmtDeg, fmtGrid, fmtLatLon, fmtTime, h } from './dom.js';
import { MapView } from './map.js';
import { setSymbolStyle, type SymbolStyle, symbolCanvas } from './symbols.js';
import type { View3D } from './view3d.js';
import { AarPlayer } from './aar.js';
import { Timeline } from './timeline.js';
import type { CotStatus as CotView } from '../src/integrations/cot.js';
import type { Webhook as WebhookView } from '../src/integrations/webhooks.js';

const ROE_LABELS: Record<Roe, string> = { fireAtWill: 'Fire at will', returnFire: 'Return fire', holdFire: 'Hold fire' };
const FORMATIONS: Formation[] = ['column', 'line', 'wedge', 'vee', 'echelonRight'];
const DOMAIN_LABELS: Record<string, string> = { ground: 'Ground vehicles', lifeform: 'Dismounted', air: 'Aircraft', surface: 'Surface vessels' };
/** Which force's palette shows a type, from its DIS country: 222 Russia -> Red, 0 civilian -> Neutral, others -> Blue. */
function paletteForce(country: number): ForceId {
  return country === 222 ? 2 : country === 0 ? 3 : 1;
}
const LOG_LIMIT = 600;

/** A small bar for suppression (0..1). */
function suppressionBar(v: number): HTMLElement {
  return h(
    'span',
    { class: 'meter', title: `${Math.round(v * 100)}%` },
    h('span', { style: `width:${Math.round(v * 100)}%;background:${v >= 0.6 ? 'var(--bad)' : v >= 0.3 ? 'var(--warn)' : 'var(--accent)'}` }),
  );
}

/** A fuel-gauge style meter: green when full, red when nearly empty. */
function levelBar(v: number): HTMLElement {
  return h(
    'span',
    { class: 'meter', title: `${Math.round(v * 100)}%` },
    h('span', { style: `width:${Math.round(v * 100)}%;background:${v <= 0.2 ? 'var(--bad)' : v <= 0.4 ? 'var(--warn)' : 'var(--good, #3fb950)'}` }),
  );
}

function moraleText(m: number | undefined, state: string | undefined): string {
  if (m === undefined) return 'off';
  return `${Math.round(m * 100)}% · ${state ?? 'steady'}`;
}

type PlanStepKind =
  | 'moveTo'
  | 'followRoute'
  | 'patrol'
  | 'wait'
  | 'attack'
  | 'orbit'
  | 'setRoe'
  | 'setSpeed'
  | 'setAltitude'
  | 'setFormation'
  | 'waitTime'
  | 'waitArea'
  | 'waitEnemy'
  | 'waitFire'
  | 'waitDestroyed'
  | 'waitEnemyInArea'
  | 'waitStrength'
  | 'waitFuel'
  | 'waitAmmo'
  | 'resupply'
  | 'setReaction'
  | 'fireMission'
  | 'setCallForFire'
  | 'mount'
  | 'dismount';

class App {
  readonly api: Api;
  readonly map: MapView;
  catalog: Catalog | null = null;
  types = new Map<string, EntityTypeDef>();
  state: SimState | null = null;
  frame: LocalFrame | null = null;
  grid: TerrainGrid | null = null;
  terrainVersion = -1;
  terrainData: TerrainData | null = null;
  view3d: View3D | null = null;
  view: '2d' | '3d' | 'split' = '2d';
  selectedId: string | null = null;
  private timeline!: Timeline;
  private timelineDrawn = 0;
  /** Everything selected; more than one for group orders. */
  selection = new Set<string>();
  force: ForceId = 1;
  /** Exercise control, or a player limited to one force. */
  role: Role = { kind: 'controller' };
  armed: string | null = null;
  events: SimEvent[] = [];
  planDrafts = new Map<string, Plan>();
  private inspectorFor: string | null = null;
  private treeSignature = '';
  private lastTree = 0;
  private logFilter = new Set<string>();
  readonly aar: AarPlayer;
  /** Live state and log kept aside while replaying. */
  private liveState: SimState | null = null;
  private liveEvents: SimEvent[] = [];

  constructor() {
    this.api = new Api({
      hello: (catalog, version, role) => this.onHello(catalog, version, role),
      state: (s) => this.onState(s),
      events: (evs) => this.onEvents(evs),
      terrainChanged: (v) => this.loadTerrain(v),
      connection: (ok) => {
        const el = $('#conn-status');
        el.textContent = ok ? 'connected' : 'offline';
        el.className = `pill ${ok ? 'good' : 'bad'}`;
      },
    });
    this.map = new MapView($('#map'), {
      select: (id) => this.select(id),
      toggleSelect: (id) => this.toggleSelect(id),
      selectMany: (ids) => this.selectMany(ids),
      contextMenu: (w, c, hit) => this.contextMenu(w, c, hit),
      hover: (w) => this.hover(w),
      dragEntity: (id, w) => (this.aar.active ? undefined : this.cmd({ cmd: 'moveEntity', id, x: w.x, y: w.y })),
      modeChanged: (m) => {
        if (m.kind !== 'place') this.disarm();
      },
    });
    this.timeline = new Timeline($('#timeline-strip'), {
      review: async (t) => {
        if (!this.aar.active) await this.enterReplay();
        if (this.aar.active) this.aar.seek(t);
      },
      select: (id) => this.exists(id) && this.select(id),
    });
    this.aar = new AarPlayer(
      {
        api: this.api,
        surface: (x, y) => this.grid?.surfaceHeight(x, y) ?? 0,
        show: (state, fresh, log) => this.showReplay(state, fresh, log),
        exited: () => this.leaveReplay(),
        toast: (m, info) => this.toast(m, info),
        modal: (c) => this.modal(c),
        graphics: () => this.liveState?.graphics ?? this.state?.graphics ?? [],
        weaponName: (id) => this.catalog?.weapons.find((w) => w.id === id)?.name ?? id,
      },
      $('#log-wrap'),
    );
    this.bindToolbar();
    this.bindLeft();
    this.bindLog();
    this.bindViews();
    setInterval(() => this.refreshPath(), 1000);
    void this.api.ensureAuth().then(() => {
      if (this.api.user) {
        const u = $('#user-name');
        u.textContent = `${this.api.user.name} · sign out`;
        u.classList.remove('hidden');
      }
      this.api.connect();
    });
  }

  // ------------------------------------------------------------ server messages

  private onHello(catalog: Catalog, terrainVersion: number, role: Role): void {
    this.role = role;
    const player = role.kind === 'player';
    document.body.classList.toggle('player', player);
    const pill = $('#role-status');
    pill.classList.toggle('hidden', !player);
    if (player) {
      pill.textContent = `${FORCE_NAMES[role.force]} player · fog of war`;
      pill.className = `pill force-${role.force}`;
      this.force = role.force;
      // Players cannot create objects: start on the Objects tab.
      ($('[data-tab="objects"]') as HTMLElement).click();
    }
    this.catalog = catalog;
    this.types = new Map(catalog.entityTypes.map((t) => [t.id, t]));
    this.map.sidcOf = (id) => this.types.get(id)?.sidc;
    if (BASE) {
      const pill = $('#session-name');
      pill.textContent = `session ${decodeURIComponent(BASE.slice(3))}`;
      pill.classList.remove('hidden');
    }
    this.map.losCheck = async (a, b) => {
      try {
        const r = await this.api.v1<{ visible: boolean }>('POST', '/terrain/line-of-sight', { from: { x: a.x, y: a.y }, to: { x: b.x, y: b.y } });
        return r.visible;
      } catch {
        return null;
      }
    };
    this.renderPalette();
    if (terrainVersion !== this.terrainVersion) this.loadTerrain(terrainVersion);
  }

  private async loadTerrain(version: number): Promise<void> {
    this.terrainVersion = version;
    const data = await this.api.terrain();
    this.grid = TerrainGrid.fromData(data);
    this.frame = new LocalFrame(data.spec.origin.lat, data.spec.origin.lon);
    this.map.setTerrain(data);
    this.terrainData = data;
    if (this.view3d && this.grid && this.map.terrainImage) this.view3d.setTerrain(data, this.grid, this.map.terrainImage);
  }

  private onState(s: SimState): void {
    this.liveState = s;
    if (this.aar.active) return;
    this.state = s;
    const wall = performance.now();
    if (wall - this.timelineDrawn > 500) {
      this.timelineDrawn = wall;
      this.timeline.update(s, this.events);
    }
    this.map.setState(s);
    this.view3d?.setState(s);
    const clock = $('#sim-time');
    clock.textContent = fmtTime(s.time);
    // The server cannot keep up with the time scale: say so.
    const behind = s.running && (s.load ?? 0) > 0.9;
    clock.classList.toggle('behind', behind);
    clock.title = behind ? `The server is busy ${Math.round((s.load ?? 0) * 100)}% of the time: the simulation runs slower than ${s.timeScale}x` : 'Simulation time';
    this.renderEnvironment(s.environment);
    $('#scenario-name').textContent = s.scenarioName;
    const run = $('#btn-run');
    run.textContent = s.running ? '⏸ Pause' : '▶ Run';
    run.classList.toggle('primary', !s.running);
    const speed = $('#sel-speed') as HTMLSelectElement;
    if (document.activeElement !== speed) speed.value = String(s.timeScale);
    const dis = $('#dis-status');
    if (s.dis) {
      dis.textContent = `DIS ex ${s.dis.exerciseId} · ${s.dis.site}:${s.dis.application} · tx ${s.dis.pdusSent} rx ${s.dis.pdusReceived} · ${s.dis.remoteEntities} remote`;
      dis.className = 'pill good';
    } else {
      dis.textContent = 'DIS off';
      dis.className = 'pill';
    }
    const score = [1, 2, 3]
      .map((f) => {
        const list = s.entities.filter((e) => e.force === f);
        if (!list.length) return '';
        const alive = list.filter((e) => e.damage !== 'destroyed').length;
        return `${FORCE_NAMES[f as ForceId]} ${alive}/${list.length}`;
      })
      .filter(Boolean)
      .join(' · ');
    $('#score').textContent = score;
    for (const id of [...this.selection]) if (!this.exists(id)) this.selection.delete(id);
    if (this.selectedId && !this.exists(this.selectedId)) this.select(this.selection.size ? [...this.selection][0] : null);
    this.updateInspector();
    const now = performance.now();
    if (now - this.lastTree > 500) {
      this.lastTree = now;
      this.renderTree();
    }
  }

  private onEvents(evs: SimEvent[]): void {
    if (this.aar.active) {
      this.liveEvents.push(...evs);
      return;
    }
    // A scenario load starts a fresh log.
    let start = 0;
    for (let i = evs.length - 1; i >= 0; i--) {
      if (evs[i].kind === 'info' && evs[i].text.startsWith('scenario "')) {
        start = i;
        this.events = [];
        break;
      }
    }
    this.events.push(...evs.slice(start));
    if (this.events.length > LOG_LIMIT) this.events.splice(0, this.events.length - LOG_LIMIT);
    this.map.addEvents(evs);
    this.view3d?.addEvents(evs);
    this.renderLog(evs);
  }

  // ------------------------------------------------------------ helpers

  async cmd(c: Command): Promise<CommandResult> {
    const r = await this.api.send(c);
    if (!r.ok) this.toast(r.error ?? 'command failed');
    return r;
  }

  toast(msg: string, info = false): void {
    const t = $('#toast');
    t.textContent = msg;
    t.className = `toast${info ? ' info' : ''}`;
    clearTimeout((t as unknown as { timer?: number }).timer);
    (t as unknown as { timer?: number }).timer = window.setTimeout(() => t.classList.add('hidden'), 3500);
  }

  entity(id: string | null | undefined): EntitySnapshot | undefined {
    return id ? this.state?.entities.find((e) => e.id === id) : undefined;
  }

  unit(id: string | null | undefined): UnitSnapshot | undefined {
    return id ? this.state?.units.find((u) => u.id === id) : undefined;
  }

  graphic(id: string | null | undefined): Graphic | undefined {
    return id ? this.state?.graphics.find((g) => g.id === id) : undefined;
  }

  exists(id: string): boolean {
    return !!(this.entity(id) || this.unit(id) || this.graphic(id));
  }

  routes(): Graphic[] {
    return (this.state?.graphics ?? []).filter((g) => g.kind === 'route' || g.kind === 'phaseLine');
  }

  areas(): Graphic[] {
    return (this.state?.graphics ?? []).filter((g) => g.kind === 'area');
  }

  /** An entity type's 2525 SIDC pattern, if the catalog gives one. */
  sidc(typeId: string | undefined): string | undefined {
    return typeId ? this.types.get(typeId)?.sidc : undefined;
  }

  /** True if the entity, or any member of the unit, has an indirect-fire weapon. */
  hasIndirect(id: string): boolean {
    const u = this.unit(id);
    const ids = u ? u.memberIds : [id];
    return ids.some((m) => {
      const t = this.types.get(this.entity(m)?.typeId ?? '');
      return !!t?.weapons.some((w) => this.catalog?.weapons.find((x) => x.id === w)?.indirect);
    });
  }

  /** Entity types of the entity, or of every member of the unit. */
  private memberTypes(id: string): EntityTypeDef[] {
    const u = this.unit(id);
    return (u ? u.memberIds : [id]).map((m) => this.types.get(this.entity(m)?.typeId ?? '')).filter((t): t is EntityTypeDef => !!t);
  }

  /** True if the entity (or the unit's leader) is an engineer. */
  canBreach(id: string): boolean {
    const lead = this.unit(id)?.leaderId ?? id;
    return !!this.types.get(this.entity(lead)?.typeId ?? '')?.breachTime;
  }

  /** True if the entity or a member of the unit has a weapon that fires smoke rounds. */
  hasSmoke(id: string): boolean {
    return this.memberTypes(id).some((t) => t.weapons.some((w) => this.catalog?.weapons.find((x) => x.id === w)?.smoke));
  }

  /** Seats of an entity type (0 for non-carriers). */
  capacityOf(id: string | undefined): number {
    const e = id ? this.entity(id) : undefined;
    return (e && this.types.get(e.typeId)?.capacity) ?? 0;
  }

  /** True if the id is a carrier entity, or a unit with carriers. */
  isCarrier(id: string): boolean {
    const u = this.unit(id);
    return u ? u.memberIds.some((m) => this.capacityOf(m) > 0) : this.capacityOf(id) > 0;
  }

  /** Passengers aboard a carrier entity, or all carriers of a unit. */
  passengerCount(id: string): number {
    const u = this.unit(id);
    return (u ? u.memberIds : [id]).reduce((n, m) => n + (this.entity(m)?.passengers?.length ?? 0), 0);
  }

  /** Domain of the thing being tasked (unit uses its leader). */
  domainOf(id: string): string | undefined {
    const e = this.entity(id) ?? this.entity(this.unit(id)?.leaderId);
    return e?.domain;
  }

  // ------------------------------------------------------------ toolbar

  private bindToolbar(): void {
    const fileMenu = $('#btn-file').parentElement!;
    $('#btn-file').addEventListener('click', (e) => {
      e.stopPropagation();
      fileMenu.classList.toggle('open');
    });
    const layersMenu = $('#layers-menu');
    $('#btn-layers').addEventListener('click', (e) => {
      e.stopPropagation();
      layersMenu.classList.toggle('open');
    });
    layersMenu.querySelector('.menu-items')!.addEventListener('click', (e) => e.stopPropagation());
    document.addEventListener('click', () => {
      layersMenu.classList.remove('open');
      fileMenu.classList.remove('open');
      $('#context-menu').classList.add('hidden');
    });
    $('#menu-file').addEventListener('click', (e) => {
      const action = (e.target as HTMLElement).dataset.action;
      fileMenu.classList.remove('open');
      if (action === 'new') this.newScenarioDialog();
      if (action === 'open-sample') this.openScenarioDialog();
      if (action === 'import') ($('#file-input') as HTMLInputElement).click();
      if (action === 'export') this.exportScenario();
      if (action === 'save-server') this.saveOnServer();
      if (action === 'review-recording') void this.reviewRecordingDialog();
      if (action === 'settings') void this.settingsDialog();
      if (action === 'undo' || action === 'redo') void this.undoRedo(action);
      if (action === 'batch') void this.batchDialog();
      if (action === 'sessions') void this.sessionsDialog();
    });
    ($('#file-input') as HTMLInputElement).addEventListener('change', async (e) => {
      const input = e.target as HTMLInputElement;
      const file = input.files?.[0];
      input.value = '';
      if (!file) return;
      try {
        const scenario = JSON.parse(await file.text());
        const r = await this.cmd({ cmd: 'loadScenario', scenario });
        if (r.ok) this.toast(`Loaded ${file.name}`, true);
      } catch {
        this.toast('File is not valid JSON');
      }
    });
    $('#btn-run').addEventListener('click', () => this.cmd({ cmd: this.state?.running ? 'pause' : 'run' }));
    $('#env-chip').addEventListener('click', () => void this.settingsDialog());
    $('#btn-step').addEventListener('click', () => this.cmd({ cmd: 'step', seconds: 1 }));
    $('#btn-rewind').addEventListener('click', () => {
      if (confirm('Rewind to the scenario as it was last loaded or saved? Changes since then will be lost.')) this.cmd({ cmd: 'rewind' });
    });
    ($('#sel-speed') as HTMLSelectElement).addEventListener('change', (e) => this.cmd({ cmd: 'setTimeScale', scale: Number((e.target as HTMLSelectElement).value) }));
    document.querySelectorAll<HTMLButtonElement>('#draw-tools button[data-draw]').forEach((b) =>
      b.addEventListener('click', () => this.startDraw(b.dataset.draw as GraphicKind)),
    );
    $('#btn-measure').addEventListener('click', () => this.map.setMode({ kind: 'measure', points: [] }));
    document.querySelectorAll<HTMLInputElement>('[data-layer]').forEach((cb) =>
      cb.addEventListener('change', () => {
        (this.map.layers as unknown as Record<string, boolean>)[cb.dataset.layer!] = cb.checked;
        if (cb.dataset.layer === 'labels' && this.view3d) this.view3d.labels = cb.checked;
        this.map.invalidate();
      }),
    );
    const symSel = $('#sel-symbols') as HTMLSelectElement;
    try {
      symSel.value = localStorage.getItem('werforces.symbols') === 'simple' ? 'simple' : '2525';
    } catch {
      // storage unavailable
    }
    setSymbolStyle(symSel.value as SymbolStyle);
    symSel.addEventListener('change', () => {
      setSymbolStyle(symSel.value as SymbolStyle);
      try {
        localStorage.setItem('werforces.symbols', symSel.value);
      } catch {
        // storage unavailable
      }
      this.map.invalidate();
      this.renderPalette();
      this.renderTree(true);
      this.inspectorFor = null;
      this.updateInspector();
    });
    ($('#sel-aggregate') as HTMLSelectElement).addEventListener('change', (e) => {
      this.map.layers.aggregate = (e.target as HTMLSelectElement).value as 'auto';
      this.map.invalidate();
    });
    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement)?.closest('input, textarea, select')) return;
      if (e.code === 'Space') {
        e.preventDefault();
        this.cmd({ cmd: this.state?.running ? 'pause' : 'run' });
      }
      if (e.key === 'Delete' && this.selectedId) this.deleteSelected();
      if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z' || e.key === 'y')) {
        e.preventDefault();
        void this.undoRedo(e.key === 'y' || e.shiftKey ? 'redo' : 'undo');
      }
      if (e.key === 'f' && this.selectedId) this.centerOn(this.selectedId);
      if (e.key === 'm' && !e.ctrlKey && !e.metaKey) this.map.setMode({ kind: 'measure', points: [] });
    });
  }

  private startDraw(kind: GraphicKind): void {
    this.map.setMode({
      kind: 'draw',
      graphic: kind,
      points: [],
      onDone: async (points) => {
        const r = await this.cmd({ cmd: 'createGraphic', kind, points, force: this.force });
        if (r.ok && r.id) this.select(r.id);
      },
    });
  }

  // ------------------------------------------------------------ after-action review

  private async enterReplay(): Promise<void> {
    if (this.liveState?.running) await this.cmd({ cmd: 'pause' });
    this.liveEvents = this.events;
    this.inspectorFor = '\u0000';
    await this.aar.enter();
    $('#btn-aar').classList.toggle('active', this.aar.active);
    if (!this.aar.active) this.inspectorFor = null;
  }

  private showReplay(state: SimState, fresh: SimEvent[], log: SimEvent[]): void {
    this.state = state;
    this.map.setState(state);
    this.view3d?.setState(state);
    if (fresh.length) {
      this.map.addEvents(fresh);
      this.view3d?.addEvents(fresh);
    }
    $('#sim-time').textContent = fmtTime(state.time);
    $('#scenario-name').textContent = state.scenarioName;
    if (log.length || fresh.length) {
      this.events = log.length ? log.slice(-LOG_LIMIT) : this.events;
      this.renderLog();
    }
    for (const id of [...this.selection]) if (!this.exists(id)) this.selection.delete(id);
    if (this.selectedId && !this.exists(this.selectedId)) this.select(this.selection.size ? [...this.selection][0] : null);
    this.updateInspector();
    this.renderTree();
  }

  private renderEnvironment(env: EnvironmentState | undefined): void {
    const chip = $('#env-chip');
    chip.classList.toggle('hidden', !env);
    if (!env) return;
    const icon = env.period === 'day' ? '☀' : env.period === 'twilight' ? '◐' : '☾';
    const wx = (env.visibility < 5000 ? ' ≋' : '') + (env.precipitation === 'snow' ? ' ❄' : env.precipitation !== 'none' ? ' ☂' : '');
    chip.textContent = `${icon} ${env.localTime}${wx}`;
    chip.classList.toggle('night', env.period !== 'day');
    chip.title = `${env.localDate} ${env.localTime} local · ${env.period}${env.precipitation !== 'none' ? ` · ${PRECIPITATION_LABELS[env.precipitation]}` : ''} · sun ${env.sunAltitude}° · light ${Math.round(env.light * 100)}% · visibility ${env.visibility >= 1000 ? `${env.visibility / 1000} km` : `${env.visibility} m`}${env.windSpeed ? ` · wind ${env.windSpeed} m/s from ${env.windFrom}°` : ''}. Click to change.`;
  }

  /** Optional model parts and the environment for the current scenario. */
  private async settingsDialog(): Promise<void> {
    const rules = await this.api.v1<Record<string, boolean>>('GET', '/simulation/rules');
    const env = await this.api.v1<EnvironmentState>('GET', '/simulation/environment');
    const hh = Math.floor(env.time);
    const mm = Math.round((env.time - hh) * 60);
    const field = (label: string, input: HTMLElement) => [h('label', { text: label }), input];
    const date = h('input', { type: 'date', value: env.date }) as HTMLInputElement;
    const time = h('input', { type: 'time', value: `${String(hh).padStart(2, '0')}:${String(mm % 60).padStart(2, '0')}` }) as HTMLInputElement;
    const visibility = h('input', { type: 'number', min: '50', max: '100000', step: '50', value: String(env.visibility) }) as HTMLInputElement;
    const precipitation = h('select', {}, Object.entries(PRECIPITATION_LABELS).map(([v, t]) => h('option', { value: v, text: t || 'None', selected: v === env.precipitation }))) as HTMLSelectElement;
    const windSpeed = h('input', { type: 'number', min: '0', max: '40', step: '1', value: String(env.windSpeed) }) as HTMLInputElement;
    const windFrom = h('input', { type: 'number', min: '0', max: '360', step: '10', value: String(env.windFrom) }) as HTMLInputElement;
    const box = (key: string, label: string, hint: string) =>
      h('label', { class: 'setting' }, h('input', { type: 'checkbox', checked: rules[key] !== false, 'data-rule': key }), h('span', {}, h('strong', { text: label }), h('small', { text: hint })));
    let close = () => {};
    const body = h(
      'div',
      { class: 'settings' },
      h('h3', { text: 'Simulation settings' }),
      h('h4', { text: 'Models' }),
      box('suppression', 'Suppression', 'Incoming fire makes targets less accurate, slower to fire and spot; infantry get pinned down'),
      box('morale', 'Morale', 'Units become shaken and break under losses and fire, then rally'),
      box('orderDelay', 'Order delay', 'Orders take time to reach units: about 5 s for an entity, 15 s a section, 30 s a platoon, 60 s a company; orders to a superior pass down level by level'),
      box('fuel', 'Fuel', 'Vehicles and aircraft burn fuel; out of fuel, vehicles stop and aircraft come down. Supply trucks refuel and rearm.'),
      h('h4', { text: 'Time and weather (at the scenario start)' }),
      h(
        'div',
        { class: 'env-grid' },
        ...field('Date', date),
        ...field('Time of day', time),
        ...field('Visibility (m)', visibility),
        ...field('Precipitation', precipitation),
        ...field('Wind (m/s)', windSpeed),
        ...field('Wind from (°)', windFrom),
      ),
      h('small', { class: 'hint', text: `Now ${env.localTime} on ${env.localDate}. Night cuts eyes and binoculars to under 10% of their range; night-vision goggles keep 60%; thermal sights are unaffected by darkness. Fog cuts every optical sensor (thermals see about 3× further); rain and snow slow vehicles off roads; wind drifts smoke.` }),
      h(
        'div',
        { class: 'row' },
        h('button', {
          class: 'primary',
          text: 'Apply',
          onclick: async () => {
            const next: Record<string, boolean> = {};
            for (const el of body.querySelectorAll<HTMLInputElement>('[data-rule]')) next[el.dataset.rule!] = el.checked;
            const r = await this.cmd({ cmd: 'setRules', rules: next });
            const [th, tm] = time.value.split(':').map(Number);
            const e = await this.cmd({
              cmd: 'setEnvironment',
              environment: {
                date: date.value || env.date,
                time: Number.isFinite(th) ? th + (tm || 0) / 60 : env.time,
                visibility: Number(visibility.value),
                precipitation: precipitation.value as Precipitation,
                windSpeed: Number(windSpeed.value),
                windFrom: Number(windFrom.value) % 360,
              },
            });
            if (r.ok && e.ok) close();
          },
        }),
        h('button', { text: 'Cancel', onclick: () => close() }),
      ),
    );
    close = this.modal(body);
  }

  private async reviewRecordingDialog(): Promise<void> {
    const list = await this.api.v1<{ name: string; bytes: number; modified: string }[]>('GET', '/recordings').catch(() => []);
    let close = () => {};
    const cards = list.map((r) =>
      h(
        'div',
        {
          class: 'scenario-card',
          onclick: async () => {
            close();
            try {
              if (this.aar.active) this.aar.exit();
              await this.api.v1('POST', `/recordings/${encodeURIComponent(r.name)}/load`);
              await this.enterReplay();
            } catch (err) {
              this.toast(String((err as Error).message));
            }
          },
        },
        h('strong', { text: r.name }),
        h('p', { text: `${(r.bytes / 1e6).toFixed(1)} MB · saved ${new Date(r.modified).toLocaleString()}` }),
      ),
    );
    close = this.modal(
      h(
        'div',
        {},
        h('h3', { text: 'Review saved recording' }),
        cards.length ? cards : h('p', { class: 'hint', text: 'No saved recordings yet. Use Save… in the AAR bar.' }),
        h('div', { class: 'row' }, h('button', { text: 'Cancel', onclick: () => close() })),
      ),
    );
  }

  private leaveReplay(): void {
    // Leaving a loaded recording resumes live recording.
    void this.api.v1<{ live: boolean }>('GET', '/recording').then((s) => (s.live ? undefined : this.api.v1('POST', '/recording/clear'))).catch(() => undefined);
    $('#btn-aar').classList.remove('active');
    this.events = this.liveEvents;
    this.liveEvents = [];
    this.inspectorFor = '\u0000';
    this.renderLog();
    if (this.liveState) this.onState(this.liveState);
  }

  /** Read-only inspector while replaying. */
  private buildReplayInspector(el: HTMLElement, id: string): void {
    const e = this.entity(id);
    const u = this.unit(id);
    if (e) {
      el.append(
        h('h3', {}, symbolCanvas(e.force, e.domain, e.symbol, 24, undefined, this.sidc(e.typeId)), ` ${e.name}`),
        h('div', { class: 'sub', text: `${this.types.get(e.typeId)?.name ?? e.typeId} · ${FORCE_NAMES[e.force]} · ${e.id} · ${this.aar.active ? 'replay' : 'contact'}` }),
        h('div', { class: 'kv' }, 'Grid', this.bind('grid'), 'Altitude', this.bind('alt'), 'Heading', this.bind('heading'), 'Speed', this.bind('speed'), 'Damage', this.bind('damage')),
        h('div', { class: 'section' }, h('h4', { text: 'Status' }), h('div', { class: 'status-line', 'data-bind': 'activity' })),
      );
    } else if (u) {
      el.append(
        h('h3', { text: u.name }),
        h('div', { class: 'sub', text: `${u.echelon} · ${FORCE_NAMES[u.force]} · ${u.id} · replay` }),
        h('div', { class: 'kv' }, 'Grid', this.bind('grid'), 'Strength', this.bind('strength'), 'Leader', this.bind('leader')),
        h('div', { class: 'section' }, h('h4', { text: 'Status' }), h('div', { class: 'status-line', 'data-bind': 'activity' })),
        h('div', { class: 'section' }, h('h4', { text: 'Members' }), h('div', { 'data-bind': 'members' })),
      );
    }
    el.append(
      h('p', {
        class: 'hint',
        text: this.aar.active
          ? 'After-action review: positions and damage as recorded. Exit the AAR to give orders.'
          : `Enemy contact, last seen ${e?.contactAge ?? 0} s ago. Position is where your force last saw it.`,
      }),
    );
  }

  private modal(content: HTMLElement): () => void {
    const m = $('#modal');
    const body = $('#modal-body');
    body.className = 'modal-body';
    clear(body);
    body.append(content);
    m.classList.remove('hidden');
    const close = () => m.classList.add('hidden');
    m.onclick = (e) => {
      if (e.target === m) close();
    };
    return close;
  }

  private async openScenarioDialog(): Promise<void> {
    const list = await this.api.listScenarios();
    let close = () => {};
    const cards = list.map((s) =>
      h(
        'div',
        {
          class: 'scenario-card',
          onclick: async () => {
            close();
            try {
              const scenario = await this.api.fetchScenario(s.name);
              const r = await this.cmd({ cmd: 'loadScenario', scenario: scenario as never });
              if (r.ok) {
                this.select(null);
                this.toast(`Loaded "${s.title}"`, true);
              }
            } catch (err) {
              this.toast(String(err));
            }
          },
        },
        h('strong', { text: s.title }),
        h('p', { text: s.description || s.name }),
      ),
    );
    close = this.modal(
      h('div', {}, h('h3', { text: 'Open scenario' }), cards.length ? cards : h('p', { class: 'hint', text: 'No scenarios found in ./scenarios' }), h('div', { class: 'row' }, h('button', { text: 'Cancel', onclick: () => close() }))),
    );
  }

  private async newScenarioDialog(): Promise<void> {
    const datasets = await this.api.v1<{ name: string; title: string; size: number; cellSize: number }[]>('GET', '/terrains').catch(() => []);
    const source = h(
      'select',
      {},
      h('option', { value: '', text: 'Generated (settings below)' }),
      datasets.map((d) => h('option', { value: d.name, text: `${d.title} · ${(d.size / 1000).toFixed(1)} km, ${d.cellSize} m`, selected: this.grid?.spec.dataset === d.name })),
    ) as HTMLSelectElement;
    const name = h('input', { type: 'text', value: 'New scenario' }) as HTMLInputElement;
    const seed = h('input', { type: 'number', value: String(Math.floor(Math.random() * 100000)) }) as HTMLInputElement;
    const size = h('select', {}, ...[8000, 12000, 16000, 24000].map((s) => h('option', { value: String(s), text: `${s / 1000} km`, selected: s === 16000 }))) as HTMLSelectElement;
    const water = h('input', { type: 'number', value: '10', min: '0', max: '40' }) as HTMLInputElement;
    const forest = h('input', { type: 'number', value: '28', min: '0', max: '70' }) as HTMLInputElement;
    const keep = h('input', { type: 'checkbox', checked: true }) as HTMLInputElement;
    let close = () => {};
    close = this.modal(
      h(
        'div',
        {},
        h('h3', { text: 'New scenario' }),
        h('div', { class: 'kv' }, 'Name', name, 'Terrain', source, 'Keep terrain', h('label', {}, keep, ' use current terrain'), 'Terrain seed', seed, 'Extent', size, 'Water %', water, 'Forest %', forest),
        h('p', { class: 'hint', text: 'Real-world terrains are imported from elevation data and map features with werforces-terrain (see Help → Terrain import).' }),
        h(
          'div',
          { class: 'row' },
          h('button', {
            class: 'primary',
            text: 'Create',
            onclick: async () => {
              close();
              const terrain = source.value
                ? { dataset: source.value }
                : keep.checked && !this.grid?.spec.dataset
                ? this.grid?.spec
                : { seed: Number(seed.value), size: Number(size.value), waterFraction: Number(water.value) / 100, forestFraction: Number(forest.value) / 100 };
              await this.cmd({ cmd: 'newScenario', name: name.value || 'Untitled', terrain });
              this.select(null);
            },
          }),
          h('button', { text: 'Cancel', onclick: () => close() }),
        ),
      ),
    );
  }

  private async exportScenario(): Promise<void> {
    const s = await this.api.scenario();
    const blob = new Blob([JSON.stringify(s, null, 2)], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `${(this.state?.scenarioName ?? 'scenario').replace(/[^\w-]+/g, '-').toLowerCase()}.json` });
    document.body.append(a);
    a.click();
    a.remove();
  }

  // ------------------------------------------------------------ 2D / 3D views

  private bindViews(): void {
    document.querySelectorAll<HTMLButtonElement>('#view-seg button').forEach((b) => b.addEventListener('click', () => void this.setView(b.dataset.view as '2d')));
    $('#btn-integrations').addEventListener('click', () => this.integrationsDialog());
    $('#btn-aar').addEventListener('click', () => (this.aar.active ? this.aar.exit() : this.enterReplay()));
  }

  async setView(view: '2d' | '3d' | 'split'): Promise<void> {
    this.view = view;
    document.querySelectorAll<HTMLButtonElement>('#view-seg button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
    $('#map-wrap').className = `view-${view}`;
    if (view !== '2d' && !this.view3d) {
      // Load three.js and create the WebGL view on first use.
      const { View3D } = await import('./view3d.js');
      if (this.view3d) return this.setView(view);
      this.view3d = new View3D($('#view3d'), {
        select: (id) => this.select(id),
        contextMenu: (w, c, hit) => this.contextMenu(w, c, hit),
      });
      if (this.terrainData && this.grid && this.map.terrainImage) this.view3d.setTerrain(this.terrainData, this.grid, this.map.terrainImage);
      if (this.state) this.view3d.setState(this.state);
      this.view3d.setSelected(this.selectedId);
    }
    this.view3d?.setVisible(view !== '2d');
    if (this.view3d) this.view3d.labels = this.map.layers.labels;
    this.map.invalidate();
  }

  // ------------------------------------------------------------ integrations dialog

  private async integrationsDialog(): Promise<void> {
    let close = () => {};
    // The REST and MCP endpoints of this session (sessions other than main live under /s/{id}).
    const origin = location.origin + BASE;
    const keyArg = this.api.key ? ` --header "Authorization: Bearer ${this.api.key}"` : '';
    const snippet = (text: string) => h('pre', { class: 'snippet', text });
    const status = await this.api.v1<{ cot: CotView; webhooks: WebhookView[] }>('GET', '/integrations').catch((e: Error) => {
      this.toast(e.message);
      return null;
    });
    if (!status) return;

    // --- CoT
    const cotEnabled = h('input', { type: 'checkbox', checked: status.cot.enabled }) as HTMLInputElement;
    const cotUrl = h('input', { type: 'text', value: status.cot.url }) as HTMLInputElement;
    const cotInterval = h('input', { type: 'number', value: String(status.cot.interval), min: '0.2', step: '0.5', style: 'width:70px' }) as HTMLInputElement;
    const cotRemote = h('input', { type: 'checkbox', checked: status.cot.includeRemote }) as HTMLInputElement;
    const cotStatus = h('div', { class: 'hint' });
    const showCot = (c: CotView) =>
      (cotStatus.textContent = `${c.enabled ? (c.connected ? 'Streaming' : 'Connecting…') : 'Off'} · ${c.eventsSent} events sent${c.errors ? ` · ${c.errors} errors (${c.lastError ?? ''})` : ''}`);
    showCot(status.cot);

    // --- Webhooks
    const hookList = h('div', { class: 'int-list' });
    const renderHooks = (hooks: WebhookView[]) => {
      clear(hookList);
      if (!hooks.length) hookList.append(h('div', { class: 'hint', text: 'No webhooks yet.' }));
      for (const w of hooks) {
        hookList.append(
          h(
            'div',
            { class: 'item' },
            h('span', { text: `${w.name} · ${w.format} · ${w.kinds.join(', ')}`, title: w.url }),
            h('span', { class: 'hint', text: `${w.delivered} sent${w.failed ? ` · ${w.failed} failed${w.lastError ? ` (${w.lastError})` : ''}` : ''}` }),
            h('button', {
              text: 'Test',
              onclick: async () => {
                try {
                  await this.api.v1('POST', `/webhooks/${w.id}/test`);
                  renderHooks(await this.api.v1<WebhookView[]>('GET', '/webhooks'));
                } catch (e) {
                  this.toast((e as Error).message);
                }
              },
            }),
            h('button', {
              class: 'danger',
              text: 'Remove',
              onclick: async () => {
                await this.api.v1('DELETE', `/webhooks/${w.id}`);
                renderHooks(await this.api.v1<WebhookView[]>('GET', '/webhooks'));
              },
            }),
          ),
        );
      }
    };
    renderHooks(status.webhooks);
    const hookUrl = h('input', { type: 'text', placeholder: 'https://hooks.slack.com/services/… or your endpoint' }) as HTMLInputElement;
    const hookFormat = h('select', {}, ['json', 'slack', 'discord'].map((f) => h('option', { value: f, text: f }))) as HTMLSelectElement;
    hookUrl.addEventListener('input', () => {
      if (/hooks\.slack\.com/.test(hookUrl.value)) hookFormat.value = 'slack';
      else if (/discord(app)?\.com\/api\/webhooks/.test(hookUrl.value)) hookFormat.value = 'discord';
    });
    const kindNames = ['detonation', 'damaged', 'destroyed', 'detected', 'task', 'info', 'radio', 'fire', 'created', 'deleted'];
    const defaultKinds = new Set(['damaged', 'destroyed', 'task', 'info']);
    const kindBoxes = kindNames.map((k) => [k, h('input', { type: 'checkbox', checked: defaultKinds.has(k) }) as HTMLInputElement] as const);

    const gis = (label: string, path: string) => h('a', { href: this.api.link(`/api/v1/export/${path}`), target: '_blank', text: label });

    close = this.modal(
      h(
        'div',
        {},
        h('h3', { text: 'Integrations' }),
        h(
          'div',
          { class: 'int-section' },
          h('h4', { text: 'REST API' }),
          h('div', { class: 'hint', text: 'Resource-oriented API for entities, units, graphics, tasks, plans, terrain queries and exports.' }),
          h('div', { class: 'int-row' }, h('a', { href: this.api.link('/api/docs'), target: '_blank', text: 'API reference' }), h('a', { href: this.api.link('/api/v1/openapi.json'), target: '_blank', text: 'openapi.json' })),
          snippet(`curl -s ${origin}/api/v1/simulation${this.api.key ? ` -H "Authorization: Bearer ${this.api.key}"` : ''}`),
        ),
        h(
          'div',
          { class: 'int-section' },
          h('h4', { text: 'MCP (AI agents)' }),
          h('div', { class: 'hint', text: 'Let Claude or another MCP client inspect and command the simulation. Streamable HTTP endpoint:' }),
          snippet(`claude mcp add --transport http werforces ${origin}/mcp${keyArg}`),
          h('div', { class: 'hint', text: 'Or as a stdio server (e.g. Claude Desktop config):' }),
          snippet(
            JSON.stringify(
              { mcpServers: { werforces: { command: 'node', args: ['/path/to/WeRForces/dist/mcp/stdio.js', '--url', origin, ...(this.api.key ? ['--api-key', this.api.key] : [])] } } },
              null,
              2,
            ),
          ),
        ),
        h(
          'div',
          { class: 'int-section' },
          h('h4', { text: 'TAK / Cursor-on-Target' }),
          h('div', { class: 'hint', text: 'Stream entity positions to ATAK/WinTAK (UDP multicast, default 239.2.3.1:6969) or a TAK Server TCP input (tcp://host:8087).' }),
          h('div', { class: 'int-row' }, h('label', {}, cotEnabled, ' enabled'), cotUrl),
          h('div', { class: 'int-row' }, 'every', cotInterval, 's', h('label', {}, cotRemote, ' include DIS remote entities'), h('span', { class: 'spacer' }),
            h('button', {
              class: 'primary',
              text: 'Apply',
              onclick: async () => {
                try {
                  showCot(await this.api.v1<CotView>('PUT', '/integrations/cot', { enabled: cotEnabled.checked, url: cotUrl.value.trim(), interval: Number(cotInterval.value), includeRemote: cotRemote.checked }));
                  this.toast('CoT settings applied', true);
                } catch (e) {
                  this.toast((e as Error).message);
                }
              },
            }),
          ),
          cotStatus,
        ),
        h(
          'div',
          { class: 'int-section' },
          h('h4', { text: 'Webhooks' }),
          h('div', { class: 'hint', text: 'POST batched simulation events to Slack, Discord or any HTTP endpoint.' }),
          hookList,
          h('div', { class: 'int-row' }, hookUrl, hookFormat,
            h('button', {
              text: 'Add',
              onclick: async () => {
                try {
                  await this.api.v1('POST', '/webhooks', { url: hookUrl.value.trim(), format: hookFormat.value, kinds: kindBoxes.filter(([, b]) => b.checked).map(([k]) => k) });
                  hookUrl.value = '';
                  renderHooks(await this.api.v1<WebhookView[]>('GET', '/webhooks'));
                } catch (e) {
                  this.toast((e as Error).message);
                }
              },
            }),
          ),
          h('div', { class: 'kinds' }, kindBoxes.map(([k, b]) => h('label', {}, b, ` ${k}`))),
        ),
        h(
          'div',
          { class: 'int-section' },
          h('h4', { text: 'GIS export' }),
          h('div', { class: 'hint', text: 'Live feeds for QGIS, Google Earth, ArcGIS or web maps.' }),
          h('div', { class: 'int-row' }, gis('entities.geojson', 'entities.geojson'), gis('graphics.geojson', 'graphics.geojson'), gis('scene.kml', 'scene.kml'), gis('Google Earth live link (.kml)', 'live.kml')),
        ),
        h('div', { class: 'row' }, h('span', { class: 'spacer' }), h('button', { text: 'Close', onclick: () => close() })),
      ),
    );
    $('#modal-body').classList.add('wide');
  }

  private async saveOnServer(): Promise<void> {
    const name = prompt('Save scenario on the server as (letters, digits, - and _):', (this.state?.scenarioName ?? 'scenario').replace(/[^\w-]+/g, '-').toLowerCase());
    if (!name) return;
    const r = await this.api.saveScenarioOnServer(name);
    if (r.ok) this.toast(`Saved scenarios/${name}.json`, true);
    else this.toast(r.error ?? 'save failed');
  }

  // ------------------------------------------------------------ left panel

  private bindLeft(): void {
    document.querySelectorAll<HTMLButtonElement>('.tabs button').forEach((b) =>
      b.addEventListener('click', () => {
        document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
        document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${b.dataset.tab}`));
        if (b.dataset.tab === 'objects') this.renderTree(true);
      }),
    );
    document.querySelectorAll<HTMLButtonElement>('#force-seg button').forEach((b) =>
      b.addEventListener('click', () => {
        this.force = Number(b.dataset.force) as ForceId;
        document.querySelectorAll('#force-seg button').forEach((x) => x.classList.toggle('active', x === b));
        this.renderPalette();
      }),
    );
    $('#palette-filter').addEventListener('input', () => this.renderPalette());
    $('#objects-filter').addEventListener('input', () => this.renderTree(true));
  }

  private renderPalette(): void {
    const el = $('#palette');
    clear(el);
    if (!this.catalog) return;
    const filter = ($('#palette-filter') as HTMLInputElement).value.toLowerCase();
    // Typing a filter searches every force's catalog.
    const matches = (name: string, typeId: string) =>
      (!filter || name.toLowerCase().includes(filter)) && (filter.length > 0 || paletteForce(this.types.get(typeId)!.dis.country) === this.force);
    const templates = this.catalog.unitTemplates.filter((u) => matches(u.name, u.members[0]));
    if (templates.length) {
      el.append(
        h(
          'div',
          { class: 'palette-group' },
          h('h4', { text: 'Units' }),
          templates.map((u) => {
            const lead = this.types.get(u.members[0])!;
            const counts = new Map<string, number>();
            for (const m of u.members) counts.set(m, (counts.get(m) ?? 0) + 1);
            const desc = [...counts].map(([t, n]) => `${n}× ${this.types.get(t)?.name ?? t}`).join(', ');
            return this.paletteItem(`unit:${u.id}`, symbolCanvas(this.force, lead.domain, lead.symbol, 26, u.echelon, this.sidc(u.members[0])), u.name, desc);
          }),
        ),
      );
    }
    for (const domain of ['ground', 'lifeform', 'air', 'surface']) {
      const types = this.catalog.entityTypes.filter((t) => t.domain === domain && matches(t.name, t.id));
      if (!types.length) continue;
      el.append(
        h(
          'div',
          { class: 'palette-group' },
          h('h4', { text: DOMAIN_LABELS[domain] }),
          types.map((t) => this.paletteItem(`type:${t.id}`, symbolCanvas(this.force, t.domain, t.symbol, 26, undefined, t.sidc), t.name, t.description)),
        ),
      );
    }
  }

  private paletteItem(key: string, icon: HTMLElement, name: string, desc: string): HTMLElement {
    return h(
      'button',
      {
        class: `palette-item${this.armed === key ? ' armed' : ''}`,
        'data-key': key,
        title: desc,
        onclick: () => this.arm(key, name),
      },
      icon,
      h('div', {}, name, h('small', { text: desc })),
    );
  }

  private arm(key: string, label: string): void {
    if (this.aar.active) return this.toast('Replaying: exit the AAR to add objects', true);
    this.armed = key;
    document.querySelectorAll('.palette-item').forEach((b) => b.classList.toggle('armed', (b as HTMLElement).dataset.key === key));
    const force = this.force;
    this.map.setMode({
      kind: 'place',
      label,
      onPlace: async (p) => {
        const [kind, id] = key.split(':');
        const r =
          kind === 'unit'
            ? await this.cmd({ cmd: 'createUnit', templateId: id, force, x: p.x, y: p.y })
            : await this.cmd({ cmd: 'createEntity', typeId: id, force, x: p.x, y: p.y });
        if (r.ok && r.id) this.select(r.id);
      },
    });
    this.armed = key;
  }

  private disarm(): void {
    this.armed = null;
    document.querySelectorAll('.palette-item.armed').forEach((b) => b.classList.remove('armed'));
  }

  private renderTree(force = false): void {
    const st = this.state;
    if (!st) return;
    const filter = ($('#objects-filter') as HTMLInputElement).value.toLowerCase();
    const sig =
      filter +
      '|' +
      this.selectedId +
      '|' +
      st.units.map((u) => u.id + u.name + u.memberIds.join() + (u.parentId ?? '')).join() +
      '|' +
      st.entities.map((e) => e.id + e.name + e.damage).join() +
      '|' +
      st.graphics.map((g) => g.id + g.name).join();
    if (!force && sig === this.treeSignature) return;
    this.treeSignature = sig;
    const el = $('#objects');
    clear(el);
    const match = (s: string) => !filter || s.toLowerCase().includes(filter);
    const item = (id: string, name: string, icon: HTMLElement | null, dead = false) =>
      h('div', { class: `tree-item${id === this.selectedId ? ' selected' : ''}${dead ? ' dead' : ''}`, onclick: () => this.select(id), ondblclick: () => this.centerOn(id) }, icon, name);
    for (const f of [1, 2, 3, 0] as ForceId[]) {
      const units = st.units.filter((u) => u.force === f);
      const loose = st.entities.filter((e) => e.force === f && !e.unitId);
      if (!units.length && !loose.length) continue;
      el.append(h('div', { class: 'tree-head', text: `${FORCE_NAMES[f]} force` }));
      const byId = new Map(units.map((u) => [u.id, u]));
      const subsOf = (u: UnitSnapshot) => (u.childIds ?? []).map((id) => byId.get(id)).filter((x): x is UnitSnapshot => !!x);
      const membersOf = (u: UnitSnapshot) => u.memberIds.map((id) => this.entity(id)).filter((e): e is EntitySnapshot => !!e);
      const matches = (u: UnitSnapshot): boolean => match(u.name) || membersOf(u).some((m) => match(m.name)) || subsOf(u).some(matches);
      // Units nest under their superiors; members follow their subordinate units.
      const renderUnit = (u: UnitSnapshot, into: HTMLElement) => {
        if (!matches(u)) return;
        const members = membersOf(u);
        const lead = members[0];
        into.append(item(u.id, `${u.name}`, lead ? symbolCanvas(f, lead.domain, lead.symbol, 18, u.echelon, this.sidc(lead.typeId)) : null));
        const kids = h('div', { class: 'tree-children' });
        for (const sub of subsOf(u)) renderUnit(sub, kids);
        kids.append(...members.filter((m) => match(m.name) || match(u.name)).map((m) => item(m.id, m.name, symbolCanvas(f, m.domain, m.symbol, 16, undefined, this.sidc(m.typeId)), m.damage === 'destroyed')));
        into.append(kids);
      };
      for (const u of units) if (!u.parentId || !byId.has(u.parentId)) renderUnit(u, el);
      for (const e of loose) {
        if (!match(e.name)) continue;
        el.append(item(e.id, `${e.name}${e.remote ? ' (remote)' : ''}`, symbolCanvas(f, e.domain, e.symbol, 16, undefined, this.sidc(e.typeId)), e.damage === 'destroyed'));
      }
    }
    const graphics = st.graphics.filter((g) => match(g.name));
    if (graphics.length) {
      el.append(h('div', { class: 'tree-head', text: 'Tactical graphics' }));
      for (const g of graphics) el.append(item(g.id, `${g.name}  · ${g.kind}`, null));
    }
  }

  // ------------------------------------------------------------ selection

  select(id: string | null): void {
    this.selection = new Set(id ? [id] : []);
    this.selectionChanged(id);
  }

  /** Add to or remove from a multi-selection. */
  toggleSelect(id: string): void {
    if (this.selection.has(id)) this.selection.delete(id);
    else this.selection.add(id);
    this.selectionChanged(this.selection.has(id) ? id : ([...this.selection][0] ?? null));
  }

  selectMany(ids: string[]): void {
    for (const id of ids) this.selection.add(id);
    this.selectionChanged(this.selectedId && this.selection.has(this.selectedId) ? this.selectedId : (ids[0] ?? null));
  }

  private selectionChanged(id: string | null): void {
    this.map.selectedIds = this.selection;
    this.selectedId = id;
    this.map.selectedId = id;
    this.view3d?.setSelected(id);
    this.map.selectedPath = [];
    this.map.selectedRanges = this.rangesFor(id);
    this.map.invalidate();
    this.inspectorFor = null;
    this.updateInspector();
    this.renderTree(true);
    this.refreshPath();
  }

  private rangesFor(id: string | null): { radius: number; label: string; color: string }[] {
    const e = this.entity(id) ?? this.entity(this.unit(id)?.leaderId);
    const t = e ? this.types.get(e.typeId) : undefined;
    if (!t || !this.catalog) return [];
    const out: { radius: number; label: string; color: string }[] = [];
    for (const wid of t.weapons) {
      const w = this.catalog.weapons.find((x) => x.id === wid);
      if (w) out.push({ radius: w.maxRange, label: w.name, color: 'rgba(255,90,90,0.9)' });
    }
    for (const sid of t.sensors) {
      const s = this.catalog.sensors.find((x) => x.id === sid);
      if (s) out.push({ radius: s.maxRange, label: s.name, color: 'rgba(255,220,80,0.9)' });
    }
    return out;
  }

  private async refreshPath(): Promise<void> {
    const id = this.selectedId;
    const target = this.unit(id)?.leaderId ?? id;
    if (!target || !this.entity(target)) return;
    const path = await this.api.plannedPath(target);
    if (this.selectedId === id) {
      this.map.selectedPath = path;
      this.map.invalidate();
    }
  }

  centerOn(id: string): void {
    const e = this.entity(id);
    const u = this.unit(id);
    const g = this.graphic(id);
    const p = e ?? (u ? (this.entity(u.leaderId) ?? u) : g?.points[0]);
    if (p) this.map.centerOn(p);
    if (this.view !== '2d') this.view3d?.focus(id);
  }

  private async deleteSelected(): Promise<void> {
    const id = this.selectedId;
    if (!id) return;
    const r = await this.cmd({ cmd: 'deleteObject', id });
    if (r.ok) this.select(null);
  }

  private hover(w: Vec2 | null): void {
    const el = $('#cursor-readout');
    if (!w || !this.grid || !this.frame) {
      el.textContent = '';
      return;
    }
    const geo = this.frame.toGeodetic({ x: w.x, y: w.y, z: 0 });
    const elev = this.grid.elevation(w.x, w.y);
    const terrain = elev < 0 ? 'water' : this.grid.isForest(w.x, w.y) ? 'forest' : 'open';
    el.textContent = `${fmtGrid(w.x, w.y)}  ${fmtLatLon(geo.lat, geo.lon)}  elev ${Math.round(Math.max(0, elev))} m  ${terrain}`;
  }

  // ------------------------------------------------------------ context menu

  private contextMenu(world: Vec2, client: { x: number; y: number }, hit: string | null): void {
    if (this.aar.active) return this.toast('Replaying: exit the AAR to give orders', true);
    const menu = $('#context-menu');
    clear(menu);
    const items: (HTMLElement | null)[] = [];
    const add = (label: string, fn: () => void) =>
      items.push(
        h('button', {
          text: label,
          onclick: (e: Event) => {
            e.stopPropagation();
            menu.classList.add('hidden');
            fn();
          },
        }),
      );
    const sep = () => items.push(h('hr'));
    const sel = this.selectedId;
    const selTaskable = sel && ((this.entity(sel) && !this.entity(sel)!.remote && this.entity(sel)!.damage !== 'destroyed') || this.unit(sel));
    const selName = sel ? (this.entity(sel)?.name ?? this.unit(sel)?.name) : undefined;
    const hitEntity = this.entity(hit) ?? this.entity(this.unit(hit)?.leaderId);
    const hitGraphic = this.graphic(hit);

    const group = this.selection.size > 1 && !(hit && this.selection.has(hit)) ? this.orderable() : [];
    if (group.length > 1) {
      items.push(h('div', { class: 'title', text: `${group.length} selected` }));
      const selForces = new Set(group.map((id) => this.entity(id)?.force ?? this.unit(id)?.force));
      if (hitEntity && hit && !selForces.has(hitEntity.force) && hitEntity.damage !== 'destroyed') {
        add(`All attack ${hitEntity.name}`, () => this.groupOrder((id) => this.task(id, { type: 'attack', targetId: hitEntity.id })));
      } else if (this.unit(hit) && selForces.has(this.unit(hit)!.force) && group.every((id) => this.unit(id))) {
        add(`Put under ${this.unit(hit)!.name}`, () => this.groupOrder((id) => this.cmd({ cmd: 'setSuperior', unitId: id, superiorId: hit! })));
      } else {
        add('Move here (keep formation)', () => this.groupTaskAt(world, (t) => ({ type: 'moveTo', target: t }), false));
        add('Move here by a covered route', () => this.groupTaskAt(world, (t) => ({ type: 'moveTo', target: t, covered: true }), false));
        add('Defend here (in line)', () => this.groupTaskAt(world, (t, f) => ({ type: 'defend', position: t, facing: f }), true));
        add('Overwatch here (in line)', () => this.groupTaskAt(world, (t, f) => ({ type: 'overwatch', position: t, facing: f }), true));
        const guns = group.filter((id) => this.hasIndirect(id));
        if (guns.length) add(`Fire mission here (${guns.length} firing)`, () => void Promise.all(guns.map((id) => this.task(id, { type: 'fireMission', target: world, rounds: 3, radius: this.unit(id) ? 50 : 0 }))));
      }
      add('Stop all', () => this.groupOrder((id) => this.cmd({ cmd: 'stop', targetId: id })));
      sep();
    } else if (selTaskable && hit !== sel) {
      items.push(h('div', { class: 'title', text: selName ?? '' }));
      if (hitEntity && hit) {
        const selForce = this.entity(sel)?.force ?? this.unit(sel)?.force;
        if (hitEntity.force !== selForce && hitEntity.damage !== 'destroyed') add(`Attack ${hitEntity.name}`, () => this.task(sel, { type: 'attack', targetId: hitEntity.id }));
        if (hitEntity.force !== selForce && this.hasIndirect(sel)) add(`Fire mission on ${hitEntity.name}`, () => this.task(sel, { type: 'fireMission', target: { x: Math.round(hitEntity.x), y: Math.round(hitEntity.y) }, rounds: 3, radius: this.unit(sel) ? 50 : 0 }));
        add(`Follow ${hitEntity.name}`, () => this.task(sel, { type: 'follow', targetId: hitEntity.id }));
        if (hitEntity.force === selForce && hitEntity.supplies !== undefined && hitEntity.id !== sel) add(`Resupply from ${hitEntity.name}`, () => this.task(sel, { type: 'resupply', supplierId: hitEntity.id }));
        const carrierId = this.unit(hit) ? hit : hitEntity.id;
        if (hitEntity.force === selForce && this.domainOf(sel) === 'lifeform' && this.isCarrier(carrierId)) {
          const cname = this.unit(hit)?.name ?? hitEntity.name;
          add(`Mount ${cname}`, () => this.task(sel, { type: 'mount', carrierId }));
          add(`Put inside ${cname} now`, () => this.cmd({ cmd: 'embark', passengerId: sel, carrierId }));
        }
      } else if (hitGraphic && (hitGraphic.kind === 'route' || hitGraphic.kind === 'phaseLine')) {
        add(`Follow route ${hitGraphic.name}`, () => this.task(sel, { type: 'followRoute', routeId: hitGraphic.id }));
        add(`Patrol route ${hitGraphic.name}`, () => this.task(sel, { type: 'patrol', routeId: hitGraphic.id }));
      } else if (hitGraphic && (hitGraphic.kind === 'minefield' || hitGraphic.kind === 'obstacle') && this.canBreach(sel)) {
        add(`Breach a lane through ${hitGraphic.name}`, () => this.task(sel, { type: 'breach', graphicId: hitGraphic.id }));
        add('Move here', () => this.task(sel, { type: 'moveTo', target: world }));
      } else {
        if (hitGraphic?.kind === 'area') {
          add(`Search ${hitGraphic.name}`, () => this.task(sel, { type: 'search', areaId: hitGraphic.id }));
          const here = this.entity(sel) ?? this.entity(this.unit(sel)?.leaderId);
          if (here && this.domainOf(sel) !== 'air') add(`Ambush ${hitGraphic.name} from here`, () => this.task(sel, { type: 'ambush', position: { x: Math.round(here.x), y: Math.round(here.y) }, killZoneId: hitGraphic.id }));
        }
        add('Move here', () => this.task(sel, { type: 'moveTo', target: world }));
        if (this.domainOf(sel) !== 'air') {
          add('Move here by a covered route', () => this.task(sel, { type: 'moveTo', target: world, covered: true }));
          add('Overwatch here', () => this.task(sel, { type: 'overwatch', position: world }));
          add('Defend here', () => this.task(sel, { type: 'defend', position: world }));
          add('Screen here', () => this.task(sel, { type: 'screen', position: world }));
        }
        if (this.passengerCount(sel) > 0) {
          add('Move here and dismount', () => {
            this.planDrafts.set(sel, { name: 'Move and dismount', statements: [{ kind: 'task', task: { type: 'moveTo', target: world } }, { kind: 'task', task: { type: 'dismount' } }] });
            this.cmd({ cmd: 'assignPlan', targetId: sel, plan: this.planDrafts.get(sel)! });
          });
        }
        if (this.hasIndirect(sel)) add('Fire mission here (3 rounds)', () => this.task(sel, { type: 'fireMission', target: world, rounds: 3, radius: this.unit(sel) ? 50 : 0 }));
        if (this.hasSmoke(sel)) add('Smoke screen here (2 rounds)', () => this.task(sel, { type: 'fireMission', target: world, rounds: 2, radius: this.unit(sel) ? 60 : 0, smoke: true }));
        if (this.domainOf(sel) === 'air') add('Orbit here (2 km)', () => this.task(sel, { type: 'orbit', center: world, radius: 2000 }));
        add('Add "move here" to plan', () => this.addPlanStep(sel, { kind: 'task', task: { type: 'moveTo', target: world } }));
      }
      add('Stop', () => this.cmd({ cmd: 'stop', targetId: sel }));
      sep();
    }
    if (hit) {
      const name = hitEntity?.name ?? this.unit(hit)?.name ?? hitGraphic?.name ?? hit;
      items.push(h('div', { class: 'title', text: name }));
      if (hit !== sel) add('Select', () => this.select(hit));
      add('Center map', () => this.centerOn(hit));
      add('Delete', () => this.cmd({ cmd: 'deleteObject', id: hit }).then((r) => r.ok && sel === hit && this.select(null)));
      sep();
    }
    add('Center map here', () => this.map.centerOn(world));
    add('Place point here', () => this.cmd({ cmd: 'createGraphic', kind: 'point', points: [world], force: this.force }));
    if (this.armed) add('Place armed item here', () => (this.map.mode.kind === 'place' ? this.map.mode.onPlace(world) : undefined));
    for (const it of items) if (it) menu.append(it);
    menu.classList.remove('hidden');
    const r = menu.getBoundingClientRect();
    menu.style.left = `${Math.min(client.x, window.innerWidth - r.width - 8)}px`;
    menu.style.top = `${Math.min(client.y, window.innerHeight - r.height - 8)}px`;
  }

  async task(targetId: string, task: TaskSpec): Promise<void> {
    await this.cmd({ cmd: 'assignTask', targetId, task });
    this.refreshPath();
  }

  // ------------------------------------------------------------ inspector

  private updateInspector(): void {
    const el = $('#inspector');
    if (this.selection.size > 1) {
      const key = `multi:${[...this.selection].sort().join(',')}`;
      if (key !== this.inspectorFor) {
        this.inspectorFor = key;
        clear(el);
        this.buildMultiInspector(el);
      }
      return;
    }
    const id = this.selectedId;
    // An object can be selected before the state that contains it arrives; build its panel then.
    if (id && id !== this.inspectorFor && !this.exists(id)) return;
    if (id !== this.inspectorFor) {
      this.inspectorFor = id;
      clear(el);
      if (!id) {
        el.append(
          h('p', { class: 'hint', text: 'Select an entity, unit or graphic on the map.' }),
          h(
            'div',
            { class: 'section' },
            h('h4', { text: 'Quick help' }),
            h(
              'ul',
              { class: 'hint' },
              h('li', { text: 'Pick an item in Create, then click the map to place it.' }),
              h('li', { text: 'Left-click selects. Right-click opens tasking (move, attack, follow, routes).' }),
              h('li', { text: 'Alt+drag repositions an entity. Wheel zooms, drag pans.' }),
              h('li', { text: 'Space runs/pauses. F centres the selection. Delete removes it.' }),
            ),
          ),
        );
        return;
      }
      const e = this.entity(id);
      const u = this.unit(id);
      const g = this.graphic(id);
      if ((this.aar.active || e?.contactAge !== undefined) && (e || u)) this.buildReplayInspector(el, id);
      else if (e) this.buildEntityInspector(el, e);
      else if (u) this.buildUnitInspector(el, u);
      else if (g) this.buildGraphicInspector(el, g);
    }
    this.updateLiveFields(el);
  }

  private bind(key: string): HTMLElement {
    return h('span', { 'data-bind': key });
  }

  private nameEditor(id: string, name: string, icon: HTMLElement | null): HTMLElement {
    const input = h('input', { type: 'text', value: name }) as HTMLInputElement;
    input.addEventListener('change', () => input.value.trim() && this.cmd({ cmd: 'rename', id, name: input.value.trim() }));
    return h('h3', {}, icon, input);
  }

  private buildEntityInspector(el: HTMLElement, e: EntitySnapshot): void {
    const t = this.types.get(e.typeId);
    el.append(
      this.nameEditor(e.id, e.name, symbolCanvas(e.force, e.domain, e.symbol, 24, undefined, this.sidc(e.typeId))),
      h('div', { class: 'sub', text: `${t?.name ?? e.typeId} · ${FORCE_NAMES[e.force]} · ${e.id}${e.remote ? ' · remote (DIS)' : ''}` }),
      h(
        'div',
        { class: 'kv' },
        'Grid',
        this.bind('grid'),
        'Lat/Lon',
        this.bind('latlon'),
        'Altitude',
        this.bind('alt'),
        'Heading',
        this.bind('heading'),
        'Speed',
        this.bind('speed'),
        'Damage',
        this.bind('damage'),
        'Suppression',
        this.bind('suppression'),
        e.unitId ? null : 'Morale',
        e.unitId ? null : this.bind('morale'),
        e.fuel === undefined ? null : 'Fuel',
        e.fuel === undefined ? null : this.bind('fuel'),
        e.supplies === undefined ? null : 'Supplies',
        e.supplies === undefined ? null : this.bind('supplies'),
        e.unitId ? 'Unit' : null,
        e.unitId ? h('a', { href: '#', text: this.unit(e.unitId)?.name ?? e.unitId, onclick: (ev: Event) => (ev.preventDefault(), this.select(e.unitId!)) }) : null,
      ),
    );
    if (e.remote) {
      el.append(h('p', { class: 'hint', text: 'This entity is simulated by another DIS application and cannot be tasked here.' }));
      return;
    }
    el.append(
      h('div', { class: 'section' }, h('h4', { text: 'Current activity' }), h('div', { class: 'status-line', 'data-bind': 'activity' })),
      this.roeSection(e.id),
      this.reactionsSection(e.id, false),
      this.taskSection(e.id, e.domain),
      this.planSection(e.id, false),
      h('div', { class: 'section' }, h('h4', { text: 'Weapons' }), h('div', { 'data-bind': 'weapons' })),
      h('div', { class: 'section' }, h('h4', { text: 'Sensors' }), h('div', { class: 'hint', text: (t?.sensors ?? []).map((s) => this.catalog?.sensors.find((x) => x.id === s)?.name ?? s).join(', ') || 'none' })),
      h('div', { class: 'section' }, h('h4', { text: 'Contacts' }), h('div', { 'data-bind': 'contacts' })),
      h('div', { class: 'section row' }, h('button', { text: 'Center', onclick: () => this.centerOn(e.id) }), h('button', { class: 'danger', text: 'Delete', onclick: () => this.deleteSelected() })),
    );
  }

  private pendingOrderText(id: string): string {
    const o = this.state?.orders?.find((x) => x.targetId === id);
    return o ? `ORDER IN ${Math.max(0, Math.ceil(o.due - (this.state?.time ?? 0)))} s: ${o.text}` : '';
  }

  /** Chooser for a unit's superior: same-force units that are not under it. */
  private superiorSelect(u: UnitSnapshot): HTMLElement {
    const units = this.state?.units ?? [];
    const under = new Set<string>([u.id]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const x of units) if (x.parentId && under.has(x.parentId) && !under.has(x.id)) (under.add(x.id), (grew = true));
    }
    const options = units.filter((x) => x.force === u.force && !under.has(x.id));
    return h(
      'select',
      { onchange: (ev: Event) => this.cmd({ cmd: 'setSuperior', unitId: u.id, superiorId: (ev.target as HTMLSelectElement).value || null }) },
      h('option', { value: '', text: '(none)' }),
      options.map((x) => h('option', { value: x.id, text: x.name, selected: x.id === u.parentId })),
    );
  }

  private buildUnitInspector(el: HTMLElement, u: UnitSnapshot): void {
    const lead = this.entity(u.leaderId) ?? this.entity(u.memberIds[0]);
    const formation = h('select', { onchange: (ev: Event) => this.cmd({ cmd: 'setFormation', unitId: u.id, formation: (ev.target as HTMLSelectElement).value as Formation }) }, FORMATIONS.map((f) => h('option', { value: f, text: f, selected: f === u.formation })));
    el.append(
      this.nameEditor(u.id, u.name, lead ? symbolCanvas(u.force, lead.domain, lead.symbol, 24, u.echelon, this.sidc(lead.typeId)) : null),
      h('div', { class: 'sub', text: `${u.echelon} · ${FORCE_NAMES[u.force]} · ${u.id}` }),
      h('div', { class: 'kv' }, 'Grid', this.bind('grid'), 'Strength', this.bind('strength'), 'Morale', this.bind('morale'), 'Leader', this.bind('leader'), 'Formation', formation, 'Superior', this.superiorSelect(u)),
      ...(u.childIds?.length
        ? [
            h(
              'div',
              { class: 'kv' },
              'Subordinates',
              h('span', {}, ...u.childIds.flatMap((id, i) => [i ? ', ' : '', h('a', { href: '#', text: this.unit(id)?.name ?? id, onclick: (ev: Event) => (ev.preventDefault(), this.select(id)) })])),
            ),
          ]
        : []),
      h('div', { class: 'section' }, h('h4', { text: 'Current activity' }), h('div', { class: 'status-line', 'data-bind': 'activity' })),
      this.roeSection(u.id),
      this.reactionsSection(u.id, true),
      this.taskSection(u.id, lead?.domain ?? 'ground'),
      this.planSection(u.id, true),
      h('div', { class: 'section' }, h('h4', { text: 'Members' }), h('div', { 'data-bind': 'members' })),
      h('div', { class: 'section row' }, h('button', { text: 'Center', onclick: () => this.centerOn(u.id) }), h('button', { class: 'danger', text: 'Delete unit', onclick: () => this.deleteSelected() })),
    );
  }

  /** Other exercises running on the same server, each in its own session. */
  private async sessionsDialog(): Promise<void> {
    type S = { id: string; path: string; scenario: string; time: number; running: boolean; entities: number; clients: number };
    const stored = await this.api.v1<{ name: string; title?: string }[]>('GET', '/scenarios').catch(() => []);
    const list = h('div', {});
    const render = async () => {
      // Sessions are listed by the server as a whole, whichever session this page is in.
      const r = await fetch('/api/v1/sessions', { headers: this.api.headers() });
      const sessions = r.ok ? ((await r.json()) as S[]) : [];
      clear(list);
      list.append(
        h(
          'table',
          { class: 'aar-table' },
          h('thead', {}, h('tr', {}, ['Session', 'Scenario', 'Time', 'Entities', 'Viewers', ''].map((c) => h('th', { text: c })))),
          h(
            'tbody',
            {},
            sessions.map((s) =>
              h(
                'tr',
                {},
                h('td', { text: s.id === 'main' ? 'main' : s.id }),
                h('td', { text: s.scenario }),
                h('td', { text: `${fmtTime(s.time)}${s.running ? ' ▶' : ''}` }),
                h('td', { text: String(s.entities) }),
                h('td', { text: String(s.clients) }),
                h(
                  'td',
                  {},
                  (s.path === '/' ? BASE === '' : BASE === s.path.slice(0, -1)) ? h('span', { class: 'hint', text: 'this page' }) : h('a', { href: this.api.link(s.path), text: 'Open' }),
                  s.id === 'main'
                    ? null
                    : h('button', {
                        class: 'danger',
                        text: 'Delete',
                        onclick: async () => {
                          if (!confirm(`Stop and delete session ${s.id}?`)) return;
                          await fetch(`/api/v1/sessions/${encodeURIComponent(s.id)}`, { method: 'DELETE', headers: this.api.headers() });
                          void render();
                        },
                      }),
                ),
              ),
            ),
          ),
        ),
      );
    };
    const id = h('input', { type: 'text', placeholder: 'e.g. red-cell', maxlength: '32' }) as HTMLInputElement;
    const scenario = h('select', {}, h('option', { value: '', text: 'Empty scenario' }), stored.map((s) => h('option', { value: s.name, text: s.title ?? s.name }))) as HTMLSelectElement;
    let close = () => {};
    close = this.modal(
      h(
        'div',
        { class: 'settings' },
        h('h3', { text: 'Sessions' }),
        h('p', { class: 'hint', text: 'Each session is a separate exercise with its own scenario, clock, recording, REST API (/s/{id}/api/v1) and MCP endpoint (/s/{id}/mcp). DIS and CoT run in the main session only.' }),
        list,
        h('h4', { text: 'New session' }),
        h('div', { class: 'env-grid' }, h('label', { text: 'Name' }), id, h('label', { text: 'Scenario' }), scenario),
        h(
          'div',
          { class: 'row' },
          h('button', {
            class: 'primary',
            text: 'Create and open',
            onclick: async () => {
              const r = await fetch('/api/v1/sessions', { method: 'POST', headers: this.api.headers(true), body: JSON.stringify({ id: id.value.trim().toLowerCase() || undefined, scenario: scenario.value || undefined }) });
              const j = (await r.json()) as S & { error?: { message: string } };
              if (!r.ok) return this.toast(j.error?.message ?? 'could not create the session');
              location.href = this.api.link(j.path);
            },
          }),
          h('button', { text: 'Close', onclick: () => close() }),
        ),
      ),
    );
    await render();
  }

  /** Monte Carlo runs of a scenario in the background, with the outcome statistics. */
  private async batchDialog(): Promise<void> {
    const stored = await this.api.v1<{ name: string; title?: string }[]>('GET', '/scenarios').catch(() => []);
    const scenario = h('select', {}, h('option', { value: '', text: 'The current state' }), stored.map((s) => h('option', { value: s.name, text: s.title ?? s.name }))) as HTMLSelectElement;
    const runs = h('input', { type: 'number', min: '1', max: '1000', value: '20' }) as HTMLInputElement;
    const minutes = h('input', { type: 'number', min: '1', max: '1440', value: '30' }) as HTMLInputElement;
    const seed = h('input', { type: 'number', value: '1000' }) as HTMLInputElement;
    const early = h('input', { type: 'checkbox', checked: true }) as HTMLInputElement;
    const out = h('div', { class: 'batch-out' });
    const startBtn = h('button', { class: 'primary', text: 'Run' }) as HTMLButtonElement;
    let jobId: string | null = null;
    let timer = 0;
    let close = () => {};
    const stop = () => window.clearInterval(timer);
    const cancelBtn = h('button', {
      text: 'Close',
      onclick: () => {
        stop();
        if (jobId && cancelBtn.textContent === 'Cancel run') void this.api.v1('DELETE', `/batch/${jobId}`).catch(() => undefined);
        close();
      },
    }) as HTMLButtonElement;
    type Job = { id: string; status: string; done: number; runs: number; error?: string; thread: string; summary?: BatchView };
    const poll = async () => {
      if (!jobId) return;
      const j = await this.api.v1<Job>('GET', `/batch/${jobId}`).catch(() => null);
      if (!j) return;
      clear(out);
      if (j.status === 'running') {
        out.append(h('p', { text: `Running ${j.done}/${j.runs}…` }), h('span', { class: 'meter wide' }, h('span', { style: `width:${Math.round((j.done / j.runs) * 100)}%;background:var(--accent)` })));
        return;
      }
      stop();
      cancelBtn.textContent = 'Close';
      startBtn.disabled = false;
      if (j.status !== 'done' || !j.summary) {
        out.append(h('p', { class: 'hint', text: `Batch ${j.status}${j.error ? `: ${j.error}` : ''}` }));
        return;
      }
      out.append(batchResults(j.summary), h('div', { class: 'row' }, h('button', { text: 'Download runs (CSV)', onclick: () => this.api.download(`/batch/${j.id}/runs.csv`, `batch-${j.id}.csv`).catch((e) => this.toast(String(e.message))) })));
    };
    startBtn.addEventListener('click', async () => {
      try {
        const j = await this.api.v1<Job>('POST', '/batch', {
          scenario: scenario.value || undefined,
          runs: Number(runs.value),
          duration: Number(minutes.value) * 60,
          seed: Number(seed.value),
          stopWhenDestroyed: early.checked,
        });
        jobId = j.id;
        startBtn.disabled = true;
        cancelBtn.textContent = 'Cancel run';
        stop();
        timer = window.setInterval(() => void poll(), 1000);
        void poll();
      } catch (err) {
        this.toast(String((err as Error).message));
      }
    });
    const field = (label: string, input: HTMLElement) => [h('label', { text: label }), input];
    close = this.modal(
      h(
        'div',
        { class: 'settings batch' },
        h('h3', { text: 'Batch analysis' }),
        h('p', { class: 'hint', text: 'Run the scenario many times with different random seeds, on the server in the background, and compare the outcomes.' }),
        h('div', { class: 'env-grid' }, ...field('Scenario', scenario), ...field('Runs', runs), ...field('Minutes per run', minutes), ...field('First seed', seed), ...field('Stop when a side is wiped out', early)),
        h('div', { class: 'row' }, startBtn, cancelBtn),
        out,
      ),
    );
    document.getElementById('modal-body')?.classList.add('wide');
  }

  private async undoRedo(which: 'undo' | 'redo'): Promise<void> {
    if (this.aar.active) return this.toast('Replaying: exit the AAR to edit', true);
    const r = await this.cmd({ cmd: which });
    if (r.ok) this.toast(which === 'undo' ? 'Undone' : 'Redone', true);
  }

  /** Several things selected: list them; right-click the map to order them all. */
  private buildMultiInspector(el: HTMLElement): void {
    const ids = [...this.selection];
    const loose = ids.filter((id) => this.entity(id) && !this.entity(id)!.unitId && !this.entity(id)!.remote);
    const forces = new Set(loose.map((id) => this.entity(id)!.force));
    el.append(
      h('h3', { text: `${ids.length} selected` }),
      h('p', { class: 'hint', text: 'Right-click the map to give them all an order: they keep their positions relative to each other. Shift+click adds or removes; Shift+drag selects a box.' }),
      h(
        'div',
        { class: 'section' },
        ids.map((id) => {
          const e = this.entity(id);
          const u = this.unit(id);
          const lead = e ?? this.entity(u?.leaderId);
          const name = e?.name ?? u?.name ?? this.graphic(id)?.name ?? id;
          return h(
            'div',
            { class: 'tree-item', onclick: () => this.select(id) },
            lead ? symbolCanvas(lead.force, lead.domain, lead.symbol, 16, u?.echelon, this.sidc(lead.typeId)) : null,
            name,
          );
        }),
      ),
      h(
        'div',
        { class: 'section row' },
        loose.length >= 2 && forces.size === 1 ? h('button', { text: 'Group into a unit', onclick: () => this.cmd({ cmd: 'groupUnit', entityIds: loose }).then((r) => r.ok && r.id && this.select(r.id)) }) : null,
        h('button', { text: 'Stop all', onclick: () => this.groupOrder((id) => this.cmd({ cmd: 'stop', targetId: id })) }),
        h('button', { text: 'Clear selection', onclick: () => this.select(null) }),
        h('button', {
          class: 'danger',
          text: 'Delete all',
          onclick: async () => {
            if (!confirm(`Delete ${ids.length} objects?`)) return;
            for (const id of ids) if (this.exists(id)) await this.cmd({ cmd: 'deleteObject', id });
            this.select(null);
          },
        }),
      ),
    );
  }

  /** The selected things that take orders: units, and entities not in a selected unit. */
  private orderable(): string[] {
    const ids = [...this.selection];
    return ids.filter((id) => {
      const e = this.entity(id);
      if (e) return !e.remote && e.damage !== 'destroyed' && !(e.unitId && this.selection.has(e.unitId));
      return !!this.unit(id);
    });
  }

  private async groupOrder(fn: (id: string) => Promise<unknown>): Promise<void> {
    for (const id of this.orderable()) await fn(id);
    this.refreshPath();
  }

  /** Where a selected thing is: entity position or unit centre. */
  private positionOf(id: string): Vec2 | undefined {
    const e = this.entity(id);
    if (e) return { x: e.x, y: e.y };
    const u = this.unit(id);
    return u ? { x: u.x, y: u.y } : undefined;
  }

  /**
   * Order the whole selection to a point: moves keep their offsets from the group's
   * centre; positional tasks spread them in a line across the direction of the move.
   */
  private groupTaskAt(world: Vec2, make: (target: Vec2, facing: number) => TaskSpec, line: boolean): void {
    const ids = this.orderable();
    const pos = ids.map((id) => this.positionOf(id)!).filter(Boolean);
    if (!pos.length) return;
    const c = { x: pos.reduce((s, p) => s + p.x, 0) / pos.length, y: pos.reduce((s, p) => s + p.y, 0) / pos.length };
    const facing = ((Math.atan2(world.x - c.x, world.y - c.y) * 180) / Math.PI + 360) % 360;
    const h = (facing * Math.PI) / 180;
    const size = this.terrainData?.spec.size ?? Infinity;
    const clamp = (p: Vec2) => ({ x: Math.round(Math.max(0, Math.min(size, p.x))), y: Math.round(Math.max(0, Math.min(size, p.y))) });
    let targets: Vec2[];
    if (line) {
      const side = (p: Vec2) => (p.x - c.x) * Math.cos(h) - (p.y - c.y) * Math.sin(h);
      const order = ids.map((id, i) => ({ id, i, s: side(pos[i]) })).sort((a, b) => a.s - b.s);
      const gap = ids.some((id) => this.unit(id)) ? 300 : 60;
      targets = new Array(ids.length);
      order.forEach((o, k) => {
        const off = (k - (order.length - 1) / 2) * gap;
        targets[o.i] = clamp({ x: world.x + Math.cos(h) * off, y: world.y - Math.sin(h) * off });
      });
    } else {
      targets = pos.map((p) => clamp({ x: world.x + p.x - c.x, y: world.y + p.y - c.y }));
    }
    void (async () => {
      for (let i = 0; i < ids.length; i++) await this.cmd({ cmd: 'assignTask', targetId: ids[i], task: make(targets[i], Math.round(facing)) });
      this.refreshPath();
    })();
  }

  private buildGraphicInspector(el: HTMLElement, g: Graphic): void {
    let len = 0;
    for (let i = 1; i < g.points.length; i++) len += Math.hypot(g.points[i].x - g.points[i - 1].x, g.points[i].y - g.points[i - 1].y);
    let area = 0;
    if (g.kind === 'area') {
      for (let i = 0; i < g.points.length; i++) {
        const a = g.points[i];
        const b = g.points[(i + 1) % g.points.length];
        area += a.x * b.y - b.x * a.y;
      }
      area = Math.abs(area) / 2;
    }
    el.append(
      this.nameEditor(g.id, g.name, null),
      h('div', { class: 'sub', text: `${g.kind} · ${FORCE_NAMES[g.force]} · ${g.id}` }),
      h(
        'div',
        { class: 'kv' },
        'Points',
        String(g.points.length),
        g.kind === 'area' ? 'Area' : g.kind === 'point' ? 'Location' : 'Length',
        g.kind === 'area' ? `${(area / 1e6).toFixed(2)} km²` : g.kind === 'point' ? fmtGrid(g.points[0].x, g.points[0].y) : `${(len / 1000).toFixed(2)} km`,
      ),
      ...(g.kind === 'minefield' ? [this.densityEditor(g)] : []),
      ...(g.kind === 'minefield' || g.kind === 'obstacle'
        ? [h('div', { class: 'kv' }, 'Lanes', String(g.lanes?.length ?? 0), 'Known to', [g.force, ...(g.knownBy ?? [])].map((f) => FORCE_NAMES[f]).join(', '))]
        : []),
      h('p', { class: 'hint', text: GRAPHIC_HINTS[g.kind] }),
      h('div', { class: 'section row' }, h('button', { text: 'Center', onclick: () => this.centerOn(g.id) }), h('button', { class: 'danger', text: 'Delete', onclick: () => this.deleteSelected() })),
    );
  }

  private densityEditor(g: Graphic): HTMLElement {
    const input = h('input', { type: 'number', min: '0.05', max: '5', step: '0.05', value: String(g.density ?? 0.5) }) as HTMLInputElement;
    input.addEventListener('change', () => this.cmd({ cmd: 'updateGraphic', id: g.id, density: Number(input.value) }));
    return h('div', { class: 'kv' }, 'Density', input);
  }

  private reactionsSection(id: string, isUnit: boolean): HTMLElement {
    const onContact = h('select', { 'data-bind-value': 'onContact' }, h('option', { value: 'continue', text: 'Continue the task' }), h('option', { value: 'halt', text: 'Halt and fight' })) as HTMLSelectElement;
    const withdraw = h(
      'select',
      { 'data-bind-value': 'withdraw' },
      h('option', { value: '0', text: 'Never' }),
      ...(isUnit ? [75, 50, 25].map((p) => h('option', { value: String(p / 100), text: `Below ${p}% strength` })) : [h('option', { value: '1', text: 'When weapons are knocked out' })]),
    ) as HTMLSelectElement;
    const cff = h('select', { 'data-bind-value': 'callForFire', title: 'Request fire missions from idle friendly artillery on hostiles in sight' }, h('option', { value: 'no', text: 'No' }), h('option', { value: 'yes', text: 'Yes' })) as HTMLSelectElement;
    const apply = () =>
      this.cmd({ cmd: 'setReactions', targetId: id, reactions: { onContact: onContact.value as 'halt', withdrawBelow: Number(withdraw.value), callForFire: cff.value === 'yes' } });
    onContact.addEventListener('change', apply);
    withdraw.addEventListener('change', apply);
    cff.addEventListener('change', apply);
    return h(
      'div',
      { class: 'section' },
      h('h4', { text: 'Reactions' }),
      h('div', { class: 'kv' }, 'On contact', onContact, 'Withdraw', withdraw, 'Call for fire', cff),
      h('div', { class: 'hint', text: 'Withdrawing units fall back to where this was set, with return-fire ROE. Observers that call for fire get missions from the nearest idle friendly artillery in range.' }),
    );
  }

  private roeSection(id: string): HTMLElement {
    const sel = h('select', { 'data-bind-value': 'roe', onchange: (ev: Event) => this.cmd({ cmd: 'setRoe', targetId: id, roe: (ev.target as HTMLSelectElement).value as Roe }) }, (Object.keys(ROE_LABELS) as Roe[]).map((r) => h('option', { value: r, text: ROE_LABELS[r] })));
    return h('div', { class: 'section' }, h('h4', { text: 'Rules of engagement' }), sel);
  }

  private routeSelect(): HTMLSelectElement {
    const routes = this.routes();
    return h('select', {}, routes.length ? routes.map((r) => h('option', { value: r.id, text: r.name })) : h('option', { value: '', text: '(draw a route first)' })) as HTMLSelectElement;
  }

  private taskSection(id: string, domain: string): HTMLElement {
    const route = this.routeSelect();
    const routeAction = (type: 'followRoute' | 'patrol') => () => {
      if (!route.value) return this.toast('Draw a route with the Route tool first');
      this.task(id, { type, routeId: route.value });
    };
    const waitSecs = h('input', { type: 'number', value: '60', min: '1', style: 'width:64px' }) as HTMLInputElement;
    const rounds = h('input', { type: 'number', value: '3', min: '1', max: '100', style: 'width:56px', title: 'rounds per tube' }) as HTMLInputElement;
    const fireRow = this.hasIndirect(id)
      ? h(
          'div',
          { class: 'row' },
          'Fire',
          rounds,
          'rounds',
          h('button', {
            text: 'Fire mission…',
            onclick: () =>
              this.map.setMode({
                kind: 'pickPoint',
                label: 'Click the target location',
                onPick: (p) => this.task(id, { type: 'fireMission', target: p, rounds: Math.max(1, Number(rounds.value) || 3), radius: this.unit(id) ? 50 : 0 }),
              }),
          }),
        )
      : null;
    return h(
      'div',
      { class: 'section' },
      h('h4', { text: 'Tasks' }),
      h(
        'div',
        { class: 'btn-grid' },
        h('button', { text: 'Move to…', onclick: () => this.map.setMode({ kind: 'pickPoint', label: 'Click the destination', onPick: (p) => this.task(id, { type: 'moveTo', target: p }) }) }),
        h('button', { text: 'Attack…', onclick: () => this.map.setMode({ kind: 'pickEntity', label: 'Click the target', onPick: (t) => this.task(id, { type: 'attack', targetId: this.unit(t)?.leaderId ?? t }) }) }),
        h('button', { text: 'Follow…', onclick: () => this.map.setMode({ kind: 'pickEntity', label: 'Click the entity to follow', onPick: (t) => this.task(id, { type: 'follow', targetId: this.unit(t)?.leaderId ?? t }) }) }),
        domain === 'air'
          ? h('button', { text: 'Orbit…', onclick: () => this.map.setMode({ kind: 'pickPoint', label: 'Click the orbit centre', onPick: (p) => this.task(id, { type: 'orbit', center: p, radius: 2000 }) }) })
          : null,
        h('button', { text: 'Stop', onclick: () => this.cmd({ cmd: 'stop', targetId: id }) }),
      ),
      h('div', { class: 'row' }, route, h('button', { text: 'Follow', onclick: routeAction('followRoute') }), h('button', { text: 'Patrol', onclick: routeAction('patrol') })),
      h('div', { class: 'row' }, 'Wait', waitSecs, 's', h('button', { text: 'Wait', onclick: () => this.task(id, { type: 'wait', duration: Number(waitSecs.value) || 0 }) })),
      fireRow,
      this.isCarrier(id)
        ? h(
            'div',
            { class: 'row' },
            h('span', { 'data-bind': 'passengers' }),
            h('button', { text: 'Dismount', title: 'Stop and let the passengers out', onclick: () => this.task(id, { type: 'dismount' }) }),
          )
        : domain === 'lifeform'
          ? h('div', { class: 'row' }, h('button', { text: 'Mount…', onclick: () => this.map.setMode({ kind: 'pickEntity', label: 'Click the carrier', onPick: (t) => this.task(id, { type: 'mount', carrierId: t }) }) }))
          : null,
    );
  }

  // ------------------------------------------------------------ plan editor

  private draft(id: string): Plan {
    let p = this.planDrafts.get(id);
    if (!p) {
      p = { name: 'Plan', statements: [], loop: false };
      this.planDrafts.set(id, p);
    }
    return p;
  }

  addPlanStep(id: string, st: PlanStatement): void {
    this.draft(id).statements.push(st);
    if (this.selectedId === id) this.renderPlanList(id);
  }

  private describe(st: PlanStatement): string {
    const name = (gid: string) => this.graphic(gid)?.name ?? this.entity(gid)?.name ?? gid;
    switch (st.kind) {
      case 'task': {
        const t = st.task;
        switch (t.type) {
          case 'moveTo':
            return `Move to ${fmtGrid(t.target.x, t.target.y)}`;
          case 'followRoute':
            return `Follow route ${name(t.routeId)}`;
          case 'patrol':
            return `Patrol ${name(t.routeId)}`;
          case 'wait':
            return `Wait ${t.duration} s`;
          case 'attack':
            return `Attack ${name(t.targetId)}`;
          case 'follow':
            return `Follow ${name(t.targetId)}`;
          case 'orbit':
            return `Orbit ${fmtGrid(t.center.x, t.center.y)} r ${t.radius} m`;
          case 'fireMission':
            return `Fire mission ${fmtGrid(t.target.x, t.target.y)}, ${t.rounds ?? 3} rounds`;
          case 'mount':
            return `Mount ${this.unit(t.carrierId)?.name ?? name(t.carrierId)}`;
          case 'dismount':
            return 'Dismount passengers';
          case 'breach':
            return `Breach ${name(t.graphicId)}`;
          case 'resupply':
            return t.supplierId ? `Resupply from ${name(t.supplierId)}` : 'Resupply';
          case 'overwatch':
          case 'defend':
          case 'screen':
            return `${t.type[0].toUpperCase()}${t.type.slice(1)} ${fmtGrid(t.position.x, t.position.y)}`;
          case 'ambush':
            return `Ambush ${name(t.killZoneId)}`;
          case 'search':
            return `Search ${name(t.areaId)}`;
          default:
            return t.type;
        }
      }
      case 'setRoe':
        return `Set ROE: ${ROE_LABELS[st.roe]}`;
      case 'setSpeed':
        return `Set speed ${Math.round(st.speed * 3.6)} km/h`;
      case 'setAltitude':
        return `Set altitude ${st.altitude} m AGL`;
      case 'setFormation':
        return `Set formation ${st.formation}`;
      case 'waitUntil': {
        const c = st.condition;
        if (c.type === 'simTime') return `Wait until time ${fmtTime(c.time)}`;
        if (c.type === 'inArea') return `Wait until in ${name(c.areaId)}`;
        if (c.type === 'enemyDetected') return 'Wait until enemy detected';
        if (c.type === 'underFire') return 'Wait until under fire';
        if (c.type === 'enemyInArea') return `Wait until enemy in ${name(c.areaId)}`;
        if (c.type === 'strengthBelow') return `Wait until strength below ${Math.round(c.fraction * 100)}%`;
        if (c.type === 'fuelBelow') return `Wait until fuel below ${Math.round(c.fraction * 100)}%`;
        if (c.type === 'ammoBelow') return `Wait until ammunition below ${Math.round(c.fraction * 100)}%`;
        return `Wait until ${name(c.entityId)} destroyed`;
      }
      case 'setReactions':
        if (st.reactions.callForFire !== undefined && st.reactions.onContact === undefined) return `Set reaction: ${st.reactions.callForFire ? 'call for fire' : 'no call for fire'}`;
        return `Set reaction: ${st.reactions.onContact === 'halt' ? 'halt on contact' : 'continue on contact'}`;
    }
  }

  private planSection(id: string, isUnit: boolean): HTMLElement {
    const kinds: [PlanStepKind, string][] = [
      ['moveTo', 'Move to (pick)'],
      ['followRoute', 'Follow route'],
      ['patrol', 'Patrol route'],
      ['wait', 'Wait (seconds)'],
      ['attack', 'Attack (pick)'],
      ['orbit', 'Orbit (pick)'],
      ['setRoe', 'Set ROE'],
      ['setSpeed', 'Set speed (km/h)'],
      ['setAltitude', 'Set altitude (m AGL)'],
      ...(isUnit ? ([['setFormation', 'Set formation']] as [PlanStepKind, string][]) : []),
      ['waitTime', 'Wait until time (s)'],
      ['waitArea', 'Wait until in area'],
      ['waitEnemy', 'Wait until enemy detected'],
      ['waitFire', 'Wait until under fire'],
      ['waitDestroyed', 'Wait until destroyed (pick)'],
      ['waitEnemyInArea', 'Wait until enemy in area'],
      ['waitStrength', 'Wait until strength below (%)'],
      ['waitFuel', 'Wait until fuel below (%)'],
      ['waitAmmo', 'Wait until ammunition below (%)'],
      ['resupply', 'Resupply at the nearest supply vehicle'],
      ['setReaction', 'Set reaction on contact'],
      ['setCallForFire', 'Set call for fire'],
      ...(this.domainOf(id) === 'lifeform' ? ([['mount', 'Mount carrier (pick)']] as [PlanStepKind, string][]) : []),
      ...(this.isCarrier(id) ? ([['dismount', 'Dismount passengers']] as [PlanStepKind, string][]) : []),
      ...(this.hasIndirect(id) ? ([['fireMission', 'Fire mission (pick), rounds']] as [PlanStepKind, string][]) : []),
    ];
    const kindSel = h('select', {}, kinds.map(([k, l]) => h('option', { value: k, text: l }))) as HTMLSelectElement;
    const param = h('span', {});
    let getParam: () => unknown = () => undefined;
    const renderParam = () => {
      clear(param);
      const k = kindSel.value as PlanStepKind;
      getParam = () => undefined;
      if (k === 'followRoute' || k === 'patrol') {
        const s = this.routeSelect();
        param.append(s);
        getParam = () => s.value;
      } else if (k === 'waitArea' || k === 'waitEnemyInArea') {
        const areas = this.areas();
        const s = h('select', {}, areas.length ? areas.map((a) => h('option', { value: a.id, text: a.name })) : h('option', { value: '', text: '(no areas)' })) as HTMLSelectElement;
        param.append(s);
        getParam = () => s.value;
      } else if (k === 'setRoe') {
        const s = h('select', {}, (Object.keys(ROE_LABELS) as Roe[]).map((r) => h('option', { value: r, text: ROE_LABELS[r] }))) as HTMLSelectElement;
        param.append(s);
        getParam = () => s.value;
      } else if (k === 'setFormation') {
        const s = h('select', {}, FORMATIONS.map((f) => h('option', { value: f, text: f }))) as HTMLSelectElement;
        param.append(s);
        getParam = () => s.value;
      } else if (k === 'setReaction') {
        const s = h('select', {}, h('option', { value: 'halt', text: 'Halt and fight' }), h('option', { value: 'continue', text: 'Continue' })) as HTMLSelectElement;
        param.append(s);
        getParam = () => s.value;
      } else if (k === 'setCallForFire') {
        const s = h('select', {}, h('option', { value: 'yes', text: 'Call for fire' }), h('option', { value: 'no', text: 'Stop calling for fire' })) as HTMLSelectElement;
        param.append(s);
        getParam = () => s.value;
      } else if (['wait', 'setSpeed', 'setAltitude', 'waitTime', 'orbit', 'waitStrength', 'waitFuel', 'waitAmmo', 'fireMission'].includes(k)) {
        const defaults: Record<string, string> = { wait: '60', setSpeed: '30', setAltitude: '150', waitTime: String(Math.round((this.state?.time ?? 0) + 120)), orbit: '2000', waitStrength: '50', waitFuel: '25', waitAmmo: '30', fireMission: '3' };
        const n = h('input', { type: 'number', value: defaults[k], style: 'width:80px', title: k === 'orbit' ? 'radius (m)' : '' }) as HTMLInputElement;
        param.append(n);
        getParam = () => Number(n.value);
      }
    };
    kindSel.addEventListener('change', renderParam);
    renderParam();
    const addBtn = h('button', {
      text: 'Add',
      onclick: () => {
        const k = kindSel.value as PlanStepKind;
        const v = getParam();
        const push = (st: PlanStatement) => this.addPlanStep(id, st);
        switch (k) {
          case 'moveTo':
            this.map.setMode({ kind: 'pickPoint', label: 'Click the plan waypoint', onPick: (p) => push({ kind: 'task', task: { type: 'moveTo', target: p } }) });
            return;
          case 'attack':
            this.map.setMode({ kind: 'pickEntity', label: 'Click the target', onPick: (t) => push({ kind: 'task', task: { type: 'attack', targetId: this.unit(t)?.leaderId ?? t } }) });
            return;
          case 'orbit':
            this.map.setMode({ kind: 'pickPoint', label: 'Click the orbit centre', onPick: (p) => push({ kind: 'task', task: { type: 'orbit', center: p, radius: Number(v) || 2000 } }) });
            return;
          case 'followRoute':
          case 'patrol':
            if (!v) return this.toast('Draw a route first');
            return push({ kind: 'task', task: { type: k, routeId: String(v) } });
          case 'wait':
            return push({ kind: 'task', task: { type: 'wait', duration: Number(v) || 0 } });
          case 'setRoe':
            return push({ kind: 'setRoe', roe: v as Roe });
          case 'setSpeed':
            return push({ kind: 'setSpeed', speed: (Number(v) || 0) / 3.6 });
          case 'setAltitude':
            return push({ kind: 'setAltitude', altitude: Number(v) || 0 });
          case 'setFormation':
            return push({ kind: 'setFormation', formation: v as Formation });
          case 'waitTime':
            return push({ kind: 'waitUntil', condition: { type: 'simTime', time: Number(v) || 0 } });
          case 'waitArea':
            if (!v) return this.toast('Draw an area first');
            return push({ kind: 'waitUntil', condition: { type: 'inArea', areaId: String(v) } });
          case 'waitEnemy':
            return push({ kind: 'waitUntil', condition: { type: 'enemyDetected' } });
          case 'waitFire':
            return push({ kind: 'waitUntil', condition: { type: 'underFire' } });
          case 'waitEnemyInArea':
            if (!v) return this.toast('Draw an area first');
            return push({ kind: 'waitUntil', condition: { type: 'enemyInArea', areaId: String(v) } });
          case 'waitStrength':
            return push({ kind: 'waitUntil', condition: { type: 'strengthBelow', fraction: Math.min(100, Math.max(1, Number(v) || 50)) / 100 } });
          case 'waitFuel':
          case 'waitAmmo':
            return push({ kind: 'waitUntil', condition: { type: k === 'waitFuel' ? 'fuelBelow' : 'ammoBelow', fraction: Math.min(100, Math.max(1, Number(v) || 25)) / 100 } });
          case 'resupply':
            return push({ kind: 'task', task: { type: 'resupply' } });
          case 'setReaction':
            return push({ kind: 'setReactions', reactions: { onContact: v === 'halt' ? 'halt' : 'continue' } });
          case 'mount':
            this.map.setMode({ kind: 'pickEntity', label: 'Click the carrier', onPick: (t) => push({ kind: 'task', task: { type: 'mount', carrierId: t } }) });
            return;
          case 'dismount':
            return push({ kind: 'task', task: { type: 'dismount' } });
          case 'setCallForFire':
            return push({ kind: 'setReactions', reactions: { callForFire: v === 'yes' } });
          case 'fireMission':
            this.map.setMode({
              kind: 'pickPoint',
              label: 'Click the target location',
              onPick: (p) => push({ kind: 'task', task: { type: 'fireMission', target: p, rounds: Math.max(1, Number(v) || 3), radius: this.unit(id) ? 50 : 0 } }),
            });
            return;
          case 'waitDestroyed':
            this.map.setMode({
              kind: 'pickEntity',
              label: 'Click the entity to wait for',
              onPick: (t) => push({ kind: 'waitUntil', condition: { type: 'entityDestroyed', entityId: this.unit(t)?.leaderId ?? t } }),
            });
            return;
        }
      },
    });
    const plan = this.draft(id);
    const loop = h('input', { type: 'checkbox', checked: !!plan.loop, onchange: (ev: Event) => (plan.loop = (ev.target as HTMLInputElement).checked) });
    return h(
      'div',
      { class: 'section' },
      h('h4', { text: 'Plan editor' }),
      h(
        'div',
        { class: 'row' },
        'Name',
        h('input', { type: 'text', value: plan.name ?? 'Plan', 'data-plan-name': id, style: 'flex:1', oninput: (ev: Event) => (plan.name = (ev.target as HTMLInputElement).value.trim() || 'Plan') }),
      ),
      h('ol', { class: 'plan-list', 'data-plan-list': id }),
      h('div', { class: 'row' }, kindSel, param, addBtn),
      h(
        'div',
        { class: 'row' },
        h('label', {}, loop, ' loop'),
        h('span', { class: 'spacer' }),
        h('button', {
          class: 'primary',
          text: 'Assign plan',
          onclick: async () => {
            const p = this.draft(id);
            if (!p.statements.length) return this.toast('Add some plan steps first');
            const r = await this.cmd({ cmd: 'assignPlan', targetId: id, plan: JSON.parse(JSON.stringify(p)) });
            if (r.ok) this.toast('Plan assigned', true);
          },
        }),
        h('button', {
          text: 'Clear',
          onclick: () => {
            this.draft(id).statements = [];
            this.renderPlanList(id);
          },
        }),
      ),
    );
  }

  private renderPlanList(id: string): void {
    const list = document.querySelector<HTMLElement>(`[data-plan-list="${id}"]`);
    if (!list) return;
    clear(list);
    const plan = this.draft(id);
    if (!plan.statements.length) {
      list.append(h('li', {}, h('span', { class: 'hint', text: 'No steps yet: build a plan from the controls below.' })));
      return;
    }
    plan.statements.forEach((st, i) => {
      list.append(
        h(
          'li',
          {},
          h('span', { text: `${i + 1}. ${this.describe(st)}` }),
          h('button', {
            text: '↑',
            title: 'Move up',
            disabled: i === 0,
            onclick: () => {
              [plan.statements[i - 1], plan.statements[i]] = [plan.statements[i], plan.statements[i - 1]];
              this.renderPlanList(id);
            },
          }),
          h('button', {
            text: '✕',
            title: 'Remove',
            onclick: () => {
              plan.statements.splice(i, 1);
              this.renderPlanList(id);
            },
          }),
        ),
      );
    });
  }

  private updateLiveFields(el: HTMLElement): void {
    const id = this.selectedId;
    if (!id) return;
    if (el.querySelector(`[data-plan-list="${id}"]`)?.childElementCount === 0) this.renderPlanList(id);
    const set = (key: string, value: string | Node, cls?: string) => {
      const n = el.querySelector<HTMLElement>(`[data-bind="${key}"]`);
      if (!n) return;
      if (typeof value === 'string') {
        if (n.textContent !== value) n.textContent = value;
      } else {
        clear(n);
        n.append(value);
      }
      if (cls !== undefined) n.className = cls;
    };
    const roeSel = el.querySelector<HTMLSelectElement>('[data-bind-value="roe"]');
    const syncReactions = (r: { onContact?: string; withdrawBelow?: number; callForFire?: boolean } | undefined) => {
      const oc = el.querySelector<HTMLSelectElement>('[data-bind-value="onContact"]');
      const wd = el.querySelector<HTMLSelectElement>('[data-bind-value="withdraw"]');
      const cf = el.querySelector<HTMLSelectElement>('[data-bind-value="callForFire"]');
      if (oc && document.activeElement !== oc) oc.value = r?.onContact ?? 'continue';
      if (wd && document.activeElement !== wd) wd.value = String(r?.withdrawBelow ?? 0);
      if (cf && document.activeElement !== cf) cf.value = r?.callForFire ? 'yes' : 'no';
    };
    const e = this.entity(id);
    const u = this.unit(id);
    if (e) {
      set('grid', fmtGrid(e.x, e.y));
      if (this.frame) {
        const g = this.frame.toGeodetic(e);
        set('latlon', fmtLatLon(g.lat, g.lon));
      }
      set('alt', e.domain === 'air' ? `${Math.round(e.z)} m MSL · ${Math.round(e.agl)} m AGL` : `${Math.round(e.z)} m`);
      set('heading', fmtDeg(e.heading));
      set('speed', `${(e.speed * 3.6).toFixed(0)} km/h`);
      set('damage', e.damage === 'none' ? 'operational' : e.damage === 'destroyed' ? 'destroyed' : `${e.damage} kill`, `damage-${e.damage}`);
      set(
        'activity',
        [
          e.embarkedIn ? `MOUNTED in ${this.entity(e.embarkedIn)?.name ?? e.embarkedIn}` : '',
          e.moraleState === 'broken' || this.unit(e.unitId)?.moraleState === 'broken' ? 'BROKEN' : '',
          e.pinned ? 'PINNED' : '',
          e.withdrawn ? 'WITHDRAWING' : '',
          this.pendingOrderText(e.id),
          e.halted ? 'HALTED (contact)' : '',
          e.prepared === 'dugIn' ? 'DUG IN' : e.prepared === 'hullDown' ? 'HULL-DOWN' : '',
          e.plan,
          e.task,
        ]
          .filter(Boolean)
          .join(' — ') ||
          (e.damage === 'destroyed' ? 'destroyed' : 'idle'),
      );
      set('suppression', suppressionBar(e.suppression ?? 0));
      if (!e.unitId) set('morale', moraleText(e.morale, e.moraleState));
      if (e.fuel !== undefined) set('fuel', levelBar(e.fuel));
      if (e.supplies !== undefined) set('supplies', `${e.supplies.toFixed(1)} vehicle loads`);
      const cap = this.capacityOf(e.id);
      if (cap) set('passengers', `Passengers ${e.passengers?.length ?? 0}/${cap}`);
      syncReactions(e.reactions);
      if (roeSel && document.activeElement !== roeSel) roeSel.value = e.roe;
      const t = this.types.get(e.typeId);
      set(
        'weapons',
        e.ammo.length
          ? h(
              'div',
              {},
              e.ammo.map((a) => {
                const w = this.catalog?.weapons.find((x) => x.id === a.weapon);
                const max = w?.ammo ?? 1;
                return h('div', { style: 'margin-bottom:6px' }, h('div', { text: `${w?.name ?? a.weapon} — ${a.rounds}/${max} · ${((w?.maxRange ?? 0) / 1000).toFixed(1)} km` }), h('div', { class: 'ammo-bar' }, h('div', { style: `width:${(a.rounds / max) * 100}%` })));
              }),
            )
          : h('span', { class: 'hint', text: t ? 'unarmed' : '' }),
      );
      set(
        'contacts',
        e.contacts.length
          ? h(
              'div',
              {},
              e.contacts.map((cid) => {
                const c = this.entity(cid);
                return h('div', { class: 'tree-item', onclick: () => this.select(cid) }, c ? symbolCanvas(c.force, c.domain, c.symbol, 14, undefined, this.sidc(c.typeId)) : null, `${c?.name ?? cid}${cid === e.engagingId ? '  ◎ engaging' : ''}${c ? ` · ${(Math.hypot(c.x - e.x, c.y - e.y) / 1000).toFixed(1)} km` : ''}`);
              }),
            )
          : h('span', { class: 'hint', text: 'none' }),
      );
    } else if (u) {
      const lead = this.entity(u.leaderId);
      set('grid', fmtGrid(u.x, u.y));
      const members = u.memberIds.map((m) => this.entity(m)).filter((m): m is EntitySnapshot => !!m);
      const alive = members.filter((m) => m.damage !== 'destroyed');
      set('strength', `${alive.length}/${members.length}`);
      set('leader', lead?.name ?? '—');
      const mounted = alive.filter((m) => m.embarkedIn).length;
      set(
        'activity',
        [
          mounted ? `MOUNTED ${mounted}/${alive.length}` : '',
          u.moraleState === 'broken' ? 'BROKEN' : '',
          alive.some((m) => m.pinned) ? `PINNED ${alive.filter((m) => m.pinned).length}/${alive.length}` : '',
          u.withdrawn ? 'WITHDRAWING' : '',
          this.pendingOrderText(u.id),
          lead?.halted ? 'HALTED (contact)' : '',
          u.plan,
          u.task,
        ]
          .filter(Boolean)
          .join(' — ') || 'idle (in formation)',
      );
      set('morale', moraleText(u.morale, u.moraleState));
      const seats = u.memberIds.reduce((n, m) => n + this.capacityOf(m), 0);
      if (seats) set('passengers', `Passengers ${this.passengerCount(u.id)}/${seats}`);
      syncReactions(u.reactions);
      if (roeSel && document.activeElement !== roeSel && lead) roeSel.value = lead.roe;
      set(
        'members',
        h(
          'div',
          {},
          members.map((m) =>
            h(
              'div',
              { class: `tree-item${m.damage === 'destroyed' ? ' dead' : ''}`, onclick: () => this.select(m.id) },
              symbolCanvas(m.force, m.domain, m.symbol, 14, undefined, this.sidc(m.typeId)),
              `${m.name}${m.id === u.leaderId ? ' ★' : ''} · ${m.damage === 'none' ? 'ok' : m.damage}${m.engagingId ? ' · engaging' : ''}`,
            ),
          ),
        ),
      );
    }
  }

  // ------------------------------------------------------------ event log

  private bindLog(): void {
    document.querySelectorAll<HTMLInputElement>('[data-log]').forEach((cb) => {
      if (cb.checked) this.logFilter.add(cb.dataset.log!);
      cb.addEventListener('change', () => {
        if (cb.checked) this.logFilter.add(cb.dataset.log!);
        else this.logFilter.delete(cb.dataset.log!);
        if (cb.dataset.log === 'created') cb.checked ? this.logFilter.add('deleted') : this.logFilter.delete('deleted');
        this.renderLog();
      });
    });
  }

  private renderLog(newEvents?: SimEvent[]): void {
    const el = $('#log');
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 20;
    const line = (ev: SimEvent) =>
      h(
        'div',
        { class: `log-line k-${ev.kind}`, ondblclick: () => ev.entityId && this.exists(ev.entityId) && (this.select(ev.entityId), this.centerOn(ev.entityId)) },
        h('span', { class: 't', text: fmtTime(ev.time) }),
        ev.text,
      );
    if (!newEvents || this.events.length <= newEvents.length) {
      clear(el);
      for (const ev of this.events) if (this.logFilter.has(ev.kind)) el.append(line(ev));
    } else {
      for (const ev of newEvents) if (this.logFilter.has(ev.kind)) el.append(line(ev));
      while (el.childElementCount > LOG_LIMIT) el.firstChild?.remove();
    }
    if (atBottom) el.scrollTop = el.scrollHeight;
  }
}

declare global {
  interface Window {
    werforces: App;
  }
}

window.werforces = new App();

export type { UnitTemplate };

const GRAPHIC_HINTS: Record<GraphicKind, string> = {
  route: 'Select an entity or unit, then right-click this route to follow or patrol it.',
  phaseLine: 'Select an entity or unit, then right-click this line to follow or patrol it.',
  area: 'Areas can be used in plans: "wait until in area".',
  point: '',
  minefield: 'Vehicles and troops crossing it may set off mines (density: chance per 100 m driven). Forces avoid it once they know it is there. Select engineers, then right-click it to breach a lane.',
  obstacle: 'Vehicles cannot cross it; infantry climb through slowly. Select engineers, then right-click it to breach a lane.',
};

const PRECIPITATION_LABELS: Record<Precipitation, string> = { none: '', rain: 'rain', heavyRain: 'heavy rain', snow: 'snow' };

interface BatchView {
  scenario: string;
  runs: number;
  duration: number;
  losses: { force: ForceId; total: number; stats: { mean: number; sd: number; min: number; max: number; ci95: [number, number] }; histogram: number[] }[];
  exchangeRatio?: number;
  areas: { id: string; name: string; held: Partial<Record<ForceId, number>> }[];
  shots: { mean: number };
  endTime: { mean: number };
  wallSeconds: number;
}

/** Batch outcome tables and a loss histogram per force. */
function batchResults(s: BatchView): HTMLElement {
  const colors: Record<number, string> = { 0: '#e0d060', 1: '#4fa3ff', 2: '#ff5a5a', 3: '#5ad06a' };
  const hist = (hgram: number[], color: string) => {
    const max = Math.max(1, ...hgram);
    const w = 220;
    const bw = w / hgram.length;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', String(w));
    svg.setAttribute('height', '40');
    hgram.forEach((n, i) => {
      const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      const hh = (n / max) * 34;
      r.setAttribute('x', String(i * bw + 0.5));
      r.setAttribute('y', String(36 - hh));
      r.setAttribute('width', String(Math.max(1, bw - 1)));
      r.setAttribute('height', String(hh));
      r.setAttribute('fill', color);
      const t = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      t.textContent = `${n} run${n === 1 ? '' : 's'} lost ${i}`;
      r.append(t);
      svg.append(r);
    });
    return svg;
  };
  return h(
    'div',
    {},
    h('p', { class: 'hint', text: `${s.scenario}: ${s.runs} runs of ${Math.round(s.duration / 60)} min in ${s.wallSeconds} s · runs ended at ${Math.round(s.endTime.mean / 60)} min on average · ${s.shots.mean} rounds fired per run` }),
    h(
      'table',
      { class: 'aar-table' },
      h('thead', {}, h('tr', {}, ['Force', 'Losses (mean ± sd)', '95% CI', 'Range', 'Distribution of losses'].map((c) => h('th', { text: c })))),
      h(
        'tbody',
        {},
        s.losses.map((l) =>
          h(
            'tr',
            {},
            h('td', { text: FORCE_NAMES[l.force] }),
            h('td', { text: `${l.stats.mean} ± ${l.stats.sd} of ${l.total}` }),
            h('td', { text: `${l.stats.ci95[0]} – ${l.stats.ci95[1]}` }),
            h('td', { text: `${l.stats.min} – ${l.stats.max}` }),
            h('td', {}, hist(l.histogram, colors[l.force] ?? '#aaa')),
          ),
        ),
      ),
    ),
    s.exchangeRatio !== undefined ? h('p', { text: `Loss exchange ratio (Red lost per Blue lost): ${s.exchangeRatio}` }) : null,
    ...s.areas.map((a) =>
      h('p', { text: `${a.name} held at the end: ${Object.entries(a.held).map(([f, p]) => `${FORCE_NAMES[Number(f) as ForceId]} ${Math.round((p ?? 0) * 100)}%`).join(', ') || 'by nobody'}` }),
    ),
  );
}
