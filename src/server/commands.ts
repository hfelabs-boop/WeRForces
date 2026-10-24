// Remote-control command dispatcher shared by the REST and WebSocket APIs.

import type { Command, CommandResult, Condition, Environment, ForceId, Formation, Phase, PhaseOrder, PhaseTrigger, Plan, PlanStatement, Reactions, Roe, SimulationRules, TaskSpec, Vec2 } from '../shared/types.js';
import { FORCE_NAMES } from '../shared/types.js';
import type { Engine } from '../sim/engine.js';
import { MAX_AMBIENT } from '../sim/life.js';
import { CATALOG_SECTIONS, VALIDATORS } from '../sim/catalogEdit.js';
import type { SimRunner } from './runner.js';

const FORCES = new Set([0, 1, 2, 3]);
const ROES = new Set<Roe>(['holdFire', 'returnFire', 'fireAtWill']);
const FORMATIONS = new Set<Formation>(['column', 'line', 'wedge', 'vee', 'echelonRight']);

class ValidationError extends Error {}

function num(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new ValidationError(`${what} must be a finite number`);
  return v;
}

function str(v: unknown, what: string): string {
  if (typeof v !== 'string' || v.length === 0 || v.length > 200) throw new ValidationError(`${what} must be a non-empty string`);
  return v;
}

function vec(v: unknown, what: string): Vec2 {
  if (!v || typeof v !== 'object') throw new ValidationError(`${what} must be a point`);
  const p = v as Record<string, unknown>;
  return { x: num(p.x, `${what}.x`), y: num(p.y, `${what}.y`) };
}

function force(v: unknown): ForceId {
  if (!FORCES.has(v as number)) throw new ValidationError('force must be 0-3');
  return v as ForceId;
}

function roe(v: unknown): Roe {
  if (!ROES.has(v as Roe)) throw new ValidationError('invalid rules of engagement');
  return v as Roe;
}

function formation(v: unknown): Formation {
  if (!FORMATIONS.has(v as Formation)) throw new ValidationError('invalid formation');
  return v as Formation;
}

