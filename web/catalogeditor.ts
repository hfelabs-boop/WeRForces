// The catalog editor: browse entity types, weapons, sensors and unit templates, and make
// variants or new ones with a form (or as JSON). Entries saved here belong to the scenario.

import type { Catalog } from '../src/shared/types.js';
import { clear, h } from './dom.js';

type Section = 'entityTypes' | 'weapons' | 'sensors' | 'unitTemplates';
const PATH: Record<Section, string> = { entityTypes: 'entity-types', weapons: 'weapons', sensors: 'sensors', unitTemplates: 'unit-templates' };
const TITLE: Record<Section, string> = { entityTypes: 'Entity types', weapons: 'Weapons', sensors: 'Sensors', unitTemplates: 'Unit templates' };

const DOMAINS = ['ground', 'lifeform', 'air', 'surface'];
const ARMOR = ['lifeform', 'soft', 'light', 'armored', 'air', 'ship', 'drone'];
const SYMBOLS = ['armor', 'mech', 'infantry', 'recon', 'wheeled', 'air-defense', 'artillery', 'engineer', 'supply', 'ew', 'rotary', 'fixed-wing', 'uav', 'ugv', 'legged', 'ship', 'boat', 'generic'];

interface Field {
  key: string;
  label: string;
  kind: 'text' | 'number' | 'bool' | 'enum' | 'multi' | 'list' | 'deg' | 'kmh';
  options?: () => string[];
  hint?: string;
}

export interface CatalogEditorHost {
  catalog(): Catalog | null;
  v1<T>(method: string, path: string, body?: unknown): Promise<T>;
  modal(content: HTMLElement): () => void;
  toast(msg: string, info?: boolean): void;
}

function get(o: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined), o);
}

function set(o: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.');
  const parents: Record<string, unknown>[] = [o];
  let cur = o;
  for (const k of keys.slice(0, -1)) {
    if (!cur[k] || typeof cur[k] !== 'object') cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
    parents.push(cur);
  }
  const last = keys[keys.length - 1];
  if (value === undefined || value === '') delete cur[last];
  else cur[last] = value;
  // Drop nested objects left empty (e.g. no jammer any more).
  for (let i = keys.length - 1; i > 0; i--) {
    if (Object.keys(parents[i]).length) break;
    delete parents[i - 1][keys[i - 1]];
  }
}

export class CatalogEditor {
  constructor(private readonly host: CatalogEditorHost) {}

