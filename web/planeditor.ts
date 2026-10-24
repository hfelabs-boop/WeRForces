// The plan editor: build a plan step by step, with if/else and while blocks, codewords and
// reports. New steps go into the block being edited ("▸ next step goes here").

import type { Condition, Formation, Graphic, Plan, PlanStatement, Roe, TaskSpec, Vec2 } from '../src/shared/types.js';
import { clear, fmtGrid, fmtTime, h } from './dom.js';

export interface PlanEditorHost {
  pickPoint(label: string, onPick: (p: Vec2) => void): void;
  pickEntity(label: string, onPick: (id: string) => void): void;
  graphics(): Graphic[];
  nameOf(id: string): string;
  /** An entity id to aim at for a picked object (a unit's leader). */
  aimAt(id: string): string;
  time(): number;
  can(what: 'air' | 'ground' | 'indirect' | 'smoke' | 'carrier' | 'infantry' | 'engineer' | 'unit'): boolean;
  assign(plan: Plan): Promise<boolean>;
  toast(msg: string, info?: boolean): void;
}

const ROE: Record<Roe, string> = { fireAtWill: 'Fire at will', returnFire: 'Return fire', holdFire: 'Hold fire' };
const FORMATIONS: Formation[] = ['column', 'line', 'wedge', 'vee', 'echelonRight'];

type CondKind = 'simTime' | 'inArea' | 'enemyDetected' | 'underFire' | 'entityDestroyed' | 'enemyInArea' | 'strengthBelow' | 'fuelBelow' | 'ammoBelow' | 'codeword' | 'notCodeword';

const CONDITIONS: [CondKind, string][] = [
  ['enemyDetected', 'enemy detected'],
  ['underFire', 'under fire'],
  ['simTime', 'time is (s)'],
  ['inArea', 'in area'],
  ['enemyInArea', 'enemy in area'],
  ['entityDestroyed', 'entity destroyed (pick)'],
  ['strengthBelow', 'strength below (%)'],
  ['fuelBelow', 'fuel below (%)'],
  ['ammoBelow', 'ammunition below (%)'],
  ['codeword', 'codeword received'],
  ['notCodeword', 'codeword not yet received'],
];

interface StepKind {
  id: string;
  label: string;
  group: string;
  when?: () => boolean;
}

/** One plan being edited: the plan, and the stack of blocks new steps go into. */
interface Draft {
  plan: Plan;
  stack: PlanStatement[][];
}

export class PlanEditor {
  private drafts = new Map<string, Draft>();

  constructor(private readonly host: PlanEditorHost) {}

  private draft(id: string): Draft {
    let d = this.drafts.get(id);
    if (!d) {
      const plan: Plan = { name: 'Plan', statements: [], loop: false };
      d = { plan, stack: [plan.statements] };
      this.drafts.set(id, d);
    }
    return d;
  }

  /** Replace a draft (e.g. "Move here and dismount" from the context menu). */
  set(id: string, plan: Plan): void {
    this.drafts.set(id, { plan, stack: [plan.statements] });
  }

  get(id: string): Plan {
    return this.draft(id).plan;
  }

  /** Add a step to the block being edited. */
  add(id: string, st: PlanStatement): void {
    const d = this.draft(id);
    d.stack[d.stack.length - 1].push(st);
    // Blocks open for their body at once.
    if (st.kind === 'if') d.stack.push(st.then);
    if (st.kind === 'while') d.stack.push(st.body);
    this.render(id);
  }

  describeCondition(c: Condition): string {
    switch (c.type) {
      case 'simTime':
        return `time ${fmtTime(c.time)}`;
      case 'inArea':
        return `in ${this.host.nameOf(c.areaId)}`;
      case 'enemyDetected':
        return 'enemy detected';
      case 'underFire':
        return 'under fire';
      case 'entityDestroyed':
        return `${this.host.nameOf(c.entityId)} destroyed`;
      case 'enemyInArea':
        return `enemy in ${this.host.nameOf(c.areaId)}`;
      case 'strengthBelow':
        return `strength below ${Math.round(c.fraction * 100)}%`;
      case 'fuelBelow':
        return `fuel below ${Math.round(c.fraction * 100)}%`;
      case 'ammoBelow':
        return `ammunition below ${Math.round(c.fraction * 100)}%`;
      case 'codeword':
        return `codeword ${c.codeword}`;
      case 'all':
        return c.conditions.map((x) => this.describeCondition(x)).join(' and ');
      case 'any':
        return c.conditions.map((x) => this.describeCondition(x)).join(' or ');
      case 'not':
        return c.condition.type === 'codeword' ? `no codeword ${c.condition.codeword} yet` : `not ${this.describeCondition(c.condition)}`;
    }
  }

