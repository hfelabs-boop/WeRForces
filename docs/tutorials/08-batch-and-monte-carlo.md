# Tutorial 8: Batch runs and Monte Carlo analysis

**Time:** 20 minutes · **You will learn:**

- running scenarios without the GUI;
- using the engine as a library;
- comparing two courses of action statistically.

Combat in WeRForces is probabilistic: detection rolls, hit rolls and damage
rolls. One run is an anecdote. To learn whether a plan is *good*, run it many
times with different random seeds and compare the distributions.

## 1. Headless runs from the command line

```bash
npm start -- -s calloway-crossroads --headless --duration 3000
```

This simulates 50 minutes as fast as possible, prints the event log (without
individual shots), and ends with a summary:

```
00:30:20  destroyed  Squad 1 Lead destroyed by Team ARMOR 4
00:33:56  task       Team MECH: plan Follow and support complete

Simulated 3000s in 1.60s wall time.
  Blue     13/14 surviving
  Red      4/19 surviving
  Neutral  3/3 surviving
```

Run the same command again and you get **the same result**. The simulation is
deterministic: the scenario's terrain seed also seeds the random numbers. That
is useful for debugging and fair comparisons, but for statistics you need
different seeds.

## 2. The engine as a library

`src/sim` has no I/O, so you can drive it from a script.
[`examples/monte-carlo.ts`](../../examples/monte-carlo.ts) is the core of a
Monte Carlo study:

```ts
const engine = new Engine();                 // terrain is generated once and reused
for (let i = 0; i < runs; i++) {
  engine.loadScenario(scenario);             // reset everything…
  engine.reseed(1000 + i);                   // …then give this replication its own random stream
  let shots = 0;
  const off = engine.on('fire', () => shots++);
  engine.runFor(seconds);                    // simulate as fast as possible
  off();
  // collect measures: losses per force, whether the objective is held, shots fired, …
}
```

Run it:

```bash
npx tsx examples/monte-carlo.ts calloway-crossroads 20 3000
```

```
run   1: blue lost 3, red lost 12, 64 shots, objective not taken
run   2: blue lost 1, red lost 15, 101 shots, objective not taken
run   3: blue lost 1, red lost 15, 42 shots, objective not taken
…
Calloway Crossroads: 20 runs of 3000 s (27.8 s wall time)
  Blue losses 1.4 ± 0.7 of 14
  Red losses  14.8 ± 0.8 of 19
  Loss exchange ratio (red/blue) 10.17
  Objective "OBJ CALLOWAY" taken in 0/20 runs
```

Each replication of this 36-entity, 50-minute battle takes about 1.4 s.

## 3. Comparing courses of action

How much do the Apaches contribute? Make a variant without them. You can do
this in the GUI (delete *Gunslinger* and **Save on server…** as
`no-apaches`) or with a few lines of code:

```bash
node -e '
const fs = require("fs");
const s = JSON.parse(fs.readFileSync("scenarios/calloway-crossroads.json", "utf8"));
const u = s.units.find((u) => u.name === "Gunslinger");
s.units = s.units.filter((x) => x !== u);
s.entities = s.entities.filter((e) => !u.memberIds.includes(e.id));
s.name += " (no Apaches)";
fs.writeFileSync("no-apaches.json", JSON.stringify(s));'

npx tsx examples/monte-carlo.ts no-apaches.json 20 3000
```

```
Calloway Crossroads (no Apaches): 20 runs of 3000 s (22.1 s wall time)
  Blue losses 2.0 ± 1.2 of 12
  Red losses  14.8 ± 1.1 of 19
  Loss exchange ratio (red/blue) 7.20
```

| Measure (20 runs each) | With Apaches | Without |
| --- | --- | --- |
| Blue losses | 1.4 ± 0.7 | 2.0 ± 1.2 |
| Red losses | 14.8 ± 0.8 | 14.8 ± 1.1 |
| Loss exchange ratio | 10.2 | 7.2 |

In this scenario the Apaches don't change how many Red vehicles die. They kill
the supply convoy early, which the ground forces would have caught anyway.
What they do is **reduce Blue losses and their spread**. With 20 runs per side
the difference is suggestive, not conclusive. Run 100+ before drawing
conclusions, and look at the whole distribution, not only the mean.

### Why is the objective never taken?

The measure is strict: Blue survivors inside *OBJ CALLOWAY* **and no Red
survivors there**. To see what is left, load each replication, run it, and list
the Red entities inside the area:

```ts
const left = [...engine.entities.values()]
  .filter((e) => e.alive && e.force === 2 && pointInPolygon(e, objective.points))
  .map((e) => e.name);
```

Across seeds 1000–1005:

- every run leaves **Osa 1**, the SA-8 parked behind the crest north of town;
- one run also leaves three riflemen of *Squad 1* in the woods. Infantry in
  forest is hard to detect (× 0.35 × 0.6), and canopy blocks sight lines beyond
  150 m of forest.

Blue's plan ends with the tanks parked in the middle of town, out of sight of
the SA-8, so nobody goes looking for it. That is the point of the analysis: the
numbers show the plan is missing a step.

**Fix it and measure.** Append an attack on the SA-8 (entity `E29` in this
scenario) to Team ARMOR's (`U1`) plan:

```bash
node -e '
const fs = require("fs");
const s = JSON.parse(fs.readFileSync("scenarios/calloway-crossroads.json", "utf8"));
s.units.find((u) => u.id === "U1").plan.statements.push({ kind: "task", task: { type: "attack", targetId: "E29" } });
s.name += " (clear the SA-8)";
fs.writeFileSync("clear-sa8.json", JSON.stringify(s));'

npx tsx examples/monte-carlo.ts clear-sa8.json 20 3000
```

```
Calloway Crossroads (clear the SA-8): 20 runs of 3000 s (27.9 s wall time)
  Blue losses 1.1 ± 0.9 of 14
  Red losses  15.2 ± 0.5 of 19
  Loss exchange ratio (red/blue) 13.22
  Objective "OBJ CALLOWAY" taken in 5/20 runs
```

The objective is now taken in a quarter of the runs, from none before. The
failures are mostly the infantry in the woods. Clearing woods is infantry work,
so try adding a US Rifle Squad with *Wait until time 1800 → Move to* the wood
line west of Calloway.

## 4. Making it your own

- **Measures.** Anything in the engine state: `engine.entities` (positions,
  damage, ammo), `engine.time`, event counts by kind, time to first contact,
  survivors per unit…
- **Variants in code.** Instead of editing JSON, modify the engine after
  `loadScenario`, e.g. `engine.assignPlan('U1', {...})` or
  `engine.setRoe('U2', 'holdFire')`.
- **Parallel runs.** Each replication is independent. Use worker threads or
  several processes, each with its own `Engine`.
- **Export.** Write one row per run to CSV and analyse in Python/R:

  ```ts
  rows.push([i, blueLost, redLost, shots].join(','));
  fs.writeFileSync('results.csv', 'run,blue_lost,red_lost,shots\n' + rows.join('\n'));
  ```

- **Over the API.** If you would rather not write TypeScript, the same loop
  works through REST (`PUT /api/v1/scenario`, `POST /simulation/step`,
  `GET /simulation`), or ask an AI agent over MCP to run the comparison. API
  runs use the scenario's fixed seed, so vary the scenario itself
  (positions, plans) rather than the random stream.

**Next:** [Tutorial 9: Extending the catalog](09-extending-the-catalog.md).