  private fields(section: Section): Field[] {
    const cat = () => this.host.catalog();
    switch (section) {
      case 'entityTypes':
        return [
          { key: 'name', label: 'Name', kind: 'text' },
          { key: 'description', label: 'Description', kind: 'text' },
          { key: 'domain', label: 'Domain', kind: 'enum', options: () => DOMAINS },
          { key: 'symbol', label: 'Symbol', kind: 'enum', options: () => SYMBOLS },
          { key: 'armor', label: 'Armour class', kind: 'enum', options: () => ARMOR },
          ...(['front', 'side', 'rear', 'top'] as const).map((a) => ({ key: `protection.${a}`, label: `Armour ${a} (mm RHA)`, kind: 'number' as const, hint: 'Set all four, or none' })),
          { key: 'rcs', label: 'Radar cross-section (m²)', kind: 'number' },
          { key: 'maxSpeed', label: 'Top speed (km/h)', kind: 'kmh' },
          { key: 'cruiseSpeed', label: 'Cruise speed (km/h)', kind: 'kmh' },
          { key: 'acceleration', label: 'Acceleration (m/s²)', kind: 'number' },
          { key: 'turnRate', label: 'Turn rate (°/s)', kind: 'deg' },
          { key: 'offroadFactor', label: 'Off-road factor (0-1)', kind: 'number' },
          { key: 'sensorHeight', label: 'Eye height (m)', kind: 'number' },
          { key: 'weapons', label: 'Weapons', kind: 'multi', options: () => cat()?.weapons.map((w) => w.id) ?? [] },
          { key: 'sensors', label: 'Sensors', kind: 'multi', options: () => cat()?.sensors.map((s) => s.id) ?? [] },
          { key: 'crew', label: 'Crew', kind: 'number' },
          { key: 'capacity', label: 'Passenger seats', kind: 'number' },
          { key: 'smokeGrenades', label: 'Smoke grenade salvos', kind: 'number' },
          { key: 'breachTime', label: 'Breach time (s), engineers', kind: 'number' },
          { key: 'endurance.km', label: 'Range on a tank (km)', kind: 'number' },
          { key: 'endurance.hours', label: 'Endurance (h), aircraft', kind: 'number' },
          { key: 'supply.capacity', label: 'Supply loads carried', kind: 'number' },
          { key: 'jammer.range', label: 'Jammer reach (m)', kind: 'number' },
          { key: 'jammer.radio', label: 'Jams radios', kind: 'bool' },
          { key: 'jammer.radar', label: 'Jams radars', kind: 'bool' },
          { key: 'jammer.spoof', label: 'Spoofs GNSS (with GNSS jamming)', kind: 'bool' },
          { key: 'aps.name', label: 'Active protection: name', kind: 'text' },
          { key: 'aps.charges', label: 'Active protection: charges', kind: 'number' },
          { key: 'aps.pk', label: 'Active protection: chance to defeat (0-1)', kind: 'number' },
          { key: 'aps.arc', label: 'Active protection: arc (°, about the front)', kind: 'number', hint: '360 all round' },
          { key: 'aps.top', label: 'Active protection: also against top attack', kind: 'bool' },
          { key: 'decoys.salvos', label: 'Flare/chaff salvos, aircraft', kind: 'number' },
          { key: 'decoys.pkFactor', label: 'Flares/chaff: missile kill chance × (0-1)', kind: 'number' },
          { key: 'insDrift', label: 'Inertial drift without GNSS (m/s)', kind: 'number', hint: 'GNSS navigators; default 1' },
          { key: 'cruiseAltitude', label: 'Cruise altitude (m), aircraft', kind: 'number' },
          { key: 'minSpeed', label: 'Stall speed (km/h), aircraft', kind: 'kmh' },
          { key: 'sidc', label: 'MIL-STD-2525C code (optional)', kind: 'text' },
        ];
      case 'weapons':
        return [
          { key: 'name', label: 'Name', kind: 'text' },
          { key: 'minRange', label: 'Minimum range (m)', kind: 'number' },
          { key: 'maxRange', label: 'Maximum range (m)', kind: 'number' },
          { key: 'reloadTime', label: 'Seconds between shots', kind: 'number' },
          { key: 'ammo', label: 'Rounds carried', kind: 'number' },
          { key: 'projectileSpeed', label: 'Projectile speed (m/s)', kind: 'number' },
          { key: 'targets', label: 'Engages', kind: 'multi', options: () => DOMAINS },
          ...ARMOR.map((a) => ({ key: `pk.${a}`, label: `Kill chance: ${a}`, kind: 'number' as const, hint: '0-1 per shot at short range' })),
          { key: 'guided', label: 'Guided', kind: 'bool' },
          { key: 'commandGuided', label: 'Command-guided (SACLOS)', kind: 'bool' },
          { key: 'indirect', label: 'Indirect fire (artillery)', kind: 'bool' },
          { key: 'blastRadius', label: 'Blast radius (m)', kind: 'number' },
          { key: 'dispersion', label: 'Dispersion at max range (m)', kind: 'number' },
          { key: 'penetration', label: 'Penetration (mm RHA)', kind: 'number', hint: 'Set against the armour of the face hit' },
          { key: 'topAttack', label: 'Top attack', kind: 'bool' },
          { key: 'spreadMrad', label: 'Spread (mrad), unguided', kind: 'number', hint: 'Turns on gravity drop and spread with range' },
          { key: 'rangeError', label: 'Range estimate error (0-1)', kind: 'number', hint: '0.01 laser rangefinder, 0.1 by eye' },
          { key: 'gnss', label: 'GNSS-guided', kind: 'bool', hint: 'Misses by more under GNSS jamming' },
          { key: 'antiRadiation', label: 'Anti-radiation (homes on radars and jammers)', kind: 'bool' },
          { key: 'smoke.radius', label: 'Smoke cloud radius (m)', kind: 'number' },
          { key: 'smoke.duration', label: 'Smoke duration (s)', kind: 'number' },
        ];
      case 'sensors':
        return [
          { key: 'name', label: 'Name', kind: 'text' },
          { key: 'maxRange', label: 'Range (m)', kind: 'number' },
          { key: 'fov', label: 'Field of view (°)', kind: 'deg' },
          { key: 'detects', label: 'Detects', kind: 'multi', options: () => DOMAINS },
          { key: 'radar', label: 'Radar', kind: 'bool' },
          { key: 'refRange', label: 'Radar: range (m) against reference RCS', kind: 'number', hint: 'Range scales with RCS^¼, up to the range above' },
          { key: 'refRcs', label: 'Radar: reference RCS (m²)', kind: 'number' },
          { key: 'thermal', label: 'Thermal', kind: 'bool' },
          { key: 'nightVision', label: 'Night vision', kind: 'bool' },
          { key: 'df.bearingError', label: 'Direction finder: bearing error (rad)', kind: 'number', hint: 'Takes bearings to enemy emitters instead of seeing; 0.035 is 2°' },
        ];
      case 'unitTemplates':
        return [
          { key: 'name', label: 'Name', kind: 'text' },
          { key: 'echelon', label: 'Echelon', kind: 'enum', options: () => ['team', 'section', 'platoon', 'company', 'flight', 'group'] },
          { key: 'members', label: 'Members (type ids, leader first)', kind: 'list' },
          { key: 'formation', label: 'Formation', kind: 'enum', options: () => ['column', 'line', 'wedge', 'vee', 'echelonRight'] },
          { key: 'spacing', label: 'Spacing (m)', kind: 'number' },
          { key: 'subunits', label: 'Subordinate templates', kind: 'list' },
        ];
    }
  }

