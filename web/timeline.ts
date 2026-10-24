// Mission timeline: a strip showing what has happened (kills, detections, completed
// plans) and what is due (plan steps waiting for a time, orders on their way).

import type { SimEvent, SimState } from '../src/shared/types.js';

export interface TimelineHost {
  /** Jump the after-action review to a past time. */
  review(time: number): void;
  select(id: string): void;
}

interface Mark {
  t: number;
  color: string;
  tall: boolean;
  text: string;
  id?: string;
  future: boolean;
}

const fmt = (t: number) => {
  const s = Math.max(0, Math.round(t));
  return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

export class Timeline {
  readonly el: HTMLCanvasElement;
  private marks: Mark[] = [];
  private span = 600;
  private now = 0;
  private hover: Mark | null = null;
  private tip: HTMLElement;

  constructor(
    parent: HTMLElement,
    private readonly host: TimelineHost,
  ) {
    this.el = document.createElement('canvas');
    this.el.className = 'timeline';
    this.tip = document.createElement('div');
    this.tip.className = 'timeline-tip hidden';
    parent.append(this.el, this.tip);
    new ResizeObserver(() => this.draw()).observe(this.el);
    this.el.addEventListener('pointermove', (e) => {
      this.hover = this.markAt(e.offsetX);
      this.tip.classList.toggle('hidden', !this.hover);
      if (this.hover) {
        this.tip.textContent = `${fmt(this.hover.t)}  ${this.hover.text}`;
        this.tip.style.left = `${Math.min(e.offsetX, this.el.clientWidth - 260)}px`;
      }
      this.el.style.cursor = this.hover ? 'pointer' : 'default';
    });
    this.el.addEventListener('pointerleave', () => {
      this.hover = null;
      this.tip.classList.add('hidden');
    });
    this.el.addEventListener('click', (e) => {
      const m = this.markAt(e.offsetX);
      if (!m) return;
      if (m.future) {
        if (m.id) this.host.select(m.id);
      } else {
        this.host.review(m.t);
      }
    });
  }

  update(state: SimState, events: SimEvent[]): void {
    this.now = state.time;
    const marks: Mark[] = [];
    for (const ev of events) {
      if (ev.kind === 'destroyed') marks.push({ t: ev.time, color: '#ff5050', tall: true, text: ev.text, id: ev.entityId, future: false });
      else if (ev.kind === 'detected') marks.push({ t: ev.time, color: '#6fb4ff', tall: false, text: ev.text, id: ev.entityId, future: false });
      else if (ev.kind === 'task' && /plan .*complete|sprang the ambush|breached a lane|finished searching/.test(ev.text)) marks.push({ t: ev.time, color: '#4cd17a', tall: false, text: ev.text, id: ev.entityId, future: false });
    }
    for (const s of state.schedule ?? []) marks.push({ t: s.time, color: '#ffd24a', tall: true, text: s.text, id: s.targetId, future: true });
    for (const o of state.orders ?? []) marks.push({ t: o.due, color: '#c9a0ff', tall: true, text: `order arrives: ${o.text}`, id: o.targetId, future: true });
    this.marks = marks;
    const last = Math.max(state.time, ...marks.map((m) => m.t));
    // Round the span up so the scale doesn't jitter every second.
    const want = Math.max(600, last * 1.15 + 60);
    if (want > this.span || want < this.span / 3) this.span = Math.ceil(want / 600) * 600;
    this.draw();
  }

  private x(t: number): number {
    return 6 + (t / this.span) * (this.el.clientWidth - 12);
  }

  private markAt(px: number): Mark | null {
    let best: Mark | null = null;
    let bestD = 5;
    for (const m of this.marks) {
      const d = Math.abs(this.x(m.t) - px);
      if (d < bestD || (d === bestD && m.tall)) {
        best = m;
        bestD = d;
      }
    }
    return best;
  }

  private draw(): void {
    const w = this.el.clientWidth;
    const h = this.el.clientHeight;
    if (!w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    if (this.el.width !== Math.round(w * dpr) || this.el.height !== Math.round(h * dpr)) {
      this.el.width = Math.round(w * dpr);
      this.el.height = Math.round(h * dpr);
    }
    const ctx = this.el.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    // Past and future.
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.fillRect(6, 4, this.x(this.now) - 6, h - 16);
    // Hour/ten-minute ticks.
    const step = this.span > 7200 ? 1800 : this.span > 1800 ? 600 : 60;
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.font = '10px system-ui';
    ctx.textBaseline = 'bottom';
    for (let t = 0; t <= this.span; t += step) {
      const x = this.x(t);
      ctx.fillRect(x, h - 14, 1, 3);
      if ((t / step) % (step === 60 ? 5 : 1) === 0) ctx.fillText(fmt(t).slice(0, 5), x + 2, h);
    }
    for (const m of this.marks) {
      const x = this.x(m.t);
      ctx.fillStyle = m.color;
      if (m.future) {
        ctx.beginPath();
        ctx.moveTo(x, 6);
        ctx.lineTo(x + 4, 12);
        ctx.lineTo(x, 18);
        ctx.lineTo(x - 4, 12);
        ctx.fill();
      } else {
        ctx.fillRect(x - (m.tall ? 1 : 0.5), m.tall ? 4 : 10, m.tall ? 2 : 1, m.tall ? h - 16 : h - 22);
      }
    }
    // Now.
    const nx = this.x(this.now);
    ctx.fillStyle = '#fff';
    ctx.fillRect(nx - 1, 2, 2, h - 12);
  }
}