export function validateTask(v: unknown): TaskSpec {
  if (!v || typeof v !== 'object') throw new ValidationError('task must be an object');
  const t = v as Record<string, unknown>;
  const speed = t.speed === undefined ? undefined : num(t.speed, 'speed');
  switch (t.type) {
    case 'moveTo':
      return { type: 'moveTo', target: vec(t.target, 'target'), speed, covered: t.covered === true || undefined };
    case 'followRoute':
      return {
        type: 'followRoute',
        routeId: str(t.routeId, 'routeId'),
        speed,
        reverse: t.reverse === true,
        startIndex: t.startIndex === undefined ? undefined : Math.max(0, Math.floor(num(t.startIndex, 'startIndex'))),
      };
    case 'patrol':
      return { type: 'patrol', routeId: str(t.routeId, 'routeId'), speed };
    case 'wait':
      return { type: 'wait', duration: num(t.duration, 'duration') };
    case 'follow':
      return { type: 'follow', targetId: str(t.targetId, 'targetId'), distance: t.distance === undefined ? undefined : num(t.distance, 'distance') };
    case 'attack':
      return { type: 'attack', targetId: str(t.targetId, 'targetId') };
    case 'orbit':
      return {
        type: 'orbit',
        center: vec(t.center, 'center'),
        radius: num(t.radius, 'radius'),
        duration: t.duration === undefined ? undefined : num(t.duration, 'duration'),
      };
    case 'mount':
      return { type: 'mount', carrierId: str(t.carrierId, 'carrierId') };
    case 'dismount':
      return { type: 'dismount' };
    case 'manual':
      return { type: 'manual' };
    case 'fireMission': {
      const rounds = t.rounds === undefined ? undefined : Math.floor(num(t.rounds, 'rounds'));
      if (rounds !== undefined && (rounds < 1 || rounds > 100)) throw new ValidationError('rounds must be between 1 and 100');
      const radius = t.radius === undefined ? undefined : num(t.radius, 'radius');
      if (radius !== undefined && (radius < 0 || radius > 1000)) throw new ValidationError('radius must be between 0 and 1000 m');
      return {
        type: 'fireMission',
        target: vec(t.target, 'target'),
        rounds,
        radius,
        weaponId: t.weaponId === undefined ? undefined : str(t.weaponId, 'weaponId'),
        smoke: t.smoke === true || undefined,
      };
    }
    case 'breach':
      return { type: 'breach', graphicId: str(t.graphicId, 'graphicId') };
    case 'resupply':
      return t.supplierId === undefined ? { type: 'resupply' } : { type: 'resupply', supplierId: str(t.supplierId, 'supplierId') };
    case 'overwatch':
    case 'defend':
    case 'ambush':
    case 'screen': {
      const opt = (k: string, min: number, max: number) => {
        if (t[k] === undefined) return undefined;
        const x = num(t[k], k);
        if (x < min || x > max) throw new ValidationError(`${k} must be between ${min} and ${max}`);
        return x;
      };
      const base = { position: vec(t.position, 'position'), facing: opt('facing', 0, 360) };
      if (t.type === 'overwatch') return { type: 'overwatch', ...base, duration: opt('duration', 0, 1e7) };
      const width = opt('width', 0, 10000);
      if (t.type === 'defend') return { type: 'defend', ...base, width };
      if (t.type === 'ambush') return { type: 'ambush', ...base, width, killZoneId: str(t.killZoneId, 'killZoneId'), sprung: t.sprung === true || undefined };
      return { type: 'screen', ...base, width, fallback: t.fallback === undefined ? undefined : vec(t.fallback, 'fallback'), breakContact: opt('breakContact', 100, 20000) };
    }
    case 'search': {
      const spacing = t.spacing === undefined ? undefined : num(t.spacing, 'spacing');
      if (spacing !== undefined && (spacing < 20 || spacing > 10000)) throw new ValidationError('spacing must be between 20 and 10000 m');
      return { type: 'search', areaId: str(t.areaId, 'areaId'), spacing, speed, startIndex: t.startIndex === undefined ? undefined : Math.max(0, Math.floor(num(t.startIndex, 'startIndex'))) };
    }
    default:
      throw new ValidationError(`unknown task type ${String(t.type)}`);
  }
}

function validateCondition(v: unknown): Condition {
  if (!v || typeof v !== 'object') throw new ValidationError('condition must be an object');
  const c = v as Record<string, unknown>;
  switch (c.type) {
    case 'simTime':
      return { type: 'simTime', time: num(c.time, 'time') };
    case 'inArea':
      return { type: 'inArea', areaId: str(c.areaId, 'areaId') };
    case 'enemyDetected':
      return { type: 'enemyDetected' };
    case 'underFire':
      return { type: 'underFire' };
    case 'entityDestroyed':
      return { type: 'entityDestroyed', entityId: str(c.entityId, 'entityId') };
    case 'enemyInArea':
      return { type: 'enemyInArea', areaId: str(c.areaId, 'areaId') };
    case 'strengthBelow':
    case 'fuelBelow':
    case 'ammoBelow': {
      const fraction = num(c.fraction, 'fraction');
      if (fraction <= 0 || fraction > 1) throw new ValidationError('fraction must be in (0, 1]');
      return { type: c.type, fraction };
    }
    case 'codeword':
      return { type: 'codeword', codeword: codeword(c.codeword) };
    case 'all':
    case 'any': {
      if (!Array.isArray(c.conditions) || c.conditions.length === 0 || c.conditions.length > 20) throw new ValidationError(`${c.type}: conditions must be a list of 1 to 20 conditions`);
      return { type: c.type, conditions: c.conditions.map(validateCondition) };
    }
    case 'not':
      return { type: 'not', condition: validateCondition(c.condition) };
    default:
      throw new ValidationError(`unknown condition ${String(c.type)}`);
  }
}