  describe(st: PlanStatement): string {
    const name = (id: string) => this.host.nameOf(id);
    switch (st.kind) {
      case 'task': {
        const t = st.task;
        switch (t.type) {
          case 'moveTo':
            return `Move to ${fmtGrid(t.target.x, t.target.y)}${t.covered ? ' (covered)' : ''}`;
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
            return `${t.smoke ? 'Smoke' : 'Fire mission'} ${fmtGrid(t.target.x, t.target.y)}, ${t.rounds ?? 3} rounds`;
          case 'mount':
            return `Mount ${name(t.carrierId)}`;
          case 'dismount':
            return 'Dismount passengers';
          case 'breach':
            return `Breach ${name(t.graphicId)}`;
          case 'resupply':
            return t.supplierId ? `Resupply from ${name(t.supplierId)}` : 'Resupply';
          case 'overwatch':
          case 'defend':
          case 'screen':
            return `${t.type[0].toUpperCase()}${t.type.slice(1)} ${fmtGrid(t.position.x, t.position.y)}${t.facing !== undefined ? ` facing ${t.facing}°` : ''}`;
          case 'ambush':
            return `Ambush ${name(t.killZoneId)} from ${fmtGrid(t.position.x, t.position.y)}`;
          case 'search':
            return `Search ${name(t.areaId)}`;
          default:
            return t.type;
        }
      }
      case 'setRoe':
        return `Set ROE: ${ROE[st.roe]}`;
      case 'setSpeed':
        return `Set speed ${Math.round(st.speed * 3.6)} km/h`;
      case 'setAltitude':
        return `Set altitude ${st.altitude} m AGL`;
      case 'setFormation':
        return `Set formation ${st.formation}`;
      case 'waitUntil':
        return `Wait until ${this.describeCondition(st.condition)}`;
      case 'setReactions':
        if (st.reactions.callForFire !== undefined && st.reactions.onContact === undefined) return `Set reaction: ${st.reactions.callForFire ? 'call for fire' : 'no call for fire'}`;
        return `Set reaction: ${st.reactions.onContact === 'halt' ? 'halt on contact' : 'continue on contact'}`;
      case 'if':
        return `If ${this.describeCondition(st.condition)}`;
      case 'while':
        return `While ${this.describeCondition(st.condition)}`;
      case 'sendCodeword':
        return `Send codeword ${st.codeword}`;
      case 'report':
        return `Report "${st.text}"`;
    }
  }