  async open(): Promise<void> {
    let section: Section = 'entityTypes';
    let custom = await this.host.v1<Partial<Catalog>>('GET', '/catalog/custom').catch(() => ({}) as Partial<Catalog>);
    let draft: Record<string, unknown> | null = null;
    let original = '';
    let asJson = false;
    const list = h('div', { class: 'catalog-list' });
    const form = h('div', { class: 'catalog-form' });
    const filter = h('input', { type: 'text', placeholder: 'Filter…' }) as HTMLInputElement;
    const tabs = h('div', { class: 'seg' });
    const isCustom = (id: string) => ((custom[section] ?? []) as { id: string }[]).some((x) => x.id === id);

    const renderList = () => {
      clear(tabs);
      for (const s of Object.keys(TITLE) as Section[]) {
        tabs.append(h('button', { class: s === section ? 'active' : '', text: TITLE[s], onclick: () => ((section = s), (draft = null), renderList(), renderForm()) }));
      }
      clear(list);
      const items = (this.host.catalog()?.[section] ?? []) as { id: string; name: string }[];
      const f = filter.value.toLowerCase();
      for (const it of items.filter((x) => !f || x.id.includes(f) || x.name.toLowerCase().includes(f))) {
        list.append(
          h(
            'div',
            { class: `catalog-item${draft && draft.id === it.id ? ' selected' : ''}`, onclick: () => ((draft = JSON.parse(JSON.stringify(it))), (original = it.id), renderList(), renderForm()) },
            h('span', { text: it.name }),
            h('small', { text: `${it.id}${isCustom(it.id) ? ' · custom' : ''}` }),
          ),
        );
      }
    };

    const renderForm = () => {
      clear(form);
      if (!draft) {
        form.append(h('p', { class: 'hint', text: 'Pick an entry to see it, change it, or start a new one from it. Changes belong to this scenario (saved with it); entities already on the map keep their old definition.' }));
        return;
      }
      const d = draft;
      const idInput = h('input', { type: 'text', value: String(d.id ?? ''), oninput: (e: Event) => (d.id = (e.target as HTMLInputElement).value.trim()) }) as HTMLInputElement;
      form.append(h('div', { class: 'row' }, h('strong', { text: 'id' }), idInput, h('button', { text: 'Copy as new', title: 'Start a new entry from this one', onclick: () => ((d.id = `${String(d.id)}-2`), (d.name = `${String(d.name)} (variant)`), renderForm()) })));
      if (asJson) {
        const ta = h('textarea', { class: 'catalog-json', spellcheck: 'false' }) as HTMLTextAreaElement;
        ta.value = JSON.stringify(d, null, 2);
        ta.addEventListener('change', () => {
          try {
            draft = JSON.parse(ta.value);
          } catch {
            this.host.toast('Not valid JSON');
          }
        });
        form.append(ta);
      } else {
        const grid = h('div', { class: 'catalog-grid' });
        for (const f of this.fields(section)) {
          const v = get(d, f.key);
          let input: HTMLElement;
          switch (f.kind) {
            case 'bool': {
              const cb = h('input', { type: 'checkbox', checked: !!v }) as HTMLInputElement;
              cb.addEventListener('change', () => set(d, f.key, cb.checked || undefined));
              input = cb;
              break;
            }
            case 'enum': {
              const s = h('select', {}, ...f.options!().map((o) => h('option', { value: o, text: o, selected: o === v }))) as HTMLSelectElement;
              s.addEventListener('change', () => set(d, f.key, s.value));
              input = s;
              break;
            }
            case 'multi': {
              const s = h('select', { multiple: true, size: '4' }, ...f.options!().map((o) => h('option', { value: o, text: o, selected: Array.isArray(v) && v.includes(o) }))) as HTMLSelectElement;
              s.addEventListener('change', () => set(d, f.key, [...s.selectedOptions].map((o) => o.value)));
              input = s;
              break;
            }
            case 'list': {
              const t = h('input', { type: 'text', value: Array.isArray(v) ? v.join(', ') : '' }) as HTMLInputElement;
              t.addEventListener('change', () => set(d, f.key, t.value.split(',').map((x) => x.trim()).filter(Boolean)));
              input = t;
              break;
            }
            case 'number':
            case 'deg':
            case 'kmh': {
              const shown = typeof v === 'number' ? (f.kind === 'deg' ? (v * 180) / Math.PI : f.kind === 'kmh' ? v * 3.6 : v) : '';
              const n = h('input', { type: 'number', step: 'any', value: shown === '' ? '' : String(Math.round(Number(shown) * 1000) / 1000) }) as HTMLInputElement;
              n.addEventListener('change', () => {
                if (n.value === '') return set(d, f.key, undefined);
                const x = Number(n.value);
                set(d, f.key, f.kind === 'deg' ? (x * Math.PI) / 180 : f.kind === 'kmh' ? x / 3.6 : x);
              });
              input = n;
              break;
            }
            default: {
              const t = h('input', { type: 'text', value: v === undefined ? '' : String(v) }) as HTMLInputElement;
              t.addEventListener('change', () => set(d, f.key, t.value.trim() || undefined));
              input = t;
            }
          }
          grid.append(h('label', { text: f.label, title: f.hint ?? '' }), input);
        }
        form.append(grid);
      }
      form.append(
        h(
          'div',
          { class: 'row' },
          h('button', { class: 'primary', text: 'Save', onclick: () => void save() }),
          h('button', { text: asJson ? 'Form' : 'JSON', title: 'Edit every field as JSON', onclick: () => ((asJson = !asJson), renderForm()) }),
          isCustom(String(d.id)) ? h('button', { class: 'danger', text: 'Remove custom entry', onclick: () => void remove(String(d.id)) }) : null,
        ),
      );
    };

    const refresh = async () => {
      custom = await this.host.v1<Partial<Catalog>>('GET', '/catalog/custom').catch(() => custom);
      // Wait for the app to pick up the new catalog.
      await new Promise((r) => setTimeout(r, 400));
      renderList();
      renderForm();
    };

    const save = async () => {
      if (!draft) return;
      try {
        await this.host.v1('PUT', `/catalog/${PATH[section]}/${encodeURIComponent(String(draft.id))}`, draft);
        this.host.toast(`${String(draft.name)} saved${draft.id !== original ? ' as a new entry' : ''}`, true);
        original = String(draft.id);
        await refresh();
      } catch (err) {
        this.host.toast(err instanceof Error ? err.message : String(err));
      }
    };

    const remove = async (id: string) => {
      try {
        await this.host.v1('DELETE', `/catalog/${PATH[section]}/${encodeURIComponent(id)}`);
        this.host.toast(`${id} removed`, true);
        draft = null;
        await refresh();
      } catch (err) {
        this.host.toast(err instanceof Error ? err.message : String(err));
      }
    };

    const exportCustom = () => {
      const blob = new Blob([JSON.stringify(custom, null, 2)], { type: 'application/json' });
      const a = h('a', { href: URL.createObjectURL(blob), download: 'catalog-extension.json' }) as HTMLAnchorElement;
      a.click();
    };

    filter.addEventListener('input', renderList);
    const body = h(
      'div',
      { class: 'catalog-editor' },
      h('h3', { text: 'Catalog editor' }),
      tabs,
      h('div', { class: 'catalog-cols' }, h('div', {}, filter, list), form),
      h('div', { class: 'row' }, h('span', { class: 'spacer' }), h('button', { text: 'Export custom entries', title: 'Download them as a catalog extension (for --catalog)', onclick: exportCustom }), h('button', { text: 'Close', onclick: () => close() })),
    );
    renderList();
    renderForm();
    const close = this.host.modal(body);
    document.querySelector('#modal-body')?.classList.add('wide');
  }
}
