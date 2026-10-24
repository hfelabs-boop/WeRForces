// Versioned, resource-oriented REST API (/api/v1). The same routes back the MCP server.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { entitiesGeoJSON, frameFor, graphicsGeoJSON, liveKML, sceneKML } from '../integrations/gis.js';
import type { IntegrationHub } from '../integrations/hub.js';
import { dist2d } from '../shared/math.js';
import type { Command, CommandResult, EntitySnapshot, ForceId, Role, ScenarioFile, SimEventKind, SimState, TerrainData, TerrainDataset, UnitSnapshot, Vec2 } from '../shared/types.js';
import { outcomesCsv } from '../sim/batch.js';
import type { BatchManager } from './batch.js';
import { attachment, eventsCsv, killsCsv, reportPdf, strengthCsv } from './reports.js';
import { DATASET_NAME, listDatasets } from '../terrain/store.js';
import { Terrain } from '../sim/terrain.js';
import { CONTROLLER, canSee, checkCommand, filterEvents, filterState, ForbiddenError } from './fog.js';
import { FORCE_NAMES } from '../shared/types.js';
import { executeCommand } from './commands.js';
import { buildOpenApi } from './openapi.js';
import { HttpError, Router, type RouteRequest } from './router.js';
import type { SimRunner } from './runner.js';

export interface ApiContext {
  runner: SimRunner;
  integrations: IntegrationHub;
  scenarioDir: string;
  /** Where saved recordings go (default: a "recordings" folder next to scenarioDir). */
  recordingDir?: string;
  /** Imported terrain datasets (default: a "terrains" folder next to scenarioDir). */
  terrainDir?: string;
  /** Batch (Monte Carlo) jobs. */
  batch?: BatchManager;
}

const SCENARIO_NAME = /^[A-Za-z0-9_-]{1,64}$/;

function obj(body: unknown): Record<string, unknown> {
  if (body === undefined || body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'request body must be a JSON object');
  return body as Record<string, unknown>;
}

function num(v: unknown, what: string): number {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new HttpError(400, `${what} must be a number`);
  return n;
}

/** Routes a player may use (everything else is exercise control only). */
const PLAYER_ROUTES: [string, RegExp][] = [
  ['GET', /^\/api\/v1\/?$/],
  ['GET', /^\/api\/v1\/(openapi\.json|simulation|catalog(\/[\w-]+)?|entities|units|graphics|events|terrain(\/point)?)\/?$/],
  ['GET', /^\/api\/v1\/(entities|units|graphics)\/[^/]+\/?$/],
  ['GET', /^\/api\/v1\/entities\/[^/]+\/path\/?$/],
  ['POST', /^\/api\/v1\/(entities|units)\/[^/]+\/(task|plan|stop|embark|disembark)\/?$/],
  ['POST', /^\/api\/v1\/(graphics|terrain\/line-of-sight|terrain\/route)\/?$/],
  ['PATCH', /^\/api\/v1\/(entities|units|graphics)\/[^/]+\/?$/],
  ['DELETE', /^\/api\/v1\/graphics\/[^/]+\/?$/],
];

export class ApiV1 {
  readonly router = new Router();
  /** Role of the request being handled (handlers run synchronously, one at a time). */
  private role: Role = CONTROLLER;

  constructor(readonly ctx: ApiContext) {
    this.routes();
  }

  private get engine() {
    return this.ctx.runner.engine;
  }

  /** Handle a request as a role: players get their force's view and orders only. */
  dispatch(input: Omit<RouteRequest, 'params'>) {
    const role = input.role ?? CONTROLLER;
    if (role.kind === 'player' && !PLAYER_ROUTES.some(([m, re]) => m === input.method && re.test(input.path))) {
      const status = this.router.matches(input.path) ? 403 : 404;
      return Promise.resolve({ status, json: { error: { status, message: status === 403 ? 'exercise control only' : 'unknown endpoint' } } });
    }
    this.role = role;
    return this.router.dispatch(input);
  }

  private run(c: Command): CommandResult {
    try {
      checkCommand(this.engine, this.role, c);
    } catch (err) {
      if (err instanceof ForbiddenError) throw new HttpError(403, err.message);
      throw err;
    }
    const r = executeCommand(this.ctx.runner, c);
    if (!r.ok) throw new HttpError(/^unknown (entity|unit|object|local entity|graphic)\b(?! type)/.test(r.error ?? '') ? 404 : 400, r.error ?? 'command failed');
    return r;
  }