  private kinds(): StepKind[] {
    const c = (w: Parameters<PlanEditorHost['can']>[0]) => () => this.host.can(w);
    return [
      { id: 'moveTo', label: 'Move to (pick)', group: 'Movement' },
      { id: 'moveCovered', label: 'Move by a covered route (pick)', group: 'Movement', when: c('ground') },
      { id: 'followRoute', label: 'Follow route', group: 'Movement' },
      { id: 'patrol', label: 'Patrol route', group: 'Movement' },
      { id: 'orbit', label: 'Orbit (pick), radius m', group: 'Movement', when: c('air') },
      { id: 'wait', label: 'Wait (seconds)', group: 'Movement' },
      { id: 'attack', label: 'Attack (pick)', group: 'Tactics' },
      { id: 'overwatch', label: 'Overwatch (pick), facing °', group: 'Tactics', when: c('ground') },
      { id: 'defend', label: 'Defend (pick), facing °', group: 'Tactics', when: c('ground') },
      { id: 'screen', label: 'Screen (pick), facing °', group: 'Tactics', when: c('ground') },
      { id: 'ambush', label: 'Ambush area (pick position)', group: 'Tactics', when: c('ground') },
      { id: 'search', label: 'Search area', group: 'Tactics' },
      { id: 'breach', label: 'Breach minefield or obstacle', group: 'Tactics', when: c('engineer') },
      { id: 'fireMission', label: 'Fire mission (pick), rounds', group: 'Tactics', when: c('indirect') },
      { id: 'smoke', label: 'Smoke (pick), rounds', group: 'Tactics', when: c('smoke') },
      { id: 'resupply', label: 'Resupply at the nearest supply vehicle', group: 'Tactics' },
      { id: 'mount', label: 'Mount carrier (pick)', group: 'Tactics', when: c('infantry') },
      { id: 'dismount', label: 'Dismount passengers', group: 'Tactics', when: c('carrier') },
      { id: 'setRoe', label: 'Set ROE', group: 'Settings' },
      { id: 'setSpeed', label: 'Set speed (km/h)', group: 'Settings' },
      { id: 'setAltitude', label: 'Set altitude (m AGL)', group: 'Settings', when: c('air') },
      { id: 'setFormation', label: 'Set formation', group: 'Settings', when: c('unit') },
      { id: 'setReaction', label: 'Set reaction on contact', group: 'Settings' },
      { id: 'setCallForFire', label: 'Set call for fire', group: 'Settings' },
      { id: 'waitUntil', label: 'Wait until…', group: 'Control' },
      { id: 'if', label: 'If… (block)', group: 'Control' },
      { id: 'while', label: 'Repeat while… (block)', group: 'Control' },
      { id: 'else', label: 'Else (in the current If)', group: 'Control' },
      { id: 'end', label: 'End block', group: 'Control' },
      { id: 'sendCodeword', label: 'Send codeword', group: 'Control' },
      { id: 'report', label: 'Report on the radio', group: 'Control' },
    ].filter((k) => !k.when || k.when());
  }

