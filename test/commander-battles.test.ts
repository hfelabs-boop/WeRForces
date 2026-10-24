import { describe, expect, it } from 'vitest';
import type { ForceId } from '../src/shared/types.js';
import { Engine } from '../src/sim/engine.js';
import { generateBattle, type WizardOptions, type WizardSide } from '../src/sim/wizard.js';

// Quick battles between like forces (the same mechanised platoon with mortars and scouts
// on both sides), 10 seeds each, 30 simulated minutes.
const SIDE: WizardSide = { nation: 'ru', composition: 'mech', size: 'platoon', support: ['artillery', 'recon'] };
const SEEDS = Array.from({ length: 10 }, (_, i) => i + 1);

type Mode = 'rules' | 'idle' | 'plan';

/** Win: the enemy lost clearly more, or we hold the objective without losing more. Hold: we lost no more than it did. */
function fight(seed: number, mission: WizardOptions['mission'], side: ForceId, self: Mode, enemy: Exclude<Mode, 'rules'>) {
  const eng = new Engine({ seed: 1 });
  const r = generateBattle(eng, { seed, mission, terrain: { seed: 5, size: 12000 }, blue: SIDE, red: SIDE });
  const other: ForceId = side === 1 ? 2 : 1;
  if (enemy === 'idle') eng.sync.set({ force: other, phases: [] });
  if (self !== 'plan') eng.sync.set({ force: side, phases: [] });
  if (self === 'rules') eng.commanders.set(side, 'rules');
  eng.runFor(1800);
  const ents = [...eng.entities.values()];
  const lost = (f: ForceId) => ents.filter((e) => e.force === f && e.destroyed).length / ents.filter((e) => e.force === f).length;
  const onObjective = (f: ForceId) => ents.some((e) => e.force === f && e.alive && Math.hypot(e.x - r.objective.x, e.y - r.objective.y) < 600);
  const win = lost(other) >= lost(side) + 0.15 || (onObjective(side) && !onObjective(other) && lost(side) <= lost(other) + 0.15);
  const hold = !win && lost(side) <= lost(other) + 0.1;
  const refused = (eng.commanders.get(side)?.decisions ?? []).flatMap((d) => d.rejected ?? []);
  return { win, hold, refused };
}

describe('rule-based commander in quick battles', () => {
  it('beats an idle enemy more often than not, and never gives an order a player could not', () => {
    const runs = SEEDS.map((s) => fight(s, 'attack', 1, 'rules', 'idle'));
    const wins = runs.filter((r) => r.win).length;
    expect(wins).toBeGreaterThan(SEEDS.length / 2);
    expect(runs.flatMap((r) => r.refused)).toEqual([]);
  }, 120_000);

  it('wins or holds against an attack more often than the same force left idle', () => {
    const score = (mode: Mode) => SEEDS.map((s) => fight(s, 'meeting', 2, mode, 'plan')).filter((r) => r.win || r.hold).length;
    const rules = score('rules');
    const idle = score('idle');
    expect(rules).toBeGreaterThan(idle);
    expect(rules).toBeGreaterThan(SEEDS.length / 2);
  }, 120_000);
});
