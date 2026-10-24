// WebSocket client for the WeRForces remote-control API.

import type { Catalog, Command, CommandResult, ServerMessage, SimEvent, SimState, TerrainData } from '../src/shared/types.js';

export interface ApiHandlers {
  hello(catalog: Catalog, terrainVersion: number): void;
  state(state: SimState): void;
  events(events: SimEvent[]): void;
  terrainChanged(version: number): void;
  connection(connected: boolean): void;
}

const KEY_STORAGE = 'werforces.apiKey';

function storedKey(): string | null {
  try {
    return localStorage.getItem(KEY_STORAGE);
  } catch {
    return null;
  }
}

export class Api {
  private ws: WebSocket | null = null;
  private reqId = 0;
  private pending = new Map<number, (r: CommandResult) => void>();
  /** API key, when the server was started with --api-key. */
  key: string | null = new URLSearchParams(location.search).get('api_key') ?? storedKey();

  constructor(private readonly handlers: ApiHandlers) {}

  headers(json = false): Record<string, string> {
    const h: Record<string, string> = {};
    if (this.key) h.Authorization = `Bearer ${this.key}`;
    if (json) h['Content-Type'] = 'application/json';
    return h;
  }

  /** Make sure we hold a valid API key if the server requires one. */
  async ensureAuth(): Promise<void> {
    for (;;) {
      const r = await fetch('/api/v1', { headers: this.headers() });
      if (r.status !== 401) return;
      const key = prompt('This WeRForces server requires an API key:');
      if (!key) return;
      this.key = key;
      try {
        localStorage.setItem(KEY_STORAGE, key);
      } catch {
        // storage unavailable: keep the key for this page only
      }
    }
  }

  /** Call the /api/v1 REST API. */
  async v1<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await fetch(`/api/v1${path}`, { method, headers: this.headers(true), body: body === undefined ? (method === 'GET' || method === 'DELETE' ? undefined : '{}') : JSON.stringify(body) });
    if (r.status === 204) return undefined as T;
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data?.error?.message ?? `HTTP ${r.status}`);
    return data as T;
  }

  /** URL with the API key appended (for links the browser or Google Earth opens directly). */
  link(path: string): string {
    return this.key ? `${path}${path.includes('?') ? '&' : '?'}api_key=${encodeURIComponent(this.key)}` : path;
  }

  connect(): void {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}${this.link('/ws')}`);
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
    const r = await fetch('/api/terrain', { headers: this.headers() });
    return r.json();
  }

  async plannedPath(id: string): Promise<{ x: number; y: number }[]> {
    const r = await fetch(`/api/path/${encodeURIComponent(id)}`, { headers: this.headers() });
    return r.ok ? r.json() : [];
  }

  async scenario(): Promise<unknown> {
    const r = await fetch('/api/scenario', { headers: this.headers() });
    return r.json();
  }

  async listScenarios(): Promise<{ name: string; title: string; description: string }[]> {
    const r = await fetch('/api/scenarios', { headers: this.headers() });
    return r.json();
  }

  async fetchScenario(name: string): Promise<unknown> {
    const r = await fetch(`/api/scenarios/${encodeURIComponent(name)}`, { headers: this.headers() });
    if (!r.ok) throw new Error(`could not load ${name}`);
    return r.json();
  }

  async saveScenarioOnServer(name: string): Promise<CommandResult> {
    const r = await fetch(`/api/scenarios/${encodeURIComponent(name)}`, { method: 'PUT', headers: this.headers(true), body: '{}' });
    const data = await r.json();
    return r.ok ? { ok: true, id: name } : { ok: false, error: data?.error?.message ?? `HTTP ${r.status}` };
  }
}