  /** The editor section for an entity or unit. */
  section(id: string): HTMLElement {
    const d = this.draft(id);
    const kinds = this.kinds();
    const groups = [...new Set(kinds.map((k) => k.group))];
    const kindSel = h('select', {}, ...groups.map((g) => h('optgroup', { label: g }, ...kinds.filter((k) => k.group === g).map((k) => h('option', { value: k.id, text: k.label }))))) as HTMLSelectElement;
    const param = h('span', { class: 'plan-param' });
    let read: () => unknown = () => undefined;
    const select = (options: [string, string][], empty = '(none)') => {
      const s = h('select', {}, ...(options.length ? options.map(([v, l]) => h('option', { value: v, text: l })) : [h('option', { value: '', text: empty })])) as HTMLSelectElement;
      param.append(s);
      return s;
    };
    const number = (value: string, title = '', width = 70) => {
      const n = h('input', { type: 'number', value, title, style: `width:${width}px` }) as HTMLInputElement;
      param.append(n);
      return n;
    };
    const text = (placeholder: string) => {
      const t = h('input', { type: 'text', placeholder, style: 'width:120px' }) as HTMLInputElement;
      param.append(t);
      return t;
    };
    const graphics = (kinds: string[]) => this.host.graphics().filter((g) => kinds.includes(g.kind)).map((g) => [g.id, g.name] as [string, string]);
    const conditionEditor = () => {
      const cs = select(CONDITIONS);
      const sub = h('span', {});
      param.append(sub);
      let get: () => Condition | null = () => null;
      const render = () => {
        clear(sub);
        const k = cs.value as CondKind;
        const sel = (opts: [string, string][], empty: string) => {
          const s = h('select', {}, ...(opts.length ? opts.map(([v, l]) => h('option', { value: v, text: l })) : [h('option', { value: '', text: empty })])) as HTMLSelectElement;
          sub.append(s);
          return s;
        };
        const num = (v: string) => {
          const n = h('input', { type: 'number', value: v, style: 'width:60px' }) as HTMLInputElement;
          sub.append(n);
          return n;
        };
        if (k === 'simTime') {
          const n = num(String(Math.round(this.host.time() + 120)));
          get = () => ({ type: 'simTime', time: Number(n.value) || 0 });
        } else if (k === 'inArea' || k === 'enemyInArea') {
          const s = sel(graphics(['area']), '(draw an area)');
          get = () => (s.value ? { type: k, areaId: s.value } : null);
        } else if (k === 'strengthBelow' || k === 'fuelBelow' || k === 'ammoBelow') {
          const n = num(k === 'strengthBelow' ? '50' : '25');
          get = () => ({ type: k, fraction: Math.min(100, Math.max(1, Number(n.value) || 50)) / 100 });
        } else if (k === 'codeword' || k === 'notCodeword') {
          const t = h('input', { type: 'text', placeholder: 'e.g. ROMEO', style: 'width:90px' }) as HTMLInputElement;
          sub.append(t);
          get = () => {
            const w = t.value.trim().toUpperCase();
            if (!w) return null;
            return k === 'codeword' ? { type: 'codeword', codeword: w } : { type: 'not', condition: { type: 'codeword', codeword: w } };
          };
        } else if (k === 'entityDestroyed') {
          get = () => ({ type: 'entityDestroyed', entityId: '' });
        } else {
          get = () => ({ type: k } as Condition);
        }
      };
      cs.addEventListener('change', render);
      render();
      return () => get();
    };
    const renderParam = () => {
      clear(param);
      read = () => undefined;
      const k = kindSel.value;
      if (k === 'followRoute' || k === 'patrol') {
        const s = select(graphics(['route', 'phaseLine']), '(draw a route)');
        read = () => s.value;
      } else if (k === 'ambush' || k === 'search') {
        const s = select(graphics(['area']), '(draw an area)');
        read = () => s.value;
      } else if (k === 'breach') {
        const s = select(graphics(['minefield', 'obstacle']), '(no minefields or obstacles)');
        read = () => s.value;
      } else if (k === 'setRoe') {
        const s = select(Object.entries(ROE));
        read = () => s.value;
      } else if (k === 'setFormation') {
        const s = select(FORMATIONS.map((f) => [f, f]));
        read = () => s.value;
      } else if (k === 'setReaction') {
        const s = select([['halt', 'Halt and fight'], ['continue', 'Continue']]);
        read = () => s.value;
      } else if (k === 'setCallForFire') {
        const s = select([['yes', 'Call for fire'], ['no', 'Stop calling for fire']]);
        read = () => s.value;
      } else if (k === 'overwatch' || k === 'defend' || k === 'screen') {
        const n = number('', 'facing, degrees (blank: the direction of the move)');
        n.placeholder = 'facing°';
        read = () => (n.value === '' ? undefined : Number(n.value));
      } else if (['wait', 'setSpeed', 'setAltitude', 'orbit', 'fireMission', 'smoke'].includes(k)) {
        const defaults: Record<string, string> = { wait: '60', setSpeed: '30', setAltitude: '150', orbit: '2000', fireMission: '3', smoke: '2' };
        const n = number(defaults[k]);
        read = () => Number(n.value);
      } else if (k === 'waitUntil' || k === 'if' || k === 'while') {
        read = conditionEditor();
      } else if (k === 'sendCodeword') {
        const t = text('codeword');
        read = () => t.value.trim().toUpperCase();
      } else if (k === 'report') {
        const t = text('message');
        t.style.width = '160px';
        read = () => t.value.trim();
      }
    };
    kindSel.addEventListener('change', renderParam);
    renderParam();
    const add = () => this.addFromForm(id, kindSel.value, read());
    const loop = h('input', { type: 'checkbox', checked: !!d.plan.loop, onchange: (ev: Event) => (d.plan.loop = (ev.target as HTMLInputElement).checked) });
    return h(
      'div',
      { class: 'section' },
      h('h4', { text: 'Plan editor' }),
      h('div', { class: 'row' }, 'Name', h('input', { type: 'text', value: d.plan.name ?? 'Plan', style: 'flex:1', oninput: (ev: Event) => (d.plan.name = (ev.target as HTMLInputElement).value.trim() || 'Plan') })),
      h('div', { class: 'plan-list', 'data-plan-list': id }),
      h('div', { class: 'row plan-add' }, kindSel, param, h('button', { text: 'Add', onclick: add })),
      h(
        'div',
        { class: 'row' },
        h('label', {}, loop, ' loop'),
        h('span', { class: 'spacer' }),
        h('button', {
          class: 'primary',
          text: 'Assign plan',
          onclick: async () => {
            if (!d.plan.statements.length) return this.host.toast('Add some plan steps first');
            if (await this.host.assign(JSON.parse(JSON.stringify(d.plan)))) this.host.toast('Plan assigned', true);
          },
        }),
        h('button', {
          text: 'Clear',
          onclick: () => {
            d.plan.statements = [];
            d.stack = [d.plan.statements];
            this.render(id);
          },
        }),
      ),
    );
  }

