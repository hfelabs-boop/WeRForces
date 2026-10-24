# User guide

The WeRForces window has five areas:

```
┌───────────────────────────── toolbar ──────────────────────────────┐
│ left panel   │            map (2D, 3D or split)        │ inspector │
│ Create /     │                                         │           │
│ Objects      │                                         │           │
├──────────────┴──────────── event log ─────────────────────────────┤
```

## Toolbar

| Control | What it does |
| --- | --- |
| **File ▾** | **Undo** / **Redo** (Ctrl+Z / Ctrl+Y), **New scenario** (on generated terrain, or an imported real terrain), **Open scenario…** (from the server's `scenarios/` folder), **Import from file…**, **Export to file** (downloads the current state as JSON), **Save on server…**, **Review saved recording…**, **Simulation settings…** (optional models, time of day and weather), **Batch analysis…** (see [below](#batch-analysis)), **Sessions…** (see [below](#sessions)) |
| Scenario name | The loaded scenario; a *session* pill when this page belongs to a session other than the main one |
| ⏮ | **Rewind**: reload the scenario as it was when last loaded. Anything since is discarded |
| ▶ Run / ⏸ Pause | Start or stop the clock (**Space**) |
| ⏭ | Advance one second while paused |
| 0.5× … 32× | Time multiplier: how many simulated seconds pass per real second |
| 00:00:00 | Simulation time since the scenario started. It turns amber when the server cannot keep up with the time multiplier (hover for its load) |
| ☀ 12:00 | Local time of day and weather (☾ night, ◐ twilight, ≋ fog or haze, ☂ rain, ❄ snow); click to change them |
| **Route / Area / Phase line / Point / Minefield / Obstacle** | Drawing tools for tactical graphics (see below) |
| **Measure** | Distances and bearings between clicked points; with two points, line of sight (**M**) |
| **Layers ▾** | Labels, grid, sensor contacts, weapon/sensor range rings, planned paths, unit display (auto / aggregate / entities), and symbol style (MIL-STD-2525 or simple) |
| **2D / 3D / Split** | Which map views are shown |
| **AAR** | After-action review: replay the recording (see [below](#after-action-review)) |
| **Integrations** | API and MCP connection details, TAK output, webhooks, GIS feeds |
| **?** | This documentation |
| Role pill | *Blue player · fog of war* when you joined with a player key (see [below](#playing-one-force-fog-of-war)) |
| DIS pill | DIS status when started with `--dis`: exercise, site:application, PDUs sent and received, remote entities |
| connected | WebSocket connection to the simulation server |
| *Name · sign out* | Who is signed in, when the server uses OpenID Connect sign-in |

## Left panel

### Create

1. Choose the **force**: Blue, Red or Neutral. Graphics you draw also take this
   force's colour.
2. Pick an item. **Units** are whole formations (e.g. *US Tank Platoon*, four
   M1A2s in a wedge). The other groups are single entities: ground vehicles,
   dismounted, aircraft and surface vessels. Typing in **Filter…** searches
   every force's catalog.
3. Click the map to place it. **Shift+click** places several. **Esc** stops.

Ground vehicles and people cannot be placed in water, and boats cannot be placed
on land. If a unit's formation slot lands in a lake, that member is moved to the
nearest valid spot.

### Objects

A tree of every object, grouped by force: units with their subordinate units
(a company's platoons) and members, single entities, entities received over DIS
(marked *remote*), and tactical graphics. Click to select. Double-click to
centre the map. Destroyed entities are struck through.

## 2D map

| Action | How |
| --- | --- |
| Select | Left-click a symbol, route or area |
| Select several | **Shift+click** adds or removes; **Shift+drag** a box around them |
| Context menu (tasking) | Right-click (see below) |
| Pan | Drag empty map, or middle-drag |
| Zoom | Mouse wheel (zooms around the cursor) |
| Move an entity | **Alt+drag** it |
| Centre on selection | **F** |
| Delete selection | **Delete** |

Symbols are MIL-STD-2525C (drawn with [milsymbol](https://github.com/spatialillusions/milsymbol));
**Layers ▾ → Symbols: simple** switches to a lighter style. Each entity type has
a symbol code (SIDC) in the [catalog](reference/catalog.md); the frame comes from
the force and the dimension, and the echelon amplifier from the unit.

- **Frame shape and colour show the force.** Blue rectangle = friendly, red
  diamond = hostile, green square = neutral, yellow = other. Aircraft use the
  open-bottomed "air" frame and ships a circle.
- **The icon inside shows the role:** armour, mechanised, infantry, recon,
  cavalry, air defence, field artillery, mortar, engineer, supply, transport,
  attack or utility helicopter, fighter, UAV, ship or boat.
- **Other markings:**
  - a line from the symbol shows heading and speed;
  - an orange bar under the symbol means a mobility or firepower kill;
  - a red ✕ means destroyed;
  - a dashed yellow outline means the entity is remote (owned by another DIS
    simulation);
  - a red halo shows how hard the entity is being suppressed (thicker when
    pinned down).

When zoomed out (or with *Units: aggregate*), each unit is drawn as one symbol
at its leader, with its echelon above (••• platoon, •• section, Ø team) and its
strength in the label, e.g. *(3/4)*. Zoom in to see the individual vehicles.

Effects: shots appear as yellow tracer lines from shooter to target. Detonations
appear as an orange flash for a hit and a grey puff for a miss. Smoke clouds are
grey discs that drift with the wind. At night and in twilight the map darkens.

Imported terrain can show land cover (built-up grey, wetland, shrub, bare,
snow) and, when zoomed in, building footprints.

The readout in the bottom-right corner shows the cursor position as grid
(km east/north), latitude/longitude, elevation, and whether the ground is open,
forest or water.

### Context menu

What appears depends on what is selected and what you right-click:

| Selection | Right-click on | Menu items |
| --- | --- | --- |
| Entity or unit | Empty map | **Move here**, **Move here by a covered route**, **Overwatch here**, **Defend here**, **Screen here**, **Orbit here (2 km)** (aircraft), **Fire mission here (3 rounds)** and **Smoke screen here (2 rounds)** (artillery and mortars), **Move here and dismount** (carriers with passengers), **Add "move here" to plan**, **Stop** |
| Entity or unit | An area | **Search *area***, **Ambush *area* from here**, plus the empty-map items |
| Engineers | A minefield or obstacle | **Breach a lane through *name***, **Move here** |
| Entity or unit | A hostile entity or unit | **Attack *name***, **Fire mission on *name*** (artillery and mortars), **Follow *name***, **Stop** |
| Entity or unit | A friendly supply vehicle | **Resupply from *name***, **Follow *name***, **Stop** |
| Several things (Shift+click) | Empty map | **Move here (keep formation)**, **Move here by a covered route**, **Defend here (in line)**, **Overwatch here (in line)**, **Fire mission here** (those with guns), **Stop all** |
| Several things | A hostile | **All attack *name*** |
| Several units | A friendly unit | **Put under *name*** (chain of command) |
| Infantry | A friendly carrier (or carrier unit) | **Mount *name*** (walk over and board), **Put inside *name* now** (scenario set-up), **Follow *name***, **Stop** |
| Entity or unit | A route or phase line | **Follow route *name***, **Patrol route *name***, **Stop** |
| Anything | Any object | **Select**, **Center map**, **Delete** |
| Anything | Anywhere | **Center map here**, **Place point here**, **Place armed item here** (when a palette item is armed) |

## 3D view

![3D view](images/screenshot-3d.png)

Click **3D** (or **Split** for 2D and 3D side by side). The 3D view shows:

- shaded terrain with roads and towns;
- vehicle, aircraft and ship models in force colours (dark when destroyed);
  passengers are not drawn while they ride;
- routes and phase lines draped over the ground;
- objective areas, minefields and obstacles drawn as translucent curtains, and
  breached lanes as white lines;
- extruded buildings on imported terrain;
- smoke clouds, and a darker sky and closer haze at night or in poor visibility;
- tracers and detonations.

| Action | How |
| --- | --- |
| Orbit | Drag |
| Pan | Right-drag |
| Zoom | Wheel (towards the cursor) |
| Select | Click a model |
| Fly to a model | Double-click it, or **Focus selection** |
| Context menu | Right-click (same items as 2D; the ground point under the cursor is used) |
| Track the selection | **Follow selected** |
| Terrain exaggeration | **Vertical ×1/×2/×3/×5** (default ×2 so hills read clearly) |
| Back to the overview | **Reset view** |

Models grow with distance so they stay visible from far away. They are only to
scale up close. The 3D code is downloaded the first time you open the view.

## Inspector (right panel)

### Entity

- **Name.** Click it to rename.
- **Grid, Lat/Lon, Altitude** (aircraft also show height above ground),
  **Heading, Speed, Damage**, **Suppression** (a bar), **Morale** (entities not
  in a unit), **Fuel** (a gauge), **Supplies** (supply vehicles: vehicle loads
  left), and the **Unit** it belongs to (click to select the unit).
- **Current activity**: the running plan step and task, e.g. *Seize OBJ 2/4:
  Follow route IRON — Follow route IRON (wp 3/28)*. It also shows *PINNED*,
  *BROKEN*, *DUG IN* / *HULL-DOWN*, *HALTED (contact)* and *ORDER IN n s* (an
  order still on its way, with the order-delay rule).
- **Rules of engagement**: Fire at will, Return fire or Hold fire (see
  [Concepts](concepts.md#rules-of-engagement)).
- **Reactions** (see [Concepts](concepts.md#reactions)):
  - **On contact**: *Continue the task* or *Halt and fight*;
  - **Withdraw**: *Never*, or *When weapons are knocked out* (entities) /
    *Below 75 %, 50 % or 25 % strength* (units), back to where it is now;
  - **Call for fire**: request fire missions on hostiles it sees.
- **Tasks:**
  - **Move to…**, **Attack…**, **Follow…** and **Orbit…** (aircraft) ask you to
    click a point or target;
  - **Stop**;
  - a route picker with **Follow** and **Patrol**;
  - **Wait** *n* seconds;
  - **Fire** *n* **rounds** → **Fire mission…** (artillery and mortars; click the
    target location);
  - **Mount…** (infantry; click the carrier), or **Passengers n/seats** with
    **Dismount** (carriers).

  A task replaces whatever the entity was doing, including its plan.
- **Plan editor**: see below.
- **Weapons**: rounds left out of the basic load, with maximum range.
- **Sensors**: what the entity can see with.
- **Contacts**: what it currently detects, with distance. ◎ marks its current
  target.

A passenger's activity reads *MOUNTED in …*.

### Unit

The same as an entity, plus **Strength** (alive/total), **Morale**,
**Leader**, a **Formation** picker (column, line, wedge, vee, echelonRight), a
**Superior** picker (chain of command), **Subordinates**, and a **Members** list
(★ = leader).

Tasks given to a unit are carried out by the leader; the other members keep
formation on it. *Attack*, *Fire mission*, *Mount*, *Dismount* and *Resupply*
are the exceptions: every member does them. *Overwatch*, *Defend*, *Screen* and
*Ambush* deploy the members in a line across the facing. A mounted unit's
activity starts with *MOUNTED n/m*.

A unit with subordinates (a company) passes orders down: a move keeps the
platoons' positions relative to each other, *Defend*/*Overwatch*/*Screen*/
*Ambush* spread them in a line with the HQ behind, and other tasks go to all.
A plan step lasts until the subordinates have finished too.

### Several selected

Shift+click or Shift+drag selects several units or entities. The inspector lists
them, with **Group into a unit** (entities not in a unit), **Stop all**, **Clear
selection** and **Delete all**. Right-click the map to order them all.

### Graphic

Shows the kind, number of points and length or area, with Center and Delete.
Minefields also have a **Density** (chance of a mine strike per 100 m driven
through it), and minefields and obstacles list their breached **Lanes** and who
knows about them.

## Plan editor

A plan is a list of steps carried out in order. Build one in the inspector:

1. Optionally give the plan a **Name**. It appears in *Current activity* and in
   the event log.
2. Choose a step type, fill in its value, and press **Add**. Steps that need a
   location or target (*Move to*, *Attack*, *Orbit*) then ask you to click the
   map.
3. Use **↑** to reorder and **✕** to remove a step.
4. Tick **loop** to repeat the plan forever.
5. Press **Assign plan**.

Step types:

| Kind | Steps |
| --- | --- |
| Tasks | Move to (pick), Follow route, Patrol route, Wait (seconds), Attack (pick), Orbit (pick), Fire mission (pick; rounds), Mount carrier (pick), Dismount passengers, Resupply at the nearest supply vehicle |
| Settings | Set ROE, Set speed (km/h), Set altitude (m above ground; 0 lands a helicopter), Set formation (units), Set reaction on contact, Set call for fire |
| Conditions | Wait until time (s), Wait until in area, Wait until enemy detected, Wait until under fire, Wait until destroyed (pick), Wait until enemy in area, Wait until strength below (%), Wait until fuel below (%), Wait until ammunition below (%) |

Steps waiting for a time appear on the [timeline](#timeline) as yellow diamonds.

The draft stays in the editor after you assign it, so you can change it and
assign it again. Right-clicking the map also offers **Add "move here" to plan**.
See [Tutorial 2](tutorials/02-routes-plans-and-conditions.md).

## Drawing tactical graphics

Choose **Route**, **Area**, **Phase line**, **Point**, **Minefield** or
**Obstacle** in the toolbar, then:

- **click** to add points;
- **double-click**, **Enter** or **right-click** to finish;
- **Backspace** removes the last point and **Esc** cancels.

| Graphic | Used for |
| --- | --- |
| Route | *Follow route* and *Patrol* tasks (a route that ends where it starts is patrolled as a loop; otherwise it is ridden back and forth) |
| Area | *Wait until in area* conditions; objectives |
| Phase line | Reference line; can also be followed like a route |
| Point | Reference point (e.g. a staging point) |
| Minefield | Damages what crosses it (by density); a force that strikes a mine, or laid it, routes round it. Engineers breach 30 m lanes |
| Obstacle | A ditch or wire line: vehicles stop at it and route round it, infantry climb through slowly. Engineers breach lanes |

## Measuring

**Measure** (or **M**) and click points: each leg shows its distance and bearing,
the last point its elevation, and three or more points a total. With exactly two
points the tool asks the server for line of sight between eyes 2 m above the
ground: the line turns green (clear) or red (blocked). **Backspace** removes a
point, **Esc** or right-click ends.

## Undo and redo

**Ctrl+Z** (or File → **Undo**) takes back the last edit: placing, deleting,
moving, renaming, orders, plans, settings, loading a scenario. **Ctrl+Y** or
**Ctrl+Shift+Z** redoes it. The last 30 edits can be undone; running and pausing
are not edits. Undoing an order given mid-run goes back to the moment before it
(the clock too). The event log is kept.

## Event log

Shows simulation events with their simulation time. Checkboxes filter by kind:

- fire;
- detonations (hit/miss);
- kills;
- damage (mobility/firepower kills);
- detections (first sighting of a hostile);
- tasks (assignments, plan completion, failures);
- info (scenario loads, leader changes, low fuel, resupply, simulation manager);
- radio (off by default: contact reports, calls for fire, orders acknowledged;
  sent over DIS as Signal PDUs);
- created/deleted.

Double-click a line to select and centre the entity. The strength of each force
is shown on the right, e.g. *Blue 11/14 · Red 6/19*.

## Timeline

The strip above the event log is the scenario's timeline: red ticks are kills,
blue ticks detections, green ticks completed plans, ambushes sprung and lanes
breached; the white line is now. Ahead of it, yellow diamonds are plan steps
waiting for a time and purple ones orders on their way. Hover for details;
click a past mark to replay it in the after-action review, or a future one to
select who it belongs to.

## After-action review

Press **AAR** in the toolbar. The simulation pauses and the map switches to the
**recording**: everything the server recorded since the scenario was loaded.
A bar above the event log controls the replay:

| Control | What it does |
| --- | --- |
| ⏮ | Back to the start |
| ▶ / ⏸ and 1×–64× | Play the recording at that speed |
| Timeline | Drag to any time. Red ticks are kills, yellow ticks bookmarks; click one to jump there |
| *Bookmark note…* + **Bookmark** | Add a note at the current replay time |
| **Report** | Strength and losses per force, a strength-over-time chart, every kill (time, victim, killer, weapon), rounds fired per weapon, bookmarks; **Download PDF** and **Kills / Events / Strength CSV** |
| **Save…** | Save the recording on the server (File → **Review saved recording…** opens it later) |
| **Exit** | Back to the live scenario, where you left it |

While replaying, the map, 3D view, object tree and event log show the recorded
situation, the inspector is read-only, and editing and orders are disabled.

## Simulation settings

File → **Simulation settings…** (or click the time-of-day chip):

- **Models**: suppression, morale and fuel (on by default) and order delay (off
  by default). Turning one off is useful for comparison runs. See
  [Concepts](concepts.md#optional-models).
- **Time and weather** at the scenario start: date, time of day, visibility,
  precipitation and wind. See [Concepts](concepts.md#night-and-weather).

## Batch analysis

File → **Batch analysis…** runs a scenario (the current state or a stored one)
many times with different random seeds, on the server in the background. Set the
number of runs, minutes per run, the first seed and whether a run stops when a
side is wiped out, and press **Run**. The results show each force's losses
(mean ± standard deviation, 95% confidence interval, range and a histogram), the
loss exchange ratio, who holds each area at the end, and a per-run CSV.

## Sessions

File → **Sessions…** lists the exercises running on the server. Each session
is separate: its own scenario, clock, recording, REST API (`/s/{id}/api/v1`)
and MCP endpoint (`/s/{id}/mcp`), opened at `http://host:8080/s/{id}/`. Create
one empty or from a stored scenario; delete any but *main*. DIS and Cursor on
Target run in the main session only.

## Playing one force (fog of war)

When the server has player keys (`--player blue:KEY`), opening
`http://host:8080/?api_key=KEY` joins as that force:

- the role pill shows *Blue player · fog of war*;
- your own force is shown in full; enemies appear only while your force has them
  as contacts, at the position last seen, named by type (*T-72B3 (E15)*), and
  fade as the contact goes stale. Selecting one shows when it was last seen;
- the event log only shows events involving your force;
- you can give orders and draw graphics for your force. The clock, the File
  menu, the Create palette, AAR and Integrations belong to exercise control
  (the `--api-key` holder) and are hidden.

## Keyboard

| Key | Action |
| --- | --- |
| Space | Run / pause |
| F | Centre on the selection |
| Delete | Delete the selection |
| Esc | Cancel placing, picking or drawing |
| Enter | Finish drawing |
| Backspace | Remove the last drawn point |
| Shift+click | Keep placing the armed palette item; with nothing armed, add to or remove from the selection |
| Shift+drag | Select everything in a box |
| Alt+drag | Move an entity |
| M | Measure |
| Ctrl+Z / Ctrl+Y | Undo / redo |

## Signing in

If the server uses OpenID Connect sign-in, opening the app takes you to your
organisation's sign-in page and back. Your role (exercise control, or a player
of one force) comes from your account; the toolbar shows your name, and clicking
it signs you out. See [Deployment](deployment.md#sign-in-with-openid-connect).

## API key prompt

If the server was started with `--api-key`, the browser asks for the key once
and remembers it. Open the app as `http://host:8080/?api_key=…` to supply it in
the URL instead. Entering a player key joins as that force.
