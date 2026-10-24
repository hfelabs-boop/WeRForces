// WeRForces front-end: scenario editor, tasking and monitoring GUI.

import { LocalFrame } from '../src/dis/geodesy.js';
import { TerrainGrid } from '../src/shared/terrainGrid.js';
import type {
  Catalog,
  Command,
  CommandResult,
  EntitySnapshot,
  EntityTypeDef,
  ForceId,
  Formation,
  Graphic,
  GraphicKind,
  Plan,
  PlanStatement,
  Roe,
  SimEvent,
  SimState,
  TaskSpec,
  UnitSnapshot,
  UnitTemplate,
  Vec2,
} from '../src/shared/types.js';
import { FORCE_NAMES } from '../src/shared/types.js';
import { Api } from './api.js';
import { $, clear, fmtDeg, fmtGrid, fmtLatLon, fmtTime, h } from './dom.js';
import { MapView } from './map.js';
import { symbolCanvas } from './symbols.js';

const ROE_LABELS: Record<Roe, string> = { fireAtWill: 'Fire at will', returnFire: 'Return fire', holdFire: 'Hold fire' };
const FORMATIONS: Formation[] = ['column', 'line', 'wedge', 'vee', 'echelonRight'];
const DOMAIN_LABELS: Record<string, string> = { ground: 'Ground vehicles', lifeform: 'Dismounted', air: 'Aircraft', surface: 'Surface vessels' };
const FORCE_PREFIX: Record<number, string> = { 1: 'us-', 2: 'ru-', 3: 'civ-' };
const LOG_LIMIT = 600;

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
  | 'waitFire';

class App {
  readonly api: Api;
  readonly map: MapView;
  catalog: Catalog | null = null;
  types = new Map<string, EntityTypeDef>();
  state: SimState | null = null;
  frame: LocalFrame | null = null;
  grid: TerrainGrid | null = null;
  terrainVersion = -1;
  selectedId: string | null = null;
  force: ForceId = 1;
  armed: string | null = null;
  events: SimEvent[] = [];
  planDrafts = new Map<string, Plan>();
  private inspectorFor: string | null = null;
  private treeSignature = '';
  private lastTree = 0;
  private logFilter = new Set<string>();

  constructor() {
    this.api = new Api({
      hello: (catalog, version) => this.onHello(catalog, version),
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
      contextMenu: (w, c, hit) => this.contextMenu(w, c, hit),
      hover: (w) => this.hover(w),
      dragEntity: (id, w) => this.cmd({ cmd: 'moveEntity', id, x: w.x, y: w.y }),
      modeChanged: (m) => {
        if (m.kind !== 'place') this.disarm();
      },
    });
    this.bindToolbar();
    this.bindLeft();
    this.bindLog();
    setInterval(() => this.refreshPath(), 1000);
    this.api.connect();
  }

  // ------------------------------------------------------------ server messages

  private onHello(catalog: Catalog, terrainVersion: number): void {
    this.catalog = catalog;
    this.types = new Map(catalog.entityTypes.map((t) => [t.id, t]));
    this.renderPalette();
    if (terrainVersion !== this.terrainVersion) this.loadTerrain(terrainVersion);
  }

  private async loadTerrain(version: number): Promise<void> {
    this.terrainVersion = version;
    const data = await this.api.terrain();
    this.grid = TerrainGrid.fromData(data);
    this.frame = new LocalFrame(data.spec.origin.lat, data.spec.origin.lon);
    this.map.setTerrain(data);
  }

  private onState(s: SimState): void {
    this.state = s;
    this.map.setState(s);
    $('#sim-time').textContent = fmtTime(s.time);
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
    if (this.selectedId && !this.exists(this.selectedId)) this.select(null);
    this.updateInspector();
    const now = performance.now();
    if (now - this.lastTree > 500) {
      this.lastTree = now;
      this.renderTree();
    }
  }

