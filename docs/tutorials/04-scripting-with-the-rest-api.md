# Tutorial 4: Scripting with the REST API

**Time:** 20 minutes · **You will learn:**

- driving the simulation from the command line, Node.js and Python;
- terrain queries;
- stepping time;
- polling events.

Everything in the GUI is available over HTTP under `/api/v1`. The full reference
is at **http://127.0.0.1:8080/api/docs** on a running server.

Start a server first:

```bash
npm start
```

## 1. curl basics

```bash
H='Content-Type: application/json'
API=http://127.0.0.1:8080/api/v1

curl -s $API/simulation
```

The response describes the scenario:

```json
{
  "scenario": "Untitled",
  "description": "",
  "time": 0,
  "running": false,
  "timeScale": 1,
  "load": 0,
  "strength": [],
  "entities": 0,
  "units": 0,
  "graphics": 0,
  "terrain": {
    "size": 16000,
    "origin": { "lat": 50.75, "lon": 9.9 },
    "note": "Local coordinates are metres: x east, y north, from the south-west corner (0,0) to (size,size).",
    "towns": [ { "name": "Alderford", "x": 1849, "y": 14485 }, { "name": "Brenham", "x": 13791, "y": 6777 }, "…" ]
  },
  "environment": { "localTime": "12:00", "period": "day", "light": 1, "visibility": 20000, "precipitation": "none" },
  "dis": { "enabled": false },
  "lastEventSeq": 1
}
```

Two rules apply to every request:

- **POST and PUT need `-H 'Content-Type: application/json'`.** The server refuses
  them otherwise (415). This blocks other web pages from posting to your
  simulation.
- **Positions** can be `{"x":…, "y":…}` in metres, `{"lat":…, "lon":…}`, or
  `{"town": "Name"}`.

Create forces and give an order:

```bash
curl -s -H "$H" $API/units -d '{"templateId":"us-tank-platoon","force":1,"position":{"town":"Eastwick"},"name":"Blue Armor"}'
curl -s -H "$H" $API/units -d '{"templateId":"ru-mech-platoon","force":2,"position":{"town":"Brenham"},"name":"Red Mech"}'
curl -s -H "$H" $API/units/U1/task -d '{"type":"moveTo","target":{"town":"Brenham"}}'
```

Advance 15 minutes immediately. The call returns when the time has been
simulated, which takes well under a second:

```bash
curl -s -H "$H" $API/simulation/step -d '{"seconds":900}'
```

See what happened:

```bash
curl -s "$API/events?kinds=destroyed,damaged"
curl -s "$API/entities?alive=true"
```

The GUI updates live while you do this. Open it beside the terminal.

### Running instead of stepping

| Call | Effect |
| --- | --- |
| `POST /simulation/run` | runs in real time |
| `PUT /simulation/time-scale` with `{"scale": 8}` | sets the speed |
| `POST /simulation/pause` | pauses |
| `POST /simulation/step` | advances immediately. Best for scripts and batch work |

## 2. Querying the terrain

```bash
curl -s "$API/terrain/point?town=Calloway"
# {"x":7590,"y":13468,"lat":50.87…,"lon":10.007…,"elevation":172.5,"water":false,"forest":false,"road":true,"slopeDeg":…,"nearestTown":"Calloway"}

curl -s -H "$H" $API/terrain/line-of-sight -d '{"from":{"town":"Calloway"},"to":{"town":"Fallow Cross"}}'
# {"visible":false,"distance":3735,…}

curl -s -H "$H" $API/terrain/route -d '{"from":{"town":"Calloway"},"to":{"town":"Fallow Cross"},"domain":"ground"}'
# {"waypoints":[…13 points…],"length":4114}
```

Line-of-sight endpoints can also be entity ids: `{"from":"E1","to":"E5"}` uses
their sensor positions.

## 3. A Node.js script

[`examples/rest-client.mjs`](../../examples/rest-client.mjs) is a complete script
(Node 20+, no dependencies). It:

1. starts a new scenario and creates a Blue tank platoon at Eastwick and a Red
   mech platoon at Brenham;
2. draws a *Staging* point 3 km short of Brenham;
3. gives Blue a plan: column, return fire → move to staging → wedge, fire at
   will → wait 30 s → assault Brenham;
4. steps one minute at a time and prints kills, damage and task events as they
   happen.

```bash
node examples/rest-client.mjs
```

Output (the simulation is deterministic, so the same version gives the same result every time):

```
Terrain 16 km square; towns: Alderford, Brenham, Calloway, Dunmore, Eastwick, Fallow Cross, Greystone
Created Blue Armor (U1, 4 tanks) and Red Mech (U2, 3 BMPs)
  00:06:57  Red Mech 3 destroyed by Blue Armor Lead
  00:07:03  Red Mech 2 destroyed by Blue Armor 3
  00:07:06  Red Mech Lead destroyed by Blue Armor Lead
  00:07:51  Blue Armor: plan Seize Brenham complete

After 00:08:00: Blue 4/4, Red 0/3
```

Its `api()` helper is all you need to start your own client:

```js
async function api(method, path, body) {
  const res = await fetch(`http://127.0.0.1:8080/api/v1${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return null;
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message ?? res.status);
  return data;
}
```

## 4. A Python script

[`examples/rest_client.py`](../../examples/rest_client.py) uses only the standard
library:

```bash
python3 examples/rest_client.py
```

```
Towns: Alderford, Brenham, Calloway, Dunmore, Eastwick, Fallow Cross, Greystone
  Calloway      elevation  172.5 m  road=True  forest=False
  Fallow Cross  elevation  135.3 m  road=True  forest=False
Calloway -> Fallow Cross: masked at 3735 m
Ground route: 13 waypoints, 4.1 km
After 5 min the courier is at 50.87833, 10.05922 doing 0 km/h: arrived
GeoJSON: {"type": "Point", "coordinates": [10.059215, 50.8783344, 135.3]} a-f-G-E-V
```

## 5. Following events

Every event has an increasing `seq`. To follow the log:

1. Read `lastEventSeq` from `GET /simulation`.
2. Poll `GET /events?since=<seq>`.
3. Remember the highest `seq` you received and pass it next time.

Filter with `kinds=` (`fire`, `detonation`, `damaged`, `destroyed`, `detected`,
`task`, `created`, `deleted`, `info`, `radio`).

For push instead of polling, either:

- connect to the **`/ws`** WebSocket (the GUI's feed: a state snapshot at 10 Hz
  plus events), or
- register a **webhook** ([Tutorial 7](07-tak-webhooks-and-gis.md)).

## 6. Plans over the API

```bash
curl -s -H "$H" $API/units/U1/plan -d '{
  "name": "Bound forward",
  "statements": [
    {"kind": "setFormation", "formation": "column"},
    {"kind": "task", "task": {"type": "moveTo", "target": {"x": 12000, "y": 5000}}},
    {"kind": "waitUntil", "condition": {"type": "simTime", "time": 600}},
    {"kind": "setFormation", "formation": "line"},
    {"kind": "task", "task": {"type": "moveTo", "target": {"town": "Brenham"}}}
  ]}'
```

Invalid input gets a clear error:

```json
{"error":{"status":400,"message":"unknown task type teleport"}}
```

## 7. When the server has an API key

If the server runs with `--api-key`, add the key to every request:

```bash
curl -s -H "Authorization: Bearer $KEY" $API/simulation
WERFORCES_API_KEY=$KEY node examples/rest-client.mjs
```

## 8. Generating a typed client

The OpenAPI spec at `/api/v1/openapi.json` works with standard tooling. For
example:

```bash
npx @openapitools/openapi-generator-cli generate -i http://127.0.0.1:8080/api/v1/openapi.json -g python -o werforces-client
```

You can also import it into Postman or Insomnia to explore the API.

**Next:** [Tutorial 5: AI agents with MCP](05-ai-agents-with-mcp.md).
