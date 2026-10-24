# Tutorial 11: Exercise control, players and the after-action review

**Time:** 20 minutes · **You will learn:** running a two-sided exercise where
each side sees only what its own forces have detected, controlling it as the
exercise director, and reviewing it afterwards: replay, bookmarks, the AAR
report and saved recordings.

You need three browser windows (or three people): exercise control, Blue and
Red.

## 1. Start the server with keys

```bash
npm start -- -s calloway-crossroads --api-key control --player blue:blue1 --player red:red1
```

```
Player key for Blue: fog of war on
Player key for Red: fog of war on
WeRForces running at http://127.0.0.1:8080  (scenario: Calloway Crossroads)
  Docs http://127.0.0.1:8080/docs/  ·  REST API http://127.0.0.1:8080/api/docs  ·  MCP http://127.0.0.1:8080/mcp  ·  API key required
```

`--api-key` is exercise control's key. Each `--player force:key` adds a player
key for one force. Use long random keys for anything beyond a demo, and see
[Deployment](../deployment.md) for running it on a network with HTTPS.

## 2. Join as each role

Open:

- <http://127.0.0.1:8080/?api_key=control>: exercise control, the full picture;
- <http://127.0.0.1:8080/?api_key=blue1>: the Blue commander;
- <http://127.0.0.1:8080/?api_key=red1>: the Red commander.

In the Blue window the toolbar shows **Blue player · fog of war**. The clock,
File menu, Create palette, AAR and Integrations are gone, and the map shows
only Blue's 14 entities. Red sees its own 19. Exercise control sees all 36.

The REST API gives each key the same view:

```bash
curl -s -H 'Authorization: Bearer control' localhost:8080/api/v1/entities | jq length   # 36
curl -s -H 'Authorization: Bearer blue1'   localhost:8080/api/v1/entities | jq length   # 14
```

## 3. Run the exercise

Players give orders to their own forces as usual: right-click to move or
attack, plans, reactions. What they cannot do:

```bash
curl -s -X POST -H 'Authorization: Bearer blue1' -H 'Content-Type: application/json' \
  localhost:8080/api/v1/simulation/run -d '{}'
```

```json
{"error":{"status":403,"message":"exercise control only"}}
```

Ordering an enemy unit, or attacking something Blue has not detected, fails the
same way. A Red entity Blue cannot see answers *404 unknown entity*, so even its
existence stays hidden.

Exercise control presses **Run** (or steps time). After five minutes the Apache
team *Gunslinger* has found and engaged the Red column, and the windows differ:

| Window | Entities shown | Of which contacts |
| --- | --- | --- |
| Control | 36 | – |
| Blue | 17 | three civilian cars |
| Red | 21 | the two F-16s overhead |

Contacts are drawn at the position where they were **last seen**, named by type
(*Civilian Car (E34)*), and fade when they have not been seen for a few seconds.
Select one and the inspector says how long ago that was. When a contact is
destroyed, or lost for 15 s, it disappears.

The event logs differ too. Blue's has its own detections and kills, with Red
names replaced by types:

```
00:02:16  T-72B3 (E15) destroyed by Gunslinger Lead
00:02:19  T-72B3 (E17) destroyed by Gunslinger 2
00:02:30  T-72B3 (E16) suffered a firepower kill
00:02:46  BRDM-2 (E30) destroyed by Gunslinger 2
```

while exercise control's says *Tank Plt 1 Lead destroyed by Gunslinger Lead*.

## 4. Bookmarks during the run

Exercise control can mark moments for the debrief. In the AAR bar (next
section) or through the API:

```bash
curl -s -X POST -H 'Authorization: Bearer control' -H 'Content-Type: application/json' \
  localhost:8080/api/v1/recording/bookmarks -d '{"text": "Gunslinger cleared the road"}'
```

```json
{"id":"B1","time":300,"text":"Gunslinger cleared the road"}
```

Without `time`, the bookmark is placed at the current simulation time.

## 5. Replay it

Run on to 15 minutes, then in the control window press **AAR**. The simulation
pauses and a bar appears above the event log:

- drag the **timeline** to any moment, or press **▶** at 1×–64×. Red ticks mark
  kills and yellow ticks bookmarks; click one to jump to it;
- the map, 3D view, Objects tree and event log show the situation as it was;
- click a unit to see where it was and its damage (read-only).

Behind the replay is the server's recording: every entity once per simulated
second, plus all events.

```bash
curl -s -H 'Authorization: Bearer control' localhost:8080/api/v1/recording
```

```json
{"live":true,"scenarioName":"Calloway Crossroads","start":0,"end":900,"interval":1,"frames":901,"entities":36,"events":62,"bookmarks":[{"id":"B1","time":300,"text":"Gunslinger cleared the road"}],"bytes":1037952}
```

`GET /recording/state?time=120` returns everything as it was at 2:00, with
latitude and longitude, which is handy for scripts and for AI agents
(the MCP tool `replay_state`).

## 6. The report

Press **Report** in the AAR bar. It shows strength and losses per force, a
strength-over-time chart, every kill with killer and weapon, and rounds fired
per weapon. The same data as JSON:

```bash
curl -s -H 'Authorization: Bearer control' localhost:8080/api/v1/recording/report | jq -c '.forces[], .kills[0], .shotsByWeapon'
```

```json
{"force":1,"start":14,"end":14,"losses":0,"shots":11,"kills":6}
{"force":2,"start":19,"end":13,"losses":6,"shots":0,"kills":0}
{"force":3,"start":3,"end":3,"losses":0,"shots":0,"kills":0}
{"time":136.7,"victimId":"E15","victim":"Tank Plt 1 Lead","victimForce":2,"killerId":"E11","killer":"Gunslinger Lead","weaponId":"hellfire"}
{"hellfire":11}
```

Eleven Hellfires for six kills. Red never fired a shot: it never saw the
helicopters. That is the kind of thing the debrief is for. AI agents get the
same report as text from the MCP tool `after_action_report`.

Players cannot read the recording (*403 exercise control only*) while the
exercise runs, since it would show the enemy.

## 7. Save it and review it later

In the AAR bar press **Save…** and give a name, or:

```bash
curl -s -X PUT -H 'Authorization: Bearer control' -H 'Content-Type: application/json' \
  localhost:8080/api/v1/recordings/calloway-run1 -d '{}'
```

The file goes to `recordings/calloway-run1.json` on the server (about 1 MB for
this 15-minute run). Later, even after loading other scenarios, choose
**File → Review saved recording…** to replay it. While a saved recording is
being reviewed, live recording is paused; pressing **Exit** in the AAR bar goes
back to recording the live scenario.

## Notes

- The recording follows the timeline: **Rewind** or loading a checkpoint cuts
  it back to that time, and a new scenario starts a new recording. Save first if
  you want to keep a run.
- `--record-interval 5` records every 5 simulated seconds (smaller, coarser);
  `0` turns recording off.
- Player keys work for MCP clients too: an agent connected with
  `Authorization: Bearer blue1` sees and commands only Blue
  ([Tutorial 5](05-ai-agents-with-mcp.md)).