export function validateReactions(v: unknown): Reactions {
  if (!v || typeof v !== 'object') throw new ValidationError('reactions must be an object');
  const r = v as Record<string, unknown>;
  const out: Reactions = {};
  if (r.onContact !== undefined) {
    if (r.onContact !== 'continue' && r.onContact !== 'halt') throw new ValidationError("onContact must be 'continue' or 'halt'");
    out.onContact = r.onContact;
  }
  if (r.withdrawBelow !== undefined && r.withdrawBelow !== null) {
    const f = num(r.withdrawBelow, 'withdrawBelow');
    if (f < 0 || f > 1) throw new ValidationError('withdrawBelow must be between 0 and 1');
    if (f > 0) out.withdrawBelow = f;
  }
  if (r.withdrawTo !== undefined) out.withdrawTo = vec(r.withdrawTo, 'withdrawTo');
  if (r.callForFire !== undefined) {
    if (typeof r.callForFire !== 'boolean') throw new ValidationError('callForFire must be a boolean');
    if (r.callForFire) out.callForFire = true;
  }
  return out;
}

/** A codeword: letters, digits, spaces and -, upper-cased. */
export function codeword(v: unknown): string {
  const s = str(v, 'codeword').trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9 _-]{0,39}$/.test(s)) throw new ValidationError('codeword: 1-40 letters, digits, spaces, - or _');
  return s;
}

function validateStatements(v: unknown, what: string, depth: number, count: { n: number }): PlanStatement[] {
  if (!Array.isArray(v)) throw new ValidationError(`${what} must be an array`);
  if (depth > 8) throw new ValidationError('plan blocks are nested too deeply');
  return v.map((s: unknown) => {
    if (++count.n > 200) throw new ValidationError('a plan has at most 200 statements');
    const st = (s ?? {}) as Record<string, unknown>;
    switch (st.kind) {
      case 'if':
        return { kind: 'if', condition: validateCondition(st.condition), then: validateStatements(st.then, 'if.then', depth + 1, count), ...(st.else !== undefined ? { else: validateStatements(st.else, 'if.else', depth + 1, count) } : {}) };
      case 'while':
        return { kind: 'while', condition: validateCondition(st.condition), body: validateStatements(st.body, 'while.body', depth + 1, count) };
      case 'sendCodeword':
        return { kind: 'sendCodeword', codeword: codeword(st.codeword) };
      case 'report': {
        const text = str(st.text, 'text').trim();
        if (!text || text.length > 200) throw new ValidationError('report text: 1-200 characters');
        return { kind: 'report', text };
      }
      case 'task':
        return { kind: 'task', task: validateTask(st.task) };
      case 'setRoe':
        return { kind: 'setRoe', roe: roe(st.roe) };
      case 'setSpeed':
        return { kind: 'setSpeed', speed: num(st.speed, 'speed') };
      case 'setAltitude':
        return { kind: 'setAltitude', altitude: num(st.altitude, 'altitude') };
      case 'setFormation':
        return { kind: 'setFormation', formation: formation(st.formation) };
      case 'waitUntil':
        return { kind: 'waitUntil', condition: validateCondition(st.condition) };
      case 'setReactions':
        return { kind: 'setReactions', reactions: validateReactions(st.reactions) };
      default:
        throw new ValidationError(`unknown plan statement ${String(st.kind)}`);
    }
  });
}

function validateTrigger(v: unknown): PhaseTrigger {
  const t = (v ?? { type: 'manual' }) as Record<string, unknown>;
  switch (t.type) {
    case 'manual':
      return { type: 'manual' };
    case 'time':
      return { type: 'time', time: num(t.time, 'time') };
    case 'codeword':
      return { type: 'codeword', codeword: codeword(t.codeword) };
    case 'previousDone': {
      const delay = t.delay === undefined ? undefined : num(t.delay, 'delay');
      if (delay !== undefined && delay < 0) throw new ValidationError('delay must be 0 or more');
      return delay ? { type: 'previousDone', delay } : { type: 'previousDone' };
    }
    case 'condition':
      return { type: 'condition', ownerId: str(t.ownerId, 'ownerId'), condition: validateCondition(t.condition) };
    default:
      throw new ValidationError(`unknown phase trigger ${String(t.type)}`);
  }
}

