// Continuous recording of a running simulation for playback and after-action review.
// Samples every entity at a fixed simulated-time interval and keeps the event log.
// Rewinding or loading a checkpoint cuts the recording back to that time.

import { aarReport, type Bookmark, encodeFlags, FRAME_STRIDE, type Recording, type RecordedEntity, type RecordedUnit, stateAt } from '../shared/recording.js';
import type { SimEvent } from '../shared/types.js';
import type { Engine } from './engine.js';

export interface RecorderOptions {
  /** Seconds of simulated time between frames (default 1). */
  interval?: number;
  /** Memory budget for frames; when exceeded, every other frame is dropped (default 256 MB). */
  maxBytes?: number;
  /** Most events kept (default 200 000). */
  maxEvents?: number;
}

interface Frame {
  t: number;
  d: Float32Array;
}

export class Recorder {
  interval: number;
  readonly maxBytes: number;
  readonly maxEvents: number;
  /** False while reviewing a loaded recording: live sampling is suspended. */
  live = true;
  private frames: Frame[] = [];
  private events: SimEvent[] = [];
  private bookmarks: Bookmark[] = [];
  private entities: RecordedEntity[] = [];
  private index = new Map<string, number>();
  private units = new Map<string, RecordedUnit>();
  private bytes = 0;
  private nextAt = 0;
  private bookmarkSeq = 0;
  private scenarioName = '';
  private loaded: Recording | null = null;
  private unsubscribe: (() => void)[] = [];

  constructor(
    readonly engine: Engine,
    opts: RecorderOptions = {},
  ) {
    this.interval = opts.interval ?? 1;
    this.maxBytes = opts.maxBytes ?? 256e6;
    this.maxEvents = opts.maxEvents ?? 200_000;
    this.scenarioName = engine.scenarioName;
    this.unsubscribe.push(
      engine.on('event', (ev) => this.onEvent(ev)),
      engine.on('step', () => this.onStep()),
      engine.on('reset', () => this.onReset()),
    );
    this.sample();
  }

  detach(): void {
    for (const u of this.unsubscribe) u();
  }

  private onEvent(ev: SimEvent): void {
    if (!this.live) return;
    this.events.push(ev);
    if (this.events.length > this.maxEvents) this.events.splice(0, this.events.length - this.maxEvents);
    // Edits between steps (creating, deleting, tasking) refresh the current frame.
    this.touch();
  }

  /** Re-sample now if the latest frame is for the current time (e.g. after an edit while paused). */
  touch(): void {
    const last = this.frames[this.frames.length - 1];
    if (this.live && last && Math.abs(last.t - this.engine.time) < 1e-9) this.sample();
  }

  private onStep(): void {
    if (this.live && this.engine.time >= this.nextAt - 1e-9) this.sample();
  }

  private onReset(): void {
    if (!this.live) return;
    const t = this.engine.time;
    if (this.engine.scenarioName !== this.scenarioName || t === 0) {
      this.clear();
      return;
    }
    // Rewind or checkpoint: the recording continues from here.
    while (this.frames.length && this.frames[this.frames.length - 1].t >= t - 1e-9) this.bytes -= this.frames.pop()!.d.byteLength;
    this.events = this.events.filter((e) => e.time < t);
    this.bookmarks = this.bookmarks.filter((b) => b.time <= t);
    this.sample();
  }

  /** Forget everything and start recording the current scenario afresh. */
  clear(): void {
    this.live = true;
    this.loaded = null;
    this.frames = [];
    this.events = [];
    this.bookmarks = [];
    this.entities = [];
    this.index.clear();
    this.units.clear();
    this.bytes = 0;
    this.scenarioName = this.engine.scenarioName;
    this.sample();
  }

  /** Record a frame of every entity now. */
  sample(): void {
    const eng = this.engine;
    // Members inside aggregated units are recorded too (where the aggregate is), so strength stays whole.
    const hidden = eng.aggregates.hiddenMembers();
    const list = [...eng.entities.values(), ...hidden];
    const inside = new Set(hidden);
    const d = new Float32Array(list.length * FRAME_STRIDE);
    list.forEach((e, k) => {
      let i = this.index.get(e.id);
      const meta: RecordedEntity = { id: e.id, name: e.name, typeId: e.type.id, force: e.force, domain: e.domain, symbol: e.type.symbol, unitId: e.unit?.id };
      if (i === undefined) {
        i = this.entities.push(meta) - 1;
        this.index.set(e.id, i);
      } else if (this.entities[i].name !== e.name || this.entities[i].unitId !== meta.unitId) {
        this.entities[i] = meta;
      }
      const o = k * FRAME_STRIDE;
      d[o] = i;
      d[o + 1] = e.x;
      d[o + 2] = e.y;
      d[o + 3] = e.z;
      d[o + 4] = e.heading;
      d[o + 5] = e.speed;
      d[o + 6] = encodeFlags(e.damage, !!e.embarkedIn, inside.has(e));
      d[o + 7] = e.embarkedIn ? (this.index.get(e.embarkedIn) ?? -1) : -1;
    });
    // Embarked entities may refer to carriers indexed later in this frame.
    list.forEach((e, k) => {
      if (e.embarkedIn && d[k * FRAME_STRIDE + 7] < 0) d[k * FRAME_STRIDE + 7] = this.index.get(e.embarkedIn) ?? -1;
    });
    for (const u of eng.units.values()) this.units.set(u.id, { id: u.id, name: u.name, force: u.force, echelon: u.echelon, memberIds: u.memberList.map((m) => m.id) });
    const t = eng.time;
    if (this.frames.length && this.frames[this.frames.length - 1].t >= t - 1e-9) this.bytes -= this.frames.pop()!.d.byteLength;
    this.frames.push({ t, d });
    this.bytes += d.byteLength;
    this.nextAt = t + this.interval;
    if (this.bytes > this.maxBytes) this.decimate();
  }

