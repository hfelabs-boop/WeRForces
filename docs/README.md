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

## Guides

- [User guide](user-guide.md): every part of the GUI (2D map, 3D view, panels,
  menus, keyboard).
- [Concepts](concepts.md): coordinates, forces, entities and units, tasks and
  plans, sensors, combat and damage, and time.
- [Architecture](architecture.md): how the code is organised, the simulation
  loop, and how to add features.
- [FAQ and troubleshooting](faq.md)

## Reference

- [Command line](reference/cli.md)
- [REST API](reference/rest-api.md) (the full interactive reference is at
  `/api/docs` on a running server)
- [MCP tools](reference/mcp-tools.md) *(generated)*
- [Catalog: entity types, weapons, sensors, unit templates](reference/catalog.md) *(generated)*
- [Scenario file format](reference/scenario-format.md)
- [DIS](reference/dis.md)
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