/** A force's synchronization matrix: up to 20 phases of up to 100 orders, each for an object of that force. */
export function validatePhases(engine: Engine, f: ForceId, v: unknown): Phase[] {
  if (!Array.isArray(v) || v.length > 20) throw new ValidationError('phases must be a list of at most 20 phases');
  const ids = new Set<string>();
  return v.map((raw: unknown, i) => {
    const p = (raw ?? {}) as Record<string, unknown>;
    const id = p.id === undefined ? `P${i + 1}` : str(p.id, 'phase id');
    if (!/^[A-Za-z0-9_-]{1,24}$/.test(id) || ids.has(id)) throw new ValidationError(`phase id ${id} must be unique: letters, digits, - and _`);
    ids.add(id);
    const name = (p.name === undefined ? `Phase ${i + 1}` : str(p.name, 'phase name')).trim().slice(0, 60) || `Phase ${i + 1}`;
    if (!Array.isArray(p.orders ?? []) || ((p.orders as unknown[]) ?? []).length > 100) throw new ValidationError('orders must be a list of at most 100');
    const orders: PhaseOrder[] = ((p.orders as unknown[]) ?? []).map((ro) => {
      const o = (ro ?? {}) as Record<string, unknown>;
      const targetId = str(o.targetId, 'targetId');
      const owner = engine.entities.get(targetId)?.force ?? engine.units.get(targetId)?.force;
      if (owner === undefined) throw new ValidationError(`unknown object ${targetId}`);
      if (owner !== f) throw new ValidationError(`${engine.nameOf(targetId)} is not ${FORCE_NAMES[f]}`);
      const out: PhaseOrder = { targetId };
      if (o.task !== undefined && o.task !== null) out.task = validateTask(o.task);
      if (o.roe !== undefined && o.roe !== null) out.roe = roe(o.roe);
      if (o.stop === true) out.stop = true;
      if (typeof o.text === 'string') out.text = o.text.slice(0, 200);
      if (!out.task && !out.roe && !out.stop) throw new ValidationError(`order for ${engine.nameOf(targetId)} has no task, roe or stop`);
      return out;
    });
    return { id, name, trigger: validateTrigger(p.trigger), orders };
  });
}

export function validatePlan(v: unknown): Plan {
  if (!v || typeof v !== 'object') throw new ValidationError('plan must be an object');
  const p = v as Record<string, unknown>;
  const statements = validateStatements(p.statements, 'plan.statements', 0, { n: 0 });
  return { name: typeof p.name === 'string' ? p.name.slice(0, 80) : undefined, statements, loop: p.loop === true };
}

/** Commands that do not change the scenario, so are not undone. */
const NOT_EDITS = new Set(['run', 'pause', 'step', 'setTimeScale', 'undo', 'redo', 'ackAlert', 'sendCodeword', 'drive']);

export function executeCommand(runner: SimRunner, raw: unknown): CommandResult {
  const cmd = raw && typeof raw === 'object' ? (raw as { cmd?: unknown }).cmd : undefined;
  const before = typeof cmd === 'string' && !NOT_EDITS.has(cmd) && runner.undoLimit > 0 ? runner.engine.toScenario() : null;
  const result = runCommand(runner, raw);
  if (result.ok && before) runner.pushUndo(before);
  // Keep the recording's current frame in step with edits made while paused.
  if (result.ok) runner.recorder?.touch();
  return result;
}

