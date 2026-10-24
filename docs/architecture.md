# Architecture and developer guide

## Layout

```
src/shared        Types and helpers used by both the server and the browser (no Node APIs)
  types.ts          every JSON shape: snapshots, tasks, plans, scenario file, commands
  math.ts           angles, bearings, polygons
  terrainGrid.ts    terrain sampling (elevation, water mask, forest, land cover, buildings) + base64 helpers
  terrainTiles.ts   tiled terrain: tile pyramid layout, manifest, binary tile encoding
  recording.ts      recording format, state-at-time interpolation, after-action report
  symbology.ts      MIL-STD-2525 symbol codes (SIDCs) for entities and units
  orders.ts         typed orders: parser and completions (runs in the browser and on the server)
src/sim           The simulation engine; no I/O, usable as a library
  engine.ts         Engine: object store, tasking API, step loop, scenarios, snapshots
  terrain.ts        procedural or imported terrain, mobility, line of sight (with earth curvature),
                    A* route planning (cached cost grids)
  tiledTerrain.ts   large terrain read tile by tile into an LRU cache: the same queries, coarse-then-fine routes
  postOverlay.ts    route cost multipliers per post (minefields, obstacles, threats), stored in blocks
  pathfinding.ts    grid A* and polyline simplification
  catalog.ts        default entity types, weapons, sensors, unit templates
  entity.ts         Entity state
  movement.ts       kinematics per domain
  tasks.ts          Task classes (move, route, patrol, wait, follow, attack, orbit, formation,
                    fire mission, mount, dismount, breach, smoke, resupply, overwatch, defend,
                    ambush, screen, search, manual (direct control))
  plans.ts          PlanExecutor (if/while compiled to steps with jumps), conditions, codewords
  units.ts          Unit: formations, leader succession, deployment, the chain of command
  aggregate.ts      aggregate level: units as one object, Lanchester attrition, (dis)aggregation
  sensors.ts        detection
  combat.ts         target and weapon selection, fly-out, damage, indirect fire and blast
  models.ts         swappable hit/kill (armour by aspect), ballistic, radar and navigation models
  fires.ts          automatic call for fire
  morale.ts         suppression, pinning, unit morale, breaking and rallying
  environment.ts    sun, light level, weather, sensor range at night
  smoke.ts          smoke clouds and their effect on sight lines
  obstacles.ts      minefields, obstacles, breached lanes, the route cost overlay
  supply.ts         fuel use and resupply
  threats.ts        threat map for covered routes
  batch.ts          Monte Carlo replications and their statistics (no I/O)
  sync.ts           synchronization matrices: phases, triggers, phase orders
  ew.ts             electronic warfare: who is jammed (radio, radar, datalink, GNSS), radio silence
  navigation.ts     GNSS navigators and GNSS-guided munitions under jamming and spoofing
  emcon.ts          what entities radiate, direction finding (DF contacts), anti-radiation missiles
  protection.ts     active protection systems and flares/chaff on the shot flow
  life.ts           pattern of life: background civilian cars and pedestrians
  explain.ts        "Why?" explanations for entities and units (read-only)
  alerts.ts         the attention queue (read-only)
  eta.ts            travel estimates for moves
  viewshed.ts       viewshed grids for the map overlay
  catalogEdit.ts    validation of catalog entries made in the editor
  wizard.ts         quick battle generator
  commander/        commanders that run a force: manager.ts (when to decide, carrying orders out as
                    the force's player), situation.ts (the force's view), rules.ts (rule-based),
                    llm.ts (the LLM tool loop; the transport is passed in), options.ts, types.ts
  spatial.ts        per-force uniform grid for neighbourhood queries (sensors, blasts)
  recorder.ts       continuous recording for playback and AAR
  rng.ts            seeded PRNG
src/dis           DIS: geodesy (WGS-84/ECEF, Euler angles), PDU codecs, UDP gateway
src/server        CLI, real-time runner (time-sliced, undo checkpoints), command dispatcher,
                  REST v1 router, OpenAPI, HTTP/WS server with sessions (server.ts),
                  fog.ts (roles, per-force views, command permissions), oidc.ts (sign-in),
                  batch.ts + batchWorker.ts (batch jobs in worker threads),
                  reports.ts + pdf.ts (AAR as CSV and PDF), llm.ts (Messages API transport for
                  LLM commanders, configured from the environment), tileServer.ts (terrain tiles
                  over HTTP)
src/terrain       real terrain import (GeoTIFF + GeoJSON/OSM → dataset), landcover.ts (WorldCover),
                  osm.ts (OSM XML, Overpass), the dataset store, tiles.ts (tiled datasets on disk),
                  importTiled.ts (large DEMs as tiled datasets), synthetic.ts (synthetic large terrain)
hla               HLA bridge federate (Java, IEEE 1516e, RPR FOM subset) and its scripts
src/mcp           MCP tools (over the REST routes) and the stdio bridge
src/integrations  Cursor-on-Target, webhooks, GeoJSON/KML, and the hub that wires them up
web               Browser app: main.ts (UI), map.ts (2D), view3d.ts (3D, lazy-loaded), aar.ts (replay),
                  tiledGrid.ts (tiles of large terrain fetched for the view),
                  timeline.ts, symbols.ts (2525 and simple symbols), api.ts, planeditor.ts (block
                  plan editor), orderline.ts, quickbar.ts, syncmatrix.ts, drive.ts, quickbattle.ts,
                  catalogeditor.ts
scenarios         Sample scenarios (generated by scripts/make-scenarios.ts)
terrains          Imported real-world terrain datasets
scripts           build-web.mjs, make-scenarios.ts, docs-gen.ts, bench.ts, bench-terrain.ts, golden-update.ts
test              vitest suites; test/golden holds the recorded golden runs
e2e               Playwright browser tests
deploy            Caddyfile for the TLS front end (docker-compose.yml)
examples          runnable client and library examples
docs              this documentation (served at /docs)
```

