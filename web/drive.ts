// Drive mode: control one entity by hand. W/S throttle, A/D turn, T pick a target, C clear
// it, X stop, Esc hand it back. The map follows it; a panel shows its state.

import type { Command, EntitySnapshot } from '../src/shared/types.js';
import { clear, fmtDeg, h } from './dom.js';

export interface DriveHost {
  entity(id: string): EntitySnapshot | undefined;
  cmd(c: Command): Promise<{ ok: boolean; error?: string }>;
  pickEntity(label: string, onPick: (id: string) => void): void;
  follow(id: string): void;
  weaponName(id: string): string;
  toast(msg: string, info?: boolean): void;
}

export class DriveMode {
  id: string | null = null;
  private throttle = 0;
  private turn = 0;
  private keepalive = 0;
  private readonly onKey = (e: KeyboardEvent) => this.key(e, true);
  private readonly onKeyUp = (e: KeyboardEvent) => this.key(e, false);

  constructor(
    private readonly hud: HTMLElement,
    private readonly host: DriveHost,
  ) {}

  get active(): boolean {
    return this.id !== null;
  }

  start(id: string): void {
    if (this.id) this.stop(false);
    const e = this.host.entity(id);
    if (!e || e.remote || e.damage === 'destroyed') return this.host.toast('Pick one of your own, working entities to drive');
    this.id = id;
    this.throttle = 0;
    this.turn = 0;
    void this.send({ throttle: 0, turn: 0 });
    // Capture, so driving keys do not also reach the rest of the GUI.
    window.addEventListener('keydown', this.onKey, true);
    window.addEventListener('keyup', this.onKeyUp, true);
    this.keepalive = window.setInterval(() => this.turn && void this.send({ turn: this.turn }), 500);
    this.hud.classList.remove('hidden');
    this.update();
  }

  /** Hand it back: stop it (its task ends). */
  stop(halt = true): void {
    if (!this.id) return;
    const id = this.id;
    this.id = null;
    window.removeEventListener('keydown', this.onKey, true);
    window.removeEventListener('keyup', this.onKeyUp, true);
    window.clearInterval(this.keepalive);
    this.hud.classList.add('hidden');
    if (halt) void this.host.cmd({ cmd: 'stop', targetId: id });
  }

  private async send(input: { throttle?: number; turn?: number; targetId?: string | null }): Promise<void> {
    if (!this.id) return;
    const r = await this.host.cmd({ cmd: 'drive', id: this.id, ...input });
    if (!r.ok) this.stop(false);
  }

  private key(e: KeyboardEvent, down: boolean): void {
    if ((e.target as HTMLElement)?.closest('input, textarea, select')) return;
    const k = e.key.toLowerCase();
    const handled = ['w', 's', 'a', 'd', 'x', 't', 'c', 'escape', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k);
    if (!handled) return;
    e.preventDefault();
    e.stopPropagation();
    if (!down) {
      if (['a', 'd', 'arrowleft', 'arrowright'].includes(k) && this.turn) {
        this.turn = 0;
        void this.send({ turn: 0 });
      }
      return;
    }
    if (e.repeat && !['a', 'd', 'arrowleft', 'arrowright'].includes(k)) return;
    switch (k) {
      case 'w':
      case 'arrowup':
        this.throttle = Math.min(1, Math.round((this.throttle + 0.25) * 4) / 4);
        void this.send({ throttle: this.throttle });
        break;
      case 's':
      case 'arrowdown':
        this.throttle = Math.max(0, Math.round((this.throttle - 0.25) * 4) / 4);
        void this.send({ throttle: this.throttle });
        break;
      case 'x':
        this.throttle = 0;
        void this.send({ throttle: 0, turn: 0 });
        break;
      case 'a':
      case 'arrowleft':
      case 'd':
      case 'arrowright': {
        const turn = k === 'a' || k === 'arrowleft' ? -1 : 1;
        if (turn !== this.turn) {
          this.turn = turn;
          void this.send({ turn });
        }
        break;
      }
      case 't':
        this.host.pickEntity('Click the target to engage', (t) => void this.send({ targetId: t }));
        break;
      case 'c':
        void this.send({ targetId: null });
        break;
      case 'escape':
        this.stop();
        break;
    }
    this.update();
  }

  /** Refresh the panel (and keep the map on it) from the latest state. */
  update(): void {
    if (!this.id) return;
    const e = this.host.entity(this.id);
    if (!e || e.damage === 'destroyed') {
      this.host.toast(e ? `${e.name} was destroyed` : 'Lost the entity', true);
      this.stop(false);
      return;
    }
    this.host.follow(this.id);
    clear(this.hud);
    const target = e.engagingId ? this.host.entity(e.engagingId) : undefined;
    this.hud.append(
      h('div', { class: 'drive-title', text: `Driving ${e.name}` }),
      h('div', { class: 'kv' }, 'Speed', h('span', { text: `${Math.round(e.speed * 3.6)} km/h` }), 'Heading', h('span', { text: fmtDeg(e.heading) }), 'Throttle', h('span', { class: 'meter' }, h('span', { style: `width:${this.throttle * 100}%;background:var(--accent)` })), 'Target', h('span', { text: target ? target.name : e.task?.includes('engaging') ? e.task.split('engaging ')[1] : 'none (T to pick)' }), 'Damage', h('span', { text: e.damage })),
      h('div', { class: 'hint', text: e.ammo.map((a) => `${this.host.weaponName(a.weapon)} ${a.rounds}`).join(' · ') }),
      h('div', { class: 'hint drive-keys', text: 'W/S throttle · A/D turn · X stop · T target · C clear target · Esc hand back' }),
    );
  }
}
