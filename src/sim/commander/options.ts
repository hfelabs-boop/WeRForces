// Commander options: checked and filled in with their defaults.

import type { CommanderOptions } from '../../shared/commander.js';

export const DEFAULT_OPTIONS: Required<Omit<CommanderOptions, 'seed' | 'intent'>> = {
  interval: 45,
  aggressiveness: 0.5,
  holdOff: 300,
  maxCallsPerMinute: 4,
  maxTokens: 2048,
  maxToolCalls: 12,
  tokenBudget: 500000,
};

const LIMITS: Record<keyof typeof DEFAULT_OPTIONS, [number, number]> = {
  interval: [10, 600],
  aggressiveness: [0, 1],
  holdOff: [0, 3600],
  maxCallsPerMinute: [1, 60],
  maxTokens: [256, 32000],
  maxToolCalls: [1, 50],
  tokenBudget: [1000, 1e8],
};

/** Throws Error with a readable message for a bad option; keeps only the options that were given. */
export function checkOptions(v: unknown): CommanderOptions {
  if (v === undefined || v === null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) throw new Error('options must be an object');
  const o = v as Record<string, unknown>;
  const out: CommanderOptions = {};
  for (const k of Object.keys(o)) {
    if (o[k] === undefined || o[k] === null) continue;
    if (k === 'intent') {
      if (typeof o.intent !== 'string' || o.intent.length > 500) throw new Error('intent: text of up to 500 characters');
      if (o.intent.trim()) out.intent = o.intent.trim();
    } else if (k === 'seed') {
      if (typeof o.seed !== 'number' || !Number.isFinite(o.seed)) throw new Error('seed must be a number');
      out.seed = Math.floor(o.seed);
    } else if (k in LIMITS) {
      const [lo, hi] = LIMITS[k as keyof typeof LIMITS];
      const x = o[k];
      if (typeof x !== 'number' || !Number.isFinite(x) || x < lo || x > hi) throw new Error(`${k} must be a number from ${lo} to ${hi}`);
      out[k as keyof typeof LIMITS] = x;
    } else {
      throw new Error(`unknown commander option ${k}`);
    }
  }
  return out;
}

export function withDefaults(o: CommanderOptions): Required<Omit<CommanderOptions, 'seed' | 'intent'>> & Pick<CommanderOptions, 'seed' | 'intent'> {
  return { ...DEFAULT_OPTIONS, ...o };
}
