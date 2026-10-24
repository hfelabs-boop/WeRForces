// The Commander dialog: hand a force to a commander (rule-based or LLM), set how it
// decides, and follow its decisions: when, why, the rationale and the orders it gave.

import type { CommanderStatus } from '../src/shared/commander.js';
import type { ForceId, SimState } from '../src/shared/types.js';
import { FORCE_NAMES } from '../src/shared/types.js';
import { clear, fmtTime, h } from './dom.js';

export interface CommanderHost {
  v1<T>(method: string, path: string, body?: unknown): Promise<T>;
  modal(content: HTMLElement): () => void;
  toast(msg: string, info?: boolean): void;
  /** Fixed for a player; exercise control may pick. */
  playerForce(): ForceId | undefined;
}

const FORCE_PATH: Record<number, string> = { 1: 'blue', 2: 'red', 3: 'neutral' };
const TRIGGERS: Record<string, string> = { start: 'start', scheduled: 'scheduled', contact: 'new contact', losses: 'losses', phase: 'new phase', idle: 'unit idle', asked: 'asked' };

type View = Omit<CommanderStatus, 'kind'> & { kind: 'none' | 'rules' | 'llm'; llm: { available: boolean; reason?: string } };

export class CommanderDialog {
  private list: HTMLElement | null = null;
  private force: ForceId = 1;
  private shown = '';

  constructor(private readonly host: CommanderHost) {}

  /** Toolbar text: who is run by a commander. */
  static label(s: SimState): string {
    const list = s.commanders ?? [];
    if (!list.length) return 'Commander';
    return `Commander: ${list.map((c) => `${FORCE_NAMES[c.force]}${c.state === 'thinking' ? ' …' : c.state === 'error' || c.state === 'unavailable' ? ' !' : ''}`).join(', ')}`;
  }

