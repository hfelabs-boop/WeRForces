// MCP server for WeRForces: exposes the simulation to AI agents as tools.
// Tools call the /api/v1 REST routes through an ApiCaller, so the same server
// works in-process (embedded /mcp endpoint) or as a stdio bridge to a remote instance.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export interface ApiResult {
  status: number;
  json?: unknown;
  text?: string;
}

export type ApiCaller = (method: string, path: string, body?: unknown) => Promise<ApiResult>;

export const SERVER_INSTRUCTIONS = `WeRForces is a computer-generated forces (CGF) military simulation.
Start with get_situation to learn the scenario, forces, terrain size and town names.
Positions are local metres (x east, y north, from the south-west corner) or {lat,lon} or {town:"Name"}.
Forces: 1 = Blue, 2 = Red, 3 = Neutral. Entities can be grouped into units (ids U..); task a unit to move it in formation.
Use list_catalog for entity type and unit template ids. Use advance_time to simulate while paused and get a summary of what happened.`;

const position = z
  .object({
    x: z.number().optional().describe('metres east of the south-west corner'),
    y: z.number().optional().describe('metres north of the south-west corner'),
    lat: z.number().optional(),
    lon: z.number().optional(),
    town: z.string().optional().describe('town name from get_situation'),
  })
  .describe('Location as {x,y}, {lat,lon} or {town}');

const force = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(0)]).describe('1 Blue, 2 Red, 3 Neutral, 0 Other');
const roe = z.enum(['fireAtWill', 'returnFire', 'holdFire']);

function text(value: unknown) {
  return { content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 1) }] };
}

function errorText(message: string) {
  return { isError: true, content: [{ type: 'text' as const, text: message }] };
}

