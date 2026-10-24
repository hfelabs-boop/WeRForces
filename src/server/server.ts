// HTTP + WebSocket server: serves the front-end, the REST APIs (/api/v1 and the
// command endpoint used by the GUI), the MCP endpoint (/mcp) and a WebSocket stream
// of simulation state and events.

import { timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { WebSocket, WebSocketServer } from 'ws';
import { IntegrationHub, type IntegrationOptions } from '../integrations/hub.js';
import { createMcpServer, type ApiCaller } from '../mcp/tools.js';
import type { ClientMessage, CommandResult, ForceId, Role, ServerMessage, SimEvent, SimState } from '../shared/types.js';
import { ApiV1 } from './apiV1.js';
import { BatchManager } from './batch.js';
import { executeCommand } from './commands.js';
import { DocsSite } from './docs.js';
import { CONTROLLER, checkCommand, filterEvents, filterState, ForbiddenError } from './fog.js';
import { docsPage } from './openapi.js';
import type { RouteResponse } from './router.js';
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
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export interface ServerOptions {
  port: number;
  host: string;
  webRoot: string;
  scenarioDir: string;
  /** Saved recordings folder (default: "recordings" next to scenarioDir). */
  recordingDir?: string;
  /** Imported terrain datasets folder (default: "terrains" next to scenarioDir). */
  terrainDir?: string;
  /** State broadcasts per second. */
  stateRate?: number;
  /** When set, every /api, /ws and /mcp request must present this key (or a player key). */
  apiKey?: string;
  /** Player keys: a client presenting one sees and commands only that force (fog of war). */
  players?: { force: ForceId; key: string }[];
  /** Browser origins allowed to call the API cross-origin ('*' for any). */
  corsOrigins?: string[];
  /** Markdown documentation folder served at /docs. */
  docsDir?: string;
  /** Repository blob URL used for doc links to files outside docs/. */
  repoBlobUrl?: string;
  integrations?: IntegrationOptions;
}

class BodyError extends Error {}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new BodyError('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new BodyError('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function hostname(hostHeader: string | undefined): string {
  if (!hostHeader) return '';
  if (hostHeader.startsWith('[')) return hostHeader.slice(0, hostHeader.indexOf(']') + 1);
  return hostHeader.split(':')[0].toLowerCase();
}

export class SimServer {
  readonly http: http.Server;
  readonly api: ApiV1;
  readonly integrations: IntegrationHub;
  private wss: WebSocketServer;
  private terrainCache: { version: number; json: string } | null = null;
  private lastTerrainVersion: number;
  private pendingEvents: SimEvent[] = [];
  private frameCount = 0;
  private docs: DocsSite | null;
  private wsRoles = new WeakMap<WebSocket, Role>();

  constructor(
    readonly runner: SimRunner,
    readonly opts: ServerOptions,
  ) {
    this.lastTerrainVersion = runner.engine.terrainVersion;
    this.integrations = new IntegrationHub(runner, opts.integrations);
    this.api = new ApiV1({ runner, integrations: this.integrations, scenarioDir: opts.scenarioDir, recordingDir: opts.recordingDir, terrainDir: opts.terrainDir, batch: new BatchManager() });
    this.docs = opts.docsDir ? new DocsSite(opts.docsDir, opts.repoBlobUrl) : null;
    this.http = http.createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        if (!res.headersSent) this.send(res, { status: 500, json: { error: { status: 500, message: String(err?.message ?? err) } } });
      });
    });
    this.wss = new WebSocketServer({
      server: this.http,
      path: '/ws',
      maxPayload: MAX_BODY,
      verifyClient: (info: { req: http.IncomingMessage; origin?: string }) => this.allowRequest(info.req, new URL(info.req.url ?? '/', 'http://x')) === null && this.allowWsOrigin(info.req),
    });
    this.wss.on('connection', (ws, req) => this.onConnection(ws, req));
    runner.engine.on('event', (ev) => this.pendingEvents.push(ev));
    const every = Math.max(1, Math.round(1000 / runner.frameMs / (opts.stateRate ?? 10)));
    runner.onFrame(() => {
      if (this.runner.engine.terrainVersion !== this.lastTerrainVersion) {
        this.lastTerrainVersion = this.runner.engine.terrainVersion;
        this.broadcast({ type: 'terrainChanged', terrainVersion: this.lastTerrainVersion });
      }
      if (this.pendingEvents.length) {
        const events = this.pendingEvents;
        this.pendingEvents = [];
        this.broadcastPerRole((role) => ({ type: 'events', events: role.kind === 'player' ? filterEvents(this.runner.engine, events, role.force) : events }));
      }
      if (++this.frameCount % every === 0 && this.wss.clients.size > 0) this.broadcastState();
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
    this.integrations.close();
    for (const c of this.wss.clients) c.terminate();
    this.wss.close();
    return new Promise((resolve) => this.http.close(() => resolve()));
  }

  get address(): string {
    const a = this.http.address();
    return typeof a === 'object' && a ? `http://${this.opts.host === '0.0.0.0' ? 'localhost' : this.opts.host}:${a.port}` : '';
  }

  /** In-process API caller used by the embedded MCP endpoint. */
  localCaller(baseUrl: string, role: Role = CONTROLLER): ApiCaller {
    return async (method, p, body) => this.api.call(method, p, body, baseUrl, role);
  }

  // ------------------------------------------------------------ security

  /** Returns an error response, or null when the request may proceed. */
  private allowRequest(req: http.IncomingMessage, url: URL): RouteResponse & { status: number } | null {
    // DNS-rebinding guard: a loopback-only server only answers to loopback host names.
    if (LOOPBACK.has(this.opts.host) && !LOOPBACK.has(hostname(req.headers.host))) {
      return { status: 403, json: { error: { status: 403, message: 'host not allowed' } } };
    }
    const protectedPath = url.pathname.startsWith('/api/') || url.pathname === '/ws' || url.pathname === '/mcp';
    if (protectedPath && url.pathname !== '/api/docs' && !this.roleFor(req, url)) {
      return { status: 401, json: { error: { status: 401, message: 'missing or invalid API key' } } };
    }
    return null;
  }

  /** The caller's role from its key: the API key is exercise control, a player key one force. */
  roleFor(req: http.IncomingMessage, url: URL): Role | null {
    const players = this.opts.players ?? [];
    if (!this.opts.apiKey && players.length === 0) return CONTROLLER;
    const auth = req.headers.authorization;
    const presented =
      (auth?.startsWith('Bearer ') ? auth.slice(7) : undefined) ?? (req.headers['x-api-key'] as string | undefined) ?? url.searchParams.get('api_key') ?? '';
    const same = (key: string) => {
      const a = Buffer.from(presented);
      const b = Buffer.from(key);
      return a.length === b.length && timingSafeEqual(a, b);
    };
    if (this.opts.apiKey && same(this.opts.apiKey)) return CONTROLLER;
    for (const p of players) if (same(p.key)) return { kind: 'player', force: p.force };
    return null;
  }

  private corsOrigin(req: http.IncomingMessage): string | null {
    const origin = req.headers.origin;
    const allowed = this.opts.corsOrigins ?? [];
    if (!origin || allowed.length === 0) return null;
    if (allowed.includes('*')) return '*';
    return allowed.includes(origin) ? origin : null;
  }

  private allowWsOrigin(req: http.IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (!origin) return true; // non-browser client
    try {
      if (new URL(origin).host === req.headers.host) return true;
    } catch {
      return false;
    }
    return this.corsOrigin(req) !== null;
  }

  // ------------------------------------------------------------ dispatch

  private send(res: http.ServerResponse, r: RouteResponse & { status: number }, extraHeaders: Record<string, string> = {}): void {
    const headers: Record<string, string> = { 'Cache-Control': 'no-store', ...extraHeaders, ...r.headers };
    if (r.status === 204) {
      res.writeHead(204, headers);
      res.end();
      return;
    }
    if (r.text !== undefined) {
      res.writeHead(r.status, { 'Content-Type': r.contentType ?? 'text/plain; charset=utf-8', ...headers });
      res.end(r.text);
      return;
    }
    if (r.bytes !== undefined) {
      res.writeHead(r.status, { 'Content-Type': r.contentType ?? 'application/octet-stream', 'Content-Length': String(r.bytes.byteLength), ...headers });
      res.end(r.bytes);
      return;
    }
    res.writeHead(r.status, { 'Content-Type': r.contentType ?? 'application/json', ...headers });
    res.end(JSON.stringify(r.json ?? null));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const p = url.pathname;
    const method = req.method ?? 'GET';
    const cors = this.corsOrigin(req);
    const corsHeaders: Record<string, string> = cors
      ? { 'Access-Control-Allow-Origin': cors, 'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key, Mcp-Session-Id, Mcp-Protocol-Version', 'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS', Vary: 'Origin' }
      : {};
    if (method === 'OPTIONS' && (p.startsWith('/api/') || p === '/mcp')) {
      res.writeHead(cors ? 204 : 403, corsHeaders);
      res.end();
      return;
    }
    const denied = this.allowRequest(req, url);
    if (denied) return this.send(res, denied, corsHeaders);

    if (p === '/api/docs') return this.send(res, { status: 200, text: docsPage(), contentType: 'text/html; charset=utf-8' });
    if (this.docs && (p === '/docs' || p.startsWith('/docs/'))) {
      if (p === '/docs') {
        res.writeHead(302, { Location: '/docs/' });
        res.end();
        return;
      }
      const d = this.docs.serve(p);
      res.writeHead(d.status, { 'Content-Type': d.contentType, 'Cache-Control': 'no-store' });
      res.end(d.body);
      return;
    }

    const isApi = p.startsWith('/api/') || p === '/mcp';
    if (!isApi) return this.serveStatic(p, res);

    // Cross-site form posts are "simple" requests; requiring JSON forces a CORS preflight.
    if ((method === 'POST' || method === 'PUT') && !(req.headers['content-type'] ?? '').includes('application/json')) {
      return this.send(res, { status: 415, json: { error: { status: 415, message: 'Content-Type must be application/json' } } }, corsHeaders);
    }
    let body: unknown;
    if (method !== 'GET' && method !== 'HEAD') {
      try {
        body = await readBody(req);
      } catch (err) {
        return this.send(res, { status: err instanceof BodyError && err.message.includes('large') ? 413 : 400, json: { error: { status: 400, message: (err as Error).message } } }, corsHeaders);
      }
    }
    const baseUrl = `http://${req.headers.host ?? 'localhost'}`;
    const role = this.roleFor(req, url) ?? CONTROLLER;

    if (p === '/mcp') return this.handleMcp(req, res, body, baseUrl, corsHeaders, role);

    if (p.startsWith('/api/v1')) {
      const r = await this.api.dispatch({ method, path: p, query: url.searchParams, body, baseUrl, role });
      return this.send(res, r, corsHeaders);
    }

    // Endpoints used by the GUI.
    const engine = this.runner.engine;
    const player = role.kind === 'player' ? role.force : undefined;
    const forbidden = () => this.send(res, { status: 403, json: { ok: false, error: 'exercise control only' } }, corsHeaders);
    if (method === 'GET' && p === '/api/catalog') return this.send(res, { status: 200, json: engine.catalog.catalog }, corsHeaders);
    if (method === 'GET' && p === '/api/terrain') return this.send(res, { status: 200, text: this.terrainJson(), contentType: 'application/json' }, corsHeaders);
    if (method === 'GET' && p === '/api/state') return this.send(res, { status: 200, json: this.stateFor(role) }, corsHeaders);
    if (method === 'GET' && p === '/api/events') {
      const evs = engine.eventsSince(Number(url.searchParams.get('since') ?? 0));
      return this.send(res, { status: 200, json: player === undefined ? evs : filterEvents(engine, evs, player) }, corsHeaders);
    }
    if (method === 'GET' && p === '/api/scenario') return player === undefined ? this.send(res, { status: 200, json: engine.toScenario() }, corsHeaders) : forbidden();
    if (method === 'GET' && p.startsWith('/api/path/')) {
      const id = decodeURIComponent(p.slice('/api/path/'.length));
      const own = player === undefined || engine.entities.get(id)?.force === player;
      return this.send(res, { status: 200, json: own ? engine.plannedPath(id) : [] }, corsHeaders);
    }
    if (method === 'POST' && p === '/api/command') {
      const result = this.command(role, body);
      return this.send(res, { status: result.ok ? 200 : 400, json: result }, corsHeaders);
    }
    // Scenario storage (kept for the GUI; same behaviour as /api/v1/scenarios).
    if (p === '/api/scenarios' || p.startsWith('/api/scenarios/')) {
      const v1 = p.replace('/api/', '/api/v1/');
      const r = await this.api.dispatch({ method, path: v1, query: url.searchParams, body, baseUrl, role });
      return this.send(res, r, corsHeaders);
    }
    return this.send(res, { status: 404, json: { ok: false, error: 'unknown endpoint' } }, corsHeaders);
  }

  /** Run a command as a role (players are limited to their own force). */
  private command(role: Role, raw: unknown): CommandResult {
    try {
      checkCommand(this.runner.engine, role, raw);
    } catch (err) {
      if (err instanceof ForbiddenError) return { ok: false, error: err.message };
      throw err;
    }
    return executeCommand(this.runner, raw);
  }

  private stateFor(role: Role, full = this.runner.state()): SimState {
    return role.kind === 'player' ? filterState(this.runner.engine, full, role.force) : full;
  }

  private async handleMcp(req: http.IncomingMessage, res: http.ServerResponse, body: unknown, baseUrl: string, corsHeaders: Record<string, string>, role: Role): Promise<void> {
    if (req.method !== 'POST') {
      return this.send(res, { status: 405, json: { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed (stateless MCP endpoint: use POST)' }, id: null } }, corsHeaders);
    }
    for (const [k, v] of Object.entries(corsHeaders)) res.setHeader(k, v);
    // Stateless mode: a fresh server/transport per request.
    const server = createMcpServer(this.localCaller(baseUrl, role));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  // ------------------------------------------------------------ websocket

  private broadcast(msg: ServerMessage): void {
    const data = JSON.stringify(msg);
    for (const c of this.wss.clients) if (c.readyState === WebSocket.OPEN) c.send(data);
  }

  /** Send each client the message for its role (built once per role). */
  private broadcastPerRole(build: (role: Role) => ServerMessage | null): void {
    const cache = new Map<string, string | null>();
    for (const c of this.wss.clients) {
      if (c.readyState !== WebSocket.OPEN) continue;
      const role = this.wsRoles.get(c) ?? CONTROLLER;
      const key = role.kind === 'player' ? `p${role.force}` : 'c';
      if (!cache.has(key)) {
        const msg = build(role);
        cache.set(key, msg && (msg.type !== 'events' || msg.events.length) ? JSON.stringify(msg) : null);
      }
      const data = cache.get(key);
      if (data) c.send(data);
    }
  }

  private broadcastState(): void {
    const full = this.runner.state();
    this.broadcastPerRole((role) => ({ type: 'state', state: this.stateFor(role, full) }));
  }

  private onConnection(ws: WebSocket, req: http.IncomingMessage): void {
    const engine = this.runner.engine;
    const role = this.roleFor(req, new URL(req.url ?? '/', 'http://x')) ?? CONTROLLER;
    this.wsRoles.set(ws, role);
    const hello: ServerMessage = { type: 'hello', catalog: engine.catalog.catalog, scenarioName: engine.scenarioName, terrainVersion: engine.terrainVersion, role };
    ws.send(JSON.stringify(hello));
    const recent = engine.eventsSince(0);
    ws.send(JSON.stringify({ type: 'events', events: (role.kind === 'player' ? filterEvents(engine, recent, role.force) : recent).slice(-200) } satisfies ServerMessage));
    ws.send(JSON.stringify({ type: 'state', state: this.stateFor(role) } satisfies ServerMessage));
    ws.on('message', (data) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg?.type !== 'command') return;
      const result = this.command(role, msg.command);
      // Push state first, so clients already know about any object the result refers to.
      this.broadcastState();
      ws.send(JSON.stringify({ type: 'result', reqId: msg.reqId, result } satisfies ServerMessage));
    });
  }

  private terrainJson(): string {
    const engine = this.runner.engine;
    if (!this.terrainCache || this.terrainCache.version !== engine.terrainVersion) {
      this.terrainCache = { version: engine.terrainVersion, json: JSON.stringify(engine.terrain.toData()) };
    }
    return this.terrainCache.json;
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
