# WeRForces

WeRForces is an open computer-generated forces (CGF) simulator, modelled on the
architecture and workflow of MAK's **VR-Forces**. It has a simulation back-end, a
browser-based scenario editor and monitoring front-end, entity and unit models with
tasks and plans, sensors, direct and guided fire with damage adjudication, and
**DIS (IEEE 1278.1)** networking, so other DIS simulations can see and engage its
entities.

> VR-Forces is a product of MAK Technologies. WeRForces is an independent
> project, not affiliated with or derived from MAK's software. It reimplements
> the general CGF concepts from public descriptions.

![Calloway Crossroads scenario](docs/screenshot.png)

## Quick start

```bash
npm install
npm run build
npm start -- --scenario calloway-crossroads      # http://127.0.0.1:8080
```

Open the URL, press **Space** (or ▶ Run), and set the time multiplier to 8–16×.

Useful options (`npm start -- --help` lists all of them):

| Option | Meaning |
| --- | --- |
| `-s, --scenario <file\|name>` | Load a scenario JSON file, or a name from `./scenarios` |
| `-p, --port`, `--host` | HTTP/WebSocket port (8080) and interface (127.0.0.1) |
| `--run`, `--time-scale <x>` | Start running immediately, at a time multiplier |
| `--dis` | Enable DIS over UDP |
| `--dis-port`, `--dis-address` | UDP port (3000) and destination: broadcast, multicast group or unicast host |
| `--exercise`, `--site`, `--application` | DIS exercise and simulation address |
| `--headless [--duration <s>]` | No GUI. With `--duration`, runs as fast as possible and prints the event log and losses |

## VR-Forces concepts mapped to WeRForces

| VR-Forces concept | WeRForces |
| --- | --- |
| Simulation engine (back-end) | `src/sim/engine.ts`: fixed-step (0.1 s) deterministic engine with seeded RNG |
| Front-end GUI / scenario editor | `web/`: 2D tactical map, palette, object tree, inspector, plan editor, event log |
| Simulation Object Model (entity, weapon and sensor parameters) | `src/sim/catalog.ts`: 20 entity types, 22 weapons, 8 sensors, 12 unit templates |
| Terrain database | `src/sim/terrain.ts`: procedural elevation, lakes, forest, towns and roads, plus LOS, mobility and route planning |
| Tasks | Move to, Follow route, Patrol, Wait, Follow entity, Attack, Orbit, plus internal formation keeping |
| Plans | Ordered statements: tasks, set ROE/speed/altitude/formation, *wait until* (time, in area, enemy detected, under fire, entity destroyed), optional loop |
| Reactive behaviour / ROE | Fire at will, Return fire, Hold fire. Automatic target and weapon selection |
| Units / aggregates | Leader + followers in column, line, wedge, vee and echelon formations. Unit tasking, contact sharing and leader succession. Aggregated symbols when zoomed out |
| Tactical graphics | Routes, areas, phase lines, points |
| Sensors / perception | Range, field of view, terrain and forest-canopy line of sight, probabilistic detection. Per-entity contact lists shared within a unit |
| Weapons & damage | Munition fly-out, range/motion/concealment-modified Pk, mobility, firepower and catastrophic kills |
| Remote Control API | REST + WebSocket commands (`src/server/commands.ts`) |
| Network interoperability (VR-Link) | DIS gateway (`src/dis/`): Entity State, Fire and Detonation PDUs, dead reckoning, heartbeats, remote entity reflection |
| Rewind / save / load | Rewind to scenario start; save to the server or download; import a file |
| Batch / headless runs | `--headless --duration <s>` |

## Using the GUI

- **Create**: choose a force, pick an entity or unit template, and click the map to
  place it. Shift+click keeps placing. Esc cancels.
- **Select**: left-click a symbol, or use the **Objects** tree. Double-click a tree
  item to centre on it.