  async open(): Promise<void> {
    this.force = this.host.playerForce() ?? (this.force || 1);
    const player = this.host.playerForce() !== undefined;
    const body = h('div', { class: 'settings commander' });
    let close = () => {};
    const draw = async () => {
      let v: View;
      try {
        v = await this.host.v1<View>('GET', `/forces/${FORCE_PATH[this.force]}/commander`);
      } catch (err) {
        this.host.toast((err as Error).message);
        return;
      }
      clear(body);
      const kind = h('select', {}, [
        h('option', { value: 'none', text: 'None (people and plans)', selected: v.kind === 'none' }),
        h('option', { value: 'rules', text: 'Rule-based (doctrinal)', selected: v.kind === 'rules' }),
        h('option', { value: 'llm', text: `Language model${v.llm.available ? '' : ' (not configured)'}`, selected: v.kind === 'llm', disabled: player || (!v.llm.available && v.kind !== 'llm') }),
      ]) as HTMLSelectElement;
      const o = v.options ?? {};
      const aggr = h('input', { type: 'range', min: '0', max: '1', step: '0.1', value: String(o.aggressiveness ?? 0.5) }) as HTMLInputElement;
      const aggrText = h('span', { text: String(o.aggressiveness ?? 0.5) });
      aggr.addEventListener('input', () => (aggrText.textContent = aggr.value));
      const interval = h('input', { type: 'number', min: '10', max: '600', step: '5', value: String(o.interval ?? 45) }) as HTMLInputElement;
      const holdOff = h('input', { type: 'number', min: '0', max: '3600', step: '30', value: String(o.holdOff ?? 300) }) as HTMLInputElement;
      const intent = h('textarea', { rows: '2', maxlength: '500', placeholder: 'e.g. Seize OBJ IRON by 10:40; keep the tanks out of the woods', value: o.intent ?? '' }) as HTMLTextAreaElement;
      const forceSeg = h(
        'div',
        { class: 'seg' },
        ([1, 2] as ForceId[]).map((f) =>
          h('button', {
            text: FORCE_NAMES[f],
            class: `${f === this.force ? 'active ' : ''}${f === 1 ? 'blue' : 'red'}`,
            disabled: player && f !== this.force,
            onclick: () => {
              this.force = f;
              this.shown = '';
              void draw();
            },
          }),
        ),
      );
      const list = h('div', { class: 'commander-decisions' });
      this.list = list;
      this.shown = '';
      body.append(
        h('h3', { text: 'Commander' }),
        h('p', { class: 'hint', text: 'A commander runs a force: at its interval, and sooner on contact, losses, a new phase or a unit left idle, it looks at what the force can see and gives orders through the same commands as a player. It leaves orders it did not give alone for the hold-off time, so you can override it.' }),
        h('div', { class: 'kv' }, 'Force', forceSeg, 'Commander', kind, 'Aggressiveness', h('span', {}, aggr, ' ', aggrText), 'Decide every (s)', interval, 'Leave others’ orders (s)', holdOff, 'Intent (LLM)', intent),
        v.kind === 'llm' && v.usage ? h('small', { class: 'hint', text: `Model calls ${v.usage.calls}, tokens ${v.usage.inputTokens} in, ${v.usage.outputTokens} out.` }) : '',
        !v.llm.available ? h('small', { class: 'hint', text: `LLM: ${v.llm.reason ?? 'not configured'}.` }) : '',
        v.error ? h('p', { class: 'hint error', text: `${v.state === 'unavailable' ? 'Unavailable' : 'Error'}: ${v.error}` }) : '',
        h(
          'div',
          { class: 'row' },
          h('button', {
            class: 'primary',
            text: 'Apply',
            onclick: async () => {
              const options: Record<string, unknown> = { aggressiveness: Number(aggr.value), interval: Number(interval.value) || 45, holdOff: Number(holdOff.value) || 0 };
              if (intent.value.trim()) options.intent = intent.value.trim();
              try {
                await this.host.v1('PUT', `/forces/${FORCE_PATH[this.force]}/commander`, { kind: kind.value, options });
                this.host.toast(kind.value === 'none' ? `${FORCE_NAMES[this.force]}: commander stood down` : `${FORCE_NAMES[this.force]} is run by the ${kind.value === 'rules' ? 'rule-based' : 'LLM'} commander`, true);
                void draw();
              } catch (err) {
                this.host.toast((err as Error).message);
              }
            },
          }),
          h('button', {
            text: 'Decide now',
            disabled: v.kind === 'none',
            onclick: async () => {
              try {
                await this.host.v1('POST', `/forces/${FORCE_PATH[this.force]}/commander/decide`);
                this.host.toast('The commander decides at the next simulated second (the clock must run)', true);
              } catch (err) {
                this.host.toast((err as Error).message);
              }
            },
          }),
          h('button', { text: 'Close', onclick: () => close() }),
        ),
        h('h4', { text: 'Latest decisions' }),
        list,
      );
      this.renderDecisions(v.kind === 'none' ? undefined : (v as CommanderStatus));
    };
    close = this.host.modal(body);
    const done = close;
    close = () => {
      this.list = null;
      done();
    };
    await draw();
  }

  /** Keep the open dialog's decision list current. */
  update(s: SimState): void {
    if (!this.list?.isConnected) {
      this.list = null;
      return;
    }
    this.renderDecisions(s.commanders?.find((c) => c.force === this.force));
  }

  private renderDecisions(c: CommanderStatus | undefined): void {
    const el = this.list;
    if (!el) return;
    const key = c ? `${c.state}|${c.decisions.length}|${c.decisions[0]?.time ?? ''}|${c.decisions[0]?.summary ?? ''}` : 'none';
    if (key === this.shown) return;
    this.shown = key;
    clear(el);
    if (!c) {
      el.append(h('p', { class: 'hint', text: 'No commander for this force.' }));
      return;
    }
    if (c.state === 'thinking') el.append(h('p', { class: 'hint', text: 'Thinking…' }));
    if (!c.decisions.length) el.append(h('p', { class: 'hint', text: `No decisions yet. The first comes when the clock runs (next at ${fmtTime(c.next)}).` }));
    for (const d of c.decisions) {
      el.append(
        h(
          'div',
          { class: 'decision' },
          h('div', { class: 'decision-head' }, h('strong', { text: fmtTime(d.time) }), ` · ${TRIGGERS[d.trigger] ?? d.trigger}`),
          h('div', { text: d.summary }),
          d.orders.length ? h('ul', {}, d.orders.map((o) => h('li', { text: o }))) : null,
          d.rejected?.length ? h('ul', { class: 'rejected' }, d.rejected.map((o) => h('li', { text: `Refused: ${o}` }))) : null,
        ),
      );
    }
  }
}
