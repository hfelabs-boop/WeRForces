// MCP server for WeRForces: exposes the simulation to AI agents as tools.
// Tools call the /api/v1 REST routes through an ApiCaller, so the same server
// works in-process (embedded /mcp endpoint) or as a stdio bridge to a remote instance.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AarReport } from '../shared/recording.js';

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
  travel?: { remaining: number; eta?: number; etaLocal?: string; stalled?: string };
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
    ...(e.travel ? { travel: e.travel.eta !== undefined ? `${(e.travel.remaining / 1000).toFixed(1)} km to go, arrives ${fmtTime(e.travel.eta)}${e.travel.etaLocal ? ` (${e.travel.etaLocal} local)` : ''}` : `stalled: ${e.travel.stalled}` } : {}),
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
      const [sim, units, graphics, alerts] = await Promise.all([
        api<Record<string, unknown>>('GET', '/api/v1/simulation'),
        api<{ id: string; name: string; force: number; echelon: string; formation: string; leaderId?: string; memberIds: string[]; x: number; y: number; task?: string; plan?: string }[]>('GET', '/api/v1/units'),
        api<{ id: string; name: string; kind: string; force: number; points: unknown[] }[]>('GET', '/api/v1/graphics'),
        api<{ severity: string; text: string }[]>('GET', '/api/v1/alerts'),
      ]);
      return {
        ...sim,
        time: `${fmtTime(sim.time as number)} (${Math.round(sim.time as number)} s)`,
        units: units.map((u) => ({ id: u.id, name: u.name, force: u.force, echelon: u.echelon, members: u.memberIds.length, leader: u.leaderId, x: Math.round(u.x), y: Math.round(u.y), activity: u.plan ?? u.task ?? 'idle' })),
        graphics: graphics.map((g) => ({ id: g.id, name: g.name, kind: g.kind, force: g.force, points: g.points.length })),
        alerts: alerts.length ? `${alerts.length} open (get_alerts): ${alerts.slice(0, 3).map((a) => a.text).join('; ')}` : 'none',
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
    'explain',
    'Why an entity or unit is or is not moving, shooting or seeing the enemy: blockers (no line of sight and what blocks it, out of range, ROE, out of ammo or fuel, pinned, halted on contact, broken, order still on its way...) with suggested fixes. Use it whenever something does not do what you ordered.',
    { id: z.string().describe('Entity or unit id') },
    async ({ id }) => {
      const kind = id.startsWith('U') ? 'units' : 'entities';
      const ex = await api<{ summary: string; activity: string; movement: unknown[]; fire: unknown[]; sensing: unknown[]; unit?: unknown[] }>('GET', `/api/v1/${kind}/${encodeURIComponent(id)}/explain`).catch(async (err) => {
        // Unit ids normally start with U, but be lenient.
        if (kind === 'units') throw err;
        return api<never>('GET', `/api/v1/units/${encodeURIComponent(id)}/explain`);
      });
      const brief = (fs: unknown[]) => (fs as { severity: string; text: string; fix?: string }[]).map((f) => `${f.severity}: ${f.text}${f.fix ? ` Fix: ${f.fix}` : ''}`);
      return { summary: ex.summary, activity: ex.activity, ...(ex.unit ? { unit: brief(ex.unit) } : {}), movement: brief(ex.movement), fire: brief(ex.fire), sensing: brief(ex.sensing) };
    },
    { readOnlyHint: true },
  );

  tool(
    'give_order',
    'Give an order in plain words, the way a commander would say it: "<who> <verb> <where/what> [modifiers]". Who: unit or entity names (join several with "and"). Verbs: move to (covered, fast, slowly, at N km/h), attack, follow, defend/overwatch/screen <place> [facing <direction>] [width <m>], ambush <area> [from <place>], search <area>, patrol <route>, follow route <route>, fire [N rounds] on <place>, smoke <place>, orbit <place> [radius N km], mount <carrier>, dismount, resupply [from X], breach <minefield>, wait N min, stop, hold fire, return fire, fire at will. Places: town or graphic names, objects, "x y", or "2 km north of Brenham". Use dryRun to check how it is understood. Prefer this for simple orders; use assign_task for details it cannot express.',
    { text: z.string().describe('The order, e.g. "Team ARMOR move to Calloway covered"'), dryRun: z.boolean().optional() },
    async ({ text, dryRun }) => api('POST', '/api/v1/orders', { text, dryRun }),
  );

  tool(
    'viewshed',
    'What an entity (or a point) can see: the share of the ground within the radius that is in its line of sight, and the dead ground. Use it to choose observation posts, overwatch positions or covered approaches.',
    { from: z.union([z.string(), z.object({ x: z.number(), y: z.number(), height: z.number().optional() })]).describe('entity id, or a position'), radius: z.number().optional() },
    async ({ from, radius }) => {
      const v = await api<{ visibleFraction: number; radius: number; cell: number; eye: { x: number; y: number; z: number } }>('POST', '/api/v1/terrain/viewshed', { from, radius });
      return { radius: v.radius, seen: `${Math.round(v.visibleFraction * 100)}% of the ground within ${(v.radius / 1000).toFixed(1)} km`, eyeHeight: Math.round(v.eye.z), cell: v.cell };
    },
    { readOnlyHint: true },
  );

  tool(
    'set_sync_matrix',
    'Plan an operation in phases for a force (a synchronization matrix, or global plan). Each phase has a trigger and orders for units; phases start in order, each giving all its orders at once and announcing its name as a codeword (e.g. phase "Phase 2 Assault" sends codeword "PHASE 2 ASSAULT", which unit plans can wait for). Triggers: {type:"manual"} (start_phase), {type:"time",time} (s), {type:"codeword",codeword}, {type:"previousDone",delay?} (when the previous phase\'s orders are carried out), {type:"condition",ownerId,condition} (plan conditions). Orders: {targetId, text} with the order in words as for give_order without the name ("move to Calloway covered", "defend OBJ CALLOWAY facing north", "hold fire"), or {targetId, task}. An empty phases list removes the matrix.',
    {
      force: z.enum(['blue', 'red', 'neutral']),
      phases: z.array(z.object({ id: z.string().optional(), name: z.string(), trigger: z.record(z.string(), z.unknown()).optional(), orders: z.array(z.record(z.string(), z.unknown())) })),
    },
    async ({ force, phases }) => api('PUT', `/api/v1/sync-matrix/${force}`, { phases }),
  );

  tool(
    'start_phase',
    'Start a phase of a synchronization matrix now, whatever its trigger.',
    { force: z.enum(['blue', 'red', 'neutral']), phaseId: z.string() },
    async ({ force, phaseId }) => api('POST', `/api/v1/sync-matrix/${force}/phases/${encodeURIComponent(phaseId)}/start`),
  );

  tool(
    'send_codeword',
    'Send a codeword to a force (players: their own). Plans waiting for it ({type:"codeword"} conditions) go on: use it to trigger phases ("EXECUTE", "PHASE 2"). Also lists codewords sent so far.',
    { codeword: z.string(), force: z.enum(['blue', 'red', 'neutral']).optional().describe('default blue (exercise control only)') },
    async ({ codeword, force }) => {
      await api('POST', '/api/v1/codewords', { codeword, force: force ? { blue: 1, red: 2, neutral: 3 }[force] : undefined });
      return api('GET', '/api/v1/codewords');
    },
  );

  tool(
    'get_alerts',
    'The attention queue: what needs looking at now (units idle after finishing their orders, broken, out of fuel or ammunition, leader lost, losses, failed tasks, under fire, first contact), newest first. Pass acknowledge: true to clear them once handled.',
    { acknowledge: z.boolean().optional().describe('Acknowledge all open alerts after reading them') },
    async ({ acknowledge }) => {
      const list = await api<{ id: string; kind: string; severity: string; objectId: string; text: string; time: number; count: number }[]>('GET', '/api/v1/alerts');
      if (acknowledge && list.length) await api('POST', '/api/v1/alerts/acknowledge');
      return list.map((a) => ({ id: a.id, severity: a.severity, kind: a.kind, about: a.objectId, text: a.text, time: fmtTime(a.time), ...(a.count > 1 ? { times: a.count } : {}) }));
    },
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
      kinds: z.array(z.enum(['fire', 'detonation', 'damaged', 'destroyed', 'detected', 'task', 'created', 'deleted', 'info', 'radio'])).optional(),
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
    'Whether two entities (by id) or points can see each other over terrain, forest, buildings and smoke.',
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
    'Draw a tactical graphic: a route (for follow/patrol tasks), an area (for "in area" plan conditions), a phase line, a point, a minefield (an area that damages what crosses it; density 0.1-1.5) or an obstacle line (ditch or wire that vehicles cannot cross; engineers can breach both).',
    { kind: z.enum(['route', 'area', 'phaseLine', 'point', 'minefield', 'obstacle']), points: z.array(position).min(1), name: z.string().optional(), force: force.optional(), density: z.number().min(0.05).max(3).optional() },
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
    'Give an entity or unit a task (replaces its current plan). moveTo/orbit/fireMission need `to`; followRoute/patrol need `routeId`; attack/follow need `targetEntityId`; mount needs `targetEntityId` (the carrier entity or unit); wait needs `duration`; dismount (for a carrier) needs nothing; breach (engineers) needs `graphicId` of a minefield or obstacle; resupply sends it to the nearest friendly supply vehicle (or `targetEntityId`) to refuel and rearm. Tactical tasks: overwatch/defend/screen need `to` (the position) and take `facing` (degrees) and `width` (units deploy in a line); ambush also needs `graphicId` (the kill zone area) and opens fire only when an enemy enters it; screen falls back when an enemy comes within 1.5 km; search needs `graphicId` (an area) and sweeps it. Holding still, infantry dig in and vehicles go hull-down. Set `smoke` on a fireMission for smoke rounds. fireMission is indirect fire by artillery or mortars on a location (`rounds` per tube, optional `radius` sheaf).',
    {
      targetId: z.string().describe('entity (E..) or unit (U..) id'),
      type: z.enum(['moveTo', 'followRoute', 'patrol', 'attack', 'follow', 'orbit', 'wait', 'fireMission', 'mount', 'dismount', 'breach', 'resupply', 'overwatch', 'defend', 'screen', 'ambush', 'search']),
      to: position.optional(),
      routeId: z.string().optional(),
      targetEntityId: z.string().optional(),
      duration: z.number().optional().describe('seconds'),
      radius: z.number().optional().describe('orbit radius in m (default 2000), or fire mission sheaf radius (default 0)'),
      rounds: z.number().int().min(1).max(100).optional().describe('fire mission rounds per tube (default 3)'),
      smoke: z.boolean().optional().describe('fire mission: smoke rounds instead of high explosive'),
      graphicId: z.string().optional().describe('breach: the minefield or obstacle; ambush: the kill zone area; search: the area'),
      facing: z.number().min(0).max(360).optional().describe('overwatch/defend/screen/ambush: direction to face, degrees from north'),
      width: z.number().optional().describe('defend/screen/ambush: frontage in m for a unit'),
      speedKmh: z.number().optional(),
      covered: z.boolean().optional().describe("moveTo: take a covered route, out of sight of known enemies' direct fire where possible"),
    },
    async (a) => {
      const speed = a.speedKmh === undefined ? undefined : a.speedKmh / 3.6;
      const need = <T>(v: T | undefined, what: string): T => {
        if (v === undefined) throw new Error(`${a.type} needs ${what}`);
        return v;
      };
      const task =
        a.type === 'moveTo'
          ? { type: 'moveTo', target: need(a.to, 'to'), speed, covered: a.covered }
          : a.type === 'mount'
            ? { type: 'mount', carrierId: need(a.targetEntityId, 'targetEntityId') }
            : a.type === 'dismount'
            ? { type: 'dismount' }
            : a.type === 'fireMission'
            ? { type: 'fireMission', target: need(a.to, 'to'), rounds: a.rounds, radius: a.radius, smoke: a.smoke }
            : a.type === 'breach'
            ? { type: 'breach', graphicId: need(a.graphicId, 'graphicId') }
            : a.type === 'resupply'
            ? { type: 'resupply', supplierId: a.targetEntityId }
            : a.type === 'overwatch' || a.type === 'defend' || a.type === 'screen'
            ? { type: a.type, position: need(a.to, 'to'), facing: a.facing, width: a.type === 'overwatch' ? undefined : a.width, duration: a.type === 'overwatch' ? a.duration : undefined }
            : a.type === 'ambush'
            ? { type: 'ambush', position: need(a.to, 'to'), killZoneId: need(a.graphicId, 'graphicId'), facing: a.facing, width: a.width }
            : a.type === 'search'
            ? { type: 'search', areaId: need(a.graphicId, 'graphicId'), speed }
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
      '{kind:"setReactions", reactions:{onContact:"halt"|"continue", withdrawBelow:0..1, callForFire:true|false}}, ' +
      '{kind:"waitUntil", condition:{type:"simTime",time}|{type:"inArea",areaId}|{type:"enemyInArea",areaId}|{type:"enemyDetected"}|{type:"underFire"}|{type:"strengthBelow",fraction}|{type:"fuelBelow",fraction}|{type:"ammoBelow",fraction}|{type:"entityDestroyed",entityId}|{type:"codeword",codeword}|{type:"all"|"any",conditions:[...]}|{type:"not",condition}}, ' +
      '{kind:"if", condition, then:[statements], else:[statements]}, {kind:"while", condition, body:[statements]} (repeats while the condition holds), ' +
      '{kind:"sendCodeword", codeword} (plans of the same force waiting for it go on), {kind:"report", text} (a radio message). ' +
      'Codewords coordinate units: e.g. one unit sends "PHASE 2" when it reaches a phase line, others wait for it.',
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
    'embark',
    'Instantly put infantry (an entity or a whole unit) inside a carrier (an entity or a unit, whose seats are shared out), e.g. to set up a mechanized platoon with its squad mounted. Use assign_task type "mount" to make them walk to the carrier instead. With `dismount: true`, lets the passengers of the carrier(s) given in carrierId out now.',
    { passengerId: z.string().optional().describe('infantry entity or unit id'), carrierId: z.string().describe('carrier entity or unit id'), dismount: z.boolean().optional() },
    async ({ passengerId, carrierId, dismount }) => {
      if (dismount) {
        const kind = carrierId.startsWith('U') ? 'units' : 'entities';
        await api('POST', `/api/v1/${kind}/${encodeURIComponent(carrierId)}/disembark`);
        return `passengers of ${carrierId} dismounted`;
      }
      if (!passengerId) throw new Error('passengerId is required');
      const kind = passengerId.startsWith('U') ? 'units' : 'entities';
      await api('POST', `/api/v1/${kind}/${encodeURIComponent(passengerId)}/embark`, { carrierId });
      return `${passengerId} mounted in ${carrierId}`;
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
    'set_unit_superior',
    'Put a unit under a superior unit in the chain of command (or make it independent with superiorId null). An order given to the superior passes down to its subordinate units: moves keep their positions relative to each other, defend/overwatch/screen/ambush spread them in a line, other tasks go to all. With the orderDelay simulation rule on, each level adds a delay.',
    { unitId: z.string(), superiorId: z.string().nullable() },
    async ({ unitId, superiorId }) => api('PATCH', `/api/v1/units/${encodeURIComponent(unitId)}`, { superiorId }),
    { idempotentHint: true },
  );

  tool(
    'set_simulation_rules',
    'Turn optional parts of the model on or off for this scenario. Suppression (fire pins and degrades the target), morale (units become shaken and break under losses) and fuel (vehicles and aircraft burn fuel) are on by default; orderDelay (orders take 5-60 s to pass down the chain of command, by echelon) is off by default. Useful for comparison runs.',
    { suppression: z.boolean().optional(), morale: z.boolean().optional(), fuel: z.boolean().optional(), orderDelay: z.boolean().optional() },
    async (rules) => api('PUT', '/api/v1/simulation/rules', rules),
    { idempotentHint: true },
  );

  tool(
    'set_environment',
    'Set the time of day and weather. Darkness cuts the range of eyes and binoculars (night-vision goggles keep about 60%, thermal sights are unaffected); fog and precipitation cut every optical sensor; rain and snow slow movement off roads; wind drifts smoke. Fields left out keep their values. Returns the current environment (local time, sun altitude, light level).',
    {
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('date at the scenario start'),
      time: z.number().min(0).max(24).optional().describe('local solar time at the scenario start, in hours (e.g. 4.5 = 04:30)'),
      visibility: z.number().min(50).max(100000).optional().describe('metres; fog is a few hundred, clear is 20000+'),
      precipitation: z.enum(['none', 'rain', 'heavyRain', 'snow']).optional(),
      windSpeed: z.number().min(0).max(40).optional().describe('m/s'),
      windFrom: z.number().min(0).max(360).optional().describe('degrees the wind blows from'),
    },
    async (env) => api('PUT', '/api/v1/simulation/environment', env),
    { idempotentHint: true },
  );

  tool(
    'set_reactions',
    'Automatic behaviours that run alongside tasks: onContact "halt" makes the entity/unit stop and fight while a hostile is within weapon range, then resume its task; withdrawBelow (0-1) makes a unit abandon its plan and fall back (to withdrawTo, default its current position) when its strength drops below that fraction, or an entity when its weapons are knocked out; callForFire makes it request fire missions from idle friendly artillery in range on hostiles it sees (not within 150 m of friendly troops).',
    {
      targetId: z.string(),
      onContact: z.enum(['continue', 'halt']).optional(),
      withdrawBelow: z.number().min(0).max(1).optional(),
      withdrawTo: position.optional(),
      callForFire: z.boolean().optional(),
    },
    async ({ targetId, ...reactions }) => {
      const kind = targetId.startsWith('U') ? 'units' : 'entities';
      const r = await api<{ name: string; reactions?: unknown }>('PATCH', `/api/v1/${kind}/${encodeURIComponent(targetId)}`, { reactions });
      return { name: r.name, reactions: r.reactions ?? {} };
    },
    { idempotentHint: true },
  );

  // ---------------------------------------------------------------- after-action review

  tool(
    'run_batch',
    'Monte Carlo analysis: replicate a scenario (a stored one by name, or the current state) with different random seeds and summarise the outcomes: losses per force (mean, standard deviation, 95% confidence interval, histogram), loss exchange ratio, which force holds each area at the end, rounds fired. Runs in the background on the server; waits up to `waitSeconds` for the result, else returns the job id to check with jobId.',
    {
      scenario: z.string().optional().describe('stored scenario name (default: the current state)'),
      runs: z.number().int().min(1).max(1000).optional().describe('replications (default 10)'),
      durationMinutes: z.number().positive().optional().describe('simulated minutes per run (default 30)'),
      seed: z.number().int().optional(),
      waitSeconds: z.number().min(0).max(600).optional().describe('how long to wait for the result (default 120)'),
      jobId: z.string().optional().describe('check on a batch started earlier instead of starting one'),
    },
    async (a) => {
      type Job = { id: string; status: string; done: number; runs: number; error?: string; summary?: { scenario: string; runs: number; duration: number; losses: { force: number; total: number; stats: { mean: number; sd: number; ci95: [number, number]; min: number; max: number } }[]; exchangeRatio?: number; areas: { name: string; held: Record<string, number> }[]; shots: { mean: number }; wallSeconds: number } };
      let job = a.jobId
        ? await api<Job>('GET', `/api/v1/batch/${encodeURIComponent(a.jobId)}`)
        : await api<Job>('POST', '/api/v1/batch', { scenario: a.scenario, runs: a.runs, duration: a.durationMinutes === undefined ? undefined : a.durationMinutes * 60, seed: a.seed });
      const until = Date.now() + (a.waitSeconds ?? 120) * 1000;
      while (job.status === 'running' && Date.now() < until) {
        await new Promise((r) => setTimeout(r, 1000));
        job = await api<Job>('GET', `/api/v1/batch/${encodeURIComponent(job.id)}`);
      }
      if (job.status !== 'done' || !job.summary) return `Batch ${job.id}: ${job.status}, ${job.done}/${job.runs} runs${job.error ? ` (${job.error})` : ''}. Call run_batch with jobId "${job.id}" to check again.`;
      const s = job.summary;
      const name = (f: number) => ['Other', 'Blue', 'Red', 'Neutral'][f] ?? String(f);
      const lines = [`Batch ${job.id}: ${s.scenario}, ${s.runs} runs of ${Math.round(s.duration / 60)} min (${s.wallSeconds} s)`];
      for (const l of s.losses) lines.push(`${name(l.force)} losses: ${l.stats.mean} ± ${l.stats.sd} of ${l.total} (95% CI ${l.stats.ci95[0]}-${l.stats.ci95[1]}, range ${l.stats.min}-${l.stats.max})`);
      if (s.exchangeRatio !== undefined) lines.push(`Loss exchange ratio (red/blue): ${s.exchangeRatio}`);
      for (const ar of s.areas) lines.push(`${ar.name} held at the end: ${Object.entries(ar.held).map(([f, p]) => `${name(Number(f))} ${Math.round(p * 100)}%`).join(', ') || 'by nobody'}`);
      lines.push(`Rounds fired per run: ${s.shots.mean}`);
      return lines.join('\n');
    },
  );

  tool(
    'after_action_report',
    'After-action review of the run so far (or of a loaded recording): strength and losses per force, every kill with killer, weapon and time, rounds fired per weapon, bookmarks.',
    {},
    async () => {
      const r = await api<AarReport>('GET', '/api/v1/recording/report');
      const name = (f: number) => ['Other', 'Blue', 'Red', 'Neutral'][f] ?? String(f);
      const lines = [`AAR: ${r.scenarioName}, ${fmtTime(r.start)} to ${fmtTime(r.end)}`];
      for (const f of r.forces) lines.push(`${name(f.force)}: ${f.end}/${f.start} remaining, ${f.losses} lost, ${f.kills} kills, ${f.shots} rounds fired`);
      if (r.kills.length) lines.push('Kills:', ...r.kills.map((k) => `  ${fmtTime(k.time)} ${k.victim} (${name(k.victimForce)}) by ${k.killer ?? 'unknown'}${k.weaponId ? ` with ${k.weaponId}` : ''}`));
      if (r.bookmarks.length) lines.push('Bookmarks:', ...r.bookmarks.map((b) => `  ${fmtTime(b.time)} ${b.text}`));
      return lines.join('\n');
    },
    { readOnlyHint: true },
  );

  tool(
    'replay_state',
    'Where everything was at a past simulation time, from the recording: entity positions (grid, lat/lon), damage and units.',
    { time: z.number().describe('simulation time in seconds'), force: z.number().int().min(0).max(3).optional() },
    async ({ time, force }) => {
      const s = await api<{ time: number; entities: { id: string; name: string; force: number; damage: string; lat: number; lon: number; embarkedIn?: string }[] }>('GET', `/api/v1/recording/state?time=${time}`);
      return {
        time: s.time,
        entities: s.entities
          .filter((e) => force === undefined || e.force === force)
          .map((e) => ({ id: e.id, name: e.name, force: e.force, damage: e.damage, lat: e.lat, lon: e.lon, mounted: e.embarkedIn })),
      };
    },
    { readOnlyHint: true },
  );

  tool(
    'add_bookmark',
    'Add a note to the recording at the current (or a given) simulation time, for the after-action review.',
    { text: z.string().min(1).max(200), time: z.number().optional() },
    async ({ text, time }) => {
      const b = await api<{ id: string; time: number }>('POST', '/api/v1/recording/bookmarks', { text, time });
      return `bookmark ${b.id} at ${fmtTime(b.time)}`;
    },
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
    'List, load or save scenarios stored on the server, start an empty one, or undo/redo the last edit (up to 30 steps).',
    { action: z.enum(['list', 'load', 'save', 'new', 'undo', 'redo']), name: z.string().optional() },
    async ({ action, name }) => {
      if (action === 'list') return api('GET', '/api/v1/scenarios');
      if (action === 'undo' || action === 'redo') return api('POST', `/api/v1/scenario/${action}`);
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