function runCommand(runner: SimRunner, raw: unknown): CommandResult {
  const engine = runner.engine;
  return engine.safely(() => {
    if (!raw || typeof raw !== 'object') throw new ValidationError('command must be an object');
    const c = raw as Command & Record<string, unknown>;
    switch (c.cmd) {
      case 'run':
        runner.setRunning(true);
        return;
      case 'pause':
        runner.setRunning(false);
        return;
      case 'step':
        runner.stepFor(c.seconds === undefined ? runner.dt : Math.min(600, Math.max(0, num(c.seconds, 'seconds'))));
        return;
      case 'setTimeScale':
        runner.setTimeScale(num(c.scale, 'scale'));
        return;
      case 'undo':
        if (!runner.undo()) throw new ValidationError('nothing to undo');
        return;
      case 'redo':
        if (!runner.redo()) throw new ValidationError('nothing to redo');
        return;
      case 'rewind':
        runner.setRunning(false);
        engine.rewind();
        return;
      case 'newScenario':
        runner.setRunning(false);
        engine.newScenario(typeof c.name === 'string' ? c.name : 'Untitled', c.terrain ?? {});
        return;
      case 'loadScenario': {
        runner.setRunning(false);
        // Restore the previous state if the file is rejected part-way through.
        const backup = engine.toScenario();
        try {
          engine.loadScenario(c.scenario);
        } catch (err) {
          engine.loadScenario(backup);
          throw err;
        }
        return;
      }
      case 'createEntity':
        return engine.createEntity({
          typeId: str(c.typeId, 'typeId'),
          force: force(c.force),
          x: num(c.x, 'x'),
          y: num(c.y, 'y'),
          heading: c.heading === undefined ? undefined : num(c.heading, 'heading'),
          name: c.name === undefined ? undefined : str(c.name, 'name'),
          altitude: c.altitude === undefined ? undefined : num(c.altitude, 'altitude'),
        }).id;
      case 'createUnit':
        return engine.createUnitFromTemplate(
          str(c.templateId, 'templateId'),
          force(c.force),
          num(c.x, 'x'),
          num(c.y, 'y'),
          c.heading === undefined ? 0 : num(c.heading, 'heading'),
          c.name === undefined ? undefined : str(c.name, 'name'),
        ).id;
      case 'groupUnit':
        if (!Array.isArray(c.entityIds)) throw new ValidationError('entityIds must be an array');
        return engine.groupUnit(
          c.entityIds.map((id) => str(id, 'entityId')),
          c.name === undefined ? undefined : str(c.name, 'name'),
          c.formation === undefined ? 'column' : formation(c.formation),
        ).id;
      case 'deleteObject':
        engine.deleteObject(str(c.id, 'id'));
        return;
      case 'moveEntity': {
        const e = engine.entities.get(str(c.id, 'id'));
        if (!e || e.remote) throw new ValidationError('unknown local entity');
        if (e.embarkedIn) throw new ValidationError(`${e.name} is mounted in ${engine.nameOf(e.embarkedIn)}; dismount it first`);
        const x = num(c.x, 'x');
        const y = num(c.y, 'y');
        if (!engine.terrain.inBounds(x, y)) throw new ValidationError('position is outside the terrain');
        const agl = e.z - engine.terrain.surfaceHeight(e.x, e.y);
        e.x = x;
        e.y = y;
        if (c.heading !== undefined) e.heading = num(c.heading, 'heading');
        e.z = e.domain === 'air' ? engine.terrain.surfaceHeight(x, y) + agl : e.domain === 'surface' ? 0 : engine.terrain.elevation(x, y);
        return;
      }
      case 'assignTask': {
        const targetId = str(c.targetId, 'targetId');
        const task = validateTask(c.task);
        if (task.type === 'fireMission') {
          // Refuse up front rather than fail later in the event log.
          // A unit's order passes down to its subordinates: their guns count too.
          const unit = engine.units.get(targetId);
          const units = unit ? [unit] : [];
          for (let i = 0; i < units.length; i++) units.push(...engine.subordinatesOf(units[i]).filter((s) => !units.includes(s)));
          const members = unit ? units.flatMap((u) => u.memberList) : [engine.entities.get(targetId)].filter((e) => !!e);
          const tubes = members.filter((m) => m.alive && m.type.weapons.some((w) => engine.catalog.weapon(w).indirect && (!task.weaponId || w === task.weaponId)));
          if (members.length && !tubes.length) throw new ValidationError(`${engine.nameOf(targetId)} has no ${task.weaponId ? `weapon ${task.weaponId}` : 'artillery or mortars'} for a fire mission`);
        }
        engine.issueOrder(targetId, { task });
        return;
      }
      case 'assignPlan':
        engine.issueOrder(str(c.targetId, 'targetId'), { plan: validatePlan(c.plan) });
        return;
      case 'setSuperior':
        engine.setSuperior(str(c.unitId, 'unitId'), c.superiorId === null || c.superiorId === undefined ? null : str(c.superiorId, 'superiorId'));
        return;
      case 'stop':
        engine.stop(str(c.targetId, 'targetId'));
        return;
      case 'setRoe':
        engine.setRoe(str(c.targetId, 'targetId'), roe(c.roe));
        return;
      case 'sendCodeword':
        engine.sendCodeword(force(c.force), codeword(c.codeword));
        return;
      case 'setSyncMatrix': {
        const f = force(c.force);
        engine.sync.set({ force: f, phases: validatePhases(engine, f, c.phases) });
        return;
      }
      case 'startPhase': {
        const f = force(c.force);
        const id = str(c.phaseId, 'phaseId');
        if (!engine.sync.get(f)?.phases.some((p) => p.id === id)) throw new ValidationError(`unknown phase ${id}`);
        engine.sync.start(f, id, 'started by hand');
        return;
      }
      case 'ackAlert': {
        const force = (c as { force?: ForceId }).force;
        if (c.all) {
          engine.alerts.acknowledgeAll(force);
          return;
        }
        const id = str(c.id, 'id');
        const a = engine.alerts.all().find((x) => x.id === id);
        if (!a || (force !== undefined && a.force !== force)) throw new ValidationError(`unknown alert ${id}`);
        engine.alerts.acknowledge(id);
        return;
      }
      case 'setReactions':
        engine.setReactions(str(c.targetId, 'targetId'), validateReactions(c.reactions));
        return;
      case 'setCatalogEntry':
      case 'removeCatalogEntry': {
        const section = c.section;
        if (!CATALOG_SECTIONS.includes(section)) throw new ValidationError(`section: one of ${CATALOG_SECTIONS.join(', ')}`);
        try {
          if (c.cmd === 'setCatalogEntry') engine.setCatalogEntry(section, VALIDATORS[section](c.entry));
          else engine.removeCatalogEntry(section, str(c.id, 'id'));
        } catch (err) {
          throw new ValidationError((err as Error).message);
        }
        return;
      }
      case 'drive': {
        const e = engine.entities.get(str(c.id, 'id'));
        if (!e || e.remote) throw new ValidationError('unknown local entity');
        if (!e.alive) throw new ValidationError(`${e.name} is destroyed`);
        if (e.embarkedIn) throw new ValidationError(`${e.name} is mounted; drive its carrier`);
        const input: { throttle?: number; turn?: number; targetId?: string | null } = {};
        if (c.throttle !== undefined) input.throttle = num(c.throttle, 'throttle');
        if (c.turn !== undefined) input.turn = num(c.turn, 'turn');
        if (c.targetId !== undefined) {
          if (c.targetId !== null && !engine.entities.has(str(c.targetId, 'targetId'))) throw new ValidationError(`unknown entity ${String(c.targetId)}`);
          input.targetId = c.targetId;
        }
        engine.drive(e, input);
        return;
      }
      case 'setJamming': {
        const e = engine.entities.get(str(c.id, 'id'));
        if (!e || e.remote) throw new ValidationError('unknown local entity');
        if (!e.type.jammer) throw new ValidationError(`${e.name} is not a jammer`);
        if (typeof c.on !== 'boolean') throw new ValidationError('on must be true or false');
        e.jamming = c.on;
        engine.log('info', `${e.name}: jamming ${c.on ? 'on' : 'off'}`, e.id);
        engine.ew.update();
        return;
      }
      case 'setPatternOfLife': {
        const n = (v: unknown, what: string) => {
          if (v === undefined) return undefined;
          const x = num(v, what);
          if (x < 0 || x > MAX_AMBIENT) throw new ValidationError(`${what} must be 0-${MAX_AMBIENT}`);
          return Math.round(x);
        };
        const cur = engine.life.settings;
        engine.life.set({ vehicles: n(c.vehicles, 'vehicles') ?? cur.vehicles, pedestrians: n(c.pedestrians, 'pedestrians') ?? cur.pedestrians });
        return;
      }
      case 'setRules': {
        const r = (c.rules ?? {}) as Record<string, unknown>;
        if (typeof r !== 'object' || Object.values(r).some((v) => typeof v !== 'boolean')) throw new ValidationError('rules must be an object of booleans');
        engine.setRules(r as SimulationRules);
        return;
      }
      case 'setEnvironment': {
        engine.setEnvironment(validateEnvironment(c.environment));
        return;
      }
      case 'embark': {
        engine.embarkNow(str(c.passengerId, 'passengerId'), str(c.carrierId, 'carrierId'));
        return;
      }
      case 'disembark': {
        const carriers = engine.units.get(str(c.carrierId, 'carrierId'))?.alive() ?? [engine.entities.get(c.carrierId as string)];
        if (carriers.some((x) => !x || x.remote)) throw new ValidationError('unknown local carrier');
        for (const x of carriers) engine.dismountAll(x!);
        return;
      }
      case 'setFormation': {
        const u = engine.units.get(str(c.unitId, 'unitId'));
        if (!u) throw new ValidationError('unknown unit');
        u.formation = formation(c.formation);
        return;
      }
      case 'rename': {
        const id = str(c.id, 'id');
        const name = str(c.name, 'name');
        const obj = engine.entities.get(id) ?? engine.units.get(id) ?? engine.graphics.get(id);
        if (!obj) throw new ValidationError(`unknown object ${id}`);
        obj.name = name;
        return;
      }
      case 'createGraphic': {
        if (!Array.isArray(c.points)) throw new ValidationError('points must be an array');
        const kinds = ['route', 'area', 'point', 'phaseLine', 'minefield', 'obstacle'];
        if (!kinds.includes(c.kind as string)) throw new ValidationError('invalid graphic kind');
        const g = engine.addGraphic(
          c.kind,
          c.points.map((p, i) => vec(p, `points[${i}]`)),
          c.name === undefined ? undefined : str(c.name, 'name'),
          c.force === undefined ? 1 : force(c.force),
        );
        const density = (c as { density?: unknown }).density;
        if (density !== undefined && g.kind === 'minefield') {
          const d = num(density, 'density');
          if (d <= 0 || d > 3) throw new ValidationError('density must be in (0, 3]');
          g.density = d;
        }
        return g.id;
      }
      case 'updateGraphic': {
        const g = engine.graphics.get(str(c.id, 'id'));
        if (!g) throw new ValidationError('unknown graphic');
        if (c.name !== undefined) g.name = str(c.name, 'name');
        if (c.points !== undefined) {
          if (!Array.isArray(c.points) || c.points.length === 0) throw new ValidationError('points must be a non-empty array');
          g.points = c.points.map((p, i) => vec(p, `points[${i}]`));
        }
        if (c.density !== undefined) {
          const d = num(c.density, 'density');
          if (d <= 0 || d > 3) throw new ValidationError('density must be in (0, 3]');
          g.density = d;
        }
        engine.obstacles.changed();
        return;
      }
      default:
        throw new ValidationError(`unknown command ${String((c as { cmd?: unknown }).cmd)}`);
    }
  });
}

