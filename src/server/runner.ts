// Real-time execution of the engine: run/pause, time multiplier and fixed-step pacing.

import type { DisGateway } from '../dis/gateway.js';
import { DEFAULT_DT, type Engine } from '../sim/engine.js';
import { Recorder } from '../sim/recorder.js';
import type { ScenarioFile, SimState } from '../shared/types.js';

/** Longest stretch of stepping before yielding to I/O. */
const SLICE_MS = 15;
/** Steps per frame before the runner gives up catching up. */
const MAX_STEPS_PER_FRAME = 400;

export class SimRunner {
  running = false;
  timeScale = 1;
  gateway: DisGateway | null = null;
  /** Continuous recording for playback and after-action review (null when disabled). */
  recorder: Recorder | null;
  private timer: NodeJS.Timeout | null = null;
  private last = 0;
  private accumulator = 0;
  private frameListeners: (() => void)[] = [];
  private stepping = false;
  private frameSteps = 0;
  private busyMs = 0;
  private loadSince = performance.now();
  private lastLoad = 0;
  /** Checkpoints before each edit, for undo, and of undone states, for redo. */
  readonly undoStack: ScenarioFile[] = [];
  readonly redoStack: ScenarioFile[] = [];
  /** How many edits can be undone (0: no undo history). */
  undoLimit = 30;

  constructor(
    readonly engine: Engine,
    readonly dt = DEFAULT_DT,
    readonly frameMs = 50,
    /** Seconds between recorded frames (0: no recording). */
    readonly recordInterval = 1,
  ) {
    this.recorder = recordInterval > 0 ? new Recorder(engine, { interval: recordInterval }) : null;
  }

  start(): void {
    if (this.timer) return;
    this.last = performance.now();
    this.timer = setInterval(() => this.frame(), this.frameMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  onFrame(fn: () => void): void {
    this.frameListeners.push(fn);
  }

  setRunning(run: boolean): void {
    this.running = run;
    this.accumulator = 0;
  }

  setTimeScale(scale: number): void {
    if (!Number.isFinite(scale) || scale <= 0 || scale > 64) throw new Error('time scale must be in (0, 64]');
    this.timeScale = scale;
  }

  /** Advance a fixed amount of simulated time immediately (used while paused). */
  stepFor(seconds: number): void {
    this.engine.runFor(seconds, this.dt);
    this.gateway?.update(this.running, this.timeScale);
  }

  private frame(): void {
    // Still working through the previous frame's steps.
    if (this.stepping) return;
    const now = performance.now();
    const elapsed = Math.min(0.5, (now - this.last) / 1000);
    this.last = now;
    if (this.running) this.accumulator += elapsed * this.timeScale;
    this.stepping = true;
    this.frameSteps = 0;
    this.slice();
  }

  /**
   * Step the engine for at most SLICE_MS, then yield to the event loop so HTTP and
   * WebSocket traffic is served between slices; finish the frame when caught up.
   */
  private slice(): void {
    const t0 = performance.now();
    while (this.running && this.accumulator >= this.dt && this.frameSteps < MAX_STEPS_PER_FRAME) {
      this.engine.step(this.dt);
      this.accumulator -= this.dt;
      this.frameSteps++;
      if (performance.now() - t0 > SLICE_MS) {
        this.busyMs += performance.now() - t0;
        setImmediate(() => this.slice());
        return;
      }
    }
    this.busyMs += performance.now() - t0;
    // Falling behind: drop time rather than spiral.
    if (this.frameSteps >= MAX_STEPS_PER_FRAME) this.accumulator = 0;
    this.stepping = false;
    this.measureLoad();
    this.gateway?.update(this.running, this.timeScale);
    for (const fn of this.frameListeners) fn();
  }

  /** Share of wall-clock time spent stepping the simulation over the last second or so (0-1). */
  get load(): number {
    return this.lastLoad;
  }

  private measureLoad(): void {
    const now = performance.now();
    if (now - this.loadSince < 1000) return;
    this.lastLoad = Math.min(1, Math.round((this.busyMs / (now - this.loadSince)) * 100) / 100);
    this.busyMs = 0;
    this.loadSince = now;
  }

  /** Remember the state before an edit. */
  pushUndo(before: ScenarioFile): void {
    if (this.undoLimit <= 0) return;
    this.undoStack.push(before);
    if (this.undoStack.length > this.undoLimit) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  undo(): boolean {
    const prev = this.undoStack.pop();
    if (!prev) return false;
    this.redoStack.push(this.engine.toScenario());
    this.engine.restoreCheckpoint(prev, 'Undo');
    return true;
  }

  redo(): boolean {
    const next = this.redoStack.pop();
    if (!next) return false;
    this.undoStack.push(this.engine.toScenario());
    this.engine.restoreCheckpoint(next, 'Redo');
    return true;
  }

  state(): SimState {
    const s = this.engine.snapshot();
    if (this.undoLimit > 0) s.history = { undo: this.undoStack.length, redo: this.redoStack.length };
    if (this.running) s.load = this.load;
    s.running = this.running;
    s.timeScale = this.timeScale;
    if (this.gateway) s.dis = this.gateway.status();
    return s;
  }
}
