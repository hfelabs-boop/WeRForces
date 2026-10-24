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
| **File ▾** | **New scenario** (on generated terrain, or an imported real terrain), **Open scenario…** (from the server's `scenarios/` folder), **Import from file…**, **Export to file** (downloads the current state as JSON), **Save on server…**, **Review saved recording…** |
| Scenario name | The loaded scenario |
| ⏮ | **Rewind**: reload the scenario as it was when last loaded. Anything since is discarded |
| ▶ Run / ⏸ Pause | Start or stop the clock (**Space**) |
| ⏭ | Advance one second while paused |
| 0.5× … 32× | Time multiplier: how many simulated seconds pass per real second |
| 00:00:00 | Simulation time since the scenario started |
| **Route / Area / Phase line / Point** | Drawing tools for tactical graphics (see below) |
| **Layers ▾** | Labels, grid, sensor contacts, weapon/sensor range rings, planned paths, and unit display (auto / aggregate / entities) |
| **2D / 3D / Split** | Which map views are shown |
| **AAR** | After-action review: replay the recording (see [below](#after-action-review)) |
| **Integrations** | API and MCP connection details, TAK output, webhooks, GIS feeds |
| **?** | This documentation |
| Role pill | *Blue player · fog of war* when you joined with a player key (see [below](#playing-one-force-fog-of-war)) |
| DIS pill | DIS status when started with `--dis`: exercise, site:application, PDUs sent and received, remote entities |
| connected | WebSocket connection to the simulation server |

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

A tree of every object, grouped by force: units with their members, single
entities, entities received over DIS (marked *remote*), and tactical graphics.
Click to select. Double-click to centre the map. Destroyed entities are struck
through.

## 2D map

| Action | How |
| --- | --- |
| Select | Left-click a symbol, route or area |
| Context menu (tasking) | Right-click (see below) |
| Pan | Drag empty map, or middle-drag |
| Zoom | Mouse wheel (zooms around the cursor) |
| Move an entity | **Alt+drag** it |
| Centre on selection | **F** |
| Delete selection | **Delete** |

Symbols follow simplified MIL-STD-2525 rules:

- **Frame shape and colour show the force.** Blue rectangle = friendly, red
  diamond = hostile, green square = neutral. Aircraft use the open-bottomed
  "air" frame and ships a circle.
- **The icon inside shows the role:** armour, mechanised, infantry, recon,
  wheeled, air defence, rotary wing, fixed wing, UAV, ship or boat.
- **Other markings:**
  - a line from the symbol shows heading and speed;
  - an orange bar under the symbol means a mobility or firepower kill;
  - a red ✕ means destroyed;
  - a dashed yellow outline means the entity is remote (owned by another DIS
    simulation).

When zoomed out (or with *Units: aggregate*), each unit is drawn as one symbol
at its leader, with its echelon above (••• platoon, •• section, Ø team) and its
strength in the label, e.g. *(3/4)*. Zoom in to see the individual vehicles.

Effects: shots appear as yellow tracer lines from shooter to target. Detonations
appear as an orange flash for a hit and a grey puff for a miss.

The readout in the bottom-right corner shows the cursor position as grid
(km east/north), latitude/longitude, elevation, and whether the ground is open,
forest or water.

### Context menu

What appears depends on what is selected and what you right-click:

| Selection | Right-click on | Menu items |
| --- | --- | --- |
| Entity or unit | Empty map | **Move here**, **Orbit here (2 km)** (aircraft), **Fire mission here (3 rounds)** (artillery and mortars), **Move here and dismount** (carriers with passengers), **Add "move here" to plan**, **Stop** |
| Entity or unit | A hostile entity or unit | **Attack *name***, **Fire mission on *name*** (artillery and mortars), **Follow *name***, **Stop** |
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
- objective areas drawn as translucent curtains;
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
  **Heading, Speed, Damage**, and the **Unit** it belongs to (click to select
  the unit).
- **Current activity**: the running plan step and task, e.g. *Seize OBJ 2/4:
  Follow route IRON — Follow route IRON (wp 3/28)*.
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

The same as an entity, plus **Strength** (alive/total), **Leader**, a
**Formation** picker (column, line, wedge, vee, echelonRight) and a **Members**
list (★ = leader).

Tasks given to a unit are carried out by the leader; the other members keep
formation on it. *Attack*, *Fire mission*, *Mount* and *Dismount* are the
exceptions: every member does them. A mounted unit's activity starts with
*MOUNTED n/m*.

### Graphic

Shows the kind, number of points and length or area, with Center and Delete.

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
| Tasks | Move to (pick), Follow route, Patrol route, Wait (seconds), Attack (pick), Orbit (pick), Fire mission (pick; rounds), Mount carrier (pick), Dismount passengers |
| Settings | Set ROE, Set speed (km/h), Set altitude (m above ground; 0 lands a helicopter), Set formation (units), Set reaction on contact, Set call for fire |
| Conditions | Wait until time (s), Wait until in area, Wait until enemy detected, Wait until under fire, Wait until destroyed (pick), Wait until enemy in area, Wait until strength below (%) |

The draft stays in the editor after you assign it, so you can change it and
assign it again. Right-clicking the map also offers **Add "move here" to plan**.
See [Tutorial 2](tutorials/02-routes-plans-and-conditions.md).

## Drawing tactical graphics

Choose **Route**, **Area**, **Phase line** or **Point** in the toolbar, then:

- **click** to add points;
- **double-click**, **Enter** or **right-click** to finish;
- **Backspace** removes the last point and **Esc** cancels.

| Graphic | Used for |
| --- | --- |
| Route | *Follow route* and *Patrol* tasks (a route that ends where it starts is patrolled as a loop; otherwise it is ridden back and forth) |
| Area | *Wait until in area* conditions; objectives |
| Phase line | Reference line; can also be followed like a route |
| Point | Reference point (e.g. a staging point) |

## Event log

Shows simulation events with their simulation time. Checkboxes filter by kind:

- fire;
- detonations (hit/miss);
- kills;
- damage (mobility/firepower kills);
- detections (first sighting of a hostile);
- tasks (assignments, plan completion, failures);
- info (scenario loads, leader changes);
- created/deleted.

Double-click a line to select and centre the entity. The strength of each force
is shown on the right, e.g. *Blue 11/14 · Red 6/19*.

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
| **Report** | Strength and losses per force, a strength-over-time chart, every kill (time, victim, killer, weapon), rounds fired per weapon, bookmarks |
| **Save…** | Save the recording on the server (File → **Review saved recording…** opens it later) |
| **Exit** | Back to the live scenario, where you left it |

While replaying, the map, 3D view, object tree and event log show the recorded
situation, the inspector is read-only, and editing and orders are disabled.

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
| Shift+click | Keep placing the armed palette item |
| Alt+drag | Move an entity |

## API key prompt

If the server was started with `--api-key`, the browser asks for the key once
and remembers it. Open the app as `http://host:8080/?api_key=…` to supply it in
the URL instead. Entering a player key joins as that force.
