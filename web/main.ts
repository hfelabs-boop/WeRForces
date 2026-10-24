// WeRForces front-end: scenario editor, tasking and monitoring GUI.

import { LocalFrame } from '../src/dis/geodesy.js';
import { TerrainGrid } from '../src/shared/terrainGrid.js';
import { TiledGrid } from './tiledGrid.js';
import type {
  AggregateSnapshot,
  AggregationPolicy,
  Catalog,
  Command,
  CommandResult,
  EntitySnapshot,
  EntityTypeDef,
  EnvironmentState,
  Explanation,
  Finding,
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
  Travel,
  UnitSnapshot,
  Viewshed,
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
import { QuickBar } from './quickbar.js';
import { PlanEditor } from './planeditor.js';
import { SyncMatrixDialog } from './syncmatrix.js';
import { QuickBattleDialog } from './quickbattle.js';
import { CommanderDialog } from './commander.js';
import { DriveMode } from './drive.js';
import { CatalogEditor } from './catalogeditor.js';
import { OrderLine } from './orderline.js';
import { orderContext } from '../src/shared/orders.js';
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

class App {
  readonly api: Api;
  readonly map: MapView;
  private quick!: QuickBar;
  private syncDialog!: SyncMatrixDialog;
  private commanderDialog!: CommanderDialog;
  private driveMode!: DriveMode;
  private orderLine!: OrderLine;
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
  private readonly plans: PlanEditor = new PlanEditor({
    pickPoint: (label, onPick) => this.map.setMode({ kind: 'pickPoint', label, onPick }),
    pickEntity: (label, onPick) => this.map.setMode({ kind: 'pickEntity', label, onPick }),
    graphics: () => this.state?.graphics ?? [],
    nameOf: (id) => this.graphic(id)?.name ?? this.entity(id)?.name ?? this.unit(id)?.name ?? id,
    aimAt: (id) => this.unit(id)?.leaderId ?? id,
    time: () => this.state?.time ?? 0,
    can: (what) => {
      const id = this.selectedId;
      if (!id) return false;
      const d = this.domainOf(id);
      switch (what) {
        case 'air':
          return d === 'air';
        case 'ground':
          return d !== 'air' && d !== 'surface';
        case 'indirect':
          return this.hasIndirect(id);
        case 'smoke':
          return this.hasSmoke(id);
        case 'carrier':
          return this.isCarrier(id);
        case 'infantry':
          return d === 'lifeform';
        case 'engineer':
          return this.canBreach(id);
        case 'unit':
          return !!this.unit(id);
      }
    },
    assign: async (plan) => (await this.cmd({ cmd: 'assignPlan', targetId: this.selectedId!, plan })).ok,
    toast: (m, info) => this.toast(m, info),
  });
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
    this.quick = new QuickBar($('#quickbar'), {
      targets: () => (this.aar.active ? [] : this.orderable().filter((id) => this.role.kind === 'controller' || (this.entity(id)?.force ?? this.unit(id)?.force) === this.role.force)),
      orderAt: (w, make, line) => this.groupTaskAt(w, make, line),
      orderEach: (make) => void this.groupOrder(make),
      pickPoint: (label, onPick) => this.map.setMode({ kind: 'pickPoint', label, onPick }),
      pickEntity: (label, onPick) => this.map.setMode({ kind: 'pickEntity', label, onPick }),
      can: (id, what) =>
        what === 'indirect'
          ? this.hasIndirect(id)
          : what === 'smoke'
            ? this.hasSmoke(id)
            : what === 'air'
              ? this.domainOf(id) === 'air'
              : what === 'ground'
                ? this.domainOf(id) !== 'air' && this.domainOf(id) !== 'surface'
                : what === 'carrier'
                  ? this.isCarrier(id)
                  : what === 'drone'
                    ? this.isDrone(id)
                    : what === 'oneWay'
                      ? this.isOneWay(id)
                      : this.canBreach(id),
      toast: (m, info) => this.toast(m, info),
      nameOf: (id) => this.entity(id)?.name ?? this.unit(id)?.name ?? id,
    });
    this.syncDialog = new SyncMatrixDialog({
      v1: (m, path, body) => this.api.v1(m, path, body),
      context: (force) =>
        this.state && this.terrainData ? orderContext(this.state, this.terrainData.towns, this.terrainData.spec.size, (id) => this.types.get(id), force) : null,
      rows: (force) => [
        ...(this.state?.units ?? []).filter((u) => u.force === force).map((u) => ({ id: u.id, name: u.name })),
        ...(this.state?.entities ?? []).filter((e) => e.force === force && !e.unitId && !e.remote && e.damage !== 'destroyed').map((e) => ({ id: e.id, name: e.name })),
      ],
      playerForce: () => (this.role.kind === 'player' ? this.role.force : undefined),
      time: () => this.state?.time ?? 0,
      describe: (task) => this.plans.describe({ kind: 'task', task }),
      modal: (c) => this.modal(c),
      toast: (m, info) => this.toast(m, info),
    });
    $('#btn-sync').addEventListener('click', () => void this.syncDialog.open());
    this.commanderDialog = new CommanderDialog({
      v1: (m, path, body) => this.api.v1(m, path, body),
      modal: (c) => this.modal(c),
      toast: (m, info) => this.toast(m, info),
      playerForce: () => (this.role.kind === 'player' ? this.role.force : undefined),
    });
    $('#btn-commander').addEventListener('click', () => void this.commanderDialog.open());
    this.driveMode = new DriveMode($('#drive-hud'), {
      entity: (id) => this.entity(id),
      cmd: (c) => this.cmd(c),
      pickEntity: (label, onPick) => this.map.setMode({ kind: 'pickEntity', label, onPick }),
      follow: (id) => {
        const e = this.entity(id);
        if (e) this.map.centerOn(e);
      },
      weaponName: (id) => this.catalog?.weapons.find((w) => w.id === id)?.name ?? id,
      toast: (m, info) => this.toast(m, info),
    });
    this.orderLine = new OrderLine($('#orderline'), {
      context: () =>
        this.state && this.terrainData
          ? orderContext(this.state, this.terrainData.towns, this.terrainData.spec.size, (id) => this.types.get(id), this.role.kind === 'player' ? this.role.force : undefined)
          : null,
      selectedNames: () => this.quick.targetsNames(),
      send: async (text) => {
        try {
          const r = await this.api.v1<{ description: string }>('POST', '/orders', { text });
          this.refreshPath();
          return r;
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      },
      toast: (m, info) => this.toast(m, info),
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
    this.applyCatalog(catalog);
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
    // Large terrain comes in tiles, fetched for what is in view.
    this.grid = data.tiles ? await TiledGrid.open(data, (z, x, y) => this.api.tile(z, x, y, version)) : TerrainGrid.fromData(data);
    if (version !== this.terrainVersion) return;
    this.frame = new LocalFrame(data.spec.origin.lat, data.spec.origin.lon);
    this.map.setTerrain(data, this.grid);
    this.terrainData = data;
    if (this.view3d && this.grid && this.map.terrainImage) this.view3d.setTerrain(data, this.grid, this.map.terrainImage);
  }

  private onState(s: SimState): void {
    // Spent one-way drones are gone from the battlefield.
    if (s.entities.some((e) => e.expended)) s = { ...s, entities: s.entities.filter((e) => !e.expended) };
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
    this.renderAlerts();
    this.quick.update();
    this.renderPhase(s);
    const cmdr = $('#btn-commander');
    const cmdrText = CommanderDialog.label(s);
    if (cmdr.textContent !== cmdrText) cmdr.textContent = cmdrText;
    this.commanderDialog.update(s);
    this.driveMode.update();
    this.checkCatalog(s);
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
        // Members inside aggregates are not in the entity list.
        const inside = s.units.reduce((n, u) => n + (u.force === f && u.aggregate ? u.aggregate.alive : 0), 0);
        if (!list.length && !inside) return '';
        const alive = list.filter((e) => e.damage !== 'destroyed').length + inside;
        return `${FORCE_NAMES[f as ForceId]} ${alive}/${list.length + inside}`;
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

  /** Unmanned systems: the entity, or a unit with unmanned members. */
  private isDrone(id: string): boolean {
    return this.memberTypes(id).some((t) => t.unmanned);
  }

  /** One-way attack drones (FPV, loitering munitions) among the entity or unit. */
  private isOneWay(id: string): boolean {
    return this.memberTypes(id).some((t) => t.unmanned?.warhead);
  }

  /** Entity types of the entity, or of every member of the unit. */
  private memberTypes(id: string): EntityTypeDef[] {
    const u = this.unit(id);
    // An aggregate's members are hidden: its strength lists their types.
    if (u?.aggregate) return u.aggregate.strength.filter((g) => g.alive > 0).map((g) => this.types.get(g.typeId)).filter((t): t is EntityTypeDef => !!t);
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
    const u = this.unit(id);
    if (u?.aggregate) return u.aggregate.domain;
    const e = this.entity(id) ?? this.entity(u?.leaderId);
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
    const alertsMenu = $('#alerts-menu');
    $('#btn-alerts').addEventListener('click', (e) => {
      e.stopPropagation();
      alertsMenu.classList.toggle('open');
      this.renderAlerts(true);
    });
    $('#alerts-list').addEventListener('click', (e) => e.stopPropagation());
    document.addEventListener('click', () => {
      alertsMenu.classList.remove('open');
      layersMenu.classList.remove('open');
      fileMenu.classList.remove('open');
      $('#context-menu').classList.add('hidden');
    });
    $('#menu-file').addEventListener('click', (e) => {
      const action = (e.target as HTMLElement).dataset.action;
      fileMenu.classList.remove('open');
      if (action === 'new') this.newScenarioDialog();
      if (action === 'quick-battle') void this.quickBattle();
      if (action === 'open-sample') this.openScenarioDialog();
      if (action === 'import') ($('#file-input') as HTMLInputElement).click();
      if (action === 'export') this.exportScenario();
      if (action === 'save-server') this.saveOnServer();
      if (action === 'review-recording') void this.reviewRecordingDialog();
      if (action === 'settings') void this.settingsDialog();
      if (action === 'catalog')
        void new CatalogEditor({ catalog: () => this.catalog, v1: (m, path, body) => this.api.v1(m, path, body), modal: (c) => this.modal(c), toast: (m, info) => this.toast(m, info) }).open();
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
      if (e.key === 'n' && !e.ctrlKey && !e.metaKey) this.nextAlert();
      if (e.key === 'g' && !e.ctrlKey && !e.metaKey && this.entity(this.selectedId)) this.driveMode.start(this.selectedId!);
      if (!e.ctrlKey && !e.metaKey && !e.altKey && this.quick.key(e.key)) e.preventDefault();
      if (e.key === '/' && !this.aar.active) {
        e.preventDefault();
        this.orderLine.focus();
      }
    });
  }

  private viewshedOn = false;

  /** Show what an entity or a point can see (null clears it). */
  private async showViewshed(from: string | { x: number; y: number; height: number } | null): Promise<void> {
    const chip = $('#viewshed-chip');
    if (!from) {
      this.viewshedOn = false;
      this.map.setViewshed(null);
      chip.classList.add('hidden');
      return;
    }
    try {
      const v = await this.api.v1<Viewshed>('POST', '/terrain/viewshed', { from });
      this.viewshedOn = true;
      this.map.setViewshed(v);
      const who = typeof from === 'string' ? (this.entity(from)?.name ?? from) : fmtGrid(from.x, from.y);
      clear(chip);
      chip.append(
        h('span', { text: `Viewshed from ${who}: ${Math.round(v.visibleFraction * 100)}% of the ground within ${(v.radius / 1000).toFixed(1)} km seen; red is dead ground` }),
        h('button', { class: 'small', text: '✕', title: 'Clear', onclick: () => void this.showViewshed(null) }),
      );
      chip.classList.remove('hidden');
    } catch (err) {
      this.toast(err instanceof Error ? err.message : String(err));
    }
  }

  private catalogVersion: number | undefined;

  private applyCatalog(catalog: Catalog): void {
    this.catalog = catalog;
    this.types = new Map(catalog.entityTypes.map((t) => [t.id, t]));
    this.map.sidcOf = (id) => this.types.get(id)?.sidc;
    this.map.jammerRange = (id) => this.types.get(id)?.jammer?.range;
  }

  /** The catalog changed on the server (catalog editor, a scenario with its own entries): fetch it again. */
  private checkCatalog(s: SimState): void {
    if (s.catalogVersion === undefined || s.catalogVersion === this.catalogVersion) return;
    const first = this.catalogVersion === undefined;
    this.catalogVersion = s.catalogVersion;
    // The first state comes with the catalog sent on connecting.
    if (first) return;
    void this.api.v1<Catalog>('GET', '/catalog').then((c) => {
      this.applyCatalog(c);
      this.renderPalette();
      this.inspectorFor = null;
    });
  }

  /** The phase in progress on the toolbar button. */
  private renderPhase(s: SimState): void {
    const force = this.role.kind === 'player' ? this.role.force : 1;
    const m = s.sync?.find((x) => x.force === force) ?? s.sync?.[0];
    const cur = m?.phases.find((p) => p.id === m.current);
    const btn = $('#btn-sync');
    const text = cur ? `Phase: ${cur.name}` : m ? 'Phases (not started)' : 'Phases';
    if (btn.textContent !== text) btn.textContent = text;
  }

  // ------------------------------------------------------------ alerts

  /** Alerts already toasted, so each critical one pops up once. */
  private alertsToasted = new Set<string>();
  private alertsPrimed = false;
  private alertsKey = '';
  private alertCursor = 0;

  /** Badge, list and pop-ups for the attention queue. */
  private renderAlerts(force = false): void {
    const alerts = this.state?.alerts ?? [];
    const count = $('#alerts-count');
    count.textContent = String(alerts.length);
    count.classList.toggle('hidden', alerts.length === 0);
    count.classList.toggle('critical', alerts.some((a) => a.severity === 'critical'));
    // Critical alerts pop up once, except those already open when the page loaded.
    for (const a of alerts) {
      if (a.severity !== 'critical' || this.alertsToasted.has(a.id)) continue;
      this.alertsToasted.add(a.id);
      if (this.alertsPrimed) this.toast(`⚠ ${a.text}`);
    }
    this.alertsPrimed = true;
    const key = alerts.map((a) => `${a.id}:${a.count}:${a.text}`).join('|');
    if (!force && key === this.alertsKey) return;
    this.alertsKey = key;
    const list = $('#alerts-list');
    clear(list);
    if (!alerts.length) {
      list.append(h('div', { class: 'hint alert-empty', text: 'Nothing needs your attention.' }));
      return;
    }
    list.append(
      h('div', { class: 'alerts-head' }, h('span', { class: 'hint', text: `${alerts.length} open · N: next` }), h('button', { class: 'small', text: 'Acknowledge all', onclick: () => void this.cmd({ cmd: 'ackAlert', all: true }) })),
      ...alerts.map((a) =>
        h(
          'div',
          { class: `alert-row sev-${a.severity}`, title: 'Select and centre' },
          h('span', { class: 'alert-time', text: fmtTime(a.time) }),
          h('span', { class: 'alert-text', text: `${a.text}${a.count > 1 ? ` (×${a.count})` : ''}`, onclick: () => this.focusAlert(a.objectId) }),
          h('button', { class: 'small', text: '✓', title: 'Acknowledge', onclick: () => void this.cmd({ cmd: 'ackAlert', id: a.id }) }),
        ),
      ),
    );
  }

  private focusAlert(objectId: string): void {
    if (!this.exists(objectId)) return;
    this.select(objectId);
    this.centerOn(objectId);
  }

  /** Jump to the next open alert (N). */
  private nextAlert(): void {
    const alerts = this.state?.alerts ?? [];
    if (!alerts.length) return this.toast('No alerts', true);
    const a = alerts[this.alertCursor++ % alerts.length];
    this.focusAlert(a.objectId);
    this.toast(a.text, true);
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
    const life = await this.api.v1<{ vehicles: number; pedestrians: number }>('GET', '/simulation/pattern-of-life').catch(() => ({ vehicles: 0, pedestrians: 0 }));
    const cars = h('input', { type: 'number', min: '0', max: '300', step: '1', value: String(life.vehicles) }) as HTMLInputElement;
    const people = h('input', { type: 'number', min: '0', max: '300', step: '1', value: String(life.pedestrians) }) as HTMLInputElement;
    const env = await this.api.v1<EnvironmentState>('GET', '/simulation/environment');
    const pol = await this.api.v1<Required<AggregationPolicy>>('GET', '/simulation/aggregation').catch(() => ({ autoDisaggregate: true, disaggregateRange: 3000, autoReaggregate: true, reaggregateRange: 5000, reaggregateDelay: 120 }));
    const autoSplit = h('input', { type: 'checkbox', checked: pol.autoDisaggregate }) as HTMLInputElement;
    const splitAt = h('input', { type: 'number', min: '100', max: '50000', step: '100', value: String(pol.disaggregateRange) }) as HTMLInputElement;
    const autoJoin = h('input', { type: 'checkbox', checked: pol.autoReaggregate }) as HTMLInputElement;
    const joinAt = h('input', { type: 'number', min: '100', max: '100000', step: '100', value: String(pol.reaggregateRange) }) as HTMLInputElement;
    const joinAfter = h('input', { type: 'number', min: '0', max: '86400', step: '10', value: String(pol.reaggregateDelay) }) as HTMLInputElement;
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
      box('curvature', 'Earth curvature', 'Long sight lines and radar are blocked by the curve of the earth (with standard refraction): two people with eyes 2 m up cannot see each other beyond about 12 km over flat ground'),
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
      h('h4', { text: 'Aggregate level' }),
      h(
        'div',
        { class: 'env-grid' },
        ...field('Split near enemy entities', autoSplit),
        ...field('… within (m)', splitAt),
        ...field('Join up again', autoJoin),
        ...field('… no enemy within (m)', joinAt),
        ...field('… for (s)', joinAfter),
      ),
      h('small', { class: 'hint', text: 'Aggregated units (inspector → Aggregate) are one object each, fighting other aggregates with Lanchester attrition. They split into their entities when an enemy entity comes close, and those that split by themselves join up again once the enemy has been further away for a while.' }),
      h('h4', { text: 'Civilians (pattern of life)' }),
      h('div', { class: 'env-grid' }, ...field('Cars', cars), ...field('People', people)),
      h('small', { class: 'hint', text: 'Neutral background traffic: cars drive between the towns along the roads, people walk about the towns. They run from shots and blasts nearby, and any killed are logged.' }),
      h(
        'div',
        { class: 'row' },
        h('button', {
          class: 'primary',
          text: 'Apply',
          onclick: async () => {
            const next: Record<string, boolean> = {};
            for (const el of body.querySelectorAll<HTMLInputElement>('[data-rule]')) next[el.dataset.rule!] = el.checked;
            const [th, tm] = time.value.split(':').map(Number);
            // One edit: a single undo takes the whole dialog back.
            const r = await this.cmd({
              cmd: 'batch',
              commands: [
                { cmd: 'setRules', rules: next },
                { cmd: 'setPatternOfLife', vehicles: Number(cars.value) || 0, pedestrians: Number(people.value) || 0 },
                {
                  cmd: 'setAggregation',
                  policy: { autoDisaggregate: autoSplit.checked, disaggregateRange: Number(splitAt.value) || pol.disaggregateRange, autoReaggregate: autoJoin.checked, reaggregateRange: Number(joinAt.value) || pol.reaggregateRange, reaggregateDelay: Number(joinAfter.value) || 0 },
                },
                {
              cmd: 'setEnvironment',
              environment: {
                date: date.value || env.date,
                time: Number.isFinite(th) ? th + (tm || 0) / 60 : env.time,
                visibility: Number(visibility.value),
                precipitation: precipitation.value as Precipitation,
                windSpeed: Number(windSpeed.value),
                windFrom: Number(windFrom.value) % 360,
              },
                },
              ],
            });
            if (r.ok) close();
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
        h('div', { class: 'sub', text: `${u.echelon} · ${FORCE_NAMES[u.force]} · ${u.id} · ${this.aar.active ? 'replay' : 'contact'}` }),
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
          : `Enemy contact, last seen ${e?.contactAge ?? u?.aggregate?.contactAge ?? 0} s ago. Position is where your force last saw it.`,
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

  private async quickBattle(): Promise<void> {
    await new QuickBattleDialog({
      v1: (m, path, body) => this.api.v1(m, path, body),
      modal: (c) => this.modal(c),
      toast: (m, info) => this.toast(m, info),
      hasDataset: () => this.grid?.spec.dataset,
      built: (b) => {
        this.select(null);
        let close = () => {};
        close = this.modal(
          h(
            'div',
            { class: 'quick-battle-brief' },
            h('h3', { text: b.name }),
            h('p', { text: b.description }),
            h(
              'div',
              { class: 'row' },
              h('button', { class: 'primary', text: 'Start', onclick: () => (close(), void this.cmd({ cmd: 'run' })) }),
              h('button', { text: 'Show phases', onclick: () => (close(), void this.syncDialog.open()) }),
              h('button', { text: 'Close', onclick: () => close() }),
            ),
          ),
        );
      },
    }).open();
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
      st.units.map((u) => u.id + u.name + u.memberIds.join() + (u.parentId ?? '') + (u.aggregate ? `A${u.aggregate.alive}` : '')).join() +
      '|' +
      st.entities.map((e) => e.id + e.name + e.damage).join() +
      '|' +
      st.graphics.map((g) => g.id + g.name).join();
    if (!force && sig === this.treeSignature) return;
    this.treeSignature = sig;
    const el = $('#objects');
    clear(el);
    const match = (s: string) => !filter || s.toLowerCase().includes(filter);
    // Under its parent, a name that repeats the parent's ("A Coy 1st Platoon" under "A Coy") shows only the rest; the full name is the tooltip.
    const item = (id: string, name: string, icon: HTMLElement | null, dead = false, parent?: string) =>
      h(
        'div',
        { class: `tree-item${id === this.selectedId ? ' selected' : ''}${dead ? ' dead' : ''}`, title: name, onclick: () => this.select(id), ondblclick: () => this.centerOn(id) },
        icon,
        h('span', { class: 'tree-name', text: parent && name.startsWith(`${parent} `) && name.length > parent.length + 1 ? `… ${name.slice(parent.length + 1)}` : name }),
      );
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
      const renderUnit = (u: UnitSnapshot, into: HTMLElement, parent?: string) => {
        if (!matches(u)) return;
        const members = membersOf(u);
        // An aggregate's members are hidden: it is one object with its strength.
        const lead = u.aggregate ?? members[0];
        const label = u.aggregate ? `${u.name} [${u.aggregate.alive}/${u.aggregate.total}]` : u.name;
        into.append(item(u.id, label, lead ? symbolCanvas(f, lead.domain, lead.symbol, 18, u.echelon, this.sidc(lead.typeId)) : null, !!u.aggregate && u.aggregate.alive === 0, parent));
        const kids = h('div', { class: 'tree-children' });
        for (const sub of subsOf(u)) renderUnit(sub, kids, u.name);
        kids.append(...members.filter((m) => match(m.name) || match(u.name)).map((m) => item(m.id, m.name, symbolCanvas(f, m.domain, m.symbol, 16, undefined, this.sidc(m.typeId)), m.damage === 'destroyed', u.name)));
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
    this.quick.update();
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
    // An aggregated unit: attacking it means attacking its leader inside it.
    const hitAgg = !hitEntity && this.unit(hit)?.aggregate && this.unit(hit)?.leaderId ? this.unit(hit) : undefined;

    const group = this.selection.size > 1 && !(hit && this.selection.has(hit)) ? this.orderable() : [];
    if (group.length > 1) {
      items.push(h('div', { class: 'title', text: `${group.length} selected` }));
      const selForces = new Set(group.map((id) => this.entity(id)?.force ?? this.unit(id)?.force));
      if (hitEntity && hit && !selForces.has(hitEntity.force) && hitEntity.damage !== 'destroyed') {
        add(`All attack ${hitEntity.name}`, () => this.groupOrder((targetId) => ({ cmd: 'assignTask', targetId, task: { type: 'attack', targetId: hitEntity.id } })));
      } else if (hitAgg && !selForces.has(hitAgg.force)) {
        add(`All attack ${hitAgg.name}`, () => this.groupOrder((targetId) => ({ cmd: 'assignTask', targetId, task: { type: 'attack', targetId: hitAgg.leaderId! } })));
      } else if (this.unit(hit) && selForces.has(this.unit(hit)!.force) && group.every((id) => this.unit(id))) {
        add(`Put under ${this.unit(hit)!.name}`, () => this.groupOrder((unitId) => ({ cmd: 'setSuperior', unitId, superiorId: hit! })));
      } else {
        add('Move here (keep formation)', () => this.groupTaskAt(world, (t) => ({ type: 'moveTo', target: t }), false));
        add('Move here by a covered route', () => this.groupTaskAt(world, (t) => ({ type: 'moveTo', target: t, covered: true }), false));
        add('Defend here (in line)', () => this.groupTaskAt(world, (t, f) => ({ type: 'defend', position: t, facing: f }), true));
        add('Overwatch here (in line)', () => this.groupTaskAt(world, (t, f) => ({ type: 'overwatch', position: t, facing: f }), true));
        const guns = group.filter((id) => this.hasIndirect(id));
        if (guns.length) add(`Fire mission here (${guns.length} firing)`, () => void Promise.all(guns.map((id) => this.task(id, { type: 'fireMission', target: world, rounds: 3, radius: this.unit(id) ? 50 : 0 }))));
      }
      add('Stop all', () => this.groupOrder((targetId) => ({ cmd: 'stop', targetId })));
      sep();
    } else if (selTaskable && hit !== sel) {
      items.push(h('div', { class: 'title', text: selName ?? '' }));
      if (hitAgg && hitAgg.force !== (this.entity(sel)?.force ?? this.unit(sel)?.force)) {
        add(`Attack ${hitAgg.name}`, () => this.task(sel, { type: 'attack', targetId: hitAgg.leaderId! }));
        add('Move here', () => this.task(sel, { type: 'moveTo', target: world }));
      } else if (hitEntity && hit) {
        const selForce = this.entity(sel)?.force ?? this.unit(sel)?.force;
        if (hitEntity.force !== selForce && hitEntity.damage !== 'destroyed') add(`Attack ${hitEntity.name}`, () => this.task(sel, { type: 'attack', targetId: hitEntity.id }));
        if (hitEntity.force !== selForce && hitEntity.damage !== 'destroyed' && this.isOneWay(sel)) add(`Strike ${hitEntity.name} (one-way attack)`, () => this.task(sel, { type: 'strike', targetId: hitEntity.id }));
        if (hitEntity.force !== selForce && hitEntity.damage !== 'destroyed' && this.unit(sel) && this.isDrone(sel)) {
          // A whole unit hit: spread the swarm over its members.
          const targets = this.unit(hit)?.memberIds.filter((m) => this.entity(m) && this.entity(m)!.damage !== 'destroyed') ?? [hitEntity.id];
          add(`Swarm attack ${this.unit(hit)?.name ?? hitEntity.name}`, () => this.task(sel, { type: 'swarmAttack', targetIds: targets }));
        }
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
          if (this.isDrone(sel) && this.domainOf(sel) === 'air') {
            add(`Loiter over ${hitGraphic.name} and attack`, () => this.task(sel, { type: 'loiter', areaId: hitGraphic.id, attack: true }));
            if (this.unit(sel)) {
              add(`Swarm search ${hitGraphic.name}`, () => this.task(sel, { type: 'swarmSearch', areaId: hitGraphic.id }));
              add(`Swarm search ${hitGraphic.name} and attack`, () => this.task(sel, { type: 'swarmSearch', areaId: hitGraphic.id, attack: true }));
              add(`Swarm attack in ${hitGraphic.name}`, () => this.task(sel, { type: 'swarmAttack', areaId: hitGraphic.id }));
            }
          }
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
            this.plans.set(sel, { name: 'Move and dismount', statements: [{ kind: 'task', task: { type: 'moveTo', target: world } }, { kind: 'task', task: { type: 'dismount' } }] });
            this.cmd({ cmd: 'assignPlan', targetId: sel, plan: this.plans.get(sel) });
          });
        }
        if (this.hasIndirect(sel)) add('Fire mission here (3 rounds)', () => this.task(sel, { type: 'fireMission', target: world, rounds: 3, radius: this.unit(sel) ? 50 : 0 }));
        if (this.hasSmoke(sel)) add('Smoke screen here (2 rounds)', () => this.task(sel, { type: 'fireMission', target: world, rounds: 2, radius: this.unit(sel) ? 60 : 0, smoke: true }));
        if (this.domainOf(sel) === 'air') add('Orbit here (2 km)', () => this.task(sel, { type: 'orbit', center: world, radius: 2000 }));
        if (this.domainOf(sel) === 'air' && this.isDrone(sel)) add('Loiter here and attack (1 km)', () => this.task(sel, { type: 'loiter', center: { x: Math.round(world.x), y: Math.round(world.y) }, radius: 1000, attack: true }));
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
    add('What can be seen from here (viewshed)', () => void this.showViewshed({ x: Math.round(world.x), y: Math.round(world.y), height: 2 }));
    if (this.viewshedOn) add('Clear viewshed', () => this.showViewshed(null));
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
      if ((this.aar.active || e?.contactAge !== undefined || u?.aggregate?.contactAge !== undefined) && (e || u)) this.buildReplayInspector(el, id);
      else if (e) this.buildEntityInspector(el, e);
      else if (u) this.buildUnitInspector(el, u);
      else if (g) this.buildGraphicInspector(el, g);
    }
    this.updateLiveFields(el);
    void this.refreshWhy();
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
        e.aps || e.decoys ? 'Protection' : null,
        e.aps || e.decoys ? this.bind('protection') : null,
        t?.gnss || t?.unmanned ? 'Navigation' : null,
        t?.gnss || t?.unmanned ? this.bind('nav') : null,
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
      this.whySection(e.id),
      t?.jammer
        ? h(
            'div',
            { class: 'section row' },
            h('h4', { text: 'Jamming' }),
            h('span', { class: 'hint', text: `${jamBands(t.jammer)} within ${(t.jammer.range / 1000).toFixed(t.jammer.range < 10000 ? 1 : 0)} km` }),
            h('button', { text: e.jamming === false ? 'Switch on' : 'Switch off', onclick: () => void this.cmd({ cmd: 'setJamming', id: e.id, on: this.entity(e.id)?.jamming === false }).then(() => (this.inspectorFor = null)) }),
          )
        : '',
      this.datalinkSection(e.id),
      this.emconSection(e.id, [e.id]),
      this.roeSection(e.id),
      this.reactionsSection(e.id, false),
      this.taskSection(e.id, e.domain),
      this.planSection(e.id, false),
      h('div', { class: 'section' }, h('h4', { text: 'Weapons' }), h('div', { 'data-bind': 'weapons' })),
      h('div', { class: 'section' }, h('h4', { text: 'Sensors' }), h('div', { class: 'hint', text: (t?.sensors ?? []).map((s) => this.catalog?.sensors.find((x) => x.id === s)?.name ?? s).join(', ') || 'none' })),
      h('div', { class: 'section' }, h('h4', { text: 'Contacts' }), h('div', { 'data-bind': 'contacts' })),
      h(
        'div',
        { class: 'section row' },
        h('button', { text: 'Center', onclick: () => this.centerOn(e.id) }),
        h('button', { text: 'Viewshed', title: 'Show the ground it can see, and its dead ground, out to its sensor range', onclick: () => void this.showViewshed(e.id) }),
        h('button', { text: 'Drive', title: 'Drive it yourself: W/S throttle, A/D turn, T pick a target, Esc hand back (G)', onclick: () => this.driveMode.start(e.id) }),
        h('button', { class: 'danger', text: 'Delete', onclick: () => this.deleteSelected() }),
      ),
    );
  }

  // ------------------------------------------------------------ why?

  private whyAt = 0;
  private whyBusy = false;
  private whyOpen = false;

  /** "Why?": the server's explanation of what the selection is doing and what stops it, kept fresh while shown. */
  private whySection(id: string): HTMLElement {
    const details = h('div', { class: 'why-details', 'data-why-details': id });
    details.hidden = !this.whyOpen;
    const toggle = h('button', { class: 'small', text: this.whyOpen ? 'Less' : 'Details', title: 'Every reason, with what you can do about it' });
    toggle.addEventListener('click', () => {
      this.whyOpen = !this.whyOpen;
      details.hidden = !this.whyOpen;
      toggle.textContent = this.whyOpen ? 'Less' : 'Details';
    });
    const sec = h('div', { class: 'section why' }, h('h4', {}, 'Why? ', toggle), h('div', { class: 'why-summary hint', 'data-why': id, text: '…' }), details);
    this.whyAt = 0;
    void this.refreshWhy(true);
    return sec;
  }

  private async refreshWhy(force = false): Promise<void> {
    const id = this.selectedId;
    const summary = id ? document.querySelector<HTMLElement>(`[data-why="${id}"]`) : null;
    if (!id || !summary || this.whyBusy) return;
    if (!force && performance.now() - this.whyAt < 2000) return;
    this.whyBusy = true;
    this.whyAt = performance.now();
    try {
      const kind = this.unit(id) ? 'units' : 'entities';
      const ex = await this.api.v1<Explanation>('GET', `/${kind}/${encodeURIComponent(id)}/explain`);
      if (this.selectedId !== id) return;
      this.renderWhy(id, ex);
    } catch {
      summary.textContent = '';
    } finally {
      this.whyBusy = false;
    }
  }

  private renderWhy(id: string, ex: Explanation): void {
    const summary = document.querySelector<HTMLElement>(`[data-why="${id}"]`);
    const details = document.querySelector<HTMLElement>(`[data-why-details="${id}"]`);
    if (!summary || !details) return;
    const worst = [...(ex.unit ?? []), ...ex.movement, ...ex.fire].find((f) => f.severity === 'block') ?? [...ex.movement, ...ex.fire].find((f) => f.severity === 'warn');
    summary.textContent = ex.summary;
    summary.className = `why-summary ${worst ? `sev-${worst.severity}` : 'hint'}`;
    const item = (f: Finding) => {
      const li = h('li', { class: `sev-${f.severity}` }, h('span', { text: f.text }));
      if (f.fix) li.append(h('div', { class: 'fix', text: `→ ${f.fix}` }));
      if (f.at || f.aboutId) {
        li.classList.add('clickable');
        li.title = f.at ? 'Show on the map' : 'Select it';
        li.addEventListener('click', () => {
          if (f.at) this.showWhyMark(id, f);
          else if (f.aboutId) this.select(f.aboutId);
        });
      }
      return li;
    };
    const group = (title: string, fs: Finding[] | undefined) => (fs && fs.length ? [h('h5', { text: title }), h('ul', { class: 'why-list' }, ...fs.map(item))] : []);
    clear(details);
    details.append(...group('Unit', ex.unit), ...group('Moving', ex.movement), ...group('Shooting', ex.fire), ...group('Seeing', ex.sensing));
  }

  /** Mark what a finding points at (e.g. the crest that blocks a sight line), with the sight line. */
  private showWhyMark(id: string, f: Finding): void {
    const from = this.positionOf(id);
    const to = f.aboutId ? this.positionOf(f.aboutId) : undefined;
    this.map.explainMarks = [{ at: f.at!, label: f.text.split(':')[0].slice(0, 40), line: from && to ? [from, to] : undefined }];
    this.map.centerOn(f.at!);
    this.map.invalidate();
    window.setTimeout(() => {
      this.map.explainMarks = [];
      this.map.invalidate();
    }, 8000);
  }

  /** "2.3 km to go, ETA 14:32 local (in 6 min)" for a move. */
  private travelText(t: Travel | undefined): string {
    if (!t) return '';
    const left = t.remaining >= 1000 ? `${(t.remaining / 1000).toFixed(1)} km` : `${t.remaining} m`;
    if (t.eta === undefined) return `${left} to go, stalled${t.stalled ? `: ${t.stalled}` : ''}`;
    const secs = Math.max(0, t.eta - (this.state?.time ?? 0));
    const inText = secs < 90 ? `${Math.round(secs)} s` : secs < 5400 ? `${Math.round(secs / 60)} min` : `${(secs / 3600).toFixed(1)} h`;
    return `${left} to go, ETA ${t.etaLocal ?? fmtTime(t.eta)}${t.etaLocal ? ' local' : ''} (in ${inText})`;
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
    const lead = u.aggregate ?? this.entity(u.leaderId) ?? this.entity(u.memberIds[0]);
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
      this.whySection(u.id),
      this.datalinkSection(u.id),
      u.aggregate ? '' : this.emconSection(u.id, u.memberIds),
      this.roeSection(u.id),
      this.reactionsSection(u.id, true),
      this.taskSection(u.id, lead?.domain ?? 'ground'),
      this.planSection(u.id, true),
      h('div', { class: 'section' }, h('h4', { text: 'Members' }), h('div', { 'data-bind': 'members' })),
      h(
        'div',
        { class: 'section row' },
        h('button', { text: 'Center', onclick: () => this.centerOn(u.id) }),
        // Aggregate: simulate the unit as one object; Disaggregate: back to its entities.
        h('button', {
          'data-bind-aggregate': u.id,
          title: 'Aggregate: simulate the unit (and units under it) as one object with a strength, Lanchester attrition and unit speed; it splits into its entities near the enemy. Disaggregate: back to entities.',
          text: u.aggregate ? 'Disaggregate' : 'Aggregate',
          onclick: () => void this.cmd({ cmd: this.unit(u.id)?.aggregate ? 'disaggregate' : 'aggregate', unitId: u.id }),
        }),
        h('button', { class: 'danger', text: 'Delete unit', onclick: () => this.deleteSelected() }),
      ),
    );
  }

  /** An aggregate's strength by type, with bars, then its posture and pooled supplies. */
  private aggregateMembers(a: AggregateSnapshot): HTMLElement {
    const posture = { moving: 'moving', halted: 'halted', defending: 'defending (hasty)', dugIn: 'dug in' }[a.posture];
    return h(
      'div',
      {},
      a.strength.map((g) =>
        h(
          'div',
          { style: 'margin-bottom:6px' },
          h('div', { text: `${g.name} — ${g.alive}/${g.total}${g.effective !== undefined && g.effective < g.alive - 0.05 ? ` (${g.effective.toFixed(1)} effective)` : ''}` }),
          h('div', { class: 'ammo-bar' }, h('div', { style: `width:${(g.alive / Math.max(1, g.total)) * 100}%` })),
        ),
      ),
      h(
        'div',
        { class: 'hint' },
        [
          `Aggregated · ${posture}`,
          a.speed > 0.5 ? `${Math.round(a.speed * 3.6)} km/h` : '',
          a.combatPower !== undefined ? `combat power ${a.combatPower}` : '',
          a.sensorRange ? `sees ${(a.sensorRange / 1000).toFixed(1)} km` : '',
          a.ammo !== undefined ? `ammo ${Math.round(a.ammo * 100)}%` : '',
          a.fuel !== undefined ? `fuel ${Math.round(a.fuel * 100)}%` : '',
        ]
          .filter(Boolean)
          .join(' · '),
      ),
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
        h('button', { text: 'Stop all', onclick: () => this.groupOrder((targetId) => ({ cmd: 'stop', targetId })) }),
        h('button', { text: 'Clear selection', onclick: () => this.select(null) }),
        h('button', {
          class: 'danger',
          text: 'Delete all',
          onclick: async () => {
            if (!confirm(`Delete ${ids.length} objects?`)) return;
            const commands: Command[] = ids.filter((id) => this.exists(id)).map((id) => ({ cmd: 'deleteObject', id }));
            if (commands.length) await this.cmd({ cmd: 'batch', commands });
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

  /** One command per selected thing, sent together: one edit, one undo step. */
  private async groupOrder(make: (id: string) => Command | null | undefined): Promise<void> {
    const commands = this.orderable().map(make).filter((c): c is Command => !!c);
    if (!commands.length) return;
    await this.cmd(commands.length === 1 ? commands[0] : { cmd: 'batch', commands });
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
    const commands: Command[] = ids.map((targetId, i) => ({ cmd: 'assignTask', targetId, task: make(targets[i], Math.round(facing)) }));
    void this.cmd(commands.length === 1 ? commands[0] : { cmd: 'batch', commands }).then(() => this.refreshPath());
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
        // Values in their own elements: two text nodes in a row would merge into one grid cell.
        'Points',
        h('span', { text: String(g.points.length) }),
        g.kind === 'area' ? 'Area' : g.kind === 'point' ? 'Location' : 'Length',
        h('span', { text: g.kind === 'area' ? `${(area / 1e6).toFixed(2)} km²` : g.kind === 'point' ? fmtGrid(g.points[0].x, g.points[0].y) : `${(len / 1000).toFixed(2)} km` }),
      ),
      ...(g.kind === 'minefield' ? [this.densityEditor(g)] : []),
      ...(g.kind === 'minefield' || g.kind === 'obstacle'
        ? [h('div', { class: 'kv' }, 'Lanes', h('span', { text: String(g.lanes?.length ?? 0) }), 'Known to', h('span', { text: [g.force, ...(g.knownBy ?? [])].map((f) => FORCE_NAMES[f]).join(', ') }))]
        : []),
      h('p', { class: 'hint', text: GRAPHIC_HINTS[g.kind] }),
      h('div', { class: 'section row' }, h('button', { text: 'Center', onclick: () => this.centerOn(g.id) }), h('button', { class: 'danger', text: 'Delete', onclick: () => this.deleteSelected() })),
    );
  }

  private densityEditor(g: Graphic): HTMLElement {
    const input = h('input', { type: 'number', min: '0.05', max: '3', step: '0.05', value: String(g.density ?? 0.5) }) as HTMLInputElement;
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

  /** Unmanned systems: the datalink, the operator they are flown from, lost-link behaviour and autonomy. */
  private datalinkSection(id: string): HTMLElement | string {
    if (!this.isDrone(id)) return '';
    const lead = this.entity(id) ?? this.entity(this.unit(id)?.leaderId);
    const ops = (this.state?.entities ?? []).filter((x) => x.force === lead?.force && x.damage !== 'destroyed' && this.types.get(x.typeId)?.groundControl);
    const set = (change: Record<string, string | null>) => void this.cmd({ cmd: 'setUnmanned', id, ...change } as Command);
    const choose = (key: string, options: [string, string][], onPick: (v: string) => void) =>
      h('select', { 'data-bind-value': key, onchange: (ev: Event) => onPick((ev.target as HTMLSelectElement).value) }, options.map(([v, text]) => h('option', { value: v, text })));
    return h(
      'div',
      { class: 'section' },
      h('h4', { text: 'Datalink' }),
      h('div', { class: 'status-line', 'data-bind': 'link' }),
      h(
        'div',
        { class: 'kv' },
        'Operator',
        choose('operator', [['', 'any of its side'], ...ops.map((o) => [o.id, o.name] as [string, string])], (v) => set({ controllerId: v || null })),
        'Lost link',
        choose('lostLink', [['hover', 'hold (hover or circle)'], ['return', 'return to its operator'], ['continue', 'carry on with its task'], ['land', 'land']], (v) => set({ lostLink: v })),
        'Autonomy',
        choose('autonomy', [['remote', 'remote (piloted)'], ['supervised', 'supervised'], ['autonomous', 'autonomous']], (v) => set({ autonomy: v })),
      ),
    );
  }

  /**
   * Emission control: radio silence, radars off and jammers on or off, for an entity or a
   * unit (members and subordinates). Shown for what the members have.
   */
  private emconSection(id: string, memberIds: string[]): HTMLElement | '' {
    const members = memberIds.map((m) => this.entity(m)).filter((m): m is EntitySnapshot => !!m && !m.remote);
    if (!members.length) return '';
    const types = members.map((m) => this.types.get(m.typeId));
    const radar = types.some((t) => t?.sensors.some((sid) => this.catalog?.sensors.find((x) => x.id === sid)?.radar));
    const jammer = types.some((t) => t?.jammer);
    const box = (label: string, title: string, checked: boolean, key: 'radioSilence' | 'radarOff' | 'jamming') => {
      const input = h('input', { type: 'checkbox', checked }) as HTMLInputElement;
      input.addEventListener('change', () => void this.cmd({ cmd: 'setEmcon', targetId: id, [key]: input.checked }).then(() => (this.inspectorFor = null)));
      return h('label', { class: 'setting', title }, input, h('span', { text: label }));
    };
    const emitting = [...new Set(members.flatMap((m) => m.emitting ?? []))];
    return h(
      'div',
      { class: 'section' },
      h('h4', { text: 'Emission control' }),
      box('Radio silence', 'Transmit nothing: enemy direction finders cannot find it by its radio, but it shares no contacts, calls no fire, hears no codewords, and orders reach it a minute late', members.every((m) => m.emcon?.radioSilence), 'radioSilence'),
      radar ? box('Radar off', 'Radars neither radiate nor detect; anti-radiation missiles lose them', members.every((m) => m.emcon?.radarOff), 'radarOff') : '',
      jammer && memberIds.length > 1 ? box('Jamming', 'Switch the jammers on or off', members.some((m) => m.jamming === true), 'jamming') : '',
      h('div', { class: 'hint', text: emitting.length ? `Radiating: ${emitting.join(', ')}` : 'Radiating nothing' }),
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
        this.isOneWay(id) ? h('button', { text: 'Strike…', title: 'Fly into an enemy and detonate', onclick: () => this.map.setMode({ kind: 'pickEntity', label: 'Click the target', onPick: (t) => this.task(id, { type: 'strike', targetId: this.unit(t)?.leaderId ?? t }) }) }) : null,
        this.isDrone(id) && domain === 'air'
          ? h('button', { text: 'Loiter…', title: 'Loiter round a point (1 km) and attack what it finds', onclick: () => this.map.setMode({ kind: 'pickPoint', label: 'Click the centre', onPick: (p) => this.task(id, { type: 'loiter', center: p, radius: 1000, attack: true }) }) })
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

  addPlanStep(id: string, st: PlanStatement): void {
    this.plans.add(id, st);
  }

  private planSection(id: string, _isUnit: boolean): HTMLElement {
    const sec = this.plans.section(id);
    window.setTimeout(() => this.plans.render(id));
    return sec;
  }

  private updateLiveFields(el: HTMLElement): void {
    const id = this.selectedId;
    if (!id) return;
    if (el.querySelector(`[data-plan-list="${id}"]`)?.childElementCount === 0) this.plans.render(id);
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
    // Unmanned systems: the datalink line and the control settings.
    const syncLink = (members: EntitySnapshot[]) => {
      const drones = members.filter((m) => m.link && m.damage !== 'destroyed');
      if (!drones.length) return;
      const up = drones.filter((m) => m.link!.up);
      const one = drones[0].link!;
      const name = (oid?: string) => (oid ? (this.entity(oid)?.name ?? oid) : '');
      const why: Record<string, string> = { jammed: 'jammed', range: 'out of range', terrain: 'no line of sight', noController: 'no operator', controllerLost: 'operator lost', tether: 'fibre ran out' };
      const text =
        drones.length > 1
          ? `${up.length}/${drones.length} linked${up.length < drones.length ? ` — ${drones.length - up.length} LOST (${why[drones.find((m) => !m.link!.up)!.link!.reason ?? ''] ?? 'no link'})` : ''}`
          : one.mode === 'autonomous'
            ? 'autonomous (no link needed)'
            : one.up
              ? `UP${one.controllerId ? ` to ${name(one.controllerId)}` : ' (satellite)'}${(one.hops ?? 1) > 1 ? ` via ${one.hops! - 1} relay${one.hops! > 2 ? 's' : ''}` : ''}${one.mode === 'fiber' ? ' (fibre)' : ''}`
              : `LOST — ${why[one.reason ?? ''] ?? 'no link'}${one.lostFor !== undefined ? `, ${Math.round(one.lostFor)} s` : ''}`;
      set('link', text, up.length < drones.length ? 'status-line damage-mobility' : 'status-line');
      const pick = (key: string, v: string) => {
        const sel = el.querySelector<HTMLSelectElement>(`[data-bind-value="${key}"]`);
        if (sel && document.activeElement !== sel && sel.value !== v) sel.value = v;
      };
      pick('operator', one.operatorId ?? '');
      pick('lostLink', one.lostLink);
      pick('autonomy', one.autonomy);
    };
    const e = this.entity(id);
    const u = this.unit(id);
    if (e) {
      syncLink([e]);
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
          e.jammed?.includes('radio') ? 'RADIO JAMMED' : '',
          e.link && !e.link.up && !e.jammed?.includes('datalink') ? 'DATALINK LOST' : '',
          e.jammed?.includes('radar') ? 'RADAR JAMMED' : '',
          e.jamming === true ? 'JAMMING' : '',
          e.emcon?.radioSilence ? 'RADIO SILENCE' : '',
          e.emcon?.radarOff ? 'RADAR OFF' : '',
          e.gnss === 'denied' ? `GNSS DENIED (~${e.navError ?? 0} m)` : e.gnss === 'spoofed' ? `GNSS SPOOFED (${e.navError ?? 0} m off)` : '',
          e.jammed?.includes('datalink') ? 'DATALINK JAMMED' : '',
          e.prepared === 'dugIn' ? 'DUG IN' : e.prepared === 'hullDown' ? 'HULL-DOWN' : '',
          e.plan,
          // A plan step already names its task ("QRF 3/3: Move to …").
          e.plan && e.task && e.plan.endsWith(e.task) ? '' : e.task,
          this.travelText(e.travel),
        ]
          .filter(Boolean)
          .join(' — ') ||
          (e.damage === 'destroyed' ? 'destroyed' : 'idle'),
      );
      set('suppression', suppressionBar(e.suppression ?? 0));
      if (!e.unitId) set('morale', moraleText(e.morale, e.moraleState));
      if (e.fuel !== undefined) set('fuel', levelBar(e.fuel));
      if (e.supplies !== undefined) set('supplies', `${e.supplies.toFixed(1)} vehicle loads`);
      const et = this.types.get(e.typeId);
      if (e.aps || e.decoys) set('protection', [e.aps ? `${et?.aps?.name ?? 'APS'} ${e.aps.left}/${e.aps.charges}` : '', e.decoys ? `flares/chaff ${e.decoys.left}/${e.decoys.salvos}` : ''].filter(Boolean).join(' · '));
      if (et?.gnss || et?.unmanned) set('nav', e.gnss === 'denied' ? `inertial, error ~${e.navError ?? 0} m` : e.gnss === 'spoofed' ? `spoofed, ${e.navError ?? 0} m off` : 'GNSS');
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
    } else if (u?.aggregate) {
      const a = u.aggregate;
      set('grid', fmtGrid(u.x, u.y));
      set('strength', `${a.alive}/${a.total} (aggregated)`);
      set('leader', '—');
      set(
        'activity',
        [a.contactAge !== undefined ? '' : 'AGGREGATED', u.moraleState === 'broken' ? 'BROKEN' : '', u.withdrawn ? 'WITHDRAWING' : '', this.pendingOrderText(u.id), a.engagingId ? `ENGAGING ${this.unit(a.engagingId)?.name ?? a.engagingId}` : '', u.plan, u.plan && u.task && u.plan.endsWith(u.task) ? '' : u.task, this.travelText(u.travel)]
          .filter(Boolean)
          .join(' — ') || (a.alive ? a.posture : 'destroyed'),
      );
      set('morale', moraleText(u.morale, u.moraleState));
      syncReactions(u.reactions);
      set('members', this.aggregateMembers(a));
      const btn = el.querySelector<HTMLButtonElement>(`[data-bind-aggregate="${u.id}"]`);
      if (btn) btn.textContent = 'Disaggregate';
    } else if (u) {
      const lead = this.entity(u.leaderId);
      set('grid', fmtGrid(u.x, u.y));
      const members = u.memberIds.map((m) => this.entity(m)).filter((m): m is EntitySnapshot => !!m);
      syncLink(members);
      const alive = members.filter((m) => m.damage !== 'destroyed');
      set('strength', `${alive.length}/${members.length}`);
      set('leader', lead?.name ?? '—');
      const btn = el.querySelector<HTMLButtonElement>(`[data-bind-aggregate="${u.id}"]`);
      if (btn) btn.textContent = 'Aggregate';
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
          alive.some((m) => m.link && !m.link.up) ? `DATALINK LOST ${alive.filter((m) => m.link && !m.link.up).length}/${alive.length}` : '',
          u.plan,
          u.plan && u.task && u.plan.endsWith(u.task) ? '' : u.task,
          this.travelText(u.travel),
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

/** What a jammer jams, in words. */
function jamBands(j: NonNullable<EntityTypeDef['jammer']>): string {
  const bands = [j.radio ? 'radios' : '', j.radar ? 'radars' : '', j.datalink ? 'drone datalinks' : '', j.gnss ? (j.spoof ? 'GNSS (spoofing)' : 'GNSS') : ''].filter(Boolean);
  return bands.length > 1 ? `${bands.slice(0, -1).join(', ')} and ${bands[bands.length - 1]}` : bands[0] ?? 'nothing';
}
