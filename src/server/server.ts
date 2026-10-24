// HTTP + WebSocket server: serves the front-end, the REST remote-control API and a
// WebSocket stream of simulation state and events.

import { createReadStream, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import type { ClientMessage, ServerMessage, SimEvent } from '../shared/types.js';
import { executeCommand } from './commands.js';
import type { SimRunner } from './runner.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};
const MAX_BODY = 8 * 1024 * 1024;
const SCENARIO_NAME = /^[A-Za-z0-9_-]{1,64}$/;

export interface ServerOptions {
  port: number;
  host: string;
  webRoot: string;
  scenarioDir: string;
  /** State broadcasts per second. */
  stateRate?: number;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(data);
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

export class SimServer {
  readonly http: http.Server;
  private wss: WebSocketServer;
  private terrainCache: { version: number; json: string } | null = null;
  private lastTerrainVersion: number;
  private pendingEvents: SimEvent[] = [];
  private frameCount = 0;

  constructor(
    readonly runner: SimRunner,
    readonly opts: ServerOptions,
  ) {
    this.lastTerrainVersion = runner.engine.terrainVersion;
    this.http = http.createServer((req, res) => {
      this.handle(req, res).catch((err) => sendJson(res, 500, { ok: false, error: String(err?.message ?? err) }));
    });
    this.wss = new WebSocketServer({ server: this.http, path: '/ws', maxPayload: MAX_BODY });
    this.wss.on('connection', (ws) => this.onConnection(ws));
    runner.engine.on('event', (ev) => this.pendingEvents.push(ev));
    const every = Math.max(1, Math.round(1000 / runner.frameMs / (opts.stateRate ?? 10)));
    runner.onFrame(() => {
      if (this.runner.engine.terrainVersion !== this.lastTerrainVersion) {
        this.lastTerrainVersion = this.runner.engine.terrainVersion;
        this.broadcast({ type: 'terrainChanged', terrainVersion: this.lastTerrainVersion });
      }
      if (this.pendingEvents.length) {
        this.broadcast({ type: 'events', events: this.pendingEvents });
        this.pendingEvents = [];
      }
      if (++this.frameCount % every === 0 && this.wss.clients.size > 0) {
        this.broadcast({ type: 'state', state: this.runner.state() });
      }
    });
  }

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.http.once('error', reject);
      this.http.listen(this.opts.port, this.opts.host, () => {
        this.http.off('error', reject);
        resolve();
      });
    });
  }

  close(): Promise<void> {
    for (const c of this.wss.clients) c.terminate();
    this.wss.close();
    return new Promise((resolve) => this.http.close(() => resolve()));
  }

  get address(): string {
    const a = this.http.address();
    return typeof a === 'object' && a ? `http://${this.opts.host === '0.0.0.0' ? 'localhost' : this.opts.host}:${a.port}` : '';
  }

  private broadcast(msg: ServerMessage): void {
    const data = JSON.stringify(msg);
    for (const c of this.wss.clients) if (c.readyState === WebSocket.OPEN) c.send(data);
  }

  private onConnection(ws: WebSocket): void {
    const engine = this.runner.engine;
    const hello: ServerMessage = { type: 'hello', catalog: engine.catalog.catalog, scenarioName: engine.scenarioName, terrainVersion: engine.terrainVersion };
    ws.send(JSON.stringify(hello));
    ws.send(JSON.stringify({ type: 'events', events: engine.eventsSince(0).slice(-200) } satisfies ServerMessage));
    ws.send(JSON.stringify({ type: 'state', state: this.runner.state() } satisfies ServerMessage));
    ws.on('message', (data) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg?.type !== 'command') return;
      const result = executeCommand(this.runner, msg.command);
      ws.send(JSON.stringify({ type: 'result', reqId: msg.reqId, result } satisfies ServerMessage));
      // Push state right away so the UI reflects the change without waiting a frame.
      this.broadcast({ type: 'state', state: this.runner.state() });
    });
  }

  private terrainJson(): string {
    const engine = this.runner.engine;
    if (!this.terrainCache || this.terrainCache.version !== engine.terrainVersion) {
      this.terrainCache = { version: engine.terrainVersion, json: JSON.stringify(engine.terrain.toData()) };
    }
    return this.terrainCache.json;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const p = url.pathname;
    const engine = this.runner.engine;
    if (p.startsWith('/api/')) {
      if (req.method === 'GET' && p === '/api/catalog') return sendJson(res, 200, engine.catalog.catalog);
      if (req.method === 'GET' && p === '/api/terrain') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(this.terrainJson());
        return;
      }
      if (req.method === 'GET' && p === '/api/state') return sendJson(res, 200, this.runner.state());
      if (req.method === 'GET' && p === '/api/events') return sendJson(res, 200, engine.eventsSince(Number(url.searchParams.get('since') ?? 0)));
      if (req.method === 'GET' && p === '/api/scenario') return sendJson(res, 200, engine.toScenario());
      if (req.method === 'GET' && p.startsWith('/api/path/')) return sendJson(res, 200, engine.plannedPath(decodeURIComponent(p.slice('/api/path/'.length))));
      if (req.method === 'POST' && p === '/api/command') {
        const body = await readBody(req).catch((e: Error) => e);
        if (body instanceof Error) return sendJson(res, 400, { ok: false, error: body.message });
        const result = executeCommand(this.runner, body);
        return sendJson(res, result.ok ? 200 : 400, result);
      }
      if (p === '/api/scenarios' && req.method === 'GET') return sendJson(res, 200, this.listScenarios());
      if (p.startsWith('/api/scenarios/')) {
        const name = decodeURIComponent(p.slice('/api/scenarios/'.length));
        if (!SCENARIO_NAME.test(name)) return sendJson(res, 400, { ok: false, error: 'invalid scenario name' });
        const file = path.join(this.opts.scenarioDir, `${name}.json`);
        if (req.method === 'GET') {
          if (!existsSync(file)) return sendJson(res, 404, { ok: false, error: 'not found' });
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          res.end(readFileSync(file));
          return;
        }
        if (req.method === 'PUT' || req.method === 'POST') {
          writeFileSync(file, JSON.stringify(engine.toScenario(), null, 2));
          return sendJson(res, 200, { ok: true, id: name });
        }
      }
      return sendJson(res, 404, { ok: false, error: 'unknown endpoint' });
    }
    return this.serveStatic(p, res);
  }

  private listScenarios(): { name: string; title: string; description: string }[] {
    if (!existsSync(this.opts.scenarioDir)) return [];
    return readdirSync(this.opts.scenarioDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        const name = f.replace(/\.json$/, '');
        try {
          const s = JSON.parse(readFileSync(path.join(this.opts.scenarioDir, f), 'utf8'));
          return { name, title: String(s.name ?? name), description: String(s.description ?? '') };
        } catch {
          return { name, title: name, description: '(unreadable)' };
        }
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  private serveStatic(p: string, res: http.ServerResponse): void {
    const rel = p === '/' ? 'index.html' : decodeURIComponent(p).replace(/^\/+/, '');
    const root = path.resolve(this.opts.webRoot);
    const file = path.resolve(root, rel);
    if (!file.startsWith(root + path.sep) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end(existsSync(root) ? 'Not found' : 'Front-end not built. Run `npm run build:web`.');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  }
}