  private onEvents(evs: SimEvent[]): void {
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
    document.addEventListener('click', () => {
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
    $('#btn-step').addEventListener('click', () => this.cmd({ cmd: 'step', seconds: 1 }));
    $('#btn-rewind').addEventListener('click', () => {
      if (confirm('Rewind to the start of the scenario? Changes since it was loaded will be lost.')) this.cmd({ cmd: 'rewind' });
    });
    ($('#sel-speed') as HTMLSelectElement).addEventListener('change', (e) => this.cmd({ cmd: 'setTimeScale', scale: Number((e.target as HTMLSelectElement).value) }));
    document.querySelectorAll<HTMLButtonElement>('#draw-tools button').forEach((b) =>
      b.addEventListener('click', () => this.startDraw(b.dataset.draw as GraphicKind)),
    );
    document.querySelectorAll<HTMLInputElement>('[data-layer]').forEach((cb) =>
      cb.addEventListener('change', () => {
        (this.map.layers as unknown as Record<string, boolean>)[cb.dataset.layer!] = cb.checked;
        this.map.invalidate();
      }),
    );
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
      if (e.key === 'f' && this.selectedId) this.centerOn(this.selectedId);
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

  private modal(content: HTMLElement): () => void {
    const m = $('#modal');
    const body = $('#modal-body');
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

  private newScenarioDialog(): void {
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
        h('div', { class: 'kv' }, 'Name', name, 'Keep terrain', h('label', {}, keep, ' use current terrain'), 'Terrain seed', seed, 'Extent', size, 'Water %', water, 'Forest %', forest),
        h(
          'div',
          { class: 'row' },
          h('button', {
            class: 'primary',
            text: 'Create',
            onclick: async () => {
              close();
              const terrain = keep.checked
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
    const prefix = FORCE_PREFIX[this.force];
    const matches = (name: string, id: string) => (!filter || name.toLowerCase().includes(filter)) && (!prefix || id.startsWith(prefix) || filter.length > 0);
    const templates = this.catalog.unitTemplates.filter((u) => matches(u.name, u.id));
    if (templates.length) {
      el.append(
        h(
          'div',
          { class: 'palette-group' },
          h('h4', { text: 'Units' }),
          templates.map((u) => {
            const lead = this.types.get(u.members[0])!;
            return this.paletteItem(`unit:${u.id}`, symbolCanvas(this.force, lead.domain, lead.symbol, 26, u.echelon), u.name, `${u.members.length}× ${lead.name}`);
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
          types.map((t) => this.paletteItem(`type:${t.id}`, symbolCanvas(this.force, t.domain, t.symbol, 26), t.name, t.description)),
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
      st.units.map((u) => u.id + u.name + u.memberIds.join()).join() +
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
      for (const u of units) {
        const members = u.memberIds.map((id) => this.entity(id)).filter((e): e is EntitySnapshot => !!e);
        if (!match(u.name) && !members.some((m) => match(m.name))) continue;
        const lead = members[0];
        el.append(item(u.id, `${u.name}`, lead ? symbolCanvas(f, lead.domain, lead.symbol, 18, u.echelon) : null));
        el.append(h('div', { class: 'tree-children' }, members.filter((m) => match(m.name) || match(u.name)).map((m) => item(m.id, m.name, symbolCanvas(f, m.domain, m.symbol, 16), m.damage === 'destroyed'))));
      }
      for (const e of loose) {
        if (!match(e.name)) continue;
        el.append(item(e.id, `${e.name}${e.remote ? ' (remote)' : ''}`, symbolCanvas(f, e.domain, e.symbol, 16), e.damage === 'destroyed'));
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
    this.selectedId = id;
    this.map.selectedId = id;
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

    if (selTaskable && hit !== sel) {
      items.push(h('div', { class: 'title', text: selName ?? '' }));
      if (hitEntity && hit) {
        const selForce = this.entity(sel)?.force ?? this.unit(sel)?.force;
        if (hitEntity.force !== selForce && hitEntity.damage !== 'destroyed') add(`Attack ${hitEntity.name}`, () => this.task(sel, { type: 'attack', targetId: hitEntity.id }));
        add(`Follow ${hitEntity.name}`, () => this.task(sel, { type: 'follow', targetId: hitEntity.id }));
      } else if (hitGraphic && (hitGraphic.kind === 'route' || hitGraphic.kind === 'phaseLine')) {
        add(`Follow route ${hitGraphic.name}`, () => this.task(sel, { type: 'followRoute', routeId: hitGraphic.id }));
        add(`Patrol route ${hitGraphic.name}`, () => this.task(sel, { type: 'patrol', routeId: hitGraphic.id }));
      } else {
        add('Move here', () => this.task(sel, { type: 'moveTo', target: world }));
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
    const id = this.selectedId;
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
      if (e) this.buildEntityInspector(el, e);
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
      this.nameEditor(e.id, e.name, symbolCanvas(e.force, e.domain, e.symbol, 24)),
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
      this.taskSection(e.id, e.domain),
      this.planSection(e.id, false),
      h('div', { class: 'section' }, h('h4', { text: 'Weapons' }), h('div', { 'data-bind': 'weapons' })),
      h('div', { class: 'section' }, h('h4', { text: 'Sensors' }), h('div', { class: 'hint', text: (t?.sensors ?? []).map((s) => this.catalog?.sensors.find((x) => x.id === s)?.name ?? s).join(', ') || 'none' })),
      h('div', { class: 'section' }, h('h4', { text: 'Contacts' }), h('div', { 'data-bind': 'contacts' })),
      h('div', { class: 'section row' }, h('button', { text: 'Center', onclick: () => this.centerOn(e.id) }), h('button', { class: 'danger', text: 'Delete', onclick: () => this.deleteSelected() })),
    );
  }

  private buildUnitInspector(el: HTMLElement, u: UnitSnapshot): void {
    const lead = this.entity(u.leaderId) ?? this.entity(u.memberIds[0]);
    const formation = h('select', { onchange: (ev: Event) => this.cmd({ cmd: 'setFormation', unitId: u.id, formation: (ev.target as HTMLSelectElement).value as Formation }) }, FORMATIONS.map((f) => h('option', { value: f, text: f, selected: f === u.formation })));
    el.append(
      this.nameEditor(u.id, u.name, lead ? symbolCanvas(u.force, lead.domain, lead.symbol, 24, u.echelon) : null),
      h('div', { class: 'sub', text: `${u.echelon} · ${FORCE_NAMES[u.force]} · ${u.id}` }),
      h('div', { class: 'kv' }, 'Grid', this.bind('grid'), 'Strength', this.bind('strength'), 'Leader', this.bind('leader'), 'Formation', formation),
      h('div', { class: 'section' }, h('h4', { text: 'Current activity' }), h('div', { class: 'status-line', 'data-bind': 'activity' })),
      this.roeSection(u.id),
      this.taskSection(u.id, lead?.domain ?? 'ground'),
      this.planSection(u.id, true),
      h('div', { class: 'section' }, h('h4', { text: 'Members' }), h('div', { 'data-bind': 'members' })),
      h('div', { class: 'section row' }, h('button', { text: 'Center', onclick: () => this.centerOn(u.id) }), h('button', { class: 'danger', text: 'Delete unit', onclick: () => this.deleteSelected() })),
    );
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
      h('p', { class: 'hint', text: g.kind === 'route' || g.kind === 'phaseLine' ? 'Select an entity or unit, then right-click this route to follow or patrol it.' : g.kind === 'area' ? 'Areas can be used in plans: "wait until in area".' : '' }),
      h('div', { class: 'section row' }, h('button', { text: 'Center', onclick: () => this.centerOn(g.id) }), h('button', { class: 'danger', text: 'Delete', onclick: () => this.deleteSelected() })),
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
        return `Wait until ${name(c.entityId)} destroyed`;
      }
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
      } else if (k === 'waitArea') {
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
      } else if (['wait', 'setSpeed', 'setAltitude', 'waitTime', 'orbit'].includes(k)) {
        const defaults: Record<string, string> = { wait: '60', setSpeed: '30', setAltitude: '150', waitTime: String(Math.round((this.state?.time ?? 0) + 120)), orbit: '2000' };
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
        }
      },
    });
    const plan = this.draft(id);
    const loop = h('input', { type: 'checkbox', checked: !!plan.loop, onchange: (ev: Event) => (plan.loop = (ev.target as HTMLInputElement).checked) });
    return h(
      'div',
      { class: 'section' },
      h('h4', { text: 'Plan editor' }),
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
      set('activity', [e.plan, e.task].filter(Boolean).join(' — ') || (e.damage === 'destroyed' ? 'destroyed' : 'idle'));
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
                return h('div', { class: 'tree-item', onclick: () => this.select(cid) }, c ? symbolCanvas(c.force, c.domain, c.symbol, 14) : null, `${c?.name ?? cid}${cid === e.engagingId ? '  ◎ engaging' : ''}${c ? ` · ${(Math.hypot(c.x - e.x, c.y - e.y) / 1000).toFixed(1)} km` : ''}`);
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
      set('activity', [u.plan, u.task].filter(Boolean).join(' — ') || 'idle (in formation)');
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
              symbolCanvas(m.force, m.domain, m.symbol, 14),
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
