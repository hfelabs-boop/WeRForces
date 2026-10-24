// After-action review in the browser: replay the server's recording on the map with a
// timeline (bookmarks and kills marked), play/pause/speed, bookmarks and a report.

import { type AarReport, type Recording, stateAt } from '../src/shared/recording.js';
import type { ForceId, SimEvent, SimState } from '../src/shared/types.js';
import type { Api } from './api.js';
import { clear, h } from './dom.js';
import { FORCE_COLORS } from './symbols.js';

const FORCE_NAMES = ['Other', 'Blue', 'Red', 'Neutral'];
const SPEEDS = [1, 4, 16, 64];

export interface AarHost {
  api: Api;
  /** Terrain height, for altitude above ground. */
  surface(x: number, y: number): number;
  /** Show a replayed state; `fresh` are events since the last frame shown (for map effects). */
  show(state: SimState, fresh: SimEvent[], log: SimEvent[]): void;
  /** Called when the review ends, to go back to the live view. */
  exited(): void;
  toast(msg: string, info?: boolean): void;
  modal(content: HTMLElement): () => void;
  /** Display name of a weapon id. */
  weaponName(id: string): string;
  /** Graphics to draw over the replay (the live scenario's). */
  graphics(): SimState['graphics'];
}

function fmt(t: number): string {
  const s = Math.max(0, Math.floor(t));
  return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export class AarPlayer {
  active = false;
  private rec: Recording | null = null;
  private t = 0;
  private shownT = 0;
  private playing = false;
  private speed = 4;
  private last = 0;
  private raf = 0;
  private bar: HTMLElement;
  private slider!: HTMLInputElement;
  private timeLabel!: HTMLElement;
  private playBtn!: HTMLButtonElement;
  private marks!: HTMLElement;
  private lastLogT = -1;

  constructor(
    private readonly host: AarHost,
    parent: HTMLElement,
  ) {
    this.bar = h('div', { id: 'aar-bar', class: 'aar-bar hidden' });
    parent.prepend(this.bar);
  }

  async enter(): Promise<void> {
    try {
      this.rec = await this.host.api.v1<Recording>('GET', '/recording/data');
    } catch (err) {
      this.host.toast(`No recording: ${(err as Error).message}`);
      return;
    }
    if (!this.rec.frames.length) {
      this.host.toast('Nothing recorded yet');
      return;
    }
    this.active = true;
    document.body.classList.add('aar');
    this.buildBar();
    this.bar.classList.remove('hidden');
    this.seek(this.rec.start);
  }

  exit(): void {
    this.pause();
    this.active = false;
    this.rec = null;
    document.body.classList.remove('aar');
    this.bar.classList.add('hidden');
    clear(this.bar);
    this.host.exited();
  }

  private buildBar(): void {
    const rec = this.rec!;
    clear(this.bar);
    this.playBtn = h('button', { class: 'primary', text: '▶', title: 'Play / pause', onclick: () => (this.playing ? this.pause() : this.play()) }) as HTMLButtonElement;
    const speed = h('select', { title: 'Replay speed', onchange: (e: Event) => (this.speed = Number((e.target as HTMLSelectElement).value)) }, SPEEDS.map((s) => h('option', { value: String(s), text: `${s}×`, selected: s === this.speed })));
    this.slider = h('input', { type: 'range', min: String(rec.start), max: String(rec.end), step: '0.1', value: String(rec.start), class: 'aar-slider' }) as HTMLInputElement;
    this.slider.addEventListener('input', () => this.seek(Number(this.slider.value)));
    this.timeLabel = h('span', { class: 'sim-time' });
    this.marks = h('div', { class: 'aar-marks' });
    const note = h('input', { type: 'text', placeholder: 'Bookmark note…', class: 'aar-note' }) as HTMLInputElement;
    const addMark = async () => {
      if (!note.value.trim()) return;
      try {
        const b = await this.host.api.v1<{ id: string; time: number; text: string }>('POST', '/recording/bookmarks', { text: note.value.trim(), time: this.t });
        rec.bookmarks.push(b);
        rec.bookmarks.sort((a, c) => a.time - c.time);
        note.value = '';
        this.drawMarks();
      } catch (err) {
        this.host.toast(String((err as Error).message));
      }
    };
    note.addEventListener('keydown', (e) => e.key === 'Enter' && addMark());
    this.bar.append(
      h('strong', { text: 'AAR' }),
      h('button', { text: '⏮', title: 'Back to the start', onclick: () => this.seek(rec.start) }),
      this.playBtn,
      speed,
      this.timeLabel,
      h('div', { class: 'aar-track' }, this.marks, this.slider),
      note,
      h('button', { text: 'Bookmark', onclick: addMark }),
      h('button', { text: 'Report', onclick: () => this.report() }),
      h('button', { text: 'Save…', title: 'Save this recording on the server', onclick: () => this.save() }),
      h('button', { text: 'Exit', onclick: () => this.exit() }),
    );
    this.drawMarks();
  }

  /** Ticks on the timeline: bookmarks (yellow) and kills (red), clickable. */
  private drawMarks(): void {
    const rec = this.rec!;
    clear(this.marks);
    const span = Math.max(1e-6, rec.end - rec.start);
    const pos = (t: number) => `${((t - rec.start) / span) * 100}%`;
    for (const ev of rec.events) {
      if (ev.kind !== 'destroyed') continue;
      this.marks.append(h('span', { class: 'aar-mark kill', style: `left:${pos(ev.time)}`, title: `${fmt(ev.time)} ${ev.text}`, onclick: () => this.seek(ev.time) }));
    }
    for (const b of rec.bookmarks) {
      this.marks.append(h('span', { class: 'aar-mark bookmark', style: `left:${pos(b.time)}`, title: `${fmt(b.time)} ${b.text}`, onclick: () => this.seek(b.time) }));
    }
  }

  private play(): void {
    if (!this.rec) return;
    if (this.t >= this.rec.end) this.seek(this.rec.start);
    this.playing = true;
    this.playBtn.textContent = '⏸';
    this.last = performance.now();
    const tick = (now: number) => {
      if (!this.playing || !this.rec) return;
      const dt = Math.min(0.25, (now - this.last) / 1000);
      this.last = now;
      const next = Math.min(this.rec.end, this.t + dt * this.speed);
      this.seek(next, true);
      if (next >= this.rec.end) this.pause();
      else this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  private pause(): void {
    this.playing = false;
    cancelAnimationFrame(this.raf);
    if (this.playBtn) this.playBtn.textContent = '▶';
  }

  /** Show the recorded situation at time t. */
  seek(t: number, playing = false): void {
    const rec = this.rec;
    if (!rec) return;
    this.t = Math.min(rec.end, Math.max(rec.start, t));
    if (!playing) this.pause();
    const s = stateAt(rec, this.t, (x, y) => this.host.surface(x, y));
    const state: SimState = { time: this.t, running: false, timeScale: this.speed, scenarioName: `${rec.scenarioName} (AAR)`, entities: s.entities, units: s.units, graphics: this.host.graphics() };
    // Effects only for events passed while playing forward a short step.
    const forward = this.t > this.shownT && this.t - this.shownT < 5;
    const fresh = forward ? rec.events.filter((e) => e.time > this.shownT && e.time <= this.t) : [];
    // Rebuilding the log is the expensive part: at most a few times a second while playing.
    const now = performance.now();
    let log: SimEvent[] = [];
    if (!playing || now - this.lastLogT > 250) {
      this.lastLogT = now;
      log = rec.events.filter((e) => e.time <= this.t);
    }
    this.shownT = this.t;
    this.host.show(state, fresh, log);
    this.slider.value = String(this.t);
    this.timeLabel.textContent = `${fmt(this.t)} / ${fmt(rec.end)}`;
  }

  private async save(): Promise<void> {
    const name = prompt('Save recording as (letters, digits, - and _):', (this.rec?.scenarioName ?? 'recording').replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 40));
    if (!name) return;
    try {
      await this.host.api.v1('PUT', `/recordings/${encodeURIComponent(name)}`);
      this.host.toast(`Saved recording "${name}"`, true);
    } catch (err) {
      this.host.toast(String((err as Error).message));
    }
  }

  private downloadFile(path: string, name: string): void {
    this.host.api.download(path, name).catch((err) => this.host.toast(String((err as Error).message)));
  }

  private async report(): Promise<void> {
    let r: AarReport;
    try {
      r = await this.host.api.v1<AarReport>('GET', '/recording/report');
    } catch (err) {
      this.host.toast(String((err as Error).message));
      return;
    }
    const table = (head: string[], rows: (string | number)[][]) =>
      h('table', { class: 'aar-table' }, h('thead', {}, h('tr', {}, head.map((c) => h('th', { text: c })))), h('tbody', {}, rows.map((row) => h('tr', {}, row.map((c) => h('td', { text: String(c) }))))));
    const forceCell = (f: ForceId) => FORCE_NAMES[f] ?? String(f);
    let close = () => {};
    close = this.host.modal(
      h(
        'div',
        { class: 'aar-report' },
        h('h3', { text: `After-action review: ${r.scenarioName}` }),
        h('p', { class: 'hint', text: `${fmt(r.start)} to ${fmt(r.end)} · ${r.frames} frames · ${r.detections} detections` }),
        table(
          ['Force', 'Start', 'End', 'Losses', 'Kills', 'Rounds fired'],
          r.forces.map((f) => [forceCell(f.force), f.start, f.end, f.losses, f.kills, f.shots]),
        ),
        h('h4', { text: 'Strength over time' }),
        strengthChart(r),
        h('h4', { text: `Kills (${r.kills.length})` }),
        r.kills.length
          ? table(
              ['Time', 'Victim', 'Killed by', 'Weapon'],
              r.kills.map((k) => [fmt(k.time), `${k.victim} (${forceCell(k.victimForce)})`, k.killer ?? '—', k.weaponId ? this.host.weaponName(k.weaponId) : '—']),
            )
          : h('p', { class: 'hint', text: 'None.' }),
        h('h4', { text: 'Rounds fired by weapon' }),
        table(
          ['Weapon', 'Rounds'],
          Object.entries(r.shotsByWeapon)
            .sort((a, b) => b[1] - a[1])
            .map(([w, n]) => [this.host.weaponName(w), n]),
        ),
        r.bookmarks.length ? h('h4', { text: 'Bookmarks' }) : null,
        r.bookmarks.length ? table(['Time', 'Note'], r.bookmarks.map((b) => [fmt(b.time), b.text])) : null,
        h(
          'div',
          { class: 'row' },
          h('button', { text: 'Download PDF', onclick: () => this.downloadFile('/recording/report.pdf', 'aar-report.pdf') }),
          h('button', { text: 'Kills CSV', onclick: () => this.downloadFile('/recording/kills.csv', 'kills.csv') }),
          h('button', { text: 'Events CSV', onclick: () => this.downloadFile('/recording/events.csv', 'events.csv') }),
          h('button', { text: 'Strength CSV', onclick: () => this.downloadFile('/recording/strength.csv', 'strength.csv') }),
          h('button', { text: 'Close', onclick: () => close() }),
        ),
      ),
    );
    widenModal();
  }
}

function widenModal(): void {
  document.getElementById('modal-body')?.classList.add('wide');
}

/** Line chart of alive entities per force, with a hover readout and end labels. */
function strengthChart(r: AarReport): HTMLElement {
  const W = 640;
  const H = 180;
  const pad = { l: 34, r: 64, t: 8, b: 22 };
  const forces = r.forces.map((f) => f.force);
  const max = Math.max(1, ...r.forces.map((f) => f.start), ...r.strength.flatMap((s) => Object.values(s.alive) as number[]));
  const t0 = r.strength[0]?.time ?? r.start;
  const t1 = Math.max(t0 + 1, r.strength[r.strength.length - 1]?.time ?? r.end);
  const x = (t: number) => pad.l + ((t - t0) / (t1 - t0)) * (W - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - v / max) * (H - pad.t - pad.b);
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'aar-chart');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Alive entities per force over simulated time');
  const el = (tag: string, attrs: Record<string, string | number>, text?: string) => {
    const n = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
    if (text !== undefined) n.textContent = text;
    svg.append(n);
    return n;
  };
  // Recessive grid and axes.
  for (const v of [0, Math.round(max / 2), max]) {
    el('line', { x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v), class: 'grid' });
    el('text', { x: pad.l - 6, y: y(v) + 4, 'text-anchor': 'end', class: 'axis' }, String(v));
  }
  for (const t of [t0, (t0 + t1) / 2, t1]) el('text', { x: x(t), y: H - 6, 'text-anchor': 'middle', class: 'axis' }, fmt(t));
  // One 2px line per force, labelled at its end (labels nudged apart so they never overlap).
  const end = r.strength[r.strength.length - 1];
  const labels: { f: ForceId; y: number }[] = [];
  for (const f of forces) {
    const pts = r.strength.map((s) => `${x(s.time).toFixed(1)},${y(s.alive[f] ?? 0).toFixed(1)}`).join(' ');
    el('polyline', { points: pts, fill: 'none', stroke: FORCE_COLORS[f].fill, 'stroke-width': 2, 'stroke-linejoin': 'round' });
    if (end) labels.push({ f, y: y(end.alive[f] ?? 0) + 4 });
  }
  labels.sort((a, b) => a.y - b.y);
  for (let i = 1; i < labels.length; i++) labels[i].y = Math.max(labels[i].y, labels[i - 1].y + 13);
  for (const l of labels) el('text', { x: x(end!.time) + 6, y: l.y, class: 'label' }, `${FORCE_NAMES[l.f]} ${end!.alive[l.f] ?? 0}`);
  // Hover: crosshair and a readout of every force at that time.
  const cross = el('line', { y1: pad.t, y2: H - pad.b, class: 'cross', visibility: 'hidden' });
  const readout = h('div', { class: 'aar-readout hint', text: 'Hover the chart for values.' });
  svg.addEventListener('mousemove', (ev) => {
    const box = svg.getBoundingClientRect();
    const px = ((ev.clientX - box.left) / box.width) * W;
    let best = r.strength[0];
    for (const s of r.strength) if (Math.abs(x(s.time) - px) < Math.abs(x(best.time) - px)) best = s;
    if (!best) return;
    cross.setAttribute('x1', String(x(best.time)));
    cross.setAttribute('x2', String(x(best.time)));
    cross.setAttribute('visibility', 'visible');
    readout.textContent = `${fmt(best.time)}  ·  ${forces.map((f) => `${FORCE_NAMES[f]} ${best.alive[f] ?? 0}`).join('  ·  ')}`;
  });
  svg.addEventListener('mouseleave', () => cross.setAttribute('visibility', 'hidden'));
  const legend = h('div', { class: 'aar-legend' }, forces.map((f) => h('span', {}, h('i', { style: `background:${FORCE_COLORS[f].fill}` }), FORCE_NAMES[f])));
  return h('div', {}, legend, svg as unknown as HTMLElement, readout);
}
