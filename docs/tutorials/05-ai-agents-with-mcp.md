# Tutorial 5: AI agents with MCP

**Time:** 15 minutes · **You will learn:** connecting Claude (or any MCP client)
to WeRForces, and what the agent can do with it.

WeRForces is a **Model Context Protocol (MCP)** server. An AI agent connected
to it can:

- read the situation;
- create forces;
- issue tasks and plans;
- run the clock and report what happened.

You can then work with the simulation in plain language, for example:

> *"Put a US tank platoon at Eastwick and a Russian mech platoon in Brenham.
> Send the tanks to Brenham, run 15 minutes and tell me how it went."*

## 1. Start WeRForces

```bash
npm run build
npm start
```

The MCP endpoint is **`http://127.0.0.1:8080/mcp`**. It uses the *streamable
HTTP* transport.

## 2a. Connect Claude Code

```bash
claude mcp add --transport http werforces http://127.0.0.1:8080/mcp
```

If the server runs with `--api-key`:

```bash
claude mcp add --transport http werforces http://127.0.0.1:8080/mcp --header "Authorization: Bearer <key>"
```

Start `claude` and check with `/mcp` that **werforces** is connected.

## 2b. Connect Claude Desktop (or another stdio client)

Desktop clients usually launch MCP servers as local processes. Use the **stdio
bridge**, which forwards to the running server. Add this to
`claude_desktop_config.json`:

- macOS: `~/Library/Application Support/Claude/`
- Windows: `%APPDATA%\Claude\`

```json
{
  "mcpServers": {
    "werforces": {
      "command": "node",
      "args": ["/absolute/path/to/WeRForces/dist/mcp/stdio.js", "--url", "http://127.0.0.1:8080"]
    }
  }
}
```

Add `"--api-key", "<key>"` to `args` if needed, then restart Claude Desktop. The
**Integrations** dialog in the WeRForces GUI shows both snippets with your
server's address filled in.

## 2c. Explore without an AI: MCP Inspector

```bash
npx @modelcontextprotocol/inspector
```

Choose transport **Streamable HTTP**, URL `http://127.0.0.1:8080/mcp`, and
connect. You can list the tools and call them by hand.

## 3. The tools