## The simulation step

`Engine.step(dt = 0.1)` runs these phases in order:

1. **Orders and suppression:** orders whose delay has run out are delivered
   (`rules.orderDelay`), and suppression wears off.
2. **Units:** replace a lost or immobilised leader, and hand the unit task on.
3. **Withdrawals:** units and entities whose withdraw reaction triggers drop
   their plan and fall back. Then the **aggregate level**: aggregated units
   move; once a second they look for each other, and split up or join up
   again by the policy; then Lanchester attrition between them.
4. **Plans:** unit plans, then entity plans. Instant statements run straight
   away; a `task` statement starts the task, and later ticks check whether it
   has finished.
5. **Tasks:** each running task sets the entity's `steer` command (a target
   point, a speed, whether to stop there). An entity halted by its on-contact
   reaction, or pinned down by suppression, stops instead, keeping its task.
   A GNSS navigator that has lost its fix runs its task from where it thinks
   it is, and the steer point is shifted back by the navigation error.
6. **Movement:** `stepMovement` turns `steer` into heading, speed and position
   changes, and applies terrain and weather effects. Vehicles out of fuel stay
   put. Ground movement is checked against obstacles and minefields (mine
   strikes). Passengers are moved with their carriers. Fuel is burned, and
   entities that move give up prepared positions.
7. **Sensors:** once per second per entity, staggered. Each scan asks the
   spatial grid for other forces' entities within sensor range, in the same
   order a full scan would visit them, so results do not depend on the grid.
8. **Once per second:** the light and weather are updated, smoke drifts and
   expires, observers request fire missions, unit morale is updated, supply
   vehicles resupply, jamming is worked out, GNSS navigators lose or regain
   their fix, direction finders take bearings (and call for fire on good
   fixes), anti-radiation missiles home on their emitters, the pattern of life tops up and
   moves its civilians, alerts are checked, synchronization-matrix
   triggers are checked (starting phases), and commanders decide or carry out
   orders that have arrived from a model.
9. **Combat:** pick a target and weapon, fire, and put the shot in flight.
10. **Impacts:** shots that arrive this tick are resolved into damage (area
   damage for indirect fire, smoke clouds for smoke rounds) and suppression.
11. **Step listeners:** e.g. the recorder samples a frame when one is due.

Everything is deterministic for a given seed: the engine uses only `Rng`, never
`Math.random`.

## Data flow

```
GUI ──ws command──►  commands.ts ─┐
REST /api/command ───────────────►├─► Engine (tasking API) ──events──► SimServer → WS clients
REST /api/v1 ──► ApiV1 router ────┘                         ├─fire/detonation─► DisGateway → UDP
MCP tools ──► ApiV1 router (in-process or over HTTP)        └─events──► IntegrationHub → webhooks
SimRunner (20 Hz): steps the engine in real time → gateway.update, CoT tick, webhook flush, state broadcast (10 Hz)
```

The runner steps the engine in slices of at most 15 ms of wall time and yields
to the event loop between slices, so HTTP and WebSocket traffic is served
between them even when a scenario cannot keep up. Before each undoable command
it keeps a checkpoint (`engine.toScenario()`, up to 30) for undo and redo.

`SimServer` hosts one or more **sessions** (`Session` in `server.ts`): each has
its own engine, runner, `ApiV1`, WebSocket server and, for `main`, the
integrations. Requests under `/s/{id}/` are routed to that session with the
prefix stripped, so the routes are the same in every session.

All mutating commands go through `executeCommand` (`src/server/commands.ts`),
which validates input. The REST v1 routes and the MCP tools are thin layers on
top, so every interface behaves the same way.

