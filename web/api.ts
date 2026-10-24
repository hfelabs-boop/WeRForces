// WebSocket client for the WeRForces remote-control API.

import type { Catalog, Command, CommandResult, ServerMessage, SimEvent, SimState, TerrainData } from '../src/shared/types.js';

export interface ApiHandlers {
  hello(catalog: Catalog, terrainVersion: number): void;
  state(state: SimState): void;
  events(events: SimEvent[]): void;
  terrainChanged(version: number): void;
  connection(connected: boolean): void;
}

export class Api {
  private ws: WebSocket | null = null;
  private reqId = 0;
  private pending = new Map<number, (r: CommandResult) => void>();

  constructor(private readonly handlers: ApiHandlers) {}

  connect(): void {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => this.handlers.connection(true);
    ws.onclose = () => {
      this.handlers.connection(false);
      for (const fn of this.pending.values()) fn({ ok: false, error: 'connection lost' });
      this.pending.clear();
      setTimeout(() => this.connect(), 1500);
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data as string) as ServerMessage;
      switch (msg.type) {
        case 'hello':
          this.handlers.hello(msg.catalog, msg.terrainVersion);
          break;
        case 'state':
          this.handlers.state(msg.state);
          break;
        case 'events':
          this.handlers.events(msg.events);
          break;
        case 'terrainChanged':
          this.handlers.terrainChanged(msg.terrainVersion);
          break;
        case 'result': {
          const fn = this.pending.get(msg.reqId);
          this.pending.delete(msg.reqId);
          fn?.(msg.result);
          break;
        }
      }
    };
  }

  send(command: Command): Promise<CommandResult> {
    return new Promise((resolve) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        resolve({ ok: false, error: 'not connected' });
        return;
      }
      const reqId = ++this.reqId;
      this.pending.set(reqId, resolve);
      this.ws.send(JSON.stringify({ type: 'command', reqId, command }));
    });
  }

  async terrain(): Promise<TerrainData> {
    const r = await fetch('/api/terrain');
    return r.json();
  }

  async plannedPath(id: string): Promise<{ x: number; y: number }[]> {
    const r = await fetch(`/api/path/${encodeURIComponent(id)}`);
    return r.ok ? r.json() : [];
  }

  async scenario(): Promise<unknown> {
    const r = await fetch('/api/scenario');
    return r.json();
  }

  async listScenarios(): Promise<{ name: string; title: string; description: string }[]> {
    const r = await fetch('/api/scenarios');
    return r.json();
  }

  async fetchScenario(name: string): Promise<unknown> {
    const r = await fetch(`/api/scenarios/${encodeURIComponent(name)}`);
    if (!r.ok) throw new Error(`could not load ${name}`);
    return r.json();
  }

  async saveScenarioOnServer(name: string): Promise<CommandResult> {
    const r = await fetch(`/api/scenarios/${encodeURIComponent(name)}`, { method: 'PUT' });
    return r.json();
  }
}
