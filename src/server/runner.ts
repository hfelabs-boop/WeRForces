// Real-time execution of the engine: run/pause, time multiplier and fixed-step pacing.

import type { DisGateway } from '../dis/gateway.js';
import { DEFAULT_DT, type Engine } from '../sim/engine.js';
import { Recorder } from '../sim/recorder.js';
import type { ScenarioFile, SimState } from '../shared/types.js';

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
  /** Checkpoints before each edit, for undo, and of undone states, for redo. */
  readonly undoStack: ScenarioFile[] = [];
  readonly redoStack: ScenarioFile[] = [];
  /** How many edits can be undone (0: no undo history). */
  undoLimit = 30;

  constructor(
    readonly engine: Engine,
    readonly dt = DEFAULT_DT,
    readonly frameMs = 50,
    recordInterval = 1,
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
    const now = performance.now();
    const elapsed = Math.min(0.5, (now - this.last) / 1000);
    this.last = now;
    if (this.running) {
      this.accumulator += elapsed * this.timeScale;
      let steps = 0;
      while (this.accumulator >= this.dt && steps < 400) {
        this.engine.step(this.dt);
        this.accumulator -= this.dt;
        steps++;
      }
      if (steps >= 400) this.accumulator = 0; // falling behind: drop time rather than spiral
    }
    this.gateway?.update(this.running, this.timeScale);
    for (const fn of this.frameListeners) fn();
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
    s.running = this.running;
    s.timeScale = this.timeScale;
    if (this.gateway) s.dis = this.gateway.status();
    return s;
  }
}