## Using the engine as a library

```ts
import { Engine } from './src/sim/engine.js';

const engine = new Engine();                 // default catalog and terrain
engine.newScenario('Library demo');
const [a, b] = engine.terrain.towns;
const unit = engine.createUnitFromTemplate('us-tank-platoon', 1, a.x, a.y);
engine.assignTask(unit.id, { type: 'moveTo', target: b });
engine.on('event', (ev) => console.log(ev.time.toFixed(0), ev.text));
engine.runFor(600);                           // ten simulated minutes, as fast as possible
console.log(engine.snapshot().entities.map((e) => `${e.name} ${e.damage}`));
```

See `examples/monte-carlo.ts` and `examples/custom-catalog.ts`.

## How to add…

### A new task type

1. Add a variant to `TaskSpec` in `src/shared/types.ts`.
2. Write a `Task` subclass in `src/sim/tasks.ts`:
   - `tick()` sets `entity.steer` and returns `'running' | 'done' | 'failed'`;
   - `describe()` returns the text shown in the GUI;
   - optionally override `remainingPath` so the planned route is drawn.
3. Handle it in `createTask()` and in `Engine.validateTask()` (check that
   referenced objects exist).
4. Accept it in `validateTask()` in `src/server/commands.ts`.
5. Expose it:
   - REST: add it to the `Task` schema in `src/server/openapi.ts`;
   - MCP: add it to the `assign_task` tool in `src/mcp/tools.ts`;
   - GUI: add a button or plan step in `web/main.ts`.
6. Add a test in `test/engine.test.ts`, then run `npm run docs:gen` if the MCP
   tools changed.

### A new plan condition

Add it to `Condition` in `types.ts`, then update:

- `describeCondition` and `evaluateCondition` in `src/sim/plans.ts`;
- `validateCondition` in `commands.ts`;
- the GUI plan editor;
- the OpenAPI `PlanStatement` schema.

### A new entity type, weapon or sensor

Add it to `src/sim/catalog.ts`, or build a custom catalog at runtime without
touching the source (see [Tutorial 9](tutorials/09-extending-the-catalog.md)).
Then run `npm run docs:gen` to refresh [the catalog reference](reference/catalog.md).

### A new REST endpoint

Add a route in `ApiV1.routes()` (`src/server/apiV1.ts`). Handlers receive
`{params, query, body}` and return `{json}` or `{text, contentType}`; throw
`HttpError(status, message)` for errors. Document the endpoint in
`src/server/openapi.ts`. MCP tools can call it immediately.

### A new MCP tool

Register it in `createMcpServer` (`src/mcp/tools.ts`) with a zod input schema.
Implement it by calling REST routes through `api()`, so it works both
in-process and over the stdio bridge. Then run `npm run docs:gen`.

### A new integration

Write a module in `src/integrations/` that listens to engine events
(`engine.on('event' | 'fire' | 'detonation' | 'removed' | 'reset')`) or polls
`runner.state()`. Wire it into `IntegrationHub`, and add configuration routes in
`apiV1.ts`.

## Testing

```bash
npm test              # all suites
npx vitest run test/engine.test.ts -t "formation"   # one test
npm run check         # typecheck + tests + build (CI)
npm run docs:gen      # regenerate docs/reference/catalog.md and mcp-tools.md
```

