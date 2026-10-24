// The quick-task bar: one-click (or one-key) orders for the selection, configurable per
// viewer. Point orders ask for a click on the map, target orders for a click on an entity.

import type { Command, TaskSpec, Vec2 } from '../src/shared/types.js';
import { clear, h } from './dom.js';

export interface QuickHost {
  /** Selected things that take orders (one, or several). */
  targets(): string[];
  /** Order every target to a point; `line` spreads a group across the direction of the move. */
  orderAt(world: Vec2, make: (target: Vec2, facing: number) => TaskSpec, line: boolean): void;
  /** Order every target. */
  orderEach(make: (id: string) => Command | null): void;
  pickPoint(label: string, onPick: (p: Vec2) => void): void;
  pickEntity(label: string, onPick: (id: string) => void): void;
  can(id: string, what: 'indirect' | 'smoke' | 'air' | 'ground' | 'carrier' | 'breach'): boolean;
  toast(msg: string, info?: boolean): void;
}

interface QuickAction {
  id: string;
  label: string;
  title: string;
  /** Shown only when at least one target can do it. */
  applies?: (host: QuickHost, id: string) => boolean;
  run: (host: QuickHost) => void;
}

const task = (targetId: string, t: TaskSpec): Command => ({ cmd: 'assignTask', targetId, task: t });

export const QUICK_ACTIONS: QuickAction[] = [
  { id: 'move', label: 'Move', title: 'Move to a point (click the map)', run: (h) => h.pickPoint('Move: click the destination', (p) => h.orderAt(p, (t) => ({ type: 'moveTo', target: t }), false)) },
  {
    id: 'covered',
    label: 'Covered',
    title: 'Move by a covered route, out of known enemies\' sight',
    applies: (h, id) => h.can(id, 'ground'),
    run: (h) => h.pickPoint('Covered move: click the destination', (p) => h.orderAt(p, (t) => ({ type: 'moveTo', target: t, covered: true }), false)),
  },
  { id: 'attack', label: 'Attack', title: 'Attack an enemy (click it)', run: (h) => h.pickEntity('Attack: click the target', (target) => h.orderEach((id) => task(id, { type: 'attack', targetId: target }))) },
  { id: 'follow', label: 'Follow', title: 'Follow an entity (click it)', run: (h) => h.pickEntity('Follow: click who to follow', (target) => h.orderEach((id) => (id === target ? null : task(id, { type: 'follow', targetId: target })))) },
  {
    id: 'defend',
    label: 'Defend',
    title: 'Defend a position facing away from you (click it); units spread in a line and dig in',
    applies: (h, id) => h.can(id, 'ground'),
    run: (h) => h.pickPoint('Defend: click the position', (p) => h.orderAt(p, (t, f) => ({ type: 'defend', position: t, facing: f }), true)),
  },
  {
    id: 'overwatch',
    label: 'Overwatch',
    title: 'Overwatch from a position (click it)',
    applies: (h, id) => h.can(id, 'ground'),
    run: (h) => h.pickPoint('Overwatch: click the position', (p) => h.orderAt(p, (t, f) => ({ type: 'overwatch', position: t, facing: f }), true)),
  },
  {
    id: 'screen',
    label: 'Screen',
    title: 'Screen from a position: watch, fall back when the enemy closes in',
    applies: (h, id) => h.can(id, 'ground'),
    run: (h) => h.pickPoint('Screen: click the position', (p) => h.orderAt(p, (t, f) => ({ type: 'screen', position: t, facing: f }), true)),
  },
  {
    id: 'fire',
    label: 'Fire',
    title: 'Fire mission, 3 rounds (click the target point)',
    applies: (h, id) => h.can(id, 'indirect'),
    run: (h) => h.pickPoint('Fire mission: click the target', (p) => h.orderEach((id) => (h.can(id, 'indirect') ? task(id, { type: 'fireMission', target: round(p), rounds: 3, radius: id.startsWith('U') ? 50 : 0 }) : null))),
  },
  {
    id: 'smoke',
    label: 'Smoke',
    title: 'Smoke screen, 2 rounds (click where)',
    applies: (h, id) => h.can(id, 'smoke'),
    run: (h) => h.pickPoint('Smoke: click where', (p) => h.orderEach((id) => (h.can(id, 'smoke') ? task(id, { type: 'fireMission', target: round(p), rounds: 2, radius: id.startsWith('U') ? 60 : 0, smoke: true }) : null))),
  },
  {
    id: 'orbit',
    label: 'Orbit',
    title: 'Orbit a point at 2 km (aircraft)',
    applies: (h, id) => h.can(id, 'air'),
    run: (h) => h.pickPoint('Orbit: click the centre', (p) => h.orderEach((id) => (h.can(id, 'air') ? task(id, { type: 'orbit', center: round(p), radius: 2000 }) : null))),
  },
  { id: 'stop', label: 'Stop', title: 'Stop: clear tasks and plans', run: (h) => h.orderEach((id) => ({ cmd: 'stop', targetId: id })) },
  { id: 'holdFire', label: 'Hold fire', title: 'ROE: hold fire', run: (h) => h.orderEach((id) => ({ cmd: 'setRoe', targetId: id, roe: 'holdFire' })) },
  { id: 'returnFire', label: 'Return fire', title: 'ROE: return fire only', run: (h) => h.orderEach((id) => ({ cmd: 'setRoe', targetId: id, roe: 'returnFire' })) },
  { id: 'fireAtWill', label: 'Fire at will', title: 'ROE: fire at will', run: (h) => h.orderEach((id) => ({ cmd: 'setRoe', targetId: id, roe: 'fireAtWill' })) },
  { id: 'resupply', label: 'Resupply', title: 'Go to the nearest friendly supply vehicle to refuel and rearm', applies: (h, id) => h.can(id, 'ground'), run: (h) => h.orderEach((id) => task(id, { type: 'resupply' })) },
  { id: 'dismount', label: 'Dismount', title: 'Let the passengers out', applies: (h, id) => h.can(id, 'carrier'), run: (h) => h.orderEach((id) => (h.can(id, 'carrier') ? task(id, { type: 'dismount' }) : null)) },
];