  /** Accepts {x, y} metres, {lat, lon} degrees, or {town: name}. */
  point(v: unknown, what = 'position'): Vec2 {
    const p = obj(v);
    if (p.x !== undefined || p.y !== undefined) return { x: num(p.x, `${what}.x`), y: num(p.y, `${what}.y`) };
    if (p.lat !== undefined || p.lon !== undefined) {
      const lat = num(p.lat, `${what}.lat`);
      const lon = num(p.lon, `${what}.lon`);
      const l = frameFor(this.engine.terrain.spec).fromGeodetic({ lat: (lat * Math.PI) / 180, lon: (lon * Math.PI) / 180, alt: 0 });
      return { x: l.x, y: l.y };
    }
    if (typeof p.town === 'string') {
      const t = this.engine.terrain.towns.find((x) => x.name.toLowerCase() === (p.town as string).toLowerCase());
      if (!t) throw new HttpError(400, `unknown town ${p.town}; towns: ${this.engine.terrain.towns.map((x) => x.name).join(', ')}`);
      return { x: t.x, y: t.y };
    }
    throw new HttpError(400, `${what} needs {x,y}, {lat,lon} or {town}`);
  }

  private geo(p: { x: number; y: number }) {
    const g = frameFor(this.engine.terrain.spec).toGeodetic({ x: p.x, y: p.y, z: 0 });
    return { lat: Math.round(((g.lat * 180) / Math.PI) * 1e7) / 1e7, lon: Math.round(((g.lon * 180) / Math.PI) * 1e7) / 1e7 };
  }

  entityView(e: EntitySnapshot) {
    return { ...e, ...this.geo(e), headingDeg: Math.round((((e.heading * 180) / Math.PI) % 360 + 360) % 360) };
  }

  unitView(u: UnitSnapshot) {
    return { ...u, ...this.geo(u) };
  }

  private state(): SimState {
    const s = this.ctx.runner.state();
    return this.role.kind === 'player' ? filterState(this.engine, s, this.role.force) : s;
  }

  private entity(id: string): EntitySnapshot {
    const e = this.engine.entities.get(id);
    if (!e || !canSee(this.engine, this.role, id)) throw new HttpError(404, `unknown entity ${id}`);
    if (this.role.kind === 'player' && e.force !== this.role.force) return this.state().entities.find((x) => x.id === id)!;
    return this.engine.snapshotEntity(e);
  }

  /** Entities a player may ask detailed questions about (own force only). */
  private ownEntity(id: string): EntitySnapshot {
    const e = this.entity(id);
    if (this.role.kind === 'player' && e.force !== this.role.force) throw new HttpError(404, `unknown entity ${id}`);
    return e;
  }

  private unit(id: string): UnitSnapshot {
    const u = this.state().units.find((x) => x.id === id);
    if (!u) throw new HttpError(404, `unknown unit ${id}`);
    return u;
  }

  private weaponName(id: string): string {
    return this.engine.catalog.weapons.get(id)?.name ?? id;
  }

  private history() {
    return { undo: this.ctx.runner.undoStack.length, redo: this.ctx.runner.redoStack.length, time: this.engine.time };
  }

  simulationSummary() {
    const s = this.state();
    const strength = ([1, 2, 3, 0] as ForceId[])
      .map((f) => {
        const list = s.entities.filter((e) => e.force === f);
        return { force: f, name: FORCE_NAMES[f], total: list.length, alive: list.filter((e) => e.damage !== 'destroyed').length };
      })
      .filter((x) => x.total > 0);
    const t = this.engine.terrain;
    return {
      scenario: s.scenarioName,
      description: this.engine.description,
      time: s.time,
      running: s.running,
      timeScale: s.timeScale,
      /** Share of wall-clock time spent simulating (near 1: the server cannot keep up with the time scale). */
      load: this.ctx.runner.load,
      strength,
      entities: s.entities.length,
      units: s.units.length,
      graphics: s.graphics.length,
      terrain: {
        size: t.spec.size,
        origin: t.spec.origin,
        note: 'Local coordinates are metres: x east, y north, from the south-west corner (0,0) to (size,size).',
        towns: t.towns,
      },
      environment: { localTime: this.engine.env.localTime, period: this.engine.env.period, light: this.engine.env.light, visibility: this.engine.env.visibility, precipitation: this.engine.env.precipitation },
      dis: s.dis ?? { enabled: false },
      lastEventSeq: this.engine.eventsSince(0).at(-1)?.seq ?? 0,
    };
  }

