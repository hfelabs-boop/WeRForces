// Real-time execution of the engine: run/pause, time multiplier and fixed-step pacing.

import type { DisGateway } from '../dis/gateway.js';
import { DEFAULT_DT, type Engine } from '../sim/engine.js';
import type { SimState } from '../shared/types.js';

export class SimRunner {
  running = false;
  timeScale = 1;
  gateway: DisGateway | null = null;
  private timer: NodeJS.Timeout | null = null;
  private last = 0;
  private accumulator = 0;
  private frameListeners: (() => void)[] = [];

  constructor(
    readonly engine: Engine,
    readonly dt = DEFAULT_DT,
    readonly frameMs = 50,
  ) {}

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

  state(): SimState {
    const s = this.engine.snapshot();
    s.running = this.running;
    s.timeScale = this.timeScale;
    if (this.gateway) s.dis = this.gateway.status();
    return s;
  }
}
