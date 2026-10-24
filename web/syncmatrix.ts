// The synchronization matrix dialog: a force's operation in phases (columns) and units
// (rows). Each cell is an order in words; each phase has a trigger. Phases start in order,
// give their orders at once and announce their names as codewords.

import { type OrderContext, OrderError, parseOrder } from '../src/shared/orders.js';
import type { ForceId, Phase, PhaseOrder, PhaseTrigger, SyncMatrixState, TaskSpec } from '../src/shared/types.js';
import { FORCE_NAMES } from '../src/shared/types.js';
import { clear, fmtTime, h } from './dom.js';

export interface SyncHost {
  v1<T>(method: string, path: string, body?: unknown): Promise<T>;
  context(force: ForceId): OrderContext | null;
  /** Units and loose entities of a force, in the order to list them. */
  rows(force: ForceId): { id: string; name: string }[];
  /** Fixed for a player; exercise control may pick. */
  playerForce(): ForceId | undefined;
  time(): number;
  describe(task: TaskSpec): string;
  modal(content: HTMLElement): () => void;
  toast(msg: string, info?: boolean): void;
}

const FORCE_PATH: Record<number, string> = { 0: '0', 1: 'blue', 2: 'red', 3: 'neutral' };

interface Column {
  id: string;
  name: string;
  trigger: PhaseTrigger;
  /** Row id -> order text. */
  cells: Map<string, string>;
  /** Orders loaded from the server that were not typed (kept unless the cell is edited). */
  kept: Map<string, PhaseOrder[]>;
}

export class SyncMatrixDialog {
  constructor(private readonly host: SyncHost) {}