const PRECIPITATION = new Set(['none', 'rain', 'heavyRain', 'snow']);

function validateEnvironment(v: unknown): Environment {
  if (!v || typeof v !== 'object') throw new ValidationError('environment must be an object');
  const e = v as Record<string, unknown>;
  const out: Environment = {};
  if (e.date !== undefined) {
    if (typeof e.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(e.date) || Number.isNaN(Date.parse(e.date))) throw new ValidationError('date must be YYYY-MM-DD');
    out.date = e.date;
  }
  const n = (k: 'time' | 'visibility' | 'windSpeed' | 'windFrom', min: number, max: number) => {
    if (e[k] === undefined) return;
    const x = e[k];
    if (typeof x !== 'number' || !Number.isFinite(x) || x < min || x > max) throw new ValidationError(`${k} must be a number from ${min} to ${max}`);
    out[k] = x;
  };
  n('time', 0, 24);
  n('visibility', 50, 100000);
  n('windSpeed', 0, 40);
  n('windFrom', 0, 360);
  if (e.precipitation !== undefined) {
    if (!PRECIPITATION.has(e.precipitation as string)) throw new ValidationError('precipitation must be none, rain, heavyRain or snow');
    out.precipitation = e.precipitation as Environment['precipitation'];
  }
  return out;
}
