# WeRForces documentation

WeRForces is a computer-generated forces (CGF) simulator. You build a scenario by
placing forces on terrain and giving them tasks and plans. The simulation then
moves them, lets them detect each other, and fights the engagements out. You can
watch and steer it in a 2D/3D editor, from scripts, from AI agents over MCP, and
from other simulations over DIS.

These pages are also served by a running server at **`/docs`** (toolbar → **Help**).

## Start here

- [Getting started](getting-started.md): install, run, and open the first scenario.
- [Tutorial 1: Your first engagement](tutorials/01-first-engagement.md): place two
  tank platoons and fight them out in ten minutes.

## Tutorials

| # | Tutorial | You will learn |
| --- | --- | --- |
| 1 | [Your first engagement](tutorials/01-first-engagement.md) | Placing units, moving them, running time, reading the event log |
| 2 | [Routes, plans and conditions](tutorials/02-routes-plans-and-conditions.md) | Drawing routes and areas, multi-step plans, *wait until* triggers, formations and ROE |
| 3 | [Building and sharing a scenario](tutorials/03-building-a-scenario.md) | New terrain, saving, exporting, rewinding, the scenario file |
| 4 | [Scripting with the REST API](tutorials/04-scripting-with-the-rest-api.md) | curl, Node.js and Python clients; terrain queries; stepping time |
| 5 | [AI agents with MCP](tutorials/05-ai-agents-with-mcp.md) | Connecting Claude (or any MCP client) and commanding forces in plain language |
| 6 | [DIS interoperability](tutorials/06-dis-interoperability.md) | Federating two WeRForces instances or another DIS simulation |
| 7 | [TAK, webhooks and GIS](tutorials/07-tak-webhooks-and-gis.md) | Feeding ATAK/TAK Server, Slack/Discord and QGIS/Google Earth |
| 8 | [Batch runs and Monte Carlo analysis](tutorials/08-batch-and-monte-carlo.md) | Headless runs, using the engine as a library, comparing courses of action |
| 9 | [Extending the catalog](tutorials/09-extending-the-catalog.md) | Adding entity types, weapons, sensors and unit templates |
| 10 | [Fire support and mechanized infantry](tutorials/10-fire-support-and-mech-infantry.md) | Observers and call for fire, fire missions, carrying and dismounting infantry, halt on contact |
| 11 | [Exercise control, players and the AAR](tutorials/11-exercise-control-and-aar.md) | Fog of war with player keys, replaying a run, bookmarks, the after-action report |
| 12 | [Real terrain](tutorials/12-real-terrain.md) | Importing a real DEM and map features, terrain queries on real ground |
| 13 | [Obstacles, smoke and breaching](tutorials/13-obstacles-smoke-and-breaching.md) | Minefields and obstacle lines, finding mines, breaching lanes with engineers, smoke screens |
| 14 | [Night, weather and supply](tutorials/14-night-weather-and-supply.md) | Time of day and weather, night vision and thermals, muzzle flashes, fuel, resupply |
| 15 | [Command, tactics and analysis](tutorials/15-command-tactics-and-analysis.md) | Companies and the chain of command, defend and other tactical tasks, order delay, group orders, undo, batch statistics, AAR export |
| 16 | [Quick battle and command tools](tutorials/16-quick-battle-and-command-tools.md) | The quick battle wizard, the synchronization matrix and codewords, typed orders, travel estimates, *Why?* and alerts, viewsheds, jammers, driving a vehicle |

## Guides

- [User guide](user-guide.md): every part of the GUI (2D map, 3D view, panels,
  menus, keyboard).
- [Concepts](concepts.md): coordinates, terrain, forces, entities and units,
  the chain of command, tasks and plans (with if/else, loops and codewords),
  synchronization matrices, sensors, combat and damage, suppression and morale,
  night and weather, obstacles, supply, electronic warfare, civilians,
  explanations and alerts, travel estimates, and time.
- [Terrain import](terrain-import.md): real elevation data, map features,
  buildings and land cover.
- [Deployment](deployment.md): Docker, HTTPS, exercise-control and player keys,
  OpenID Connect sign-in, several sessions, sizing.
- [HLA](hla.md): the HLA 1516e bridge federate.
- [Architecture](architecture.md): how the code is organised, the simulation
  loop, and how to add features.
- [FAQ and troubleshooting](faq.md)
- [Roadmap](roadmap.md): where the project is going, release by release, with acceptance tests

## Reference

- [Command line](reference/cli.md)
- [REST API](reference/rest-api.md) (the full interactive reference is at
  `/api/docs` on a running server)
- [MCP tools](reference/mcp-tools.md) *(generated)*
- [Catalog: entity types, weapons, sensors, unit templates](reference/catalog.md) *(generated)*
- [Scenario file format](reference/scenario-format.md)
- [DIS](reference/dis.md): entity state, fire, detonation, radio, emissions and simulation management
- [DIS conformance matrix](reference/dis-conformance.md): every DIS 7 PDU type, fields, deviations and the tests that cross-check it against an independent implementation
- [Integrations: CoT, webhooks, GIS](reference/integrations.md)

## Examples

Runnable scripts in [`examples/`](../examples):

| File | What it shows |
| --- | --- |
| `rest-client.mjs` | Node.js: set up an engagement, give a plan, step time, print events |
| `rest_client.py` | Python (standard library only): terrain queries, route planning, tasking, GeoJSON |
| `monte-carlo.ts` | The engine as a library: many replications, loss statistics |
| `custom-catalog.ts` | Adding a new tank, gun and unit template without editing the source |
| `webhook-receiver.mjs` | Receiving webhooks and verifying their signature |
| `cot-listener.mjs` | Printing Cursor-on-Target traffic without an ATAK device |
| `combined-arms.mjs` | Artillery with a forward observer, a mechanized platoon carrying a rifle squad, and the AAR report ([Tutorial 10](tutorials/10-fire-support-and-mech-infantry.md)) |
| `fulda-overlay.geojson` | A hand-drawn map feature overlay for terrain import ([Tutorial 12](tutorials/12-real-terrain.md)) |