  /** Halve the frame rate to stay within the memory budget. */
  private decimate(): void {
    const last = this.frames[this.frames.length - 1];
    this.frames = this.frames.filter((f, i) => i % 2 === 0 || f === last);
    this.bytes = this.frames.reduce((n, f) => n + f.d.byteLength, 0);
    this.interval *= 2;
    this.nextAt = last.t + this.interval;
  }

  addBookmark(text: string, time = this.engine.time): Bookmark {
    const b = { id: `B${++this.bookmarkSeq}`, time: Math.round(time * 10) / 10, text: text.slice(0, 200) };
    if (this.loaded) this.loaded.bookmarks.push(b);
    else this.bookmarks.push(b);
    (this.loaded?.bookmarks ?? this.bookmarks).sort((a, c) => a.time - c.time);
    return b;
  }

  removeBookmark(id: string): boolean {
    const list = this.loaded?.bookmarks ?? this.bookmarks;
    const i = list.findIndex((b) => b.id === id);
    if (i < 0) return false;
    list.splice(i, 1);
    return true;
  }

  /** Review a saved recording instead of the live one; live recording is suspended until clear(). */
  load(rec: Recording): void {
    if (rec?.format !== 'werforces-recording' || !Array.isArray(rec.frames) || !Array.isArray(rec.entities)) throw new Error('not a WeRForces recording');
    this.loaded = { ...rec, bookmarks: [...(rec.bookmarks ?? [])], events: rec.events ?? [], units: rec.units ?? [] };
    this.bookmarkSeq = Math.max(this.bookmarkSeq, ...this.loaded.bookmarks.map((b) => Number(b.id.slice(1)) || 0));
    this.live = false;
  }

  /** The recording as a JSON-friendly object (positions rounded to 0.1 m). */
  toJSON(): Recording {
    if (this.loaded) return this.loaded;
    this.catchUp();
    const r1 = (v: number) => Math.round(v * 10) / 10;
    const r3 = (v: number) => Math.round(v * 1000) / 1000;
    const frames = this.frames.map((f) => {
      const d = Array.from(f.d);
      for (let i = 0; i < d.length; i += FRAME_STRIDE) {
        for (const k of [1, 2, 3, 5]) d[i + k] = r1(d[i + k]);
        d[i + 4] = r3(d[i + 4]);
      }
      return { t: f.t, d };
    });
    return { ...this.header(), frames };
  }

  /** Take a frame for the current time if the last one is older, so queries reach "now". */
  private catchUp(): void {
    const last = this.frames[this.frames.length - 1];
    if (this.live && (!last || last.t < this.engine.time - 1e-9)) this.sample();
  }

  private view(): Recording {
    if (this.loaded) return this.loaded;
    this.catchUp();
    // Report and state queries do not need rounding; share the typed arrays.
    return { ...this.header(), frames: this.frames };
  }

  private header(): Omit<Recording, 'frames'> {
    return {
      format: 'werforces-recording',
      version: 1,
      scenarioName: this.scenarioName,
      terrain: this.engine.terrain.spec,
      interval: this.interval,
      start: this.frames[0]?.t ?? 0,
      end: this.frames[this.frames.length - 1]?.t ?? 0,
      entities: this.entities,
      units: [...this.units.values()],
      events: this.events,
      bookmarks: this.bookmarks,
    };
  }

  summary() {
    const r = this.view();
    return {
      live: this.live,
      scenarioName: r.scenarioName,
      start: r.start,
      end: r.end,
      interval: r.interval,
      frames: r.frames.length,
      entities: r.entities.length,
      events: r.events.length,
      bookmarks: r.bookmarks,
      bytes: this.loaded ? undefined : this.bytes,
    };
  }

  stateAt(t: number) {
    return stateAt(this.view(), t, (x, y) => this.engine.terrain.surfaceHeight(x, y));
  }

  report() {
    return aarReport(this.view());
  }
}
