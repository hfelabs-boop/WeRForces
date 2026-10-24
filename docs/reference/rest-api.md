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
| GET / PUT | `/simulation/rules` | `{"suppression": true, "morale": true, "fuel": true, "orderDelay": false}` (any subset) | The rules ([optional models](../concepts.md#optional-models)) |
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

### Objects

| Method | Path | Body / query |
| --- | --- | --- |
| GET | `/entities` | `?force=1\|blue&domain=air&unit=U1&alive=true&remote=false` |
| POST | `/entities` | `{"typeId", "force", "position", "heading"?, "name"?, "altitude"?}` |
| GET / PATCH / DELETE | `/entities/{id}` | PATCH: `{"name"?, "roe"?, "reactions"?, "position"?, "heading"?}` |
| POST | `/entities/{id}/task` | a [task](#tasks) |
| POST | `/entities/{id}/plan` | a [plan](#plans) |
| POST | `/entities/{id}/stop` | |
| POST | `/entities/{id}/embark` | `{"carrierId": "E4"}` or a carrier unit id: put this soldier inside now (scenario set-up) |
| POST | `/entities/{id}/disembark` | let this carrier's passengers out now |
| GET | `/entities/{id}/path` | remaining planned waypoints |
| GET | `/units` | `?force=` |
| POST | `/units` | `{"templateId", "force", "position", "heading"?, "name"?}` or `{"entityIds": [...], "name"?, "formation"?}` |
| GET / PATCH / DELETE | `/units/{id}` | PATCH: `{"name"?, "formation"?, "roe"?, "reactions"?, "superiorId"?}` (`superiorId`: put under another unit, `null` for none). DELETE removes the members too; its subordinates become independent |
| POST | `/units/{id}/task` · `/plan` · `/stop` · `/embark` · `/disembark` | as for entities. A unit embarking into a carrier unit shares out the seats |
| GET / POST | `/graphics` | POST `{"kind": "route\|area\|phaseLine\|point\|minefield\|obstacle", "points": [...], "name"?, "force"?, "density"?}` (`density`: minefields, strikes per 100 m) |
| GET / PATCH / DELETE | `/graphics/{id}` | PATCH `{"name"?, "points"?, "density"?}` |

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
```

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
Conditions: `simTime {time}`, `inArea {areaId}`, `enemyInArea {areaId}`,
`enemyDetected`, `underFire`, `strengthBelow {fraction}`, `fuelBelow {fraction}`,
`ammoBelow {fraction}`, `entityDestroyed {entityId}`.
Semantics are described in [Concepts](../concepts.md#plans).

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
| GET | `/terrain` | spec, towns, road polylines |
| GET | `/terrain/point` | `?x=&y=` / `?lat=&lon=` / `?town=` → elevation, water, forest, road, slope, nearest town |
| POST | `/terrain/line-of-sight` | `{"from": "E1" or position, "to": ...}`. Positions take an optional `height` above ground (default 2 m) |
| POST | `/terrain/route` | `{"from", "to", "domain": "ground\|lifeform\|surface\|air", "force"?, "covered"?}` → waypoints and length. With `force`, round obstacles and the minefields it knows; with `covered` too, out of sight of the enemies it knows |
| GET | `/catalog` · `/catalog/entity-types` · `/catalog/unit-templates` | see the [catalog](catalog.md) |
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
- `GET /api/terrain` returns the terrain grid (base64);
- `GET /api/path/{id}`;
- `POST /api/command` takes a command object (see `Command` in
  `src/shared/types.ts`);
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
  integrations, creating or moving entities) answers **403**. The routes a
  player may use are the object, task, plan, graphics, events, terrain and
  catalog routes.
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
