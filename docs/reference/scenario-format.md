# Scenario file format

A scenario is a JSON document. You get one from:

- **File → Export to file**;
- `GET /api/v1/scenario`;
- the `scenarios/` folder.

Load it with **File → Import from file…**, `PUT /api/v1/scenario`, or
`--scenario`. Saving captures the **current** state: positions, assigned tasks
and plans, ROE and graphics. Destroyed entities are left out.

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
  "graphics": [ ... ]
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
  "plan": { ... },
  "task": { ... }
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
  "plan": { ... }
}
```

The first member is the initial leader. `echelon` is one of `team`, `section`,
`platoon`, `company`, `flight` or `group`, and only affects the symbol. Members
must be listed in `entities` and share the unit's force.

## `graphics[]`

```json
{ "id": "G1", "kind": "route", "name": "Route IRON", "force": 1, "points": [{"x": 10266, "y": 4289}, {"x": 10500, "y": 5200}] }
```

`kind` is `route` (two or more points), `area` (three or more), `phaseLine`
(two or more) or `point` (one).

## Tasks and plans

These use the same JSON as the REST API: see
[REST API → Tasks](rest-api.md#tasks) and [Plans](rest-api.md#plans). In files,
positions must be `{x, y}`. The `{town}` and `{lat, lon}` shortcuts only work
through the API.

## Generating scenarios with code

`scripts/make-scenarios.ts` builds the bundled scenarios with the engine API,
using towns and road routes from the generated terrain, then calls
`engine.toScenario()`. Copy it as a starting point for your own generators.