export const DEFAULT_QUICK = ['move', 'covered', 'attack', 'defend', 'overwatch', 'fire', 'smoke', 'stop', 'holdFire', 'fireAtWill'];
const STORE = 'werforces.quickbar';
const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];

function round(p: Vec2): Vec2 {
  return { x: Math.round(p.x), y: Math.round(p.y) };
}

/** The bar's chosen actions, remembered in this browser (falls back to the defaults). */
function loadChoice(): string[] {
  try {
    const raw = localStorage.getItem(STORE);
    const ids = raw ? (JSON.parse(raw) as string[]) : null;
    if (Array.isArray(ids)) return ids.filter((id) => QUICK_ACTIONS.some((a) => a.id === id)).slice(0, KEYS.length);
  } catch {
    // Storage blocked: use the defaults.
  }
  return [...DEFAULT_QUICK];
}

function saveChoice(ids: string[]): void {
  try {
    localStorage.setItem(STORE, JSON.stringify(ids));
  } catch {
    // Not remembered; it still works for this visit.
  }
}

export class QuickBar {
  private choice = loadChoice();
  private shownFor = '';
  private visible: QuickAction[] = [];

  constructor(
    private readonly el: HTMLElement,
    private readonly host: QuickHost,
  ) {}

  /** Redraw for the current selection (cheap when nothing changed). */
  update(force = false): void {
    const targets = this.host.targets();
    const key = `${targets.join(',')}|${this.choice.join(',')}`;
    if (!force && key === this.shownFor) return;
    this.shownFor = key;
    clear(this.el);
    this.el.classList.toggle('hidden', targets.length === 0);
    if (!targets.length) return;
    const actions = this.choice.map((id) => QUICK_ACTIONS.find((a) => a.id === id)!).filter(Boolean);
    this.visible = actions;
    actions.forEach((a, i) => {
      const ok = !a.applies || targets.some((id) => a.applies!(this.host, id));
      const b = h('button', { class: 'quick', title: `${a.title} (${KEYS[i]})` }, h('kbd', { text: KEYS[i] }), a.label) as HTMLButtonElement;
      b.disabled = !ok;
      b.addEventListener('click', () => a.run(this.host));
      this.el.append(b);
    });
    this.el.append(h('button', { class: 'quick config', title: 'Choose the buttons', text: '⚙', onclick: () => this.configure() }));
  }

  /** A digit key: run that slot's action. Returns true when handled. */
  key(k: string): boolean {
    const i = KEYS.indexOf(k);
    if (i < 0 || !this.host.targets().length) return false;
    const a = this.visible[i];
    if (!a) return false;
    const targets = this.host.targets();
    if (a.applies && !targets.some((id) => a.applies!(this.host, id))) {
      this.host.toast(`${a.label}: not for the selection`, true);
      return true;
    }
    a.run(this.host);
    return true;
  }

  private configure(): void {
    const box = h('div', { class: 'quick-config' });
    const chosen = new Set(this.choice);
    const order = [...this.choice, ...QUICK_ACTIONS.map((a) => a.id).filter((id) => !chosen.has(id))];
    const render = () => {
      clear(box);
      box.append(h('div', { class: 'hint', text: `Up to ${KEYS.length} buttons; keys 1-9 and 0 follow this order.` }));
      for (const id of order) {
        const a = QUICK_ACTIONS.find((x) => x.id === id)!;
        const cb = h('input', { type: 'checkbox' }) as HTMLInputElement;
        cb.checked = chosen.has(id);
        cb.addEventListener('change', () => {
          if (cb.checked && chosen.size >= KEYS.length) {
            cb.checked = false;
            return this.host.toast(`At most ${KEYS.length} buttons`, true);
          }
          if (cb.checked) chosen.add(id);
          else chosen.delete(id);
        });
        const up = h('button', { class: 'small', text: '↑', title: 'Earlier' });
        up.addEventListener('click', () => {
          const i = order.indexOf(id);
          if (i > 0) [order[i - 1], order[i]] = [order[i], order[i - 1]];
          render();
        });
        box.append(h('label', { class: 'quick-config-row' }, cb, h('span', { text: a.label, title: a.title }), up));
      }
      box.append(
        h(
          'div',
          { class: 'row' },
          h('button', {
            class: 'primary',
            text: 'Save',
            onclick: () => {
              this.choice = order.filter((id) => chosen.has(id));
              saveChoice(this.choice);
              box.remove();
              this.update(true);
            },
          }),
          h('button', { text: 'Defaults', onclick: () => ((this.choice = [...DEFAULT_QUICK]), saveChoice(this.choice), box.remove(), this.update(true)) }),
          h('button', { text: 'Cancel', onclick: () => box.remove() }),
        ),
      );
    };
    render();
    this.el.parentElement?.append(box);
  }
}