  private addFromForm(id: string, k: string, v: unknown): void {
    const push = (st: PlanStatement) => this.add(id, st);
    const task = (t: TaskSpec) => push({ kind: 'task', task: t });
    const pick = (label: string, fn: (p: Vec2) => void) => this.host.pickPoint(label, (p) => fn({ x: Math.round(p.x), y: Math.round(p.y) }));
    const d = this.draft(id);
    switch (k) {
      case 'moveTo':
      case 'moveCovered':
        return pick('Click the plan waypoint', (p) => task({ type: 'moveTo', target: p, ...(k === 'moveCovered' ? { covered: true } : {}) }));
      case 'attack':
        return this.host.pickEntity('Click the target', (t) => task({ type: 'attack', targetId: this.host.aimAt(t) }));
      case 'orbit':
        return pick('Click the orbit centre', (p) => task({ type: 'orbit', center: p, radius: Number(v) || 2000 }));
      case 'overwatch':
      case 'defend':
      case 'screen':
        return pick(`Click the ${k} position`, (p) => task({ type: k, position: p, ...(v !== undefined && Number.isFinite(v) ? { facing: Number(v) } : {}) } as TaskSpec));
      case 'ambush':
        if (!v) return this.host.toast('Draw the kill zone area first');
        return pick('Click the ambush position', (p) => task({ type: 'ambush', killZoneId: String(v), position: p }));
      case 'search':
        if (!v) return this.host.toast('Draw an area first');
        return task({ type: 'search', areaId: String(v) });
      case 'breach':
        if (!v) return this.host.toast('Draw a minefield or obstacle first');
        return task({ type: 'breach', graphicId: String(v) });
      case 'followRoute':
      case 'patrol':
        if (!v) return this.host.toast('Draw a route first');
        return task({ type: k, routeId: String(v) });
      case 'wait':
        return task({ type: 'wait', duration: Number(v) || 0 });
      case 'fireMission':
      case 'smoke':
        return pick('Click the target location', (p) => task({ type: 'fireMission', target: p, rounds: Math.max(1, Number(v) || 3), radius: this.host.can('unit') ? (k === 'smoke' ? 60 : 50) : 0, ...(k === 'smoke' ? { smoke: true } : {}) }));
      case 'resupply':
        return task({ type: 'resupply' });
      case 'mount':
        return this.host.pickEntity('Click the carrier', (t) => task({ type: 'mount', carrierId: t }));
      case 'dismount':
        return task({ type: 'dismount' });
      case 'setRoe':
        return push({ kind: 'setRoe', roe: v as Roe });
      case 'setSpeed':
        return push({ kind: 'setSpeed', speed: (Number(v) || 0) / 3.6 });
      case 'setAltitude':
        return push({ kind: 'setAltitude', altitude: Number(v) || 0 });
      case 'setFormation':
        return push({ kind: 'setFormation', formation: v as Formation });
      case 'setReaction':
        return push({ kind: 'setReactions', reactions: { onContact: v === 'halt' ? 'halt' : 'continue' } });
      case 'setCallForFire':
        return push({ kind: 'setReactions', reactions: { callForFire: v === 'yes' } });
      case 'waitUntil':
      case 'if':
      case 'while': {
        const c = v as Condition | null;
        if (!c) return this.host.toast('Complete the condition first (an area, a codeword…)');
        const make = (cond: Condition): PlanStatement => (k === 'waitUntil' ? { kind: 'waitUntil', condition: cond } : k === 'if' ? { kind: 'if', condition: cond, then: [] } : { kind: 'while', condition: cond, body: [] });
        if (c.type === 'entityDestroyed') return this.host.pickEntity('Click the entity', (t) => push(make({ type: 'entityDestroyed', entityId: this.host.aimAt(t) })));
        return push(make(c));
      }
      case 'else': {
        const block = d.stack[d.stack.length - 1];
        const owner = this.blockOwner(d.plan.statements, block);
        if (!owner || owner.kind !== 'if' || block !== owner.then) return this.host.toast('Else goes inside an If block, before its End');
        owner.else = owner.else ?? [];
        d.stack[d.stack.length - 1] = owner.else;
        return this.render(id);
      }
      case 'end':
        if (d.stack.length <= 1) return this.host.toast('No open block to end');
        d.stack.pop();
        return this.render(id);
      case 'sendCodeword':
        if (!v) return this.host.toast('Type the codeword');
        return push({ kind: 'sendCodeword', codeword: String(v) });
      case 'report':
        if (!v) return this.host.toast('Type the message');
        return push({ kind: 'report', text: String(v) });
    }
  }

