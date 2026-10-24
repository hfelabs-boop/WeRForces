# REST API reference

The complete, always-current reference is generated from the running server:

- **`/api/docs`**: a readable reference with request schemas;
- **`/api/v1/openapi.json`**: OpenAPI 3.1. Import it into Postman or Insomnia,
  or generate a client with `openapi-generator`.

This page covers conventions and gives an overview. For a hands-on
introduction see [Tutorial 4](../tutorials/04-scripting-with-the-rest-api.md).

## Conventions

- Base path **`/api/v1`**. Request and response bodies are JSON.
- **`POST` and `PUT` must send `Content-Type: application/json`**, even with an
  empty body (`{}`). Otherwise the server answers 415.
- **Positions** can be `{"x": 5000, "y": 7000}` (local metres), `{"lat": 50.8,
  "lon": 9.95}` or `{"town": "Calloway"}`. This works wherever a request takes a
  position, a task `target`/`center`, or graphic `points`.
- Entity responses include both local `x`, `y`, `z` and `lat`, `lon`, `headingDeg`.
- `heading` in requests is in **radians**, clockwise from north.
- Ids: entities `E1…`, units `U1…`, graphics `G1…`. Remote DIS entities are
  `R<site>-<app>-<entity>`.
- **Errors** look like `{"error": {"status": 404, "message": "unknown entity E99"}}`.

| Status | Meaning |
| --- | --- |
| 200 / 201 / 204 | OK / created / deleted |
| 400 | Invalid input (the message says why) |
| 401 | Missing or wrong API key |
| 403 | Host not allowed (DNS-rebinding protection) |
| 404 | Unknown object or endpoint |
| 405 | Wrong method for this path |
| 415 | Missing `Content-Type: application/json` |
| 422 | No route found (`/terrain/route`) |

## Endpoints