- **Task**: right-click the map with something selected to get *Move here*,
  *Attack*, *Follow*, *Follow/Patrol route* (right-click a route) and *Orbit
  here* (aircraft). The inspector has the same tasks as buttons.
- **Plan**: build a plan in the inspector's plan editor and press *Assign plan*.
  The plan's current step shows under *Current activity*.
- **Draw** routes, areas, phase lines and points from the toolbar. Click to add
  points; double-click, Enter or right-click finishes.
- **Alt+drag** repositions an entity. The mouse wheel zooms; dragging pans.
- **Layers**: labels, grid, sensor contacts (yellow lines; red = engaging),
  weapon and sensor range rings, planned paths, and unit aggregation.
- Keys: **Space** run/pause, **F** centre on the selection, **Delete** remove it.

## Architecture

```
            browser (web/)                          other DIS simulations
   map · palette · inspector · plan editor           (VR-Forces, VBS, ...)
                 │  WebSocket /ws (state 10 Hz, events)        ▲ UDP 3000
                 │  REST /api/*                                │
        ┌────────▼───────────────────────────────┐   ┌─────────┴─────────┐
        │ SimServer (src/server/server.ts)        │   │ DisGateway        │
        │ commands.ts: validated remote control   │   │ src/dis/gateway.ts│
        └────────┬───────────────────────────────┘   └─────────▲─────────┘
                 │ SimRunner: real time, pause, time scale       │ hooks
        ┌────────▼─────────────────────────────────────────────────────────┐
        │ Engine (src/sim/engine.ts)                                        │
        │  units → plans → tasks → movement → sensors → combat → impacts    │
        │  terrain · catalog · entities · units · graphics · event log      │
        └───────────────────────────────────────────────────────────────────┘
```

Each 0.1 s step runs, in order: unit leader succession, unit and entity plans,
tasks (which produce steering commands), kinematics, sensor scans (1 Hz, staggered),
weapon selection and firing, then munition impacts.

### Models

- **Movement.** Ground vehicles turn and accelerate within their type's limits.
  Speed depends on road vs. off-road, forest and slope; water and steep slopes are
  impassable. Dismounts are slower but less affected by forest. Boats stay on
  water. Aircraft follow the terrain at a commanded height above ground, using
  look-ahead and climb-rate limits, and fixed-wing aircraft cannot drop below
  minimum speed.
- **Route planning.** Ground and sea routes come from A* over the terrain grid,
  minimising travel time, so vehicles use roads where they can. Routes are
  smoothed by string pulling and replanned when a vehicle gets blocked.
- **Sensors.** Each sensor has a range, a field of view and the domains it can
  detect. Ground observers' line of sight is blocked by terrain and by a 15 m
  forest canopy. Detection probability falls with range. Forest and dismounted
  targets are harder to see; moving or recently-firing targets are easier.
- **Combat.** Pk depends on the weapon against the target's armour class, then on
  range, shooter motion (unguided rounds), target speed and concealment. Rounds
  take flight time to arrive. A hit rolls for a catastrophic kill, otherwise a
  mobility or firepower kill; losing both counts as destroyed. Damage to remote
  (DIS) entities is left to the simulation that owns them.

## DIS interoperability

- PDUs: **Entity State** (1), **Fire** (2), **Detonation** (3). Protocol version 7
  is sent; versions 4–7 are accepted.
- Coordinates: the local flat frame maps to WGS-84 geodetic coordinates and then
  to geocentric (ECEF) positions. Orientation uses DIS ψ/θ/φ Euler angles relative
  to ECEF, and velocity is sent in ECEF.
- Publishing: an Entity State PDU goes out when the dead-reckoned position
  drifts by more than 1 m, orientation changes by more than 3°, appearance
  (damage, smoke, flames) changes, or the 5 s heartbeat expires. Paused
  simulations send zero velocity. Deleted entities are sent once with the
  *deactivated* appearance bit.
