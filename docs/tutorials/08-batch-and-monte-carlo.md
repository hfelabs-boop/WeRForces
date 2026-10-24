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
00:30:57  destroyed  Squad 1 Lead destroyed by Team ARMOR 4
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
run   1: blue lost 1, red lost 15, 92 shots, objective not taken
run   2: blue lost 1, red lost 15, 72 shots, objective not taken
run   3: blue lost 2, red lost 15, 69 shots, objective not taken
…
Calloway Crossroads: 20 runs of 3000 s (27.8 s wall time)
  Blue losses 1.6 ± 0.9 of 14
  Red losses  14.3 ± 1.6 of 19
  Loss exchange ratio (red/blue) 9.26
  Objective "OBJ CALLOWAY" taken in 0/20 runs
```

Each replication of this 36-entity, 50-minute battle takes about 1.5 s.

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
Calloway Crossroads (no Apaches): 20 runs of 3000 s (26.8 s wall time)
  Blue losses 2.5 ± 1.5 of 12
  Red losses  14.6 ± 1.1 of 19
  Loss exchange ratio (red/blue) 5.94
  Objective "OBJ CALLOWAY" taken in 0/20 runs
```

| Measure (20 runs each) | With Apaches | Without |
| --- | --- | --- |
| Blue losses | 1.6 ± 0.9 | 2.5 ± 1.5 |
| Red losses | 14.3 ± 1.6 | 14.6 ± 1.1 |
| Loss exchange ratio | 9.3 | 5.9 |

In this scenario the Apaches hardly change how many Red vehicles die. They kill
Tank Plt 1 and the supply convoy early, targets the ground forces would have
destroyed anyway. What they do is **reduce Blue losses and their spread**. With 20 runs per side
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

- every run leaves **Osa 1**, the SA-8 parked in the woods north-east of town.
  Vehicles in forest are hard to detect (× 0.35), and canopy blocks sight lines
  that pass through more than 150 m of forest. From the tanks' final positions,
  about 850 m away, the line of sight runs through some 450 m of trees.
  Nothing else is left inside the objective in these six runs.

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
  Red losses  15.4 ± 0.9 of 19
  Loss exchange ratio (red/blue) 13.39
  Objective "OBJ CALLOWAY" taken in 13/20 runs
```

The objective is now taken in about two runs out of three, from none before.
The SA-8 is destroyed in all 20 runs, about 31 minutes in, even when Team
ARMOR's lead tank is knocked out by Squad 1's RPGs just as the attack begins
(the next tank takes command and the others carry on with the attack). The
seven failures all leave one to three *Squad 1* riflemen just south-west of
the town centre, about 200 m from the tanks but hidden by the lie of the
ground. People are hard to detect anyway (× 0.6). Clearing them is infantry
work, so try adding a US Rifle Squad with *Wait until time 1800 → Move to* the
south-west edge of Calloway.

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
