// The order line: type an order in words, with completions as you type. "/" focuses it.
// Orders that start with a verb go to the selection ("defend Brenham facing north").

import { completeOrder, type Completion, ORDER_EXAMPLES, type OrderContext, OrderError, parseOrder } from '../src/shared/orders.js';
import { clear, h } from './dom.js';

export interface OrderLineHost {
  context(): OrderContext | null;
  /** Names of the selected things that take orders. */
  selectedNames(): string[];
  send(text: string): Promise<{ description: string } | { error: string }>;
  toast(msg: string, info?: boolean): void;
}

export class OrderLine {
  private input: HTMLInputElement;
  private list: HTMLElement;
  private items: Completion[] = [];
  private active = -1;
  private history: string[] = [];
  private back = -1;

  constructor(
    root: HTMLElement,
    private readonly host: OrderLineHost,
  ) {
    this.input = h('input', { type: 'text', class: 'order-input', placeholder: 'Type an order… e.g. Team ARMOR move to Calloway covered  ( / )', spellcheck: 'false', autocomplete: 'off' }) as HTMLInputElement;
    this.list = h('div', { class: 'order-suggestions hidden' });
    root.append(this.input, this.list);
    this.input.addEventListener('input', () => this.suggest());
    this.input.addEventListener('focus', () => this.suggest());
    this.input.addEventListener('blur', () => window.setTimeout(() => this.hide(), 150));
    this.input.addEventListener('keydown', (e) => this.onKey(e));
  }

  focus(): void {
    this.input.focus();
    this.input.select();
  }

  /** The text as it will be sent: with the selection's names in front when it starts with a verb. */
  private resolve(text: string): string {
    const ctx = this.host.context();
    const names = this.host.selectedNames();
    if (!ctx || !names.length) return text;
    try {
      parseOrder(text, ctx);
      return text;
    } catch (err) {
      if (!(err instanceof OrderError) || !/^Who\?/.test(err.message)) return text;
    }
    return `${names.map((n) => (/\s(and)\s/i.test(n) ? `"${n}"` : n)).join(' and ')} ${text}`;
  }

  private suggest(): void {
    const ctx = this.host.context();
    const text = this.input.value.replace(/^\/+\s*/, '');
    clear(this.list);
    this.items = [];
    this.active = -1;
    if (!ctx) return this.hide();
    if (!text.trim()) {
      const sel = this.host.selectedNames();
      const examples = sel.length ? ['move to ', 'defend ', 'overwatch ', 'attack ', 'hold fire', 'fire at will', 'stop'].map((v) => ({ label: `${v.trim()}  (${sel.join(', ')})`, text: v })) : ORDER_EXAMPLES.map((e) => ({ label: e, text: e }));
      this.items = examples;
    } else {
      const resolved = this.resolve(text);
      const prefix = resolved.slice(0, resolved.length - text.length);
      this.items = completeOrder(resolved, ctx).map((c) => ({ label: c.label, text: c.text.startsWith(prefix) ? c.text.slice(prefix.length) : c.text }));
    }
    if (!this.items.length) {
      // Show how the order reads so far, or what is wrong with it.
      try {
        const o = parseOrder(this.resolve(text), ctx);
        this.list.append(h('div', { class: 'order-preview ok', text: `↵ ${o.description}` }));
      } catch (err) {
        if (err instanceof OrderError) this.list.append(h('div', { class: 'order-preview', text: err.message }));
      }
    }
    this.items.forEach((c, i) => {
      const row = h('div', { class: 'order-suggestion', text: c.label });
      row.addEventListener('mousedown', (e) => {
        e.preventDefault();
        this.choose(i);
      });
      this.list.append(row);
    });
    this.list.classList.toggle('hidden', this.list.childElementCount === 0);
  }

  private choose(i: number): void {
    const c = this.items[i];
    if (!c) return;
    this.input.value = c.text;
    this.input.focus();
    this.suggest();
  }

  private hide(): void {
    this.list.classList.add('hidden');
  }

  private highlight(): void {
    [...this.list.querySelectorAll('.order-suggestion')].forEach((el, i) => el.classList.toggle('active', i === this.active));
  }

  private onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      this.hide();
      this.input.blur();
      return;
    }
    if (e.key === 'Tab' && this.items.length) {
      e.preventDefault();
      this.choose(this.active >= 0 ? this.active : 0);
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const open = !this.list.classList.contains('hidden') && this.items.length > 0;
      if (open && this.input.value.trim()) {
        this.active = (this.active + (e.key === 'ArrowDown' ? 1 : -1) + this.items.length) % this.items.length;
        this.highlight();
      } else if (this.history.length) {
        // History of sent orders.
        this.back = Math.max(-1, Math.min(this.history.length - 1, this.back + (e.key === 'ArrowUp' ? 1 : -1)));
        this.input.value = this.back >= 0 ? this.history[this.history.length - 1 - this.back] : '';
      }
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (this.active >= 0) return this.choose(this.active);
      void this.submit();
    }
  }

  private async submit(): Promise<void> {
    // "/" is the key that opens the line: a stray one at the start is not part of the order.
    const text = this.input.value.trim().replace(/^\/+\s*/, '');
    if (!text) return;
    const full = this.resolve(text);
    const r = await this.host.send(full);
    if ('error' in r) {
      this.host.toast(r.error);
      return;
    }
    this.host.toast(r.description, true);
    this.history.push(text);
    if (this.history.length > 50) this.history.shift();
    this.back = -1;
    this.input.value = '';
    this.hide();
  }
}
