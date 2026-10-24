# Scenario file format

A scenario is a JSON document. You get one from:

- **File → Export to file**;
- `GET /api/v1/scenario`;
- the `scenarios/` folder.

Load it with **File → Import from file…**, `PUT /api/v1/scenario`, or
`--scenario`. Saving captures the **current** state: positions, assigned tasks
and plans, ROE, reactions and graphics.

A scenario saved at time 0 is a clean starting point. Saved while running
(time > 0) it is a full **checkpoint**: entities also carry a `state` with
damage, ammunition, contacts and plan/task progress, units carry their leader
and plan progress, and the file adds munitions in flight (`shots`) and the
random generator state (`rngState`), smoke clouds (`smoke`), orders still
on their way (`orders`), the codewords sent so far (`codewords`), which
phases of each synchronization matrix have started, and the background
civilians themselves. Loading a checkpoint continues the run from that
state. Moving entities plan their route again from where they are, so the run
soon drifts from the one that was saved: two loads of the same checkpoint play
out identically, but not necessarily like the original run. Destroyed entities
are kept as wrecks.

The TypeScript definition is `ScenarioFile` in `src/shared/types.ts`.

## Top level

```json
{
  "format": "werforces-scenario",
  "version": 1,
  "name": "Calloway Crossroads",
  "description": "Free text shown in File → Open scenario",
  "terrain": { ... },
  "hostilities": [[1, 2]],
  "startTime": 0,
  "entities": [ ... ],
  "units": [ ... ],
  "graphics": [ ... ],
  "rules": { "suppression": true, "morale": true, "fuel": true, "orderDelay": false },
  "environment": { "date": "2026-11-02", "time": 5.5, "visibility": 3000, "precipitation": "rain", "windSpeed": 4, "windFrom": 250 },
  "patternOfLife": { "vehicles": 20, "pedestrians": 40 },
  "catalog": { "entityTypes": [ ... ] },
  "syncMatrices": [ ... ],
  "codewords": [ ... ],
  "shots": [ ... ],
  "rngState": 1234567890
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `format`, `version` | yes | Must be `"werforces-scenario"` and `1` |
| `name` | yes | Display name |
| `description` | | Free text |
| `terrain` | yes | Terrain spec (below). Missing fields use defaults |
| `hostilities` | | Pairs of hostile forces (default `[[1,2]]`) |
| `startTime` | | Initial simulation time in seconds (default 0) |
| `entities`, `units`, `graphics` | yes | May be empty arrays |
| `rules` | | Optional models, for comparison runs: `suppression`, `morale`, `fuel` (missing means on) and `orderDelay` (missing means off) ([Concepts](../concepts.md#optional-models)) |
| `environment` | | Time of day and weather at the start (below). Missing fields keep their defaults |
| `patternOfLife` | | Background civilians to keep on the map: `vehicles` and `pedestrians`, 0–300 each (missing means none) ([Concepts](../concepts.md#pattern-of-life)) |
| `catalog` | | Catalog entries this scenario adds or changes, made in the catalog editor: `entityTypes`, `weapons`, `sensors`, `unitTemplates`, each a list of entries as in `GET /api/v1/catalog`. Checked on load and merged by id over the server's catalog, before the entities are created ([below](#catalog)) |
| `syncMatrices` | | One synchronization matrix per force ([below](#syncmatrices)) |
| `codewords` | | Checkpoints: codewords sent so far, `{force, codeword, time}` |
| `shots` | | Checkpoints: munitions in flight (`shooterId`, `targetId`, `weaponId`, `from`, `to`, `fireTime`, `impactTime`, `range`) |
| `smoke` | | Checkpoints: smoke clouds (`id`, `x`, `y`, `radius`, `until`: the simulation time it is gone) |
| `orders` | | Checkpoints: orders on their way down the chain of command (`targetId`, `task` or `plan`, `due`) |
| `rngState` | | Checkpoints: random number generator state, so the run continues identically |

## `environment`

| Field | Default | Meaning |
| --- | --- | --- |
| `date` | `2026-06-21` | Date at the start, `YYYY-MM-DD`. With the terrain's latitude it sets sunrise and sunset |
| `time` | `12` | Local solar time at the start, in hours (0–24). `5.5` is 05:30 |
| `visibility` | `20000` | Meteorological visibility in metres: fog is a few hundred, haze a few thousand |
| `precipitation` | `none` | `none`, `rain`, `heavyRain` or `snow`: shorter sight, slower going off-road |
| `windSpeed` | `0` | Metres per second. Drifts smoke |
| `windFrom` | `270` | Direction the wind blows from, degrees clockwise from north |

See [Concepts → Night and weather](../concepts.md#night-and-weather).

## `terrain`

```json
{
  "seed": 1337,
  "size": 16000,
  "cellSize": 50,
  "origin": { "lat": 50.75, "lon": 9.9 },
  "relief": 320,
  "waterFraction": 0.1,
  "forestFraction": 0.28,
  "towns": 7
}
```

| Field | Default | Meaning |
| --- | --- | --- |
| `seed` | 1337 | Generator seed. The same spec always gives the same terrain |
| `size` | 16000 | Map edge in metres (square) |
| `cellSize` | 50 | Elevation post spacing in metres. Smaller is finer but slower |
| `origin` | 50.75, 9.9 | Latitude/longitude of the south-west corner |
| `relief` | 320 | Height range in metres |
| `waterFraction` | 0.1 | Share of the map below sea level |
| `forestFraction` | 0.28 | Share of the land that is forest |
| `towns` | 7 | Number of towns, connected by roads |
| `dataset` | | Name of an imported terrain in `terrains/`. When set, the terrain comes from that dataset and the other fields are ignored ([Terrain import](../terrain-import.md)) |

## `entities[]`

```json
{
  "id": "E1",
  "name": "Team ARMOR Lead",
  "typeId": "us-m1a2",
  "force": 1,
  "x": 10566,
  "y": 4289,
  "heading": 0,
  "altitude": 120,
  "roe": "fireAtWill",
  "reactions": { "onContact": "halt" },
  "plan": { ... },
  "task": { ... },
  "state": { ... }
}
```

| Field | Meaning |
| --- | --- |
| `id` | Unique id. New objects get ids after the highest one loaded |
| `typeId` | A [catalog](catalog.md) entity type |
| `force` | 0–3 |
| `x`, `y` | Local metres |
| `heading` | Radians clockwise from north |
| `altitude` | Aircraft only: metres above ground (defaults to the type's cruise altitude) |
| `roe` | `fireAtWill` (default), `returnFire`, `holdFire` |
| `plan` / `task` | Optional. Assigned when the scenario loads. If both are given, the plan wins |
| `reactions` | Optional: `onContact`, `withdrawBelow`, `withdrawTo`, `callForFire` ([Concepts](../concepts.md#reactions)) |
| `state` | Optional. Saved at time 0 it holds only `destroyed`, `mobilityKill`, `firepowerKill`, `embarkedIn` (carrier id: starts mounted) and `jamming: false` (a jammer that starts switched off; jammers start on). Fields added by hand are applied on load too, for example `fuel` (litres), `ammo` (rounds by weapon id), `supplies` (supply loads left) or `prepared` (`dugIn` or `hullDown`: starts in a prepared position). Checkpoints add `speed`, `z`, `ammo`, `weaponReadyAt`, `contacts`, `attackers`, `underFireUntil`, `lastFiredAt`, `sensorDue`, `speedOverride`, `altitudeOverride`, `planIndex`, `taskState` (a task spec that resumes the running task), `taskDone`, `withdrawn`, `callForFireAt`, `smokeLeft`, `suppression`, `morale`, `moraleState`, and `ambient: true` for a background civilian (taken back under the pattern of life's control on load) |

Ground and dismounted entities must be on land, and surface vessels on water.
Otherwise loading fails and the previous scenario stays loaded.

## `units[]`

```json
{
  "id": "U1",
  "name": "Team ARMOR",
  "force": 1,
  "memberIds": ["E1", "E2", "E3", "E4"],
  "formation": "wedge",
  "spacing": 80,
  "echelon": "platoon",
  "parentId": "U10",
  "plan": { ... }
}
```

The first member is the initial leader. Units also take a `task`, `reactions`
and, in checkpoints, a `state` with `planIndex`, `taskState`, `taskDone`,
`leaderId`, `withdrawn`, `morale`, `moraleState` and `lossesSeen`. `echelon` is
one of `team`, `section`, `platoon`, `company`, `flight` or `group`: it sets the
symbol and, with `rules.orderDelay`, how long orders take to arrive. Members
must be listed in `entities` and share the unit's force.

`parentId` is the unit's superior in the chain of command, for example the
company a platoon belongs to. It must be another unit of the same force, and
the chain may not loop. A company's orders are split among its subordinate
units ([Concepts](../concepts.md#chain-of-command)).

## `graphics[]`

```json
{ "id": "G1", "kind": "route", "name": "Route IRON", "force": 1, "points": [{"x": 10266, "y": 4289}, {"x": 10500, "y": 5200}] }
```

`kind` is `route` (two or more points), `area` (three or more), `phaseLine`
(two or more), `point` (one), `minefield` (three or more) or `obstacle` (two or
more: an anti-tank ditch or wire line).

```json
{ "id": "G7", "kind": "minefield", "name": "MF 1", "force": 2, "points": [ ... ], "density": 0.8, "knownBy": [2], "lanes": [{ "from": {"x": 8100, "y": 6020}, "to": {"x": 8180, "y": 6240} }] }
```

| Field | Kinds | Meaning |
| --- | --- | --- |
| `density` | minefield | Roughly mines per metre of front: 0.1 sparse to 1.5 dense (default 0.5) |
| `knownBy` | minefield | Forces that know where it is. Its own force always does. Other forces learn of it when one of their entities strikes a mine |
| `lanes` | minefield, obstacle | Breached lanes, each a centreline 30 m wide. Engineers add them; routes pass through them |

## Tasks and plans

These use the same JSON as the REST API: see
[REST API → Tasks](rest-api.md#tasks) and [Plans](rest-api.md#plans). In files,
positions must be `{x, y}`. The `{town}` and `{lat, lon}` shortcuts only work
through the API.

Plan statements are `task`, `setRoe`, `setSpeed`, `setAltitude`,
`setFormation`, `setReactions`, `waitUntil`, and the control statements:

```json
{ "kind": "if", "condition": { "type": "enemyDetected" }, "then": [ ... ], "else": [ ... ] }
{ "kind": "while", "condition": { "type": "not", "condition": { "type": "codeword", "codeword": "EXECUTE" } }, "body": [ ... ] }
{ "kind": "sendCodeword", "codeword": "BRAVO" }
{ "kind": "report", "text": "crossing PL LD" }
```

Conditions are `simTime`, `inArea`, `enemyInArea`, `enemyDetected`,
`underFire`, `strengthBelow`, `fuelBelow`, `ammoBelow`, `entityDestroyed`,
`codeword` (`{"type": "codeword", "codeword": "EXECUTE"}`), and the
combinations `all` and `any` (`"conditions": [...]`) and `not`
(`"condition": {...}`). In checkpoints, a plan's `planIndex` counts the plan's
steps after `if`/`while` blocks are flattened, not its top-level statements.

## `syncMatrices`

A force's operation in phases ([Concepts](../concepts.md#synchronization-matrix)):

```json
{
  "force": 1,
  "phases": [
    { "id": "P1", "name": "Move", "trigger": { "type": "time", "time": 1 },
      "orders": [ { "targetId": "U1", "task": { "type": "moveTo", "target": { "x": 8922, "y": 6668 } }, "text": "move to ATK POS" } ] },
    { "id": "P2", "name": "Assault", "trigger": { "type": "codeword", "codeword": "EXECUTE" },
      "orders": [ { "targetId": "U1", "task": { "type": "moveTo", "target": { "x": 9382, "y": 7938 } } },
                  { "targetId": "U5", "task": { "type": "fireMission", "target": { "x": 9382, "y": 7938 }, "rounds": 4, "radius": 150 } } ] }
  ],
  "started": { "P1": 1 }
}
```

| Field | Meaning |
| --- | --- |
| `force` | The force it belongs to (one matrix per force) |
| `phases[].id`, `name` | A unique id (letters, digits, `-`, `_`) and the name, which is also the codeword the phase sends when it starts |
| `phases[].trigger` | `manual`, `time` (`time`), `codeword` (`codeword`), `previousDone` (`delay`?) or `condition` (`ownerId`, `condition`) |
| `phases[].orders` | `targetId` (a unit or entity of the force) with a `task`, an `roe`, or `stop: true`; `text` is the order as typed, kept for the GUI. In files, orders need a `task`, `roe` or `stop`: words are only turned into tasks through the API |
| `started` | Checkpoints: phase id → simulation time it started |

## `catalog`

Entries made in the catalog editor (or with `PUT /api/v1/catalog/...`) travel
with the scenario:

```json
"catalog": {
  "entityTypes": [ { "id": "us-m1a2-sep", "name": "M1A2 SEPv3", "domain": "ground", "armor": "armored", "maxSpeed": 18, "cruiseSpeed": 12, "acceleration": 2.5, "turnRate": 0.6, "weapons": ["gun-120mm", "mg-762"], "sensors": ["thermal-sight", "eye"], ... } ]
}
```

Optional model fields (all may be left out; see
[Concepts](../concepts.md#armour-by-aspect)):

| Section | Field | Meaning |
| --- | --- | --- |
| entity type | `protection` | `{front, side, rear, top}` armour in mm RHA equivalent; all four |
| entity type | `rcs` | radar cross-section in m² (default by symbol and domain) |
| weapon | `penetration` | armour penetration in mm RHA equivalent |
| weapon | `topAttack` | `true`: hits the top armour (as indirect fire does) |
| weapon | `spreadMrad`, `rangeError` | unguided direct fire: one-sigma angular spread (mrad) and range-estimate error (fraction, default 0.05); turn on the ballistic model |
| sensor | `refRange`, `refRcs` | radar: detection range (m) against a target of `refRcs` m² (default 1); range scales with RCS^¼ up to `maxRange` |

Every entry is checked as in the editor, and an entry with the id of a
built-in one replaces it in this scenario. The same JSON works as a
`--catalog` file ([Tutorial 9](../tutorials/09-extending-the-catalog.md)).

## Generating scenarios with code

`scripts/make-scenarios.ts` builds the bundled scenarios with the engine API,
using towns and road routes from the generated terrain, then calls
`engine.toScenario()`. Copy it as a starting point for your own generators.