function fmtTime(t: number): string {
  const s = Math.floor(t);
  return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

interface EntityRow {
  id: string;
  name: string;
  typeId: string;
  force: number;
  domain: string;
  unitId?: string;
  x: number;
  y: number;
  lat: number;
  lon: number;
  agl: number;
  headingDeg: number;
  speed: number;
  damage: string;
  roe: string;
  task?: string;
  plan?: string;
  remote: boolean;
  contacts: string[];
  engagingId?: string;
  ammo: { weapon: string; rounds: number }[];
}

function compactEntity(e: EntityRow) {
  return {
    id: e.id,
    name: e.name,
    type: e.typeId,
    force: e.force,
    unit: e.unitId,
    x: Math.round(e.x),
    y: Math.round(e.y),
    lat: e.lat,
    lon: e.lon,
    ...(e.domain === 'air' ? { agl: Math.round(e.agl) } : {}),
    heading: e.headingDeg,
    kmh: Math.round(e.speed * 3.6),
    damage: e.damage,
    task: e.plan ? `${e.plan}${e.task ? ` / ${e.task}` : ''}` : e.task,
    ...(e.remote ? { remote: true } : {}),
  };
}

export function createMcpServer(call: ApiCaller): McpServer {
  const server = new McpServer({ name: 'werforces', version: '0.2.0' }, { instructions: SERVER_INSTRUCTIONS });

  /** Call the API and unwrap the JSON, throwing the API error message on failure. */
  const api = async <T = unknown>(method: string, path: string, body?: unknown): Promise<T> => {
    const r = await call(method, path, body);
    if (r.status >= 400) {
      const msg = (r.json as { error?: { message?: string } })?.error?.message ?? r.text ?? `HTTP ${r.status}`;
      throw new Error(msg);
    }
    return (r.json ?? r.text) as T;
  };

  const tool = <S extends z.ZodRawShape>(
    name: string,
    description: string,
    shape: S,
    run: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>,
    annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean } = {},
  ) => {
    server.registerTool(name, { description, inputSchema: shape, annotations }, (async (args: z.infer<z.ZodObject<S>>) => {
      try {
        return text(await run(args));
      } catch (err) {
        return errorText(err instanceof Error ? err.message : String(err));
      }
    }) as never);
  };

  // ---------------------------------------------------------------- awareness

  tool(
    'get_situation',
    'Overview of the simulation: scenario, time, running state, strength per force, terrain size and towns, units and tactical graphics. Call this first.',
    {},
    async () => {
      const [sim, units, graphics] = await Promise.all([
        api<Record<string, unknown>>('GET', '/api/v1/simulation'),
        api<{ id: string; name: string; force: number; echelon: string; formation: string; leaderId?: string; memberIds: string[]; x: number; y: number; task?: string; plan?: string }[]>('GET', '/api/v1/units'),
        api<{ id: string; name: string; kind: string; force: number; points: unknown[] }[]>('GET', '/api/v1/graphics'),
      ]);
      return {
        ...sim,
        time: `${fmtTime(sim.time as number)} (${Math.round(sim.time as number)} s)`,
        units: units.map((u) => ({ id: u.id, name: u.name, force: u.force, echelon: u.echelon, members: u.memberIds.length, leader: u.leaderId, x: Math.round(u.x), y: Math.round(u.y), activity: u.plan ?? u.task ?? 'idle' })),
        graphics: graphics.map((g) => ({ id: g.id, name: g.name, kind: g.kind, force: g.force, points: g.points.length })),
      };
    },
    { readOnlyHint: true },
  );

  tool(
    'list_entities',
    'List entities with position, damage and current activity. Filter by force, domain or unit.',
    {
      force: force.optional(),
      domain: z.enum(['ground', 'lifeform', 'air', 'surface']).optional(),
      unitId: z.string().optional(),
      aliveOnly: z.boolean().optional().describe('exclude destroyed entities'),
    },
    async (a) => {
      const q = new URLSearchParams();
      if (a.force !== undefined) q.set('force', String(a.force));
      if (a.domain) q.set('domain', a.domain);
      if (a.unitId) q.set('unit', a.unitId);
      if (a.aliveOnly) q.set('alive', 'true');
      const list = await api<EntityRow[]>('GET', `/api/v1/entities?${q}`);
      return list.map(compactEntity);
    },
    { readOnlyHint: true },
  );

  tool(
    'get_entity',
    'Full details of one entity: kinematics, damage, ROE, task/plan, ammunition and current sensor contacts.',
    { id: z.string() },
    async ({ id }) => {
      const e = await api<EntityRow>('GET', `/api/v1/entities/${encodeURIComponent(id)}`);
      return { ...compactEntity(e), domain: e.domain, roe: e.roe, ammo: e.ammo, contacts: e.contacts, engaging: e.engagingId };
    },
    { readOnlyHint: true },
  );

  tool(
    'get_unit',
    'Details of a unit and its members.',
    { id: z.string() },
    async ({ id }) => {
      const u = await api<Record<string, unknown> & { members: EntityRow[] }>('GET', `/api/v1/units/${encodeURIComponent(id)}`);
      return { ...u, members: u.members.map(compactEntity) };
    },
    { readOnlyHint: true },
  );

  tool(
    'list_catalog',
    'Entity types and unit templates that can be created.',
    { what: z.enum(['entityTypes', 'unitTemplates', 'both']).optional() },
    async ({ what = 'both' }) => {
      const out: Record<string, unknown> = {};
      if (what !== 'unitTemplates') out.entityTypes = await api('GET', '/api/v1/catalog/entity-types');
      if (what !== 'entityTypes') {
        const t = await api<{ id: string; name: string; echelon: string; members: string[]; formation: string }[]>('GET', '/api/v1/catalog/unit-templates');
        out.unitTemplates = t.map((u) => ({ id: u.id, name: u.name, echelon: u.echelon, members: u.members.join(', '), formation: u.formation }));
      }
      return out;
    },
    { readOnlyHint: true },
  );

  tool(
    'get_events',
    'Recent simulation events (detections, fire, hits, kills, task changes). Use `since` with the last seq you saw.',
    {
      since: z.number().int().optional(),
      kinds: z.array(z.enum(['fire', 'detonation', 'damaged', 'destroyed', 'detected', 'task', 'created', 'deleted', 'info'])).optional(),
      limit: z.number().int().min(1).max(500).optional(),
    },
    async (a) => {
      const q = new URLSearchParams({ since: String(a.since ?? 0), limit: String(a.limit ?? 100) });
      if (a.kinds?.length) q.set('kinds', a.kinds.join(','));
      const evs = await api<{ seq: number; time: number; kind: string; text: string }[]>('GET', `/api/v1/events?${q}`);
      return evs.map((e) => `#${e.seq} ${fmtTime(e.time)} [${e.kind}] ${e.text}`).join('\n') || '(no events)';
    },
    { readOnlyHint: true },
  );

  tool(
    'query_terrain',
    'Terrain at a point: elevation, water, forest, road, slope and nearest town.',
    { at: position },
    async ({ at }) => {
      const q: Record<string, string> = {};
      for (const [k, v] of Object.entries(at)) if (v !== undefined) q[k] = String(v);
      return api('GET', `/api/v1/terrain/point?${new URLSearchParams(q)}`);
    },
    { readOnlyHint: true },
  );

  tool(
    'check_line_of_sight',
    'Whether two entities (by id) or points can see each other over terrain and forest.',
    { from: z.union([z.string(), position]), to: z.union([z.string(), position]) },
    async (a) => api('POST', '/api/v1/terrain/line-of-sight', a),
    { readOnlyHint: true },
  );

  // ---------------------------------------------------------------- creation

  tool(
    'create_entity',
    'Create a single entity (vehicle, aircraft, ship or person) from an entity type id.',
    { typeId: z.string(), force, position, heading: z.number().optional().describe('degrees clockwise from north'), name: z.string().optional(), altitude: z.number().optional().describe('aircraft height above ground, m') },
    async (a) =>
      compactEntity(
        await api<EntityRow>('POST', '/api/v1/entities', {
          typeId: a.typeId,
          force: a.force,
          position: a.position,
          heading: a.heading === undefined ? undefined : (a.heading * Math.PI) / 180,
          name: a.name,
          altitude: a.altitude,
        }),
      ),
  );

  tool(
    'create_unit',
    'Create a unit (e.g. a tank platoon) from a unit template id; members are placed in formation.',
    { templateId: z.string(), force, position, heading: z.number().optional().describe('degrees'), name: z.string().optional() },
    async (a) => {
      const u = await api<{ id: string; name: string; members: EntityRow[] }>('POST', '/api/v1/units', {
        templateId: a.templateId,
        force: a.force,
        position: a.position,
        heading: a.heading === undefined ? undefined : (a.heading * Math.PI) / 180,
        name: a.name,
      });
      return { id: u.id, name: u.name, members: u.members.map(compactEntity) };
    },
  );

  tool(
    'create_graphic',
    'Draw a tactical graphic: a route (for follow/patrol tasks), an area (for "in area" plan conditions), a phase line or a point.',
    { kind: z.enum(['route', 'area', 'phaseLine', 'point']), points: z.array(position).min(1), name: z.string().optional(), force: force.optional() },
    async (a) => api('POST', '/api/v1/graphics', a),
  );

  tool(
    'delete_object',
    'Delete an entity, a unit (with its members) or a graphic.',
    { id: z.string() },
    async ({ id }) => {
      const kind = id.startsWith('U') ? 'units' : id.startsWith('G') ? 'graphics' : 'entities';
      await api('DELETE', `/api/v1/${kind}/${encodeURIComponent(id)}`);
      return `deleted ${id}`;
    },
    { destructiveHint: true },
  );

  // ---------------------------------------------------------------- tasking

  tool(
    'assign_task',
    'Give an entity or unit a task (replaces its current plan). moveTo/orbit need `to`; followRoute/patrol need `routeId`; attack/follow need `targetId`; wait needs `duration`.',
    {
      targetId: z.string().describe('entity (E..) or unit (U..) id'),
      type: z.enum(['moveTo', 'followRoute', 'patrol', 'attack', 'follow', 'orbit', 'wait']),
      to: position.optional(),
      routeId: z.string().optional(),
      targetEntityId: z.string().optional(),
      duration: z.number().optional().describe('seconds'),
      radius: z.number().optional().describe('orbit radius in m (default 2000)'),
      speedKmh: z.number().optional(),
    },
    async (a) => {
      const speed = a.speedKmh === undefined ? undefined : a.speedKmh / 3.6;
      const need = <T>(v: T | undefined, what: string): T => {
        if (v === undefined) throw new Error(`${a.type} needs ${what}`);
        return v;
      };
      const task =
        a.type === 'moveTo'
          ? { type: 'moveTo', target: need(a.to, 'to'), speed }
          : a.type === 'orbit'
            ? { type: 'orbit', center: need(a.to, 'to'), radius: a.radius ?? 2000, duration: a.duration }
            : a.type === 'followRoute' || a.type === 'patrol'
              ? { type: a.type, routeId: need(a.routeId, 'routeId'), speed }
              : a.type === 'attack' || a.type === 'follow'
                ? { type: a.type, targetId: need(a.targetEntityId, 'targetEntityId') }
                : { type: 'wait', duration: need(a.duration, 'duration') };
      const kind = a.targetId.startsWith('U') ? 'units' : 'entities';
      const r = await api<{ id: string; name: string; task?: string; plan?: string }>('POST', `/api/v1/${kind}/${encodeURIComponent(a.targetId)}/task`, task);
      return `${r.name}: ${r.task ?? 'task assigned'}`;
    },
  );

  tool(
    'assign_plan',
    'Give an entity or unit a plan: an ordered list of statements executed in sequence. Statement kinds: ' +
      '{kind:"task", task:{type:"moveTo",target:{town:"X"}}} (task types as in assign_task, with target/center positions), ' +
      '{kind:"setRoe", roe}, {kind:"setSpeed", speed (m/s)}, {kind:"setAltitude", altitude}, {kind:"setFormation", formation}, ' +
      '{kind:"setReactions", reactions:{onContact:"halt"|"continue", withdrawBelow:0..1}}, ' +
      '{kind:"waitUntil", condition:{type:"simTime",time}|{type:"inArea",areaId}|{type:"enemyInArea",areaId}|{type:"enemyDetected"}|{type:"underFire"}|{type:"strengthBelow",fraction}|{type:"entityDestroyed",entityId}}.',
    {
      targetId: z.string(),
      name: z.string().optional(),
      loop: z.boolean().optional(),
      statements: z.array(z.record(z.string(), z.unknown())).min(1),
    },
    async (a) => {
      const kind = a.targetId.startsWith('U') ? 'units' : 'entities';
      const r = await api<{ name: string; plan?: string }>('POST', `/api/v1/${kind}/${encodeURIComponent(a.targetId)}/plan`, { name: a.name, loop: a.loop, statements: a.statements });
      return `${r.name}: ${r.plan ?? 'plan assigned'}`;
    },
  );

  tool(
    'stop',
    'Stop an entity or unit (clears its task and plan).',
    { targetId: z.string() },
    async ({ targetId }) => {
      const kind = targetId.startsWith('U') ? 'units' : 'entities';
      await api('POST', `/api/v1/${kind}/${encodeURIComponent(targetId)}/stop`);
      return `${targetId} stopped`;
    },
  );

  tool(
    'set_roe',
    'Set rules of engagement for an entity or unit: fireAtWill, returnFire or holdFire.',
    { targetId: z.string(), roe },
    async ({ targetId, roe: value }) => {
      const kind = targetId.startsWith('U') ? 'units' : 'entities';
      await api('PATCH', `/api/v1/${kind}/${encodeURIComponent(targetId)}`, { roe: value });
      return `${targetId} ROE = ${value}`;
    },
    { idempotentHint: true },
  );

  tool(
    'set_reactions',
    'Automatic behaviours that run alongside tasks: onContact "halt" makes the entity/unit stop and fight while a hostile is within weapon range, then resume its task; withdrawBelow (0-1) makes a unit abandon its plan and fall back (to withdrawTo, default its current position) when its strength drops below that fraction, or an entity when its weapons are knocked out.',
    {
      targetId: z.string(),
      onContact: z.enum(['continue', 'halt']).optional(),
      withdrawBelow: z.number().min(0).max(1).optional(),
      withdrawTo: position.optional(),
    },
    async ({ targetId, ...reactions }) => {
      const kind = targetId.startsWith('U') ? 'units' : 'entities';
      const r = await api<{ name: string; reactions?: unknown }>('PATCH', `/api/v1/${kind}/${encodeURIComponent(targetId)}`, { reactions });
      return { name: r.name, reactions: r.reactions ?? {} };
    },
    { idempotentHint: true },
  );

  // ---------------------------------------------------------------- time & scenarios

  tool(
    'control_simulation',
    'Run (real time), pause, rewind to the scenario start, or set the real-time multiplier.',
    { action: z.enum(['run', 'pause', 'rewind', 'setTimeScale']), timeScale: z.number().min(0.1).max(64).optional() },
    async ({ action, timeScale }) => {
      if (action === 'setTimeScale') return api('PUT', '/api/v1/simulation/time-scale', { scale: timeScale ?? 1 });
      return api('POST', `/api/v1/simulation/${action}`);
    },
  );

  tool(
    'advance_time',
    'Simulate the given number of seconds immediately (as fast as possible) and summarise what happened: kills, damage, detections and task changes.',
    { seconds: z.number().min(1).max(3600), includeDetections: z.boolean().optional() },
    async ({ seconds, includeDetections }) => {
      const before = await api<{ lastEventSeq: number }>('GET', '/api/v1/simulation');
      const after = await api<{ time: number; strength: unknown }>('POST', '/api/v1/simulation/step', { seconds });
      const kinds = ['destroyed', 'damaged', 'task', 'info', ...(includeDetections ? ['detected'] : [])];
      const evs = await api<{ seq: number; time: number; kind: string; text: string }[]>('GET', `/api/v1/events?since=${before.lastEventSeq}&limit=1000&kinds=${kinds.join(',')}`);
      const fires = (await api<unknown[]>('GET', `/api/v1/events?since=${before.lastEventSeq}&limit=1000&kinds=fire`)).length;
      return {
        time: fmtTime(after.time),
        strength: after.strength,
        shotsFired: fires,
        events: evs.slice(-150).map((e) => `${fmtTime(e.time)} [${e.kind}] ${e.text}`),
      };
    },
  );

  tool(
    'manage_scenario',
    'List, load or save scenarios stored on the server, or start an empty one.',
    { action: z.enum(['list', 'load', 'save', 'new']), name: z.string().optional() },
    async ({ action, name }) => {
      if (action === 'list') return api('GET', '/api/v1/scenarios');
      if (action === 'new') return api('POST', '/api/v1/scenario/new', { name: name ?? 'Untitled' });
      if (!name) throw new Error(`${action} needs a name`);
      if (action === 'load') return api('POST', `/api/v1/scenarios/${encodeURIComponent(name)}/load`);
      return api('PUT', `/api/v1/scenarios/${encodeURIComponent(name)}`);
    },
  );

  // ---------------------------------------------------------------- resources

  server.registerResource('scenario', 'werforces://scenario', { description: 'The current state as a WeRForces scenario file', mimeType: 'application/json' }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(await api('GET', '/api/v1/scenario')) }],
  }));
  server.registerResource('catalog', 'werforces://catalog', { description: 'Entity types, weapons, sensors and unit templates', mimeType: 'application/json' }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(await api('GET', '/api/v1/catalog')) }],
  }));
  server.registerResource('entities-geojson', 'werforces://entities.geojson', { description: 'Entity positions as GeoJSON', mimeType: 'application/geo+json' }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: 'application/geo+json', text: JSON.stringify(await api('GET', '/api/v1/export/entities.geojson')) }],
  }));

  return server;
}

/** ApiCaller that talks to a running WeRForces server over HTTP. */
export function httpCaller(baseUrl: string, apiKey?: string): ApiCaller {
  const base = baseUrl.replace(/\/+$/, '');
  return async (method, path, body) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? (method === 'GET' ? undefined : '{}') : JSON.stringify(body) });
    const type = res.headers.get('content-type') ?? '';
    if (res.status === 204) return { status: 204 };
    if (type.includes('json')) return { status: res.status, json: await res.json() };
    return { status: res.status, text: await res.text() };
  };
}