### Simulation

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| GET | `/simulation` | | Status: scenario, time, running, timeScale, `load` (share of time spent simulating), strength per force, terrain (size, origin, towns), environment (local time, light, visibility), DIS, `lastEventSeq` |
| POST | `/simulation/run` · `/pause` · `/rewind` | | Status |
| POST | `/simulation/step` | `{"seconds": 300}` (≤ 3600) | Status after stepping immediately |
| PUT | `/simulation/time-scale` | `{"scale": 8}` | Status |
| GET / PUT | `/simulation/rules` | `{"suppression": true, "morale": true, "fuel": true, "orderDelay": false, "curvature": true}` (any subset) | The rules ([optional models](../concepts.md#optional-models)) |
| GET / PUT | `/simulation/pattern-of-life` | `{"vehicles": 20, "pedestrians": 40}` (0–300 each; either) | The numbers of background civilians kept on the map ([pattern of life](../concepts.md#pattern-of-life)) |
| GET / PUT | `/simulation/aggregation` | `{"autoDisaggregate": true, "disaggregateRange": 3000, "autoReaggregate": true, "reaggregateRange": 5000, "reaggregateDelay": 120}` (any subset) | The [aggregation policy](../concepts.md#aggregate-level): when aggregates split up near enemy entities, and when units that split by themselves join up again |
| GET / PUT | `/simulation/environment` | `{"date": "2026-06-21", "time": 4.5, "visibility": 800, "precipitation": "rain", "windSpeed": 6, "windFrom": 270}` (any subset) | The environment plus `localDate`, `localTime`, `sunAltitude`, `light`, `period` |

### Scenarios

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/scenario` | The current state as a [scenario file](scenario-format.md) |
| PUT | `/scenario` | Load a scenario file (the body). Rolls back if invalid |
| POST | `/scenario/new` | `{"name": "...", "terrain": {"seed": 7, "size": 12000}}` (terrain optional; `{"dataset": "fulda"}` for an imported terrain) |
| GET | `/scenarios` | Scenarios stored on the server |
| GET / PUT | `/scenarios/{name}` | Read one / save the current state under that name |
| POST | `/scenarios/{name}/load` | Load a stored scenario |
| POST | `/scenario/undo` · `/scenario/redo` | Take back the last edit, or redo it (30 steps). Returns `{undo, redo, time}` |
| GET | `/scenario/quick-battle` | The choices a quick battle takes: `missions` (with their text), `compositions`, `sizes`, `support`, `weather`, `nations` |
| POST | `/scenario/quick-battle` | Replace the scenario with a generated battle (below). 201 with the simulation status plus `description` (the brief) and `seed`. One edit: undo brings the old scenario back |

### Objects

| Method | Path | Body / query |
| --- | --- | --- |
| GET | `/entities` | `?force=1\|blue&domain=air&unit=U1&alive=true&remote=false` |
| POST | `/entities` | `{"typeId", "force", "position", "heading"?, "name"?, "altitude"?}` |
| GET / PATCH / DELETE | `/entities/{id}` | PATCH: `{"name"?, "roe"?, "reactions"?, "position"?, "heading"?, "jamming"?, "emcon"?}` (`jamming`: switch a jammer on or off; `emcon`: [emission control](#emission-control-and-direction-finding)) |
| POST | `/entities/{id}/task` | a [task](#tasks) |
| POST | `/entities/{id}/plan` | a [plan](#plans) |
| POST | `/entities/{id}/stop` | |
| POST | `/entities/{id}/embark` | `{"carrierId": "E4"}` or a carrier unit id: put this soldier inside now (scenario set-up) |
| POST | `/entities/{id}/disembark` | let this carrier's passengers out now |
| GET | `/entities/{id}/path` | remaining planned waypoints |
| GET | `/entities/{id}/explain` · `/units/{id}/explain` | why it is or is not moving, firing and detecting ([below](#explanations)) |
| POST | `/entities/{id}/drive` | direct control: `{"throttle"?: 0..1, "turn"?: -1..1, "targetId"?: "E12" or null}`. The first call replaces its task and plan with a `manual` task; a turn is let go after 1.5 s without another call; any other order ends it. Returns the entity |
| GET | `/units` | `?force=` |
| POST | `/units` | `{"templateId", "force", "position", "heading"?, "name"?}` or `{"entityIds": [...], "name"?, "formation"?}` |
| GET / PATCH / DELETE | `/units/{id}` | PATCH: `{"name"?, "formation"?, "roe"?, "reactions"?, "superiorId"?, "emcon"?}` (`superiorId`: put under another unit, `null` for none; `emcon`: for its members and subordinate units). DELETE removes the members too; its subordinates become independent |
| POST | `/units/{id}/task` · `/plan` · `/stop` · `/embark` · `/disembark` | as for entities. A unit embarking into a carrier unit shares out the seats |
| POST | `/units/{id}/aggregate` · `/units/{id}/disaggregate` | Simulate the unit and the units under it as aggregates ([aggregate level](../concepts.md#aggregate-level)), or split them back into their entities. 400 with the reason when it cannot be done (aircraft, mounted or immobilised members, a task an aggregate cannot do, already aggregated). Returns the unit |
| GET / POST | `/graphics` | POST `{"kind": "route\|area\|phaseLine\|point\|minefield\|obstacle", "points": [...], "name"?, "force"?, "density"?}` (`density`: minefields, strikes per 100 m) |
| GET / PATCH / DELETE | `/graphics/{id}` | PATCH `{"name"?, "points"?, "density"?}` |

Entity and unit responses carry `travel` while moving along a planned path:
`{"remaining": 1378, "eta": 252.4, "etaLocal": "10:04"}` (metres left, the
simulation time and local time of arrival), or `{"remaining": ..., "stalled":
"out of fuel"}` ([travel estimates](../concepts.md#travel-estimates)). Jammers
carry `jamming` (on or off), and entities that enemy jamming denies something
`jammed` (`radio`, `radar`, `datalink`, `gnss`). Entities also carry, when
they apply: `emcon` (`{"radioSilence": true, "radarOff": true}`), `emitting`
(what it radiates now: `radar`, `jammer`, `radio`, `datalink`), `aps`
(`{"left": 6, "charges": 8}`, active protection), `decoys` (`{"left": 10,
"salvos": 12}`, flare and chaff salvos), and while satellite navigation is
lost `gnss` (`denied`, or `spoofed` for exercise control only) with `navError`
(m). Background civilians carry `ambient: true`.

An aggregated unit carries `aggregate`: `alive` and `total` members,
`strength` per entity type (`alive`, `effective`: less losses still being
taken, `total`), `combatPower`, `heading`, `speed`, `posture` (`moving`,
`halted`, `defending`, `dugIn`), `unitSpeed`, `sensorRange`, pooled `ammo` and
`fuel` (0–1), `engagingId` and `contacts` (enemy unit ids). Its members are
not in `/entities` and not in the unit's `members`; wrecks are. For players,
enemy aggregates their force has seen are listed by `/units` as contacts
(`enemy platoon (U6)`, with `contactAge`), with the types and numbers seen and
nothing else.

### Emission control and direction finding

| Method | Path | Body / query |
| --- | --- | --- |
| PATCH | `/entities/{id}` · `/units/{id}` | `{"emcon": {"radioSilence"?: true, "radarOff"?: true, "jamming"?: false}}`: settings left out stay as they are; on a unit they apply to its members and subordinate units. Players: their own force |
| GET | `/df-contacts` | Enemy emitters located by direction finding: the caller's force's (exercise control: every force's, or `?force=`) |

```json
{"id":"E4","force":1,"bands":["radar"],"x":9032.5,"y":12418.2,"lat":50.86,"lon":10.03,
 "major":412.6,"minor":131.9,"orientation":0.48,"orientationDeg":28,"stations":2,"lastSeen":42,"age":0.4}
```

`id` is the emitter, `force` the force that located it. `major` and `minor` are
the semi-axes (m) of the uncertainty ellipse (about 86 % likely to hold the
emitter), `orientation` the bearing of its major axis. One station gives a long
ellipse along its bearing (`stations: 1`); two or more cross their bearings.
Fire on one with a fire mission at `x`, `y` (radius about `major / 2`). See
[Concepts](../concepts.md#direction-finding). The full state (`/simulation`
over WebSocket) carries them as `dfContacts`.

### Tasks

```json
{"type": "moveTo", "target": {"town": "Calloway"}, "speed": 8}
{"type": "followRoute", "routeId": "G1", "reverse": false}
{"type": "patrol", "routeId": "G1"}
{"type": "wait", "duration": 60}
{"type": "follow", "targetId": "E4", "distance": 80}
{"type": "attack", "targetId": "E12"}
{"type": "orbit", "center": {"x": 8000, "y": 8000}, "radius": 2500, "duration": 600}
{"type": "fireMission", "target": {"x": 9200, "y": 11400}, "rounds": 4, "radius": 50}
{"type": "mount", "carrierId": "U3"}
{"type": "dismount"}
{"type": "moveTo", "target": {"x": 9000, "y": 7000}, "covered": true}
{"type": "fireMission", "target": {"x": 9200, "y": 11400}, "rounds": 2, "smoke": true}
{"type": "breach", "graphicId": "G4"}
{"type": "resupply", "supplierId": "E30"}
{"type": "overwatch", "position": {"x": 6000, "y": 9000}, "facing": 45, "duration": 600}
{"type": "defend", "position": {"town": "Calloway"}, "facing": 0, "width": 800}
{"type": "ambush", "position": {"x": 6000, "y": 9000}, "killZoneId": "G2"}
{"type": "screen", "position": {"x": 6000, "y": 9000}, "facing": 90, "breakContact": 2000, "fallback": {"x": 3000, "y": 9000}}
{"type": "search", "areaId": "G3", "spacing": 600}
{"type": "manual"}
```

`manual` is direct control; steer it with `POST /entities/{id}/drive`.

See [Concepts](../concepts.md#tasks) for what each one does. Positions can be
`{"x", "y"}`, `{"lat", "lon"}` or `{"town"}`.

### Reactions

`PATCH /entities/{id}` or `/units/{id}` with `{"reactions": {...}}` replaces the
reactions; a plan's `setReactions` step changes only those it names:

```json
{"onContact": "halt", "withdrawBelow": 0.5, "withdrawTo": {"town": "Brenham"}, "callForFire": true}
```

### Plans

```json
{
  "name": "Seize the bridge",
  "loop": false,
  "statements": [
    {"kind": "setFormation", "formation": "column"},
    {"kind": "task", "task": {"type": "followRoute", "routeId": "G1"}},
    {"kind": "waitUntil", "condition": {"type": "simTime", "time": 900}},
    {"kind": "setRoe", "roe": "fireAtWill"},
    {"kind": "task", "task": {"type": "moveTo", "target": {"town": "Calloway"}}}
  ]
}
```

Setting statements: `setRoe` (`fireAtWill|returnFire|holdFire`), `setSpeed` (m/s),
`setAltitude` (m above ground), `setFormation` (`column|line|wedge|vee|echelonRight`),
`setReactions` (`{"reactions": {...}}`).
Control statements: `if` (`{"condition", "then": [...], "else"?: [...]}`),
`while` (`{"condition", "body": [...]}`), `sendCodeword` (`{"codeword": "BRAVO"}`)
and `report` (`{"text": "..."}`, up to 200 characters). Blocks nest up to 8 deep,
with at most 200 statements in a plan.
Conditions: `simTime {time}`, `inArea {areaId}`, `enemyInArea {areaId}`,
`enemyDetected`, `underFire`, `strengthBelow {fraction}`, `fuelBelow {fraction}`,
`ammoBelow {fraction}`, `entityDestroyed {entityId}`, `codeword {codeword}`,
`all {conditions: [...]}`, `any {conditions: [...]}` (1–20 each), `not {condition}`.

```json
{
  "name": "Probe",
  "statements": [
    {"kind": "task", "task": {"type": "moveTo", "target": {"town": "Brenham"}}},
    {"kind": "if", "condition": {"type": "any", "conditions": [{"type": "enemyDetected"}, {"type": "underFire"}]},
     "then": [{"kind": "report", "text": "contact at Brenham"}, {"kind": "sendCodeword", "codeword": "BRAVO"}],
     "else": [{"kind": "task", "task": {"type": "moveTo", "target": {"town": "Calloway"}}}]},
    {"kind": "while", "condition": {"type": "not", "condition": {"type": "codeword", "codeword": "EXECUTE"}},
     "body": [{"kind": "task", "task": {"type": "wait", "duration": 30}}]},
    {"kind": "task", "task": {"type": "defend", "position": {"town": "Brenham"}, "facing": 90}}
  ]
}
```

Semantics are described in [Concepts](../concepts.md#plans).

### Orders in words

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/orders` | `{"text": "Team ARMOR move to Calloway covered", "dryRun"?: true}` → `{description, targets, commands, executed}`. Players may only order their own force. An order to several units is one edit (one undo step). 400 with a message when it can't be understood |

```json
{"description":"US Combined Arms Team: move to ATK POS by a covered route","targets":["U1"],
 "commands":[{"cmd":"assignTask","targetId":"U1","task":{"type":"moveTo","target":{"x":8922,"y":6668},"covered":true}}],
 "executed":false}
```

The grammar is in the [user guide](../user-guide.md#typed-orders).

### Synchronization matrices and codewords

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/sync-matrix` | Every force's matrix (players: their own) with `started` (phase id → time) and `current` |
| PUT | `/sync-matrix/{force}` | `{"phases": [...]}` replaces the force's matrix (`blue`, `red`, `neutral` or 0–3); an empty list removes it. Returns the matrix |
| POST | `/sync-matrix/{force}/phases/{id}/start` | Start a phase now, whatever its trigger |
| GET | `/codewords` | `[{force, codeword, time}]` sent so far (players: their own force) |
| POST | `/codewords` | `{"codeword": "execute", "force"?: 1}` → 201 `{"force":1,"codeword":"EXECUTE","time":300}`. Players send to their own force |

A phase:

```json
{"id": "P2", "name": "Assault", "trigger": {"type": "codeword", "codeword": "EXECUTE"},
 "orders": [{"targetId": "U1", "text": "move to 9382 7938"},
            {"targetId": "U5", "task": {"type": "fireMission", "target": {"x": 9382, "y": 7938}, "rounds": 4}},
            {"targetId": "U2", "roe": "holdFire"}]}
```

Triggers: `{"type": "manual"}`, `{"type": "time", "time": 600}`, `{"type":
"codeword", "codeword": "EXECUTE"}`, `{"type": "previousDone", "delay"?: 30}`,
`{"type": "condition", "ownerId": "U1", "condition": {...}}`. Each order names a
`targetId` of that force and one of `task`, `roe`, `stop: true`, or `text`: the
order in words without the name, as on the order line. A `text` order with no
task is turned into one when the matrix is stored, and a 400 names the unit and
phase it could not understand. Up to 20 phases of 100 orders. See
[Concepts](../concepts.md#synchronization-matrix).

### Commanders

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/commanders` | Forces run by a commander (players: their own), with status and latest decisions |
| GET | `/forces/{force}/commander` | One force's commander (`kind: "none"` when it has none), and `llm: {available, reason?}`: whether a language model is configured |
| PUT | `/forces/{force}/commander` | `{"kind": "rules", "options": {"aggressiveness": 0.7}}` sets it; `{"kind": "none"}` takes the force back. Players: their own force, not `llm`. Returns the commander |
| POST | `/forces/{force}/commander/decide` | 202: a decision at the next simulated second |

```json
{"force":2,"name":"Red","kind":"rules","options":{"aggressiveness":0.7},"state":"ready","next":946,
 "decisions":[{"time":901,"trigger":"contact","summary":"Attack (2 contacts, enemy power 2.4 against our 6.1); concentrating on BMP-2 (E10).",
   "orders":["RU Mech Platoon: attack BMP-2 (E10)","RU Mortar Battery: fire 4 rounds on 2 contacts at (6667, 6640)"]}],
 "llm":{"available":false,"reason":"no language model is configured on this server (set WERFORCES_AI_API_KEY and WERFORCES_AI_MODEL)"}}
```

`kind`: `none`, `rules` or `llm`. `options`: `interval` (10–600 s, default 45),
`aggressiveness` (0–1, default 0.5), `holdOff` (0–3600 s, default 300),
`seed`, and for an LLM `intent` (up to 500 characters), `maxCallsPerMinute`
(default 4), `maxTokens` (per call, default 2048), `maxToolCalls` (per
decision, default 12) and `tokenBudget` (default 500000). `state` is `ready`,
`thinking` (a model call under way), `error` (with `error`) or `unavailable`.
A decision's `trigger` is `start`, `scheduled`, `contact`, `losses`, `phase`,
`idle` or `asked`; `rejected` lists refused orders with the reason. LLM
commanders add `usage: {calls, inputTokens, outputTokens}`. The same command
over `/api/command` or a `batch`: `{"cmd": "setCommander", "force": 2, "kind":
"rules", "options": {}}`. Scenario files keep commanders in `commanders`. See
[Concepts](../concepts.md#commanders).

### Alerts

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/alerts` | Open alerts, newest first (players: their own force's). `?all=true` adds acknowledged ones |
| POST | `/alerts/acknowledge` | Acknowledge every open alert; returns the open alerts left |
| POST | `/alerts/{id}/acknowledge` | Acknowledge one |

```json
{"id":"A6","kind":"jammed","severity":"warning","objectId":"U1","force":1,"text":"US Combined Arms Team: radio jammed","time":241,"count":1}
```

`kind` is `taskFailed`, `idle`, `broken`, `outOfFuel`, `lowFuel`, `outOfAmmo`,
`leaderLost`, `losses`, `underFire`, `contact`, `jammed`, `gnssDenied` or
`apsSpent`; `severity` is
`critical`, `warning` or `info`; `count` is how many times it was raised while
open. See [Concepts](../concepts.md#explanations-and-alerts).

### Explanations

`GET /entities/{id}/explain` (or `/units/{id}/explain`):

```json
{"id":"E2","name":"US Combined Arms Team 1st Platoon Lead","kind":"entity",
 "activity":"Move to (8848, 6827) by a covered route",
 "summary":"Move to (8848, 6827) by a covered route.",
 "movement":[],
 "fire":[{"code":"noContacts","severity":"info","text":"No enemy detected: it can only shoot at what its side has seen."}],
 "sensing":[{"code":"hidden","severity":"info","text":"RU Mech Platoon 2 (2.4 km) is hidden from it by the ground (a crest or ridge) at (9070, 7813).","at":{"x":9070,"y":7813},"aboutId":"E11"}]}
```

Findings have a `code`, a `severity` (`block`, `warn`, `info`), `text`, and
optionally `fix`, `at` and `aboutId`. Units add `unit` findings. Exercise
control also hears about enemies not detected; players only about what their
side knows.

### Quick battle

`POST /scenario/quick-battle` body (every field optional):

```json
{"mission": "attack", "seed": 3,
 "blue": {"nation": "us", "composition": "combined", "size": "platoon", "support": ["artillery"]},
 "red": {"nation": "ru", "composition": "mech", "size": "platoon", "support": ["engineers"]},
 "time": 10, "weather": "clear", "distance": 3000, "civilians": false,
 "terrain": {"seed": 7, "size": 16000}, "name": "Attack at dawn", "commander": {"red": "rules"}}
```

`mission`: `meeting`, `attack` (default), `defend`, `delay` or `recon`, from
Blue's side. `composition`: `armor`, `mech` (default), `infantry` or `combined`.
`size`: `platoon` (default) or `company`. `support`: any of `artillery`,
`recon`, `engineers`, `supply`, `air`, `airDefense`. `weather`: `clear`,
`haze`, `fog` or `rain`. `distance` 1000–20000 m (default 3000, or 5000 with a
company). `terrain` as for `/scenario/new` (default: the current terrain).
`commander`: `{"blue"?: "none" | "rules", "red"?: ...}`, a side run by the
rule-based commander instead of a phase plan. Without `seed` a random one is
used and returned. A 400 says why a battle could not be placed.

### Recording and after-action review

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/recording` | Summary: `live`, scenario, `start`/`end` time, interval, frames, entities, events, bookmarks |
| GET | `/recording/data` | The whole recording as JSON (frames of 8 numbers per entity: index, x, y, z, heading, speed, flags, carrier) |
| GET | `/recording/state` | `?time=` → every entity and unit as recorded then (interpolated), with lat/lon |
| GET | `/recording/report` | After-action report: per force start/end strength, losses, kills and rounds fired; every kill with killer and weapon; rounds per weapon; strength over time; bookmarks |
| GET | `/recording/report.pdf` | The report as a printable PDF |
| GET | `/recording/events.csv` · `/kills.csv` · `/strength.csv` | The event log, kills, and alive entities per force over time, as CSV |
| POST | `/recording/bookmarks` | `{"text", "time"?}` (default now) → 201 with the bookmark. With DIS on, also sent as a Comment PDU |
| DELETE | `/recording/bookmarks/{id}` | |
| POST | `/recording/clear` | Discard it (or stop reviewing a loaded one) and record afresh from now |
| POST | `/recording/load` | Review a recording sent in the body; live recording pauses until `clear` |
| GET | `/recordings` | Saved recordings |
| PUT | `/recordings/{name}` | Save the current recording |
| POST | `/recordings/{name}/load` | Review a saved recording |

Returns 409 when the server runs with `--record-interval 0`.

### Batch runs

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/batch` | `{"scenario"?: name or scenario file (default: the current state), "runs": 20, "duration": 1800, "seed"?: 1000, "stopWhenDestroyed"?: true}` → 202 with the job. Runs in a worker thread |
| GET | `/batch` | Jobs: status (`running`, `done`, `failed`, `cancelled`), `done`/`runs` |
| GET | `/batch/{id}` | Progress, and when done the `summary`: per force losses (`mean`, `sd`, `ci95`, `min`, `max`, `histogram`), `exchangeRatio`, area control, shots, end time. `?outcomes=true` adds every run |
| GET | `/batch/{id}/runs.csv` | One row per run |
| DELETE | `/batch/{id}` | Cancel |

### Sessions

Exercise control only. Every endpoint on this page also exists per session
under `/s/{id}/api/v1`; the unprefixed paths are the `main` session.

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/sessions` | `id`, `path`, scenario, time, running, entities, viewers, load |
| POST | `/sessions` | `{"id"?: "red-cell", "scenario"?: "calloway-crossroads"}` → 201. At most 8 |
| GET / DELETE | `/sessions/{id}` | Any session but `main` can be deleted |

### Events, terrain, catalog

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/events` | `?since=<seq>&kinds=destroyed,damaged&limit=200`. Keep the highest `seq` you have seen and pass it as `since` to poll |
| GET | `/terrain` | spec, towns, road polylines (for a tiled terrain, its main roads), and `tiles` (as below) when the terrain is tiled |
| GET | `/terrain/tiles` | How the terrain is tiled: `tiled` (a tiled dataset, or tiles cut from a small terrain), `tileSize` (cells per tile side; tiles have one more post per side and share their edge posts), `cols` (posts per side of the whole grid), `cellSize`, `maxZoom`, `levels` (per level `z`: tiles `across`, `cellSize` between posts, `span` of a tile in metres), `layers`, `elevation` range, `url` template, and for tiled datasets the server's tile `cache` (tiles, bytes, capacity, loads, evictions) |
| GET | `/terrain/tiles/{z}/{x}/{y}` | One tile: level `z` (0 is one tile over the whole terrain; `maxZoom` holds every post; each level between keeps every second post of the one below), column `x` from the west and row `y` from the south. Binary (`application/vnd.werforces.tile`), sent gzipped (`Content-Encoding: gzip`). Layout in [Terrain import](../terrain-import.md#tile-format). 404 outside the pyramid |
| GET | `/terrain/point` | `?x=&y=` / `?lat=&lon=` / `?town=` → elevation, water, forest, road, slope, nearest town |
| POST | `/terrain/line-of-sight` | `{"from": "E1" or position, "to": ..., "radar"?: true}`. Positions take an optional `height` above ground (default 2 m). Terrain, forest, buildings and smoke block it (`radar` sees through smoke) |
| POST | `/terrain/viewshed` | `{"from": "E2" or position, "radius"?: 3000, "targetHeight"?: 2, "radar"?: false}` → a grid of cells around the eye (`x0`, `y0`, `cell`, `cols`, `rows`, `cellsB64`: one byte per cell, row by row from the south-west, 0 out of range or water, 1 hidden, 2 seen), `eye`, `radius` and `visibleFraction`. From an entity the radius defaults to its best sensor's range now (1–10 km); from a point (2 m above the ground, or `height`), 3 km. 100–20000 m. At most 161 cells across |
| POST | `/terrain/route` | `{"from", "to", "domain": "ground\|lifeform\|surface\|air", "force"?, "covered"?}` → waypoints and length. With `force`, round obstacles and the minefields it knows; with `covered` too, out of sight of the enemies it knows |
| GET | `/catalog` · `/catalog/entity-types` · `/catalog/unit-templates` | see the [catalog](catalog.md) |
| GET | `/catalog/custom` | The entries this scenario adds or changes (its `catalog` field) |
| PUT | `/catalog/{section}/{id}` | Add or change an entry; `section` is `entity-types`, `weapons`, `sensors` or `unit-templates`, the body an entry as in `GET /catalog`. Every field is checked, and references (weapons, sensors, member types) must exist. Entities already on the map keep their definition. Returns the entry |
| DELETE | `/catalog/{section}/{id}` | Remove a custom entry (a built-in one it replaced comes back). 400 while entities still need it |
| GET | `/terrains` | Imported terrain datasets ([Terrain import](../terrain-import.md)) |
| PUT | `/terrains/{name}` | Upload a dataset made with `werforces-terrain` (body: the dataset JSON, up to 8 MB) |

### Integrations and export

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/integrations` | CoT and webhook status |
| GET / PUT | `/integrations/cot` | `{"enabled", "url", "interval", "stale", "includeRemote"}` |
| GET / POST | `/webhooks` | POST `{"url", "format"?: "json\|slack\|discord", "kinds"?: [...], "secret"?, "name"?}` |
| DELETE | `/webhooks/{id}` | |
| POST | `/webhooks/{id}/test` | sends a test message |
| GET | `/export/entities.geojson` · `/export/graphics.geojson` | GeoJSON (`application/geo+json`) |
| GET | `/export/scene.kml` · `/export/live.kml?refresh=5` | KML / a Google Earth NetworkLink |

See [Integrations](integrations.md) for the payload formats.

## The GUI's endpoints

The browser app uses a few unversioned endpoints, which you can also use:

- `GET /api/state` returns the full snapshot;
- `GET /api/terrain` returns the terrain grid (base64); for a tiled terrain, only
  its description and `tiles` (the GUI then fetches tiles for what is in view);
- `GET /api/path/{id}`;
- `POST /api/command` takes a command object (see `Command` in
  `src/shared/types.ts`). `{"cmd": "batch", "commands": [...]}` runs several
  (up to 500) as one edit and one undo step, all or nothing: if one fails, the
  ones before it are undone;
- `GET /auth/config` says whether sign-in is used and who is signed in; `/auth/login`,
  `/auth/callback` and `/auth/logout` are the sign-in flow;
- the **`/ws`** WebSocket:
  - on connect it sends `hello`, then recent `events`, then `state`;
  - `state` follows at 10 Hz and `events` as they happen;
  - send `{"type": "command", "reqId": 1, "command": {...}}` and receive
    `{"type": "result", "reqId": 1, "result": {"ok": true, "id": "E7"}}`.

## Security

- **Loopback by default.** The server binds 127.0.0.1. On a loopback server,
  requests whose `Host` header is not `localhost`, `127.0.0.1` or `[::1]` are
  refused, which defeats DNS-rebinding attacks.
- **API key.** With `--api-key` (or `WERFORCES_API_KEY`), `/api/*` (except
  `/api/docs`), `/ws` and `/mcp` require:
  - `Authorization: Bearer <key>`,
  - `X-API-Key: <key>`, or
  - `?api_key=<key>` (for links, KML NetworkLinks and the WebSocket).

  Keys are compared in constant time.
- **Player keys.** With `--player blue:KEY`, a request carrying a player key gets
  the player role: listings and the WebSocket state show only its force and its
  contacts, events are filtered, commands are limited to its own force, and
  every exercise-control route (time, scenarios, recordings, export,
  integrations, creating or moving entities, the catalog editor, quick battles,
  civilians) answers **403**. The routes a player may use are the object,
  task, plan, drive, explain, graphics, events, terrain (with viewshed) and
  catalog reading routes, plus orders, alerts, codewords and their own force's
  synchronization matrix and (rule-based) commander.
- **OpenID Connect.** With `--oidc-issuer`, browsers sign in with your identity
  provider and get an HttpOnly, SameSite=Lax session cookie, accepted on `/api`,
  `/ws` and `/mcp` with the role their claims map to (see
  [Deployment](../deployment.md#sign-in-with-openid-connect)). API keys still work.
- **JSON-only writes.** Requiring `Content-Type: application/json` on `POST`/`PUT`
  means a web page on another origin can only send them after a CORS preflight,
  which is refused unless you allowed that origin with `--cors`.
- **WebSocket origin.** Browser connections from other origins are refused unless
  allowed with `--cors`.
- If you expose the server (`--host 0.0.0.0`), set an API key, and put it behind
  TLS (a reverse proxy) when it leaves a trusted network.