  /** The if/while statement that owns a block. */
  private blockOwner(list: PlanStatement[], block: PlanStatement[]): Extract<PlanStatement, { kind: 'if' | 'while' }> | null {
    for (const st of list) {
      if (st.kind === 'if') {
        if (st.then === block || st.else === block) return st;
        const inner = this.blockOwner(st.then, block) ?? this.blockOwner(st.else ?? [], block);
        if (inner) return inner;
      } else if (st.kind === 'while') {
        if (st.body === block) return st;
        const inner = this.blockOwner(st.body, block);
        if (inner) return inner;
      }
    }
    return null;
  }

  /** Draw the plan, indented by block, with the insertion point. */
  render(id: string): void {
    const box = document.querySelector<HTMLElement>(`[data-plan-list="${id}"]`);
    if (!box) return;
    clear(box);
    const d = this.draft(id);
    const active = d.stack[d.stack.length - 1];
    let n = 0;
    const line = (depth: number, content: HTMLElement, cls = '') => box.append(h('div', { class: `plan-line ${cls}`, style: `padding-left:${depth * 14 + 4}px` }, content));
    const here = (depth: number, list: PlanStatement[]) => {
      if (list === active) line(depth, h('span', { class: 'hint', text: list.length || d.plan.statements.length ? '▸ next step goes here' : 'No steps yet: add them below.' }), 'plan-here');
    };
    const walk = (list: PlanStatement[], depth: number) => {
      list.forEach((st, i) => {
        const row = h(
          'span',
          { class: 'plan-step' },
          h('span', { text: `${++n}. ${this.describe(st)}` }),
          h('button', {
            class: 'small',
            text: '↑',
            title: 'Move up',
            disabled: i === 0,
            onclick: () => {
              [list[i - 1], list[i]] = [list[i], list[i - 1]];
              this.render(id);
            },
          }),
          h('button', {
            class: 'small',
            text: '✕',
            title: st.kind === 'if' || st.kind === 'while' ? 'Remove the block and its steps' : 'Remove',
            onclick: () => {
              list.splice(i, 1);
              // Leave any block that was removed.
              d.stack = d.stack.filter((b) => b === d.plan.statements || this.blockOwner(d.plan.statements, b));
              this.render(id);
            },
          }),
        );
        if (st.kind === 'if' || st.kind === 'while') {
          row.addEventListener('dblclick', () => {
            d.stack = [d.plan.statements, st.kind === 'if' ? st.then : st.body];
            this.render(id);
          });
          (row as HTMLElement).title = 'Double-click to add steps inside';
        }
        line(depth, row, st.kind === 'if' || st.kind === 'while' ? 'plan-block' : '');
        if (st.kind === 'if') {
          walk(st.then, depth + 1);
          here(depth + 1, st.then);
          if (st.else) {
            line(depth, h('span', { class: 'plan-kw', text: 'Else' }));
            walk(st.else, depth + 1);
            here(depth + 1, st.else);
          }
          line(depth, h('span', { class: 'plan-kw', text: 'End if' }));
        } else if (st.kind === 'while') {
          walk(st.body, depth + 1);
          here(depth + 1, st.body);
          line(depth, h('span', { class: 'plan-kw', text: 'End while' }));
        }
      });
    };
    walk(d.plan.statements, 0);
    here(0, d.plan.statements);
  }
}