| Purpose | Tools |
| --- | --- |
| Awareness | `get_situation`, `list_entities`, `get_entity`, `get_unit`, `list_catalog`, `get_events`, `query_terrain`, `check_line_of_sight`, `viewshed`, `explain` (why something is or is not moving, firing or seeing), `get_alerts` (what needs attention) |
| Creation | `create_entity`, `create_unit`, `create_graphic`, `delete_object`, `quick_battle` (a generated, ready-to-run battle), `set_pattern_of_life` (civilian traffic), `edit_catalog` |
| Tasking | `assign_task`, `assign_plan`, `give_order` (an order in plain words, e.g. *"Team ARMOR move to Calloway covered"*), `embark`, `stop`, `set_roe`, `set_reactions`, `set_unit_superior`, `set_jamming` |
| Phases | `set_sync_matrix` (a force's plan in phases), `start_phase`, `send_codeword` |
| Time and conditions | `control_simulation` (run/pause/rewind/speed), `advance_time` (simulate *N* seconds now and summarise), `set_environment` (time of day, weather), `set_simulation_rules` (suppression, morale, fuel, order delay on/off) |
| Review and analysis | `after_action_report`, `replay_state`, `add_bookmark`, `run_batch` (Monte Carlo replications on the server) |
| Scenarios | `manage_scenario` (list/load/save/new) |

Parameters are documented in the [MCP tools reference](../reference/mcp-tools.md).
When it connects, the server tells the agent about coordinates, force numbers,
and to start with `get_situation`.

## 4. What a session looks like

Below are the actual tool calls an agent makes for the request at the top of
this page, with the results WeRForces returned (trimmed). The GUI shows every
change live, so keep it open while the agent works.

**`manage_scenario {"action": "new", "name": "MCP demo"}`** starts clean, and
returns the terrain and towns:

```json
{ "scenario": "MCP demo", "time": 0,
  "terrain": { "size": 16000, "origin": { "lat": 50.75, "lon": 9.9 },
    "towns": [ { "name": "Alderford", "x": 1849, "y": 14485 }, { "name": "Brenham", "x": 13791, "y": 6777 },
               { "name": "Calloway", "x": 7590, "y": 13468 }, { "name": "Eastwick", "x": 10866, "y": 3389 }, … ] } }
```

**`create_unit {"templateId": "us-tank-platoon", "force": 1, "position": {"town": "Eastwick"}, "name": "Blue Armor"}`**

```json
{ "id": "U1", "name": "Blue Armor", "members": [
  { "id": "E1", "name": "Blue Armor Lead", "type": "us-m1a2", "force": 1, "unit": "U1", "x": 10866, "y": 3389,
    "lat": 50.7804647, "lon": 10.0539655, "heading": 0, "kmh": 0, "damage": "none" },
  { "id": "E2", "name": "Blue Armor 2", …, "task": "In formation on Blue Armor Lead" }, … ] }
```

**`create_unit {"templateId": "ru-mech-platoon", "force": 2, "position": {"town": "Brenham"}, "name": "Red Mech"}`**
returns U2 with three BMP-2s.

**`check_line_of_sight {"from": {"town": "Eastwick"}, "to": {"town": "Brenham"}}`**: an agent can reason about terrain before acting.

```json
{ "visible": false, "distance": 4477, "from": { "x": 10866, "y": 3389, "z": 66.7… }, "to": { "x": 13791, "y": 6777, "z": 160.3… } }
```

**`assign_task {"targetId": "U1", "type": "moveTo", "to": {"town": "Brenham"}}`**

```
Blue Armor: Move to (13791, 6777)
```

**`advance_time {"seconds": 900}`**

```json
{
  "time": "00:15:00",
  "strength": [ { "force": 1, "name": "Blue", "total": 4, "alive": 4 }, { "force": 2, "name": "Red", "total": 3, "alive": 0 } ],
  "shotsFired": 7,
  "events": [
    "00:06:20 [damaged] Red Mech 3 suffered a mobility kill",
    "00:06:20 [info] Blue Armor Lead fired smoke grenades",
    "00:06:24 [info] Blue Armor Lead fired smoke grenades",
    "00:06:26 [destroyed] Red Mech 2 destroyed by Blue Armor 3",
    "00:06:27 [destroyed] Red Mech 3 destroyed by Blue Armor Lead",
    "00:06:28 [info] Red Mech broke and is falling back",
    "00:06:34 [damaged] Red Mech Lead suffered a mobility kill",
    "00:06:34 [destroyed] Red Mech Lead destroyed by Blue Armor Lead"
  ]
}
```

From this the agent can write a report like: *"Blue took Brenham without
loss; all three BMPs were destroyed in fourteen seconds. Contact came at about
6:20, under 500 m from the town, as the tanks drove in. The lead tank hit
first; when two BMPs fired their wire-guided ATGMs at it, it screened itself
with smoke grenades and both missiles lost guidance. After losing two vehicles the Red platoon broke
and tried to fall back, but its last BMP was immobilised and destroyed."* It
can then offer to replay with a different approach, e.g. stopping in overwatch
before the town instead of driving into it. Rewind returns to the state last
loaded or saved, which here is the empty scenario from `manage_scenario new`,
so the agent should save once the forces are placed
(`manage_scenario {"action":"save","name":"mcp-demo"}`) before `advance_time`.
Then it can replay with `control_simulation {"action":"rewind"}` and
`assign_plan`.

## 5. Prompts to try

- *"What's the situation? Summarise each side's strength and what every unit is doing."*
- *"Is there line of sight from Calloway to Fallow Cross? If not, find a hill
  near Calloway that can see Fallow Cross."* The agent will call
  `query_terrain` and `check_line_of_sight` repeatedly.
- *"Load calloway-crossroads, advance 30 minutes, and tell me which Red units
  survived and why."*
- *"Give Team MECH a plan: wait until enemy detected, then attack the nearest
  enemy vehicle."*
- *"Set up a convoy ambush like Tutorial 2 and test three different ambush
  positions, reporting losses for each."* The agent will rewind between runs.
- *"Draw a route for the Red recon patrol along the river and have it patrol."*

## 6. Good practice

- **Keep the GUI open.** You can see what the agent does and correct it by hand.
- **`advance_time` is deterministic.** Rewinding and replaying gives the same
  result, which makes comparisons fair. Change positions or plans, not luck.
- **Read access is safe; writes change the scenario.** `delete_object` is
  marked destructive, and MCP clients usually ask before running such tools.
  Save first (`manage_scenario {"action":"save","name":"backup"}`) before
  letting an agent experiment.
- **Use an API key** if the server is reachable from other machines (`--api-key`
  plus the `--header` / `--api-key` options above).

## How it works

Every MCP tool calls the same `/api/v1` REST routes that scripts use, so
validation and behaviour are identical.

- The embedded `/mcp` endpoint calls them in-process.
- The stdio bridge calls them over HTTP.

To add a tool, see [Architecture → How to add a new MCP tool](../architecture.md#a-new-mcp-tool).

**Next:** [Tutorial 6: DIS interoperability](06-dis-interoperability.md).