| Suite | Covers |
| --- | --- |
| `engine.test.ts` | terrain, movement, tasks, units, plans, sensors and combat (on flat test terrain), scenarios |
| `dis.test.ts` | geodesy, PDU byte layouts, the gateway over an in-memory network |
| `dis-v7.test.ts` | Electromagnetic Emission for radars and jammers, PDU status, Data Query, Set Data, Action Request, Create/Remove Entity, Entity State Update, Collision, Designator |
| `dis-interop.test.ts` | every PDU type cross-checked against open-dis, both ways and end to end (skipped unless `npm run interop:fetch` has been run) |
| `server.test.ts` | command validation, the GUI endpoints, WebSocket |
| `api.test.ts` | REST v1, security checks, MCP over HTTP and stdio |
| `integrations.test.ts` | CoT (including real UDP), webhooks (a real HTTP receiver), GeoJSON/KML |
| `model.test.ts` | wire-guided missiles, reactions, area/strength conditions, checkpoints |
| `artillery.test.ts` | fire missions, batteries, call for fire, danger close, DIS area detonations |
| `mounted.test.ts` | mounting, riding, dismounting, carrier losses, checkpoints |
| `recording.test.ts` | frames, interpolation, AAR report, rewind, memory budget |
| `roles.test.ts` | fog of war views and events, player command limits, player keys over REST, WebSocket and MCP |
| `terrain-import.test.ts` | GeoTIFF (geographic and UTM) and GeoJSON import, lakes, rivers and bridges, high terrain |
| `spatial.test.ts` | the spatial grid |
| `los.test.ts` | the max-height pyramid line of sight against a sample-by-sample reference |
| `curvature.test.ts` | earth curvature and refraction: horizons, 30 km over flat ground, radar, the rule |
| `tiled-terrain.test.ts` | tiles against the whole grid: every query and sight line across tile edges, LRU eviction, coarse-then-fine routes |
| `tiled-dataset.test.ts` | tiled datasets written, listed, loaded and served (tile routes) |
| `terrain-import-tiled.test.ts` | the tiled import against the single-file import, post by post |
| `large-terrain.test.ts` | a synthetic 200 km terrain: a scenario in bounded memory, a 100 km route, small route overlays |
| `morale.test.ts` | suppression, pinning, morale, breaking and rallying |
| `environment.test.ts` | sun and light through the day, night sensors, weather |
| `obstacles.test.ts` | obstacles, minefields, breaching, smoke |
| `supply.test.ts` | fuel use by vehicles and aircraft, resupply |
| `tactics.test.ts` | defend, ambush, screen, overwatch, search, prepared positions |
| `command.test.ts` | company templates, orders down the chain of command, order delay |
| `threats.test.ts` | covered routes |
| `landcover.test.ts` | OSM XML and Overpass input, building heights, land cover and buildings in imported terrain |
| `undo.test.ts` | undo and redo of edits and of tasks given mid-run |
| `batch.test.ts` | batch statistics, repeatable replications, the batch REST API, AAR export as CSV and PDF |
| `golden.test.ts` | two bundled scenarios still play out as recorded in `test/golden/` |
| `sessions.test.ts` | several sessions side by side under `/s/{id}` |
| `oidc.test.ts` | OpenID Connect sign-in against an in-test identity provider, token checks |
| `hla.test.ts` | WeRForces and the HLA bridge through a real OHLA RTI (skipped unless `npm run hla:build` has been run) |
| `aggregate.test.ts` | aggregate level: attrition against the closed-form Lanchester square law, round trips, automatic disaggregation and re-aggregation, save/load, fog of war, REST and MCP |
| `explain.test.ts` | "Why?" explanations: blockers, line of sight, fixes, what players are told |
| `alerts.test.ts` | the attention queue: idle, fuel, losses, acknowledging |
| `eta.test.ts` | travel estimates |
| `orders.test.ts` | the typed-order parser and completions |
| `plan-flow.test.ts` | if/else, while, codewords and compound conditions in plans |
| `sync.test.ts` | synchronization matrices: triggers, phase orders, per-force state |
| `viewshed.test.ts` | viewshed grids |
| `life.test.ts` | pattern of life: civilians kept topped up, fleeing |
| `ew.test.ts` | radio, radar, datalink and GNSS jamming |
| `countermeasures.test.ts` | GNSS denial and spoofing, GNSS-guided munitions, counter-UAS jammers, guns and interceptors, emission control, direction finding and triangulation, DF calls for fire, active protection, decoys, anti-radiation missiles, save/load, fog of war, REST and MCP |
| `fidelity.test.ts` | armour by aspect, ballistics of unguided rounds, the radar range equation, swapping models |
| `drive.test.ts` | direct control |
| `catalog-edit.test.ts` | catalog editor validation and per-scenario entries |
| `wizard.test.ts` | quick battles |
| `commander.test.ts` | commanders: settings and checkpoints, hold-off, determinism, the LLM tool loop with a scripted transport (permissions, failures, limits), REST and MCP |
| `commander-battles.test.ts` | the rule-based commander against idle and attacking forces in quick battles, over 10 seeds |
| `docs.test.ts` | the generated references are current; internal doc links resolve |

**Golden runs** pin the model's behaviour: Calloway Crossroads and Lakeside
Patrol are run for a fixed time, and the outcome (survivors per force, kills,
and a SHA-256 digest of every event) is compared with the file in
`test/golden/`. Any change to the model shows up there. When you change the model on
purpose, run `npm run golden:update`, check the diff of `test/golden/*.json`
makes sense, and commit it with the change.

Browser tests: `npm run build && npm run e2e` starts two servers (one open, one
with exercise-control and player keys) and drives the GUI in Chromium with
Playwright (`e2e/app.spec.ts`). CI runs them, and builds and smoke-tests the
Docker image.

## Coding conventions

- TypeScript strict mode and ES modules. Relative imports use `.js` extensions.
- `src/shared` and `src/sim` must not import Node APIs, because the browser
  bundles `src/shared`.
- Validate input at the boundary (`commands.ts`, `apiV1.ts`). The engine throws
  plain `Error`s for invalid requests.
- Keep the engine deterministic: no wall-clock time and no `Math.random` inside
  `src/sim`.