  async open(): Promise<void> {
    let force: ForceId = this.host.playerForce() ?? 1;
    const all = await this.host.v1<SyncMatrixState[]>('GET', '/sync-matrix').catch(() => []);
    const body = h('div', { class: 'sync' });
    let columns: Column[] = [];
    let state: SyncMatrixState | undefined;

    const load = (f: ForceId) => {
      force = f;
      state = all.find((m) => m.force === f);
      columns = (state?.phases ?? []).map((p) => {
        const cells = new Map<string, string>();
        const kept = new Map<string, PhaseOrder[]>();
        for (const o of p.orders) {
          if (o.text) cells.set(o.targetId, cells.has(o.targetId) ? `${cells.get(o.targetId)}; ${o.text}` : o.text);
          else kept.set(o.targetId, [...(kept.get(o.targetId) ?? []), o]);
        }
        // Orders given as tasks (e.g. through the API) show as their description.
        for (const [id, os] of kept) if (!cells.has(id)) cells.set(id, os.map((o) => (o.task ? this.host.describe(o.task) : o.roe ? `ROE ${o.roe}` : 'stop')).join('; '));
        return { id: p.id, name: p.name, trigger: p.trigger, cells, kept };
      });
      if (!columns.length) columns.push(this.blank(1));
      render();
    };

    const triggerEditor = (c: Column, index: number) => {
      const types: [PhaseTrigger['type'], string][] = [
        ['manual', 'by hand'],
        ['time', 'at time (s)'],
        ['codeword', 'on codeword'],
        ...(index > 0 ? ([['previousDone', 'when previous done (+s)']] as [PhaseTrigger['type'], string][]) : []),
      ];
      if (c.trigger.type === 'condition') types.push(['condition', 'on a condition (set through the API)']);
      const sel = h('select', {}, ...types.map(([v, l]) => h('option', { value: v, text: l }))) as HTMLSelectElement;
      sel.value = c.trigger.type;
      const param = h('input', { type: 'text', class: 'sync-param' }) as HTMLInputElement;
      const show = () => {
        const t = c.trigger;
        param.hidden = t.type === 'manual' || t.type === 'condition';
        param.value = t.type === 'time' ? String(t.time) : t.type === 'codeword' ? t.codeword : t.type === 'previousDone' ? String(t.delay ?? 0) : '';
        param.placeholder = t.type === 'codeword' ? 'codeword' : 's';
      };
      const update = () => {
        const v = param.value.trim();
        switch (sel.value as PhaseTrigger['type']) {
          case 'manual':
            c.trigger = { type: 'manual' };
            break;
          case 'time':
            c.trigger = { type: 'time', time: Number(v) || Math.round(this.host.time() + 60) };
            break;
          case 'codeword':
            c.trigger = { type: 'codeword', codeword: v.toUpperCase() || 'EXECUTE' };
            break;
          case 'previousDone':
            c.trigger = { type: 'previousDone', delay: Number(v) || 0 };
            break;
        }
      };
      sel.addEventListener('change', () => {
        update();
        show();
      });
      param.addEventListener('change', update);
      show();
      return h('div', { class: 'sync-trigger' }, sel, param);
    };

    /** Check a cell as its unit's order; mark it and say how it reads. */
    const check = (input: HTMLInputElement, rowId: string) => {
      const text = input.value.trim();
      input.classList.remove('bad', 'ok');
      input.title = '';
      if (!text) return;
      const ctx = this.host.context(force);
      if (!ctx) return;
      try {
        const o = parseOrder(`${rowId} ${text}`, ctx);
        input.classList.add('ok');
        input.title = o.description;
      } catch (err) {
        input.classList.add('bad');
        input.title = err instanceof OrderError ? err.message : String(err);
      }
    };

    const render = () => {
      clear(body);
      const forcePick = this.host.playerForce() === undefined
        ? h('select', { onchange: (e: Event) => load(Number((e.target as HTMLSelectElement).value) as ForceId) }, ...[1, 2, 3].map((f) => h('option', { value: String(f), text: FORCE_NAMES[f as ForceId], selected: f === force })))
        : h('strong', { text: FORCE_NAMES[force] });
      const rows = this.host.rows(force);
      const started = state?.started ?? {};
      const head = h(
        'tr',
        {},
        h('th', { text: 'Unit' }),
        ...columns.map((c, i) => {
          const name = h('input', { type: 'text', value: c.name, class: 'sync-name', oninput: (e: Event) => (c.name = (e.target as HTMLInputElement).value) });
          const when = started[c.id];
          const status =
            when !== undefined
              ? h('span', { class: 'sync-started', text: `started ${fmtTime(when)}` })
              : state?.phases.some((p) => p.id === c.id) && (i === 0 || started[columns[i - 1].id] !== undefined)
                ? h('button', { class: 'small', text: '▶ Start now', title: 'Start this phase now (saved phases only)', onclick: () => void this.start(force, c.id).then(() => close()) })
                : null;
          const remove = h('button', {
            class: 'small',
            text: '✕',
            title: 'Remove this phase',
            onclick: () => {
              columns.splice(i, 1);
              render();
            },
          });
          return h('th', { class: started[c.id] !== undefined ? 'started' : '' }, h('div', { class: 'row' }, name, remove), triggerEditor(c, i), status);
        }),
        h('th', {}, h('button', { text: '+ Phase', onclick: () => (columns.push(this.blank(columns.length + 1)), render()) })),
      );
      const lines = rows.map((r) =>
        h(
          'tr',
          {},
          h('td', { class: 'sync-unit', text: r.name }),
          ...columns.map((c) => {
            const input = h('input', { type: 'text', class: 'sync-cell', value: c.cells.get(r.id) ?? '', placeholder: '—' }) as HTMLInputElement;
            input.addEventListener('input', () => {
              c.cells.set(r.id, input.value);
              c.kept.delete(r.id);
              check(input, r.id);
            });
            // Orders given as tasks (through the API or a quick battle) show as their description.
            if (c.kept.has(r.id)) input.title = 'Given as a task; type over it to change it';
            else check(input, r.id);
            return h('td', {}, input);
          }),
          h('td', {}),
        ),
      );
      const codeword = h('input', { type: 'text', class: 'sync-codeword', placeholder: 'Codeword, e.g. EXECUTE', maxlength: '40' }) as HTMLInputElement;
      body.append(
        h('h3', { text: 'Synchronization matrix' }),
        h('p', { class: 'hint', text: 'Phases start in order, each on its trigger, and give the orders in their column at once (type them as on the order line: "move to Calloway covered", "defend OBJ CALLOWAY facing north", "hold fire"; several with ";"). A phase also sends its name as a codeword, so unit plans can wait for it.' }),
        h('div', { class: 'row' }, 'Force', forcePick),
        h('div', { class: 'sync-scroll' }, h('table', { class: 'sync-table' }, h('thead', {}, head), h('tbody', {}, ...lines))),
        h(
          'div',
          { class: 'row' },
          codeword,
          h('button', {
            text: 'Send codeword',
            title: 'Send a codeword to this force now: plans and phases waiting for it go on',
            onclick: () => {
              const word = codeword.value.trim();
              if (!word) return;
              void this.host
                .v1('POST', '/codewords', { force, codeword: word })
                .then(() => ((codeword.value = ''), this.host.toast(`Codeword ${word.toUpperCase()} sent`, true)))
                .catch((err: Error) => this.host.toast(err.message));
            },
          }),
          h('span', { class: 'spacer' }),
          h('button', { class: 'primary', text: 'Save', onclick: () => void this.save(force, columns).then((m) => m && (all.splice(0, all.length, ...all.filter((x) => x.force !== force), m), load(force), this.host.toast('Synchronization matrix saved', true))) }),
          h('button', { text: 'Close', onclick: () => close() }),
        ),
      );
    };

    load(force);
    const close = this.host.modal(body);
    document.querySelector('#modal-body')?.classList.add('wide');
  }

  private blank(n: number): Column {
    return { id: `P${Date.now().toString(36)}${n}`, name: `Phase ${n}`, trigger: n === 1 ? { type: 'manual' } : { type: 'previousDone' }, cells: new Map(), kept: new Map() };
  }

  private async save(force: ForceId, columns: Column[]): Promise<SyncMatrixState | null> {
    const phases: Phase[] = columns.map((c) => {
      const orders: PhaseOrder[] = [];
      for (const [targetId, text] of c.cells) {
        const kept = c.kept.get(targetId);
        if (kept) {
          orders.push(...kept);
          continue;
        }
        for (const part of text.split(';').map((s) => s.trim()).filter(Boolean)) orders.push({ targetId, text: part });
      }
      return { id: c.id, name: c.name.trim() || 'Phase', trigger: c.trigger, orders };
    });
    try {
      return await this.host.v1<SyncMatrixState>('PUT', `/sync-matrix/${FORCE_PATH[force]}`, { phases });
    } catch (err) {
      this.host.toast(err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  private async start(force: ForceId, phaseId: string): Promise<void> {
    try {
      await this.host.v1('POST', `/sync-matrix/${FORCE_PATH[force]}/phases/${encodeURIComponent(phaseId)}/start`);
      this.host.toast('Phase started', true);
    } catch (err) {
      this.host.toast(err instanceof Error ? err.message : String(err));
    }
  }
}
