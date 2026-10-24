// The LLM commander: the same situation and the same orders as the rule-based one, but
// a large language model decides, through the Messages API with tool use. Each decision is
// one short conversation: the situation goes in the first message, the model calls tools
// (give_order, set_roe, call_fire, start_phase, send_codeword, report), each call is carried
// out as the force's player would give it and the result goes back, until it ends its turn
// or reaches its tool-call budget. The transport (HTTPS in the server, a script in tests)
// is passed in; nothing here does I/O itself.

import type { CommanderDecision } from '../../shared/commander.js';
import { ORDER_EXAMPLES } from '../../shared/orders.js';
import { FORCE_NAMES } from '../../shared/types.js';
import type { withDefaults } from './options.js';
import type { Situation } from './situation.js';
import type { ActionResult, CallBudget, CommanderAction } from './types.js';

export type LlmBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
  | { type: string; [k: string]: unknown };

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: string | LlmBlock[];
}

export interface LlmTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/** A Messages API request without the model, which the transport adds from its configuration. */
export interface LlmRequest {
  system: string;
  messages: LlmMessage[];
  tools: LlmTool[];
  max_tokens: number;
}

export interface LlmResponse {
  content: LlmBlock[];
  stop_reason: string | null;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export interface LlmTransport {
  send(request: LlmRequest, signal?: AbortSignal): Promise<LlmResponse>;
}

const str = (description: string) => ({ type: 'string', description });

export const TOOLS: LlmTool[] = [
  {
    name: 'give_order',
    description:
      'Give one order in words, starting with the name or id of one or more of your own units or entities: "<who> <verb> <where/what> [modifiers]". ' +
      'Verbs: move to <place> [covered] [fast|slowly], attack <contact id or name>, defend|overwatch|screen <place> [facing <direction>] [width <m>], ' +
      'search <area>, patrol <route>, follow route <route>, fire [N rounds] on <place>, smoke <place>, orbit <place> [radius N km], mount <carrier>, dismount, ' +
      'resupply, breach <minefield>, wait N min, stop. Places: graphic or town names, "x y" in metres, or "2 km north of <place>". ' +
      `Examples: ${ORDER_EXAMPLES.slice(0, 4).map((e) => `"${e}"`).join(', ')}.`,
    input_schema: { type: 'object', properties: { order: str('the order, e.g. "U3 move to OBJ IRON covered"') }, required: ['order'] },
  },
  {
    name: 'set_roe',
    description: 'Set the rules of engagement of one of your units or entities.',
    input_schema: { type: 'object', properties: { unit: str('id or name of your unit or entity'), roe: { type: 'string', enum: ['fireAtWill', 'returnFire', 'holdFire'] } }, required: ['unit', 'roe'] },
  },
  {
    name: 'call_fire',
    description: 'Order a fire mission: one of your artillery or mortar units fires rounds on a place (a contact id, "x y", a graphic or a town). Keep it well clear of your own troops.',
    input_schema: {
      type: 'object',
      properties: { unit: str('id or name of your artillery or mortar unit'), target: str('where: a contact id such as E15, "x y", a graphic or town name'), rounds: { type: 'integer', minimum: 1, maximum: 20 } },
      required: ['unit', 'target'],
    },
  },
  {
    name: 'start_phase',
    description: "Start a phase of your force's synchronization matrix now (its orders are given at once).",
    input_schema: { type: 'object', properties: { phase: str('phase id or name') }, required: ['phase'] },
  },
  {
    name: 'send_codeword',
    description: 'Send a codeword to your own force; plans and phases waiting for it go on.',
    input_schema: { type: 'object', properties: { codeword: str('1-40 letters, digits, spaces or -') }, required: ['codeword'] },
  },
  {
    name: 'report',
    description: 'Report your assessment and the reason for your orders in one or two sentences. Call it once per turn; people following the battle read it.',
    input_schema: { type: 'object', properties: { text: str('your assessment and intent') }, required: ['text'] },
  },
];

const ROE_WORDS: Record<string, string> = { fireAtWill: 'fire at will', returnFire: 'return fire', holdFire: 'hold fire' };

export function systemPrompt(sit: Situation, opts: ReturnType<typeof withDefaults>): string {
  return [
    `You command the ${FORCE_NAMES[sit.force]} force in WeRForces, a tactical combat simulation. You decide at intervals; each time you get the situation as your force sees it and give orders with the tools.`,
    'You know only what your force has seen: enemy contacts are shown where they were last seen, with their age in seconds. Ground you cannot see may hide more of them.',
    'Coordinates are metres: x east, y north, from the south-west corner of the map. Your units and entities are listed with their id, role, position, strength, fuel, ammunition, morale and what they are doing. "control: other" means someone else (a person or a plan) has given that order: leave it unless the situation demands otherwise.',
    'Give orders only to your own units, by id or name. Orders to a unit with subordinates pass down to them. Units keep doing their last order until it is done; do not repeat orders that are already being carried out.',
    `Be brief: give the orders that change something (at most ${opts.maxToolCalls} tool calls), call report once with your assessment, then end your turn. If nothing needs to change, just report.`,
    'Doctrine: find the enemy with scouts first; attack only with superior combat power, with one element supporting by fire; concentrate fire; use artillery on groups of contacts but never within 300 m of your own troops; pull back broken units; resupply units low on fuel or ammunition when out of contact; defend or delay on phase lines when weaker.',
    opts.intent ? `Your commander's intent: ${opts.intent}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** The situation as compact JSON, with the last decisions for continuity. */
export function situationPrompt(sit: Situation, previous: CommanderDecision[]): string {
  const view = {
    time: sit.time,
    localTime: sit.localTime,
    light: sit.period,
    trigger: sit.trigger,
    mapSize: sit.mapSize,
    own: sit.own.map((o) => ({
      id: o.id,
      name: o.name,
      role: o.role,
      ...(o.echelon ? { echelon: o.echelon } : {}),
      ...(o.parentId ? { superior: o.parentId } : {}),
      x: o.x,
      y: o.y,
      strength: `${o.alive}/${o.total}`,
      power: o.power,
      ...(o.fuel !== undefined ? { fuel: o.fuel } : {}),
      ammo: o.ammo,
      ...(o.supplies !== undefined ? { supplies: o.supplies } : {}),
      ...(o.moraleState && o.moraleState !== 'steady' ? { morale: o.moraleState } : {}),
      ...(o.underFire ? { underFire: o.underFire } : {}),
      ...(o.pinned ? { pinned: o.pinned } : {}),
      roe: o.roe,
      doing: o.activity,
      control: o.control,
      directRange: o.directRange,
      ...(o.indirectRange ? { indirectRange: o.indirectRange } : {}),
    })),
    contacts: sit.contacts.map((c) => ({ id: c.id, type: c.type, domain: c.domain, x: c.x, y: c.y, age: c.age, ...(c.destroyed ? { destroyed: true } : {}), ...(c.speed ? { speed: c.speed } : {}) })),
    graphics: sit.graphics.map((g) => ({ id: g.id, name: g.name, kind: g.kind, center: g.center, ...(g.kind === 'phaseLine' || g.kind === 'route' ? { points: g.points } : {}) })),
    phases: sit.phases,
    codewords: sit.codewords,
    towns: sit.towns,
    losses: sit.losses,
    alerts: sit.alerts,
    yourLastDecisions: previous.map((d) => ({ time: d.time, summary: d.summary, orders: d.orders })),
  };
  return `Situation (JSON):\n${JSON.stringify(view)}\n\nDecide now: give your orders, report, then end your turn.`;
}

export interface DecideInput {
  transport: LlmTransport;
  situation: Situation;
  /** Carry out an action as the force's player; resolves at the next simulated second. */
  act: (a: CommanderAction) => Promise<ActionResult>;
  budget: CallBudget;
  options: ReturnType<typeof withDefaults>;
  signal?: AbortSignal;
  previous: CommanderDecision[];
}

export class LlmCommander {
  async decide(input: DecideInput): Promise<{ summary: string; results: ActionResult[] }> {
    const { transport, situation: sit, act, budget, options, signal } = input;
    const system = systemPrompt(sit, options);
    const messages: LlmMessage[] = [{ role: 'user', content: situationPrompt(sit, input.previous) }];
    const results: ActionResult[] = [];
    const reports: string[] = [];
    let lastText = '';
    let toolCalls = 0;
    for (let round = 0; round <= options.maxToolCalls + 2; round++) {
      const why = budget.refuse();
      if (why) {
        reports.push(`(turn ended early: ${why})`);
        break;
      }
      const res = await transport.send({ system, messages, tools: TOOLS, max_tokens: options.maxTokens }, signal);
      if (!res || !Array.isArray(res.content)) throw new Error('malformed reply from the model');
      budget.record(res.usage ?? {});
      messages.push({ role: 'assistant', content: res.content });
      const text = res.content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text' && typeof (b as { text?: unknown }).text === 'string')
        .map((b) => b.text)
        .join(' ')
        .trim();
      if (text) lastText = text;
      if (res.stop_reason === 'pause_turn') continue;
      if (res.stop_reason === 'refusal') reports.push('(the model declined to answer)');
      if (res.stop_reason === 'max_tokens') reports.push('(the reply was cut off at the token limit)');
      const uses = res.content.filter((b): b is { type: 'tool_use'; id: string; name: string; input: unknown } => b.type === 'tool_use');
      if (res.stop_reason !== 'tool_use' || !uses.length) break;
      // All calls of a reply are carried out together; all results go back in one message.
      const pending = uses.map((u) => {
        if (toolCalls >= options.maxToolCalls) return Promise.resolve({ ok: false, text: 'tool-call budget for this turn is spent: report and end your turn' });
        toolCalls++;
        const a = toAction(u.name, u.input, sit);
        if ('error' in a) return Promise.resolve({ ok: false, text: a.error });
        if ('report' in a) reports.push(a.report);
        return act(a).then((r) => {
          if (!('report' in a)) results.push(r);
          return r;
        });
      });
      const out = await Promise.all(pending);
      if (toolCalls >= options.maxToolCalls && round > 0 && out.every((r) => !r.ok)) break;
      messages.push({ role: 'user', content: uses.map((u, i) => ({ type: 'tool_result', tool_use_id: u.id, content: out[i].text, ...(out[i].ok ? {} : { is_error: true }) })) });
    }
    const summary = (reports.join(' ') || lastText || 'No report.').replace(/\s+/g, ' ').trim();
    return { summary: summary.length > 400 ? `${summary.slice(0, 397)}...` : summary, results };
  }
}

/** A tool call as an action for the host, or why it cannot be one. */
export function toAction(name: string, raw: unknown, sit: Situation): CommanderAction | { error: string } {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const text = (k: string, max = 300): string | null => (typeof input[k] === 'string' && (input[k] as string).trim() && (input[k] as string).length <= max ? (input[k] as string).trim() : null);
  switch (name) {
    case 'give_order': {
      const order = text('order');
      return order ? { order } : { error: 'give_order needs "order": the order in words' };
    }
    case 'set_roe': {
      const unit = text('unit', 100);
      const roe = typeof input.roe === 'string' ? ROE_WORDS[input.roe] : undefined;
      if (!unit || !roe) return { error: 'set_roe needs "unit" and "roe" (fireAtWill, returnFire or holdFire)' };
      return { order: `${quoteName(unit, sit)} ${roe}` };
    }
    case 'call_fire': {
      const unit = text('unit', 100);
      const target = text('target', 120);
      if (!unit || !target) return { error: 'call_fire needs "unit" and "target"' };
      const n = typeof input.rounds === 'number' && Number.isFinite(input.rounds) ? Math.max(1, Math.min(20, Math.round(input.rounds))) : 3;
      // A contact id: fire on where it was last seen.
      const c = sit.contacts.find((x) => x.id.toLowerCase() === target.toLowerCase());
      return { order: `${quoteName(unit, sit)} fire ${n} rounds on ${c ? `${c.x} ${c.y}` : target}` };
    }
    case 'start_phase': {
      const p = text('phase', 80);
      const phase = p ? sit.phases.find((x) => x.id.toLowerCase() === p.toLowerCase() || x.name.toLowerCase() === p.toLowerCase()) : undefined;
      if (!phase) return { error: `no phase "${p ?? ''}" in your synchronization matrix${sit.phases.length ? ` (phases: ${sit.phases.map((x) => x.id).join(', ')})` : ''}` };
      return { command: { cmd: 'startPhase', force: sit.force, phaseId: phase.id }, text: `start phase ${phase.name}` };
    }
    case 'send_codeword': {
      const w = text('codeword', 40);
      return w ? { command: { cmd: 'sendCodeword', force: sit.force, codeword: w }, text: `codeword ${w.toUpperCase()}` } : { error: 'send_codeword needs "codeword"' };
    }
    case 'report': {
      const r = text('text', 1000);
      return r ? { report: r } : { error: 'report needs "text"' };
    }
    default:
      return { error: `unknown tool ${name}` };
  }
}

/** Own names with spaces are quoted so the order parser reads them whole. */
function quoteName(who: string, sit: Situation): string {
  const own = sit.own.find((o) => o.id.toLowerCase() === who.toLowerCase() || o.name.toLowerCase() === who.toLowerCase());
  return own ? own.id : /\s/.test(who) ? `"${who.replace(/"/g, '')}"` : who;
}