- Receiving: remote entities are matched to the closest catalog type by DIS
  enumeration, dead-reckoned (FPW/FVW/RVW) and timed out after 12 s. They can be
  detected and engaged. Detonations aimed at local entities are adjudicated
  locally.
- Try it with two instances on one machine:

  ```bash
  npm start -- -s calloway-crossroads --dis --dis-address 127.255.255.255
  npm start -- -s lakeside-patrol --dis --dis-address 127.255.255.255 --site 2 --port 8081 --run
  ```

  Each instance shows the other's entities with dashed, yellow-outlined symbols.

DIS entity enumerations in the catalog follow the SISO-REF-010 layout but are
representative. Check them against current SISO enumerations before you join
a real federation.

## Remote control API

Every GUI action is a command. Send one to `POST /api/command`, or as
`{"type":"command","reqId":1,"command":{...}}` over the `/ws` WebSocket.

```bash
curl -s localhost:8080/api/command -d '{"cmd":"createUnit","templateId":"us-tank-platoon","force":1,"x":5000,"y":5000}'
curl -s localhost:8080/api/command -d '{"cmd":"assignTask","targetId":"U1","task":{"type":"moveTo","target":{"x":7000,"y":9000}}}'
curl -s localhost:8080/api/command -d '{"cmd":"run"}'
curl -s localhost:8080/api/state | head -c 400
```

Commands: `run`, `pause`, `step`, `setTimeScale`, `rewind`, `newScenario`,
`loadScenario`, `createEntity`, `createUnit`, `groupUnit`, `deleteObject`,
`moveEntity`, `assignTask`, `assignPlan`, `stop`, `setRoe`, `setFormation`,
`rename`, `createGraphic`, `updateGraphic`. Types are in `src/shared/types.ts`.

Read endpoints: `GET /api/state`, `/api/catalog`, `/api/terrain`,
`/api/events?since=N`, `/api/scenario` (current state as a scenario file),
`/api/path/<entityId>`, `/api/scenarios`, and `/api/scenarios/<name>`.
`PUT /api/scenarios/<name>` saves the current state to `scenarios/<name>.json`.

The server has no authentication and listens on 127.0.0.1 by default. Only use
`--host 0.0.0.0` on a trusted network.

## Scenarios

Scenarios are JSON (`format: "werforces-scenario"`). Each one holds the terrain
spec (seed, size, origin lat/lon, water and forest fractions), hostilities,
entities, units, tactical graphics, and each object's assigned task or plan. The
samples in `scenarios/` are generated by `npm run scenarios`
(`scripts/make-scenarios.ts`):

- **Calloway Crossroads**: a combined-arms advance to seize a defended town, with
  Apaches, an SA-8, a supply convoy, F-16 CAP and civilian traffic.
- **Lakeside Patrol**: patrol boats, a rifle squad and a Stinger team against a
  recon patrol and a Hind.

Headless batch run:

```bash
npm start -- -s calloway-crossroads --headless --duration 3000
```

## Development

```bash
npm run dev        # build the web bundle and run the server from TypeScript sources
npm run typecheck
npm test           # vitest: geodesy, PDUs, gateway, terrain, tasks, units, plans, combat, API
npm run check      # typecheck + tests + build
```

```
src/shared   types and helpers shared by the server and browser
src/sim      engine, terrain, catalog, entities, tasks, plans, units, sensors, combat
src/dis      geodesy, PDU codecs, UDP gateway
src/server   real-time runner, command dispatcher, HTTP/WebSocket server, CLI
web          front-end (bundled with esbuild into dist/web)
scenarios    sample scenarios
test         unit and integration tests
```

## Not yet implemented

HLA/RPR-FOM (the gateway is the natural place to add an HLA binding), a 3D view,
indirect fire and artillery missions, simulated radio communications, scripted
behaviours (e.g. Lua), importing real terrain (GeoTIFF/OpenFlight/CDB),
record/playback and checkpoints, and multiple back-ends sharing the load.
