// What commanders hand to their host, and what the host hands back.

import type { Command } from '../../shared/types.js';

/**
 * An order as typed words (parsed like the order line), a command a player of the force
 * may give, or a report (the commander's assessment, which changes nothing).
 */
export type CommanderAction = { order: string } | { command: Command; text: string } | { report: string };

export interface ActionResult {
  ok: boolean;
  /** The order as understood, or why it was refused. */
  text: string;
}

/** What a commander knows of the ground: the map a player sees. */
export interface TerrainView {
  size: number;
  /** True if a ground vehicle can stand there (dry land, inside the map). */
  canStand(p: { x: number; y: number }): boolean;
  /** The nearest point within `radius` m where a ground vehicle can stand. */
  nearestLand(p: { x: number; y: number }, radius?: number): { x: number; y: number } | null;
}

/** The token and call allowance of an LLM commander. */
export interface CallBudget {
  /** Null if a call may be made now, else why not. */
  refuse(): string | null;
  record(usage: { input_tokens?: number; output_tokens?: number }): void;
}
