// Commanders: software that runs a force. A commander gets its force's view of the
// battle at intervals and gives orders through the same commands as a player of that
// force. Plain JSON shapes shared by the engine, the server and the browser.

import type { ForceId } from './types.js';

/** 'rules': the doctrinal commander (offline, deterministic); 'llm': a large language model. */
export type CommanderKind = 'none' | 'rules' | 'llm';

export interface CommanderOptions {
  /** Simulated seconds between decisions (10-600; default 45). Contact, losses and a new phase bring one forward. */
  interval?: number;
  /** 0 cautious .. 1 bold (default 0.5): how strong the force must feel before it attacks. */
  aggressiveness?: number;
  /** Seconds an order the commander did not give (a person's, a plan's) is left alone (0-3600; default 300). */
  holdOff?: number;
  /** Seed for the commander's own random choices (default: from the terrain seed and force). */
  seed?: number;
  /** LLM: the commander's intent, added to what the model is told (up to 500 characters). */
  intent?: string;
  /** LLM: most model calls per simulated minute (default 4). */
  maxCallsPerMinute?: number;
  /** LLM: most output tokens per model call (default 2048). */
  maxTokens?: number;
  /** LLM: most tool calls in one decision (default 12). */
  maxToolCalls?: number;
  /** LLM: tokens (in and out) the commander may use in all; it stops when they are spent (default 500000). */
  tokenBudget?: number;
}

/** A commander as saved in a scenario: the settings, never any key. */
export interface CommanderSettings {
  force: ForceId;
  kind: 'rules' | 'llm';
  options: CommanderOptions;
  /** Checkpoints only: where it was in its decision cycle. */
  state?: CommanderCheckpoint;
}

export interface CommanderCheckpoint {
  next: number;
  /** Orders it gave: object id -> [task signature, time]. */
  given: Record<string, [string, number]>;
  /** Orders others gave that it is leaving alone: object id -> [task signature, time first seen]. */
  others: Record<string, [string, number]>;
  rngState: number;
  /** The rule-based commander's working memory. */
  memory?: unknown;
}

/** One decision: what triggered it, the rationale, and the orders given or refused. */
export interface CommanderDecision {
  time: number;
  trigger: string;
  summary: string;
  orders: string[];
  /** Orders that were refused (not allowed, or not understood), with the reason. */
  rejected?: string[];
}

export interface CommanderStatus {
  force: ForceId;
  kind: 'rules' | 'llm';
  options: CommanderOptions;
  /** 'thinking': an LLM call is under way; 'unavailable': no model is configured on this server. */
  state: 'ready' | 'thinking' | 'error' | 'unavailable';
  /** Simulation time of the next scheduled decision. */
  next: number;
  error?: string;
  /** Latest decisions, newest first. */
  decisions: CommanderDecision[];
  /** LLM: model calls and tokens used so far. */
  usage?: { calls: number; inputTokens: number; outputTokens: number };
}
