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
| GET | `/simulation` | | Status: scenario, time, running, timeScale, strength per force, terrain (size, origin, towns), DIS, `lastEventSeq` |
| POST | `/simulation/run` · `/pause` · `/rewind` | | Status |
| POST | `/simulation/step` | `{"seconds": 300}` (≤ 3600) | Status after stepping immediately |
| PUT | `/simulation/time-scale` | `{"scale": 8}` | Status |

### Scenarios

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/scenario` | The current state as a [scenario file](scenario-format.md) |
| PUT | `/scenario` | Load a scenario file (the body). Rolls back if invalid |
| POST | `/scenario/new` | `{"name": "...", "terrain": {"seed": 7, "size": 12000}}` (terrain optional) |
| GET | `/scenarios` | Scenarios stored on the server |
| GET / PUT | `/scenarios/{name}` | Read one / save the current state under that name |
| POST | `/scenarios/{name}/load` | Load a stored scenario |

### Objects

| Method | Path | Body / query |
| --- | --- | --- |
| GET | `/entities` | `?force=1\|blue&domain=air&unit=U1&alive=true&remote=false` |
| POST | `/entities` | `{"typeId", "force", "position", "heading"?, "name"?, "altitude"?}` |
| GET / PATCH / DELETE | `/entities/{id}` | PATCH: `{"name"?, "roe"?, "position"?, "heading"?}` |
| POST | `/entities/{id}/task` | a [task](#tasks) |
| POST | `/entities/{id}/plan` | a [plan](#plans) |
| POST | `/entities/{id}/stop` | |
| GET | `/entities/{id}/path` | remaining planned waypoints |
| GET | `/units` | `?force=` |
| POST | `/units` | `{"templateId", "force", "position", "heading"?, "name"?}` or `{"entityIds": [...], "name"?, "formation"?}` |
| GET / PATCH / DELETE | `/units/{id}` | PATCH: `{"name"?, "formation"?, "roe"?}`. DELETE removes the members too |
| POST | `/units/{id}/task` · `/plan` · `/stop` | as for entities |
| GET / POST | `/graphics` | POST `{"kind": "route\|area\|phaseLine\|point", "points": [...], "name"?, "force"?}` |
| GET / PATCH / DELETE | `/graphics/{id}` | PATCH `{"name"?, "points"?}` |

### Tasks

```json
{"type": "moveTo", "target": {"town": "Calloway"}, "speed": 8}
{"type": "followRoute", "routeId": "G1", "reverse": false}
{"type": "patrol", "routeId": "G1"}
{"type": "wait", "duration": 60}
{"type": "follow", "targetId": "E4", "distance": 80}
{"type": "attack", "targetId": "E12"}
{"type": "orbit", "center": {"x": 8000, "y": 8000}, "radius": 2500, "duration": 600}
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
`setAltitude` (m above ground), `setFormation` (`column|line|wedge|vee|echelonRight`).
Conditions: `simTime {time}`, `inArea {areaId}`, `enemyDetected`, `underFire`,
`entityDestroyed {entityId}`. Semantics are described in [Concepts](../concepts.md#plans).

### Events, terrain, catalog

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/events` | `?since=<seq>&kinds=destroyed,damaged&limit=200`. Keep the highest `seq` you have seen and pass it as `since` to poll |
| GET | `/terrain` | spec, towns, road polylines |
| GET | `/terrain/point` | `?x=&y=` / `?lat=&lon=` / `?town=` → elevation, water, forest, road, slope, nearest town |
| POST | `/terrain/line-of-sight` | `{"from": "E1" or position, "to": ...}`. Positions take an optional `height` above ground (default 2 m) |
| POST | `/terrain/route` | `{"from", "to", "domain": "ground\|lifeform\|surface\|air"}` → waypoints and length |
| GET | `/catalog` · `/catalog/entity-types` · `/catalog/unit-templates` | see the [catalog](catalog.md) |

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
- **JSON-only writes.** Requiring `Content-Type: application/json` on `POST`/`PUT`
  means a web page on another origin can only send them after a CORS preflight,
  which is refused unless you allowed that origin with `--cors`.
- **WebSocket origin.** Browser connections from other origins are refused unless
  allowed with `--cors`.
- If you expose the server (`--host 0.0.0.0`), set an API key, and put it behind
  TLS (a reverse proxy) when it leaves a trusted network.