  private routes(): void {
    const r = this.router;
    const P = '/api/v1';

    // ---------------------------------------------------------------- meta
    r.get(`${P}`, () => ({ json: { name: 'WeRForces API', version: 1, openapi: `${P}/openapi.json`, docs: '/api/docs' } }));
    r.get(`${P}/openapi.json`, (req) => ({ json: buildOpenApi(req.baseUrl) }));

    // ---------------------------------------------------------------- simulation
    r.get(`${P}/simulation`, () => ({ json: this.simulationSummary() }));
    r.post(`${P}/simulation/run`, () => (this.run({ cmd: 'run' }), { json: this.simulationSummary() }));
    r.post(`${P}/simulation/pause`, () => (this.run({ cmd: 'pause' }), { json: this.simulationSummary() }));
    r.post(`${P}/simulation/rewind`, () => (this.run({ cmd: 'rewind' }), { json: this.simulationSummary() }));
    r.post(`${P}/simulation/step`, (req) => {
      const b = obj(req.body);
      const seconds = b.seconds === undefined ? 1 : num(b.seconds, 'seconds');
      if (seconds <= 0 || seconds > 3600) throw new HttpError(400, 'seconds must be in (0, 3600]');
      // Commands cap a single step at 600 s; split longer requests.
      for (let left = seconds; left > 1e-9; left -= 600) this.run({ cmd: 'step', seconds: Math.min(600, left) });
      return { json: this.simulationSummary() };
    });
    r.get(`${P}/simulation/rules`, () => ({ json: this.engine.rules }));
    r.put(`${P}/simulation/rules`, (req) => {
      this.run({ cmd: 'setRules', rules: obj(req.body) as never });
      return { json: this.engine.rules };
    });
    r.get(`${P}/simulation/environment`, () => ({ json: this.engine.env }));
    r.put(`${P}/simulation/environment`, (req) => {
      this.run({ cmd: 'setEnvironment', environment: obj(req.body) as never });
      return { json: this.engine.env };
    });
    r.put(`${P}/simulation/time-scale`, (req) => {
      this.run({ cmd: 'setTimeScale', scale: num(obj(req.body).scale, 'scale') });
      return { json: this.simulationSummary() };
    });

    // ---------------------------------------------------------------- scenario
    r.get(`${P}/scenario`, () => ({ json: this.engine.toScenario() }));
    r.put(`${P}/scenario`, (req) => (this.run({ cmd: 'loadScenario', scenario: obj(req.body) as never }), { json: this.simulationSummary() }));
    r.post(`${P}/scenario/new`, (req) => {
      const b = obj(req.body);
      this.run({ cmd: 'newScenario', name: typeof b.name === 'string' ? b.name : 'Untitled', terrain: b.terrain as never });
      return { status: 201, json: this.simulationSummary() };
    });
    r.post(`${P}/scenario/undo`, () => (this.run({ cmd: 'undo' }), { json: this.history() }));
    r.post(`${P}/scenario/redo`, () => (this.run({ cmd: 'redo' }), { json: this.history() }));
    r.get(`${P}/scenarios`, () => ({ json: this.listScenarios() }));

    // ---------------------------------------------------------------- batch runs
    const batch = () => {
      if (!this.ctx.batch) throw new HttpError(409, 'batch runs are not available here');
      return this.ctx.batch;
    };
    const job = (id: string) => {
      const j = batch().get(id);
      if (!j) throw new HttpError(404, `unknown batch job ${id}`);
      return j;
    };
    r.get(`${P}/batch`, () => ({ json: batch().list() }));
    r.post(`${P}/batch`, (req) => {
      const b = obj(req.body);
      const runs = b.runs === undefined ? 10 : Math.floor(num(b.runs, 'runs'));
      const duration = b.duration === undefined ? 1800 : num(b.duration, 'duration');
      if (runs < 1 || runs > 1000) throw new HttpError(400, 'runs must be between 1 and 1000');
      if (duration <= 0 || duration > 86400) throw new HttpError(400, 'duration must be in (0, 86400] seconds');
      const scenario = (typeof b.scenario === 'string' ? this.readScenario(b.scenario) : b.scenario && typeof b.scenario === 'object' ? b.scenario : this.engine.toScenario()) as ScenarioFile;
      if (scenario.format !== 'werforces-scenario') throw new HttpError(400, 'not a WeRForces scenario');
      const terrains: Record<string, TerrainData> = {};
      const ds = scenario.terrain?.dataset;
      if (ds) terrains[ds] = this.engine.terrain.spec.dataset === ds ? this.engine.terrain.toData() : this.engine.terrainLoader!(ds);
      const j = batch().start({
        scenario,
        options: { runs, duration, seed: b.seed === undefined ? 1000 : Math.floor(num(b.seed, 'seed')), stopWhenDestroyed: b.stopWhenDestroyed !== false },
        catalog: this.engine.catalog.catalog,
        terrains,
      });
      return { status: 202, json: { ...j, outcomes: undefined } };
    });
    r.get(`${P}/batch/{id}`, (req) => {
      const j = job(req.params.id);
      return { json: { ...j, outcomes: req.query.get('outcomes') === 'true' ? j.outcomes : undefined } };
    });
    r.get(`${P}/batch/{id}/runs.csv`, (req) => ({ text: outcomesCsv(job(req.params.id).outcomes), contentType: 'text/csv; charset=utf-8', headers: attachment(`batch-${req.params.id}.csv`) }));
    r.delete(`${P}/batch/{id}`, (req) => {
      job(req.params.id);
      batch().cancel(req.params.id);
      return { status: 204 };
    });
    r.get(`${P}/scenarios/{name}`, (req) => ({ json: this.readScenario(req.params.name) }));
    r.post(`${P}/scenarios/{name}/load`, (req) => {
      this.run({ cmd: 'loadScenario', scenario: this.readScenario(req.params.name) as never });
      return { json: this.simulationSummary() };
    });
    r.put(`${P}/scenarios/{name}`, (req) => {
      const name = req.params.name;
      if (!SCENARIO_NAME.test(name)) throw new HttpError(400, 'invalid scenario name');
      writeFileSync(path.join(this.ctx.scenarioDir, `${name}.json`), JSON.stringify(this.engine.toScenario(), null, 2));
      // Rewind now returns to what was just saved.
      this.engine.markRewindPoint();
      return { json: { saved: name } };
    });

    // ---------------------------------------------------------------- terrain datasets
    const terrainDir = () => this.ctx.terrainDir ?? path.join(path.dirname(this.ctx.scenarioDir), 'terrains');
    r.get(`${P}/terrains`, () => ({ json: listDatasets(terrainDir()) }));
    r.put(`${P}/terrains/{name}`, (req) => {
      const name = req.params.name;
      const ds = obj(req.body) as unknown as TerrainDataset;
      if (!DATASET_NAME.test(name)) throw new HttpError(400, 'invalid dataset name');
      if (ds.format !== 'werforces-terrain' || !ds.spec || typeof ds.heightsB64 !== 'string') throw new HttpError(400, 'not a WeRForces terrain dataset (make one with werforces-terrain)');
      try {
        Terrain.fromData(ds);
      } catch (err) {
        throw new HttpError(400, (err as Error).message);
      }
      mkdirSync(terrainDir(), { recursive: true });
      writeFileSync(path.join(terrainDir(), `${name}.json`), JSON.stringify({ ...ds, name, spec: { ...ds.spec, dataset: name } }));
      return { json: { saved: name } };
    });

    // ---------------------------------------------------------------- recording & AAR
    const rec = () => {
      if (!this.ctx.runner.recorder) throw new HttpError(409, 'recording is disabled (--record-interval 0)');
      return this.ctx.runner.recorder;
    };
    r.get(`${P}/recording`, () => ({ json: rec().summary() }));
    r.get(`${P}/recording/data`, () => ({ json: rec().toJSON() }));
    r.get(`${P}/recording/report`, () => ({ json: rec().report() }));
    r.get(`${P}/recording/events.csv`, () => ({ text: eventsCsv(rec().report(), rec().toJSON().events), contentType: 'text/csv; charset=utf-8', headers: attachment('events.csv') }));
    r.get(`${P}/recording/kills.csv`, () => ({ text: killsCsv(rec().report(), (w) => this.weaponName(w)), contentType: 'text/csv; charset=utf-8', headers: attachment('kills.csv') }));
    r.get(`${P}/recording/strength.csv`, () => ({ text: strengthCsv(rec().report()), contentType: 'text/csv; charset=utf-8', headers: attachment('strength.csv') }));
    r.get(`${P}/recording/report.pdf`, () => ({ bytes: reportPdf(rec().report(), (w) => this.weaponName(w)), contentType: 'application/pdf', headers: attachment('aar-report.pdf') }));
    r.get(`${P}/recording/state`, (req) => {
      const s = rec().summary();
      const t = req.query.get('time') === null ? s.end : num(req.query.get('time'), 'time');
      const st = rec().stateAt(t);
      return { json: { time: st.time, entities: st.entities.map((e) => this.entityView(e)), units: st.units.map((u) => this.unitView(u)) } };
    });
    r.post(`${P}/recording/bookmarks`, (req) => {
      const b = obj(req.body);
      if (typeof b.text !== 'string' || !b.text.trim()) throw new HttpError(400, 'text is required');
      const mark = rec().addBookmark(b.text.trim(), b.time === undefined ? undefined : num(b.time, 'time'));
      // Other simulations on the DIS network see it as a Comment PDU.
      this.ctx.runner.gateway?.sendComment(`Bookmark: ${mark.text}`);
      return { status: 201, json: mark };
    });
    r.delete(`${P}/recording/bookmarks/{id}`, (req) => {
      if (!rec().removeBookmark(req.params.id)) throw new HttpError(404, `unknown bookmark ${req.params.id}`);
      return { status: 204 };
    });
    r.post(`${P}/recording/clear`, () => (rec().clear(), { json: rec().summary() }));
    r.post(`${P}/recording/load`, (req) => {
      try {
        rec().load(obj(req.body) as never);
      } catch (err) {
        throw new HttpError(400, (err as Error).message);
      }
      return { json: rec().summary() };
    });
    r.get(`${P}/recordings`, () => ({ json: this.listRecordings() }));
    r.put(`${P}/recordings/{name}`, (req) => {
      const name = req.params.name;
      if (!SCENARIO_NAME.test(name)) throw new HttpError(400, 'invalid recording name');
      mkdirSync(this.recordingDir, { recursive: true });
      writeFileSync(path.join(this.recordingDir, `${name}.json`), JSON.stringify(rec().toJSON()));
      return { json: { saved: name } };
    });
    r.post(`${P}/recordings/{name}/load`, (req) => {
      const name = req.params.name;
      const file = path.join(this.recordingDir, `${name}.json`);
      if (!SCENARIO_NAME.test(name) || !existsSync(file)) throw new HttpError(404, `unknown recording ${name}`);
      try {
        rec().load(JSON.parse(readFileSync(file, 'utf8')));
      } catch (err) {
        throw new HttpError(400, (err as Error).message);
      }
      return { json: rec().summary() };
    });

    // ---------------------------------------------------------------- catalog
    r.get(`${P}/catalog`, () => ({ json: this.engine.catalog.catalog }));
    r.get(`${P}/catalog/entity-types`, () => ({
      json: this.engine.catalog.catalog.entityTypes.map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        domain: t.domain,
        maxSpeedKmh: Math.round(t.maxSpeed * 3.6),
        weapons: t.weapons,
        sensors: t.sensors,
      })),
    }));
    r.get(`${P}/catalog/unit-templates`, () => ({ json: this.engine.catalog.catalog.unitTemplates }));

    // ---------------------------------------------------------------- entities
    r.get(`${P}/entities`, (req) => {
      const q = req.query;
      let list = this.state().entities;
      if (q.get('force')) list = list.filter((e) => String(e.force) === q.get('force') || FORCE_NAMES[e.force].toLowerCase() === q.get('force')!.toLowerCase());
      if (q.get('domain')) list = list.filter((e) => e.domain === q.get('domain'));
      if (q.get('unit')) list = list.filter((e) => e.unitId === q.get('unit'));
      if (q.get('alive') === 'true') list = list.filter((e) => e.damage !== 'destroyed');
      if (q.get('remote')) list = list.filter((e) => String(e.remote) === q.get('remote'));
      return { json: list.map((e) => this.entityView(e)) };
    });
    r.post(`${P}/entities`, (req) => {
      const b = obj(req.body);
      const p = this.point(b.position ?? b);
      const res = this.run({
        cmd: 'createEntity',
        typeId: b.typeId as string,
        force: b.force as ForceId,
        x: p.x,
        y: p.y,
        heading: b.heading as number | undefined,
        name: b.name as string | undefined,
        altitude: b.altitude as number | undefined,
      });
      return { status: 201, json: this.entityView(this.entity(res.id!)) };
    });
    r.get(`${P}/entities/{id}`, (req) => ({ json: this.entityView(this.entity(req.params.id)) }));
    r.patch(`${P}/entities/{id}`, (req) => {
      const id = req.params.id;
      this.entity(id);
      const b = obj(req.body);
      if (b.name !== undefined) this.run({ cmd: 'rename', id, name: b.name as string });
      if (b.roe !== undefined) this.run({ cmd: 'setRoe', targetId: id, roe: b.roe as never });
      if (b.reactions !== undefined) this.run({ cmd: 'setReactions', targetId: id, reactions: this.resolveReactions(b.reactions) as never });
      if (b.position !== undefined || b.x !== undefined || b.lat !== undefined) {
        const p = this.point(b.position ?? b);
        this.run({ cmd: 'moveEntity', id, x: p.x, y: p.y, heading: b.heading as number | undefined });
      }
      return { json: this.entityView(this.entity(id)) };
    });
    r.delete(`${P}/entities/{id}`, (req) => {
      this.entity(req.params.id);
      this.run({ cmd: 'deleteObject', id: req.params.id });
      return { status: 204 };
    });
    r.get(`${P}/entities/{id}/path`, (req) => (this.ownEntity(req.params.id), { json: this.engine.plannedPath(req.params.id) }));
    for (const kind of ['entities', 'units'] as const) {
      const check = (id: string) => (kind === 'entities' ? this.entity(id) : this.unit(id));
      r.post(`${P}/${kind}/{id}/task`, (req) => {
        check(req.params.id);
        this.run({ cmd: 'assignTask', targetId: req.params.id, task: this.resolveTask(req.body) as never });
        return { json: this.targetView(req.params.id) };
      });
      r.post(`${P}/${kind}/{id}/plan`, (req) => {
        check(req.params.id);
        this.run({ cmd: 'assignPlan', targetId: req.params.id, plan: this.resolvePlan(req.body) as never });
        return { json: this.targetView(req.params.id) };
      });
      r.post(`${P}/${kind}/{id}/embark`, (req) => {
        check(req.params.id);
        const carrierId = obj(req.body).carrierId;
        if (typeof carrierId !== 'string') throw new HttpError(400, 'carrierId is required');
        this.run({ cmd: 'embark', passengerId: req.params.id, carrierId });
        return { json: this.targetView(req.params.id) };
      });
      r.post(`${P}/${kind}/{id}/disembark`, (req) => {
        check(req.params.id);
        this.run({ cmd: 'disembark', carrierId: req.params.id });
        return { json: this.targetView(req.params.id) };
      });
      r.post(`${P}/${kind}/{id}/stop`, (req) => {
        check(req.params.id);
        this.run({ cmd: 'stop', targetId: req.params.id });
        return { json: this.targetView(req.params.id) };
      });
    }

    // ---------------------------------------------------------------- units
    r.get(`${P}/units`, (req) => {
      let list = this.state().units;
      const f = req.query.get('force');
      if (f) list = list.filter((u) => String(u.force) === f || FORCE_NAMES[u.force].toLowerCase() === f.toLowerCase());
      return { json: list.map((u) => this.unitView(u)) };
    });
    r.post(`${P}/units`, (req) => {
      const b = obj(req.body);
      let res: CommandResult;
      if (Array.isArray(b.entityIds)) {
        res = this.run({ cmd: 'groupUnit', entityIds: b.entityIds as string[], name: b.name as string | undefined, formation: b.formation as never });
      } else {
        const p = this.point(b.position ?? b);
        res = this.run({
          cmd: 'createUnit',
          templateId: b.templateId as string,
          force: b.force as ForceId,
          x: p.x,
          y: p.y,
          heading: b.heading as number | undefined,
          name: b.name as string | undefined,
        });
      }
      const u = this.unit(res.id!);
      return { status: 201, json: { ...this.unitView(u), members: u.memberIds.map((id) => this.entityView(this.entity(id))) } };
    });
    r.get(`${P}/units/{id}`, (req) => {
      const u = this.unit(req.params.id);
      return { json: { ...this.unitView(u), members: u.memberIds.map((id) => this.entityView(this.entity(id))) } };
    });
    r.patch(`${P}/units/{id}`, (req) => {
      const id = req.params.id;
      this.unit(id);
      const b = obj(req.body);
      if (b.name !== undefined) this.run({ cmd: 'rename', id, name: b.name as string });
      if (b.formation !== undefined) this.run({ cmd: 'setFormation', unitId: id, formation: b.formation as never });
      if (b.roe !== undefined) this.run({ cmd: 'setRoe', targetId: id, roe: b.roe as never });
      if (b.reactions !== undefined) this.run({ cmd: 'setReactions', targetId: id, reactions: this.resolveReactions(b.reactions) as never });
      if (b.superiorId !== undefined) this.run({ cmd: 'setSuperior', unitId: id, superiorId: b.superiorId as string | null });
      return { json: this.unitView(this.unit(id)) };
    });
    r.delete(`${P}/units/{id}`, (req) => {
      this.unit(req.params.id);
      this.run({ cmd: 'deleteObject', id: req.params.id });
      return { status: 204 };
    });

    // ---------------------------------------------------------------- graphics
    r.get(`${P}/graphics`, () => ({ json: this.state().graphics }));
    r.post(`${P}/graphics`, (req) => {
      const b = obj(req.body);
      if (!Array.isArray(b.points)) throw new HttpError(400, 'points must be an array');
      const res = this.run({
        cmd: 'createGraphic',
        kind: b.kind as never,
        name: b.name as string | undefined,
        points: b.points.map((p, i) => this.point(p, `points[${i}]`)),
        force: b.force as ForceId | undefined,
        density: b.density as number | undefined,
      } as Command);
      return { status: 201, json: this.engine.graphics.get(res.id!) };
    });
    r.get(`${P}/graphics/{id}`, (req) => {
      const g = this.engine.graphics.get(req.params.id);
      if (!g || (this.role.kind === 'player' && g.force !== this.role.force && g.force !== 0)) throw new HttpError(404, `unknown graphic ${req.params.id}`);
      return { json: g };
    });
    r.patch(`${P}/graphics/{id}`, (req) => {
      const b = obj(req.body);
      this.run({
        cmd: 'updateGraphic',
        id: req.params.id,
        name: b.name as string | undefined,
        points: Array.isArray(b.points) ? b.points.map((p, i) => this.point(p, `points[${i}]`)) : undefined,
        density: b.density as number | undefined,
      } as Command);
      return { json: this.engine.graphics.get(req.params.id) };
    });
    r.delete(`${P}/graphics/{id}`, (req) => {
      if (!this.engine.graphics.has(req.params.id)) throw new HttpError(404, `unknown graphic ${req.params.id}`);
      this.run({ cmd: 'deleteObject', id: req.params.id });
      return { status: 204 };
    });

    // ---------------------------------------------------------------- events
    r.get(`${P}/events`, (req) => {
      const since = Number(req.query.get('since') ?? 0) || 0;
      const kinds = req.query.get('kinds')?.split(',').filter(Boolean) as SimEventKind[] | undefined;
      const limit = Math.min(1000, Math.max(1, Number(req.query.get('limit') ?? 200) || 200));
      let evs = this.engine.eventsSince(since);
      if (this.role.kind === 'player') evs = filterEvents(this.engine, evs, this.role.force);
      if (kinds?.length) evs = evs.filter((e) => kinds.includes(e.kind));
      return { json: evs.slice(-limit) };
    });

    // ---------------------------------------------------------------- terrain
    r.get(`${P}/terrain`, () => {
      const t = this.engine.terrain;
      return { json: { spec: t.spec, towns: t.towns, roads: t.roads, data: '/api/terrain' } };
    });
    r.get(`${P}/terrain/point`, (req) => {
      const p = this.point(Object.fromEntries(req.query));
      const t = this.engine.terrain;
      if (!t.inBounds(p.x, p.y)) throw new HttpError(400, 'point is outside the terrain');
      const elevation = t.elevation(p.x, p.y);
      return {
        json: {
          x: p.x,
          y: p.y,
          ...this.geo(p),
          elevation: Math.round(Math.max(0, elevation) * 10) / 10,
          water: elevation < 0,
          forest: t.isForest(p.x, p.y),
          road: t.isRoad(p.x, p.y),
          slopeDeg: Math.round((Math.atan(t.slope(p.x, p.y)) * 180) / Math.PI * 10) / 10,
          nearestTown: t.towns.slice().sort((a, b) => dist2d(a, p) - dist2d(b, p))[0]?.name,
        },
      };
    });
    r.post(`${P}/terrain/line-of-sight`, (req) => {
      const b = obj(req.body);
      const a = this.endpoint(b.from, 'from');
      const c = this.endpoint(b.to, 'to');
      return { json: { visible: this.engine.lineOfSight(a, c, b.radar === true), distance: Math.round(Math.hypot(c.x - a.x, c.y - a.y, c.z - a.z)), from: a, to: c } };
    });
    r.post(`${P}/terrain/route`, (req) => {
      const b = obj(req.body);
      const from = this.point(b.from, 'from');
      const to = this.point(b.to, 'to');
      const domain = (b.domain as string) ?? 'ground';
      if (!['ground', 'lifeform', 'surface', 'air'].includes(domain)) throw new HttpError(400, 'invalid domain');
      const offroad = typeof b.offroadFactor === 'number' ? b.offroadFactor : 0.6;
      let force = typeof b.force === 'number' ? (b.force as ForceId) : undefined;
      // Players plan as their own force.
      if (this.role.kind === 'player') force = this.role.force;
      const route = force === undefined ? this.engine.terrain.planRoute(from, to, domain as never, offroad) : this.engine.planRoute(from, to, domain as never, offroad, force, b.covered === true);
      if (!route) throw new HttpError(422, 'no route found');
      const pts = [from, ...route];
      let length = 0;
      for (let i = 1; i < pts.length; i++) length += dist2d(pts[i - 1], pts[i]);
      return { json: { waypoints: route, length: Math.round(length) } };
    });

    // ---------------------------------------------------------------- integrations
    r.get(`${P}/integrations`, () => ({ json: this.ctx.integrations.status() }));
    r.get(`${P}/integrations/cot`, () => ({ json: this.ctx.integrations.cot.status() }));
    r.put(`${P}/integrations/cot`, (req) => {
      const b = obj(req.body);
      try {
        return {
          json: this.ctx.integrations.cot.configure({
            enabled: b.enabled === undefined ? undefined : b.enabled === true,
            url: b.url as string | undefined,
            interval: b.interval as number | undefined,
            stale: b.stale as number | undefined,
            includeRemote: b.includeRemote === undefined ? undefined : b.includeRemote === true,
          } as never),
        };
      } catch (err) {
        throw new HttpError(400, (err as Error).message);
      }
    });
    r.get(`${P}/webhooks`, () => ({ json: this.ctx.integrations.webhooks.list() }));
    r.post(`${P}/webhooks`, (req) => {
      try {
        return { status: 201, json: this.ctx.integrations.webhooks.add(req.body as never) };
      } catch (err) {
        throw new HttpError(400, (err as Error).message);
      }
    });
    r.delete(`${P}/webhooks/{id}`, (req) => {
      if (!this.ctx.integrations.webhooks.remove(req.params.id)) throw new HttpError(404, 'unknown webhook');
      return { status: 204 };
    });
    r.post(`${P}/webhooks/{id}/test`, async (req) => {
      if (!this.ctx.integrations.webhooks.view(req.params.id)) throw new HttpError(404, 'unknown webhook');
      return { json: await this.ctx.integrations.webhooks.test(req.params.id) };
    });

    // ---------------------------------------------------------------- GIS exports
    r.get(`${P}/export/entities.geojson`, () => ({ json: entitiesGeoJSON(this.state(), this.engine.terrain.spec), contentType: 'application/geo+json' }));
    r.get(`${P}/export/graphics.geojson`, () => ({ json: graphicsGeoJSON(this.state(), this.engine.terrain.spec), contentType: 'application/geo+json' }));
    r.get(`${P}/export/scene.kml`, () => ({ text: sceneKML(this.state(), this.engine.terrain.spec), contentType: 'application/vnd.google-earth.kml+xml' }));
    r.get(`${P}/export/live.kml`, (req) => {
      const key = req.query.get('api_key');
      const scene = `${req.baseUrl}${P}/export/scene.kml${key ? `?api_key=${encodeURIComponent(key)}` : ''}`;
      const refresh = Math.max(1, Number(req.query.get('refresh') ?? 5) || 5);
      return {
        text: liveKML(scene, refresh),
        contentType: 'application/vnd.google-earth.kml+xml',
        headers: { 'Content-Disposition': 'attachment; filename="werforces-live.kml"' },
      };
    });
  }

  private targetView(id: string) {
    const e = this.engine.entities.get(id);
    if (e) return this.entityView(this.engine.snapshotEntity(e));
    return this.unitView(this.unit(id));
  }

  /** Line-of-sight endpoint: an entity id (uses its eye point) or a position (+ optional height above ground). */
  private endpoint(v: unknown, what: string) {
    if (typeof v === 'string') {
      const e = this.engine.entities.get(v);
      if (!e) throw new HttpError(404, `unknown entity ${v}`);
      this.ownEntity(v);
      return e.eye;
    }
    const p = this.point(v, what);
    const h = obj(v).height;
    return { x: p.x, y: p.y, z: this.engine.terrain.surfaceHeight(p.x, p.y) + (h === undefined ? 2 : num(h, `${what}.height`)) };
  }

  /** Let task positions use {lat,lon} or {town} as well as {x,y}. */
  resolveTask(body: unknown): unknown {
    const t = { ...obj(body) };
    if (t.target && typeof t.target === 'object') t.target = this.point(t.target, 'target');
    if (t.center && typeof t.center === 'object') t.center = this.point(t.center, 'center');
    if (t.position && typeof t.position === 'object') t.position = this.point(t.position, 'position');
    if (t.fallback && typeof t.fallback === 'object') t.fallback = this.point(t.fallback, 'fallback');
    return t;
  }

  resolvePlan(body: unknown): unknown {
    const p = { ...obj(body) };
    if (Array.isArray(p.statements)) {
      p.statements = p.statements.map((s) => {
        const st = { ...obj(s) };
        if (st.kind === 'task') st.task = this.resolveTask(st.task);
        if (st.kind === 'setReactions') st.reactions = this.resolveReactions(st.reactions);
        return st;
      });
    }
    return p;
  }

  resolveReactions(body: unknown): unknown {
    const r = { ...obj(body) };
    if (r.withdrawTo && typeof r.withdrawTo === 'object') r.withdrawTo = this.point(r.withdrawTo, 'withdrawTo');
    return r;
  }

  private get recordingDir(): string {
    return this.ctx.recordingDir ?? path.join(path.dirname(this.ctx.scenarioDir), 'recordings');
  }

  private listRecordings() {
    const dir = this.recordingDir;
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        const name = f.replace(/\.json$/, '');
        const st = statSync(path.join(dir, f));
        return { name, bytes: st.size, modified: st.mtime.toISOString() };
      });
  }

  private listScenarios() {
    const dir = this.ctx.scenarioDir;
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        const name = f.replace(/\.json$/, '');
        try {
          const s = JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
          return { name, title: String(s.name ?? name), description: String(s.description ?? '') };
        } catch {
          return { name, title: name, description: '(unreadable)' };
        }
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  readScenario(name: string): unknown {
    if (!SCENARIO_NAME.test(name)) throw new HttpError(400, 'invalid scenario name');
    const file = path.join(this.ctx.scenarioDir, `${name}.json`);
    if (!existsSync(file)) throw new HttpError(404, `scenario ${name} not found`);
    return JSON.parse(readFileSync(file, 'utf8'));
  }

  /** In-process call (used by the embedded MCP server). */
  call(method: string, pathAndQuery: string, body?: unknown, baseUrl = '', role: Role = CONTROLLER) {
    const u = new URL(pathAndQuery, 'http://local');
    return this.dispatch({ method, path: u.pathname, query: u.searchParams, body, baseUrl, role });
  }
}

export type { RouteRequest };
