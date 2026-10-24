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
individual shots, but with radio contact reports and morale changes), and ends
with a summary:

```
00:32:20  destroyed  Squad 1 3 destroyed by Team MECH 2
00:32:21  detonation 25mm M242 Bushmaster (burst) missed Squad 1 3
00:33:56  task       Team MECH: plan Follow and support complete

Simulated 3000s in 2.26s wall time.
  Blue     12/14 surviving
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
run   1: blue lost 3, red lost 14, 62 shots, objective not taken
run   2: blue lost 3, red lost 15, 78 shots, objective not taken
run   3: blue lost 2, red lost 15, 60 shots, objective not taken
…
Calloway Crossroads: 20 runs of 3000 s (42.0 s wall time)
  Blue losses 2.7 ± 0.8 of 14
  Red losses  13.6 ± 1.9 of 19
  Loss exchange ratio (red/blue) 5.02
  Objective "OBJ CALLOWAY" taken in 0/20 runs
```

Each replication of this 36-entity, 50-minute battle takes about 2 s.

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
Calloway Crossroads (no Apaches): 20 runs of 3000 s (40.2 s wall time)
  Blue losses 3.8 ± 1.1 of 12
  Red losses  11.5 ± 2.7 of 19
  Loss exchange ratio (red/blue) 3.07
  Objective "OBJ CALLOWAY" taken in 0/20 runs
```

| Measure (20 runs each) | With Apaches | Without |
| --- | --- | --- |
| Blue losses | 2.7 ± 0.8 | 3.8 ± 1.1 |
| Red losses | 13.6 ± 1.9 | 11.5 ± 2.7 |
| Loss exchange ratio | 5.0 | 3.1 |

The Apaches usually destroy Tank Plt 1 and the supply convoy in the first four
minutes. Without them the tanks have to do that work twenty minutes later: in
eight of the 20 runs a T-72 of Tank Plt 1 destroys Team ARMOR's lead tank
first, and the convoy, breaking and falling back once it starts losing trucks,
gets its lead vehicle away into the town in 19 runs. Blue loses about one
vehicle more, and Red losses fall and **vary more**. In both variants most of
Blue's losses come in Calloway itself, where Squad 1's RPGs knock out two or
three of Team ARMOR's tanks, and often Team MECH's lead Bradley, in almost
every run. With 20 runs per side the difference is suggestive, not
conclusive. Run 100+ before drawing
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
  700–870 m away, the line of sight runs through some 450–500 m of trees.
- in two of the six, Squad 1 riflemen are left in the objective too: one in
  seed 1000, and four in seed 1003, where Squad 1's RPGs knock out three of
  Team ARMOR's tanks in the town and the platoon breaks and falls back.

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
Calloway Crossroads (clear the SA-8): 20 runs of 3000 s (41.2 s wall time)
  Blue losses 2.4 ± 1.2 of 14
  Red losses  14.2 ± 2.4 of 19
  Loss exchange ratio (red/blue) 5.92
  Objective "OBJ CALLOWAY" taken in 11/20 runs
```

The objective is now taken in about half the runs, from none before. The SA-8
is destroyed in 15 of the 20 runs, about 31 minutes in, often after Team
ARMOR's lead tank is knocked out by Squad 1's RPGs just as the attack begins
(the next tank takes command and the others carry on with the attack). In the
other five, the RPGs knock out three of Team ARMOR's four tanks in the town,
the platoon breaks and falls back, and the attack never happens. The other
four failures leave one to five *Squad 1* riflemen just south-west of the town
centre, about 600 m from the nearest Blue vehicle and out of its sight. People
are hard to detect anyway (× 0.6). Clearing them is infantry work, so try
adding a US Rifle Squad with *Wait until…* *time is (s)* 1800, then *Move to
(pick)* the south-west edge of Calloway.

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

- **On the server.** If you would rather not write TypeScript, the server
  runs replications for you in the background: **File → Batch analysis…** in
  the GUI, `POST /api/v1/batch` (`{"scenario": "calloway-crossroads", "runs":
  20, "duration": 3000}`; seeds start at 1000 as here, so the losses come out
  the same as `monte-carlo.ts`), or the MCP tool `run_batch` for an AI agent.
  Plain REST runs (`POST /simulation/step`) use the scenario's fixed seed, so
  there vary the scenario itself (positions, plans) rather than the random
  stream.

**Next:** [Tutorial 9: Extending the catalog](09-extending-the-catalog.md).
