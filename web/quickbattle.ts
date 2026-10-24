// Quick battle: pick a mission and the two forces, and get a ready-to-run scenario.

import { clear, h } from './dom.js';

export interface QuickBattleHost {
  v1<T>(method: string, path: string, body?: unknown): Promise<T>;
  modal(content: HTMLElement): () => void;
  toast(msg: string, info?: boolean): void;
  /** Called with the brief once the battle is built. */
  built(brief: { name: string; description: string; seed: number }): void;
  hasDataset(): string | undefined;
}

interface Choices {
  missions: { id: string; text: string }[];
  compositions: string[];
  sizes: string[];
  support: string[];
  weather: string[];
  nations: string[];
}

const NAMES: Record<string, string> = {
  armor: 'Armor',
  mech: 'Mechanised',
  infantry: 'Infantry',
  combined: 'Combined arms',
  platoon: 'Platoon',
  company: 'Company',
  artillery: 'Artillery',
  recon: 'Scouts',
  engineers: 'Engineers',
  supply: 'Supply',
  air: 'Attack helicopters',
  airDefense: 'Air defence',
  clear: 'Clear',
  haze: 'Haze',
  fog: 'Fog',
  rain: 'Rain',
  us: 'US',
  ru: 'RU',
};

const TIMES: [string, number][] = [
  ['Dawn 06:00', 6],
  ['Day 10:00', 10],
  ['Dusk 19:00', 19],
  ['Night 01:00', 1],
];

function select(options: string[], value: string): HTMLSelectElement {
  return h('select', {}, options.map((o) => h('option', { value: o, text: NAMES[o] ?? o, selected: o === value }))) as HTMLSelectElement;
}

export class QuickBattleDialog {
  constructor(private readonly host: QuickBattleHost) {}

  async open(): Promise<void> {
    const c = await this.host.v1<Choices>('GET', '/scenario/quick-battle').catch(() => null);
    if (!c) return this.host.toast('Quick battles are not available here');
    const mission = h('div', { class: 'qb-missions' }) as HTMLElement;
    let missionId = 'attack';
    const drawMissions = () => {
      clear(mission);
      for (const m of c.missions) {
        mission.append(
          h('button', { class: `qb-mission${m.id === missionId ? ' selected' : ''}`, 'data-mission': m.id, onclick: () => ((missionId = m.id), drawMissions()) }, h('strong', { text: m.id[0].toUpperCase() + m.id.slice(1) }), h('span', { text: m.text })),
        );
      }
    };
    drawMissions();
    const side = (force: 'blue' | 'red', nation: string, composition: string) => {
      const n = select(c.nations, nation);
      const comp = select(c.compositions, composition);
      const size = select(c.sizes, 'platoon');
      const support = c.support.map((s) => ({ s, box: h('input', { type: 'checkbox', checked: force === 'blue' ? s === 'artillery' || s === 'recon' : s === 'engineers' }) as HTMLInputElement }));
      const el = h(
        'div',
        { class: `qb-side qb-${force}` },
        h('h4', { text: force === 'blue' ? 'Blue' : 'Red' }),
        h('div', { class: 'kv' }, 'Nation', n, 'Force', comp, 'Size', size),
        h('div', { class: 'qb-support' }, support.map(({ s, box }) => h('label', {}, box, ` ${NAMES[s] ?? s}`))),
      );
      return { el, value: () => ({ nation: n.value, composition: comp.value, size: size.value, support: support.filter((x) => x.box.checked).map((x) => x.s) }) };
    };
    const blue = side('blue', 'us', 'combined');
    const red = side('red', 'ru', 'mech');
    const time = h('select', {}, TIMES.map(([label, t]) => h('option', { value: String(t), text: label, selected: t === 10 }))) as HTMLSelectElement;
    const weather = select(c.weather, 'clear');
    const distance = h('select', {}, h('option', { value: '', text: 'Automatic', selected: true }), [2000, 3000, 5000, 8000].map((d) => h('option', { value: String(d), text: `${d / 1000} km` }))) as HTMLSelectElement;
    const civilians = h('input', { type: 'checkbox' }) as HTMLInputElement;
    const terrain = h('select', {}, h('option', { value: 'current', text: this.host.hasDataset() ? `Current (${this.host.hasDataset()})` : 'Current terrain' }), h('option', { value: 'new', text: 'New generated terrain' })) as HTMLSelectElement;
    const seed = h('input', { type: 'number', placeholder: 'random' }) as HTMLInputElement;
    const status = h('p', { class: 'hint' }) as HTMLElement;
    let close = () => {};
    const build = async () => {
      status.textContent = 'Building…';
      const body: Record<string, unknown> = {
        mission: missionId,
        blue: blue.value(),
        red: red.value(),
        time: Number(time.value),
        weather: weather.value,
        civilians: civilians.checked,
      };
      if (distance.value) body.distance = Number(distance.value);
      if (seed.value) body.seed = Number(seed.value);
      if (terrain.value === 'new') body.terrain = { seed: Math.floor(Math.random() * 100000), size: 16000 };
      try {
        const r = await this.host.v1<{ scenario: string; description: string; seed: number }>('POST', '/scenario/quick-battle', body);
        close();
        this.host.built({ name: r.scenario, description: r.description, seed: r.seed });
      } catch (err) {
        status.textContent = (err as Error).message;
      }
    };
    close = this.host.modal(
      h(
        'div',
        { class: 'quick-battle' },
        h('h3', { text: 'Quick battle' }),
        h('p', { class: 'hint', text: 'Pick a mission and the two forces. Both are placed on land either side of an objective, with the graphics and a phase plan for each side; start the clock to fight it.' }),
        mission,
        h('div', { class: 'qb-sides' }, blue.el, red.el),
        h('div', { class: 'kv' }, 'Time', time, 'Weather', weather, 'Distance', distance, 'Terrain', terrain, 'Civilians', h('label', {}, civilians, ' traffic and people in the towns'), 'Seed', seed),
        status,
        h('div', { class: 'row' }, h('button', { class: 'primary', text: 'Build battle', onclick: () => void build() }), h('button', { text: 'Cancel', onclick: () => close() })),
      ),
    );
    mission.closest('.modal-body')?.classList.add('wide');
  }
}
