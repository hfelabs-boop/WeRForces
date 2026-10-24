# Concepts

This page explains how WeRForces models the world. The numbers are the actual
values in the code (`src/sim/`), so you can predict and explain what you see.

## Coordinates and units

- **Local frame.** Positions are metres on a flat square map. **x is east, y is
  north**, measured from the south-west corner (0, 0) to (*size*, *size*). The
  default map is 16 km × 16 km.
- **Altitude** `z` is metres above sea level. Aircraft also report height above
  ground (*AGL*).
- **Heading** is clockwise from true north. The engine and the REST API use
  **radians**. The GUI, `headingDeg` in API responses, and the MCP tools use
  **degrees**.
- **Speed** is metres per second internally, shown as km/h in the GUI.
- **Geographic position.** The map's south-west corner sits at a latitude and
  longitude (the scenario's `terrain.origin`, default 50.75° N 9.9° E). Local
  metres convert to WGS-84 latitude/longitude using the curvature at that
  origin, accurate to well under a metre across the map. The same conversion
  feeds DIS, TAK, GeoJSON and KML.
- The REST API and MCP tools accept a location in three forms: `{x, y}`,
  `{lat, lon}`, or `{town: "Calloway"}`.

## Terrain

Terrain is either **generated** from a seed (the same seed always produces the
same map) or **imported** from real elevation data and map features with
`werforces-terrain` (see [Terrain import](terrain-import.md)). A scenario refers
to an imported terrain by name: `"terrain": {"dataset": "fulda"}`.

The table describes generated terrain. Imported terrain has the same layers,
taken from the data instead: elevation from the DEM, inland water (lakes and
rivers, with bridges where roads cross) from an extra water layer, and forest,
roads and towns from the features. It can also carry **land cover** (from ESA
WorldCover) and **buildings** (from OpenStreetMap), described below.

| Feature | Model |
| --- | --- |
| Elevation | A 50 m grid of height posts with bilinear interpolation. Relief is set by `relief` (default 320 m) |
| Water | Everything below sea level. `waterFraction` sets how much (default 10 %) |
| Forest | Patches covering `forestFraction` of the land (default 28 %). Canopy is 15 m high |
| Towns | Placed on flat dry ground and named (Alderford, Brenham, Calloway…) |
| Roads | Connect the towns along easy ground |

**Mobility.** Each domain's speed depends on where it is:

| Domain | Water | Road | Off-road | Forest | Slope |
| --- | --- | --- | --- | --- | --- |
| Ground vehicle | impassable | 100 % | type's off-road factor (tanks 0.7, trucks 0.4) | × 0.45 off-road | slower with slope; impassable above ~31° off-road |
| Dismounted | impassable | 100 % | factor 0.85 | × 0.75 | gentler penalty; impassable above 45° |
| Surface vessel | only on water (at sea level, or a lake's level) | – | – | – | – |
| Aircraft | unaffected | | | | |

**Land cover** (imported terrain) slows movement off roads: shrub × 0.8 for
vehicles (× 0.85 on foot), built-up × 0.7 (× 0.9), wetland × 0.35 (× 0.6), snow
× 0.6 (× 0.5). WorldCover tree cover also counts as forest, and permanent water
as water. Built-up ground halves the chance of spotting what is on it (× 0.6),
and shrub hides people (× 0.7).

**Buildings** (imported terrain) are rasterised per grid post: the share of the
cell their footprints cover, and their height. A post at least 25 % covered is
built-up:

- sight lines below the roofs are blocked after 25 m among buildings, so
  streets and gaps give short views but not across a block; from above the
  roofs you see over them;
- vehicles cannot enter posts at least 50 % covered (solid blocks) and are
  slowed to × 0.4 among buildings; troops × 0.8;
- troops among buildings are harder to hit (× 0.6) and to spot.

**Route planning.** *Move to* and *Follow route* plan a ground or water path with
A\* over the terrain grid, as soon as the order is given (also while the clock is
paused, so the path and [travel estimate](#travel-estimates) show at once). Paths minimise travel time, so vehicles use roads when
that is faster, and avoid water and cliffs. If a vehicle gets blocked for 3 s, it
replans. Aircraft fly straight. Routes also go round **obstacles** and the
**minefields the force knows about** (through breached lanes where there are
some).

**Covered routes.** A *Move to* with `covered` (context menu: *Move here by a
covered route*) also keeps out of sight of the enemies the force knows about:
ground each known enemy can see and reach with direct fire costs more to cross,
the more so the closer it is, so the route goes behind ridges, woods and
buildings or round the enemy's reach. It replans every 15 s as contacts change.
Broken units, withdrawing units and screens falling back take covered routes.

**Line of sight.** Line of sight is sampled every 25 m along the line from the
observer's eyes to the target. Terrain blocks it outright. Forest canopy (15 m)
blocks it only once the line has passed through **more than 150 m of
forest**, so vehicles at a wood's edge, or close together inside a wood, can
still see each other. Smoke clouds block it too (except for radar), and so do
buildings (above).

## Forces and hostility

| Force id | Name | Default colour |
| --- | --- | --- |
| 1 | Blue | blue |
| 2 | Red | red |
| 3 | Neutral | green |
| 0 | Other | yellow |

Background civilians ([pattern of life](#pattern-of-life)) are Neutral.

By default only Blue and Red are hostile to each other. A scenario can list other
hostile pairs in `hostilities` (e.g. `[[1,2],[2,3]]` for Red attacking
neutrals). Entities only shoot at forces they are hostile to, but they detect
every other force.

## Entities

An **entity** is one platform: a tank, a helicopter, a rifleman, a ship. Its
**type** (see the [catalog](reference/catalog.md)) fixes its:

- **domain**: ground, lifeform (people), air or surface;
- **armour class**: lifeform, soft, light, armored, air or ship;
- maximum and cruise speed, acceleration, turn rate, and off-road factor;
- sensors and weapons, each with a basic load of ammunition;
- DIS entity type.

Entities move with realistic limits. They accelerate and brake, and turn at
their turn rate (vehicles slow down for sharp turns). Aircraft follow
the terrain at a set height above ground and climb early when high ground is
ahead. Fixed-wing aircraft never drop below their minimum speed; with nothing
to do, they circle.

### Damage

| State | Meaning |
| --- | --- |
| none | Fully working |
| mobility kill | Cannot move, can still fight |
| firepower kill | Cannot fire, can still move |
| destroyed | Out of action. Its task and plan are cleared |

A vehicle that suffers both a mobility and a firepower kill counts as destroyed.
People and aircraft are either unharmed or destroyed.

## Units

A **unit** is a group of entities of one force with a **leader** (the first
living member) and a **formation**:

| Formation | Followers relative to the leader |
| --- | --- |
| column | in file behind |
| line | abreast, alternating right and left |
| wedge | a V opening backwards |
| vee | a V opening forwards |
| echelonRight | diagonally back to the right |

`spacing` sets the distance between slots (e.g. 80 m for a tank platoon, 12 m for
a rifle squad). Units are created from **templates** or by grouping existing
entities.

- **Tasking a unit.** The leader does the task and the others hold formation on
  it. They speed up to catch up, and fall in behind the leader if their slot is
  blocked by terrain. *Attack*, *Fire mission*, *Mount*, *Dismount* and
  *Resupply* are different: every member does them itself. *Overwatch*,
  *Defend*, *Screen* and *Ambush* deploy the members in a line across the
  facing (`width` m wide, or at the unit's spacing).
- **Shared contacts.** When one member detects something, every member knows
  about it.
- **Succession.** If the leader is destroyed, or immobilised while another
  member can still move, the next member takes command and carries on the unit's
  task.

### Chain of command

A unit can have a **superior** unit (`parentId`; inspector *Superior*; REST
`PATCH /units/{id}` with `superiorId`). Company templates build an HQ unit with
three platoons under it, named after the company (*US Tank Company 1st
Platoon*), with the HQ vehicles close together behind them. An order to a
superior passes down:

- *Move to*: each subordinate moves to the target plus its current offset from
  the HQ, so the company keeps its shape;
- *Overwatch*, *Defend*, *Screen*, *Ambush*: the subordinates spread in a line
  across the facing (`width`, or 400 m apart for vehicles and 150 m on foot),
  each with its share of the frontage, and the HQ takes post 300 m (150 m on
  foot) behind;
- anything else: every subordinate gets the same task.

A superior's plan step lasts until its subordinates have finished too.

**Order delay** (optional rule, off by default): orders take time to reach and
be acted on. 5 s for an entity, 10 s a team or flight, 15 s a section, 30 s a
platoon, 60 s a company or group, ± 20 %. An order to a company arrives after
its delay, then each platoon gets its part after its own: orders pass down level
by level. A new order replaces one still on its way; **Stop** is immediate.
Orders received are acknowledged on the radio net.

## Tasks

A **task** is one behaviour. Giving a task replaces the current task and any
plan. **Stop** clears both.

| Task | Behaviour | Ends when |
| --- | --- | --- |
| **Move to** *point* | Plans a route and drives it. Ground vehicles brake to a stop at the end | Arrived (fails if no route) |
| **Follow route** *route* | Drives from the route's first point to its last (or the reverse with `reverse`) | Last point reached |
| **Patrol** *route* | Joins at the nearest point. Closed routes (first point ≈ last) loop; open routes go back and forth | Never |
| **Wait** *seconds* | Stops and waits | Time is up |
| **Follow** *entity* | Stays `distance` m behind it (default 50) | The followed entity is destroyed |
| **Attack** *entity* | Closes to 80 % of its best weapon's range with line of sight, then stops and engages (fixed-wing aircraft keep making passes). **Ignores ROE for this target** | Target destroyed (fails if no weapon can hurt it) |
| **Orbit** *point, radius* | Circles the point. Meant for aircraft | `duration` elapsed, if set; otherwise never |
| **Fire mission** *point* | Stops, lays the weapon (20 s), then fires `rounds` (default 3) indirect-fire rounds at the point, spread over `radius` m (default 0). On a unit, every tube that can reach fires | All rounds fired (fails out of range or out of ammunition) |
| **Mount** *carrier* | Dismounted infantry walk to the carrier and board when it is stopped (a helicopter must have landed). A unit as carrier: each soldier takes the nearest free seat in it | Aboard (fails when no seats are left) |
| **Dismount** | A carrier stops (a helicopter lands) and unloads its passengers in a line behind it | Passengers out |
| **Overwatch** *position* | Takes the position facing `facing` (degrees; default the direction of the move) and watches and engages from it | `duration` elapsed, if set; otherwise never |
| **Defend** *position* | Takes the position and holds it, fighting from it without chasing | Never |
| **Ambush** *position, kill zone* | Takes the position with **hold fire**; as soon as an enemy enters the kill-zone area (or the ambushers come under fire) the whole unit switches to **fire at will** together | Never |
| **Screen** *position* | Watches with **return fire**, and falls back to `fallback` (default 2 km to the rear) by a covered route when an enemy comes within `breakContact` m. Without `breakContact` it falls back before an enemy gets within reach of its direct fire (that enemy's longest direct-fire range against it plus 200 m, at least 1500 m), or as soon as it comes under fire | Back at the fallback point |
| **Search** *area* | Sweeps the area in back-and-forth tracks spaced to the searcher's sensor range (or `spacing`), then reports how many enemies it found | Last track done |
| **Breach** *minefield or obstacle* | Engineers only: go to the nearest edge and work there for the type's breach time (slower under fire), then open a 30 m lane | Lane open |
| **Resupply** | Drives to the nearest friendly supply vehicle with stock (or the one given), halts within 36 m of it, and waits until full. A helicopter flies there, sets down beside it, and goes back up to its height when full. Fixed-wing aircraft and boats can't | Full (fails when there is no supply vehicle with stock) |
| **Direct control** (`manual`) | A person drives it: throttle 0–1 of top speed, turn −1 to 1, and a target it engages first whatever its ROE ([Drive mode](user-guide.md#drive-mode)). A turn lasts 1.5 s unless it is sent again. Driving a unit's leader drops the unit's orders | Another order is given |

**Prepared positions.** An entity holding still on *Overwatch*, *Defend*,
*Ambush* or *Screen* is in a prepared position after a while: infantry **dug
in** after 90 s, vehicles **hull-down** after 30 s. Dug-in infantry are hit
with × 0.4 the usual chance and hull-down vehicles × 0.6, and while quiet both
are half as likely to be spotted. Moving gives the position up.

Every task accepts an optional `speed` (m/s) where it makes sense. The plan
setting *Set speed* changes the default cruise speed.

## Plans

A **plan** is a list of statements carried out **in order**:

| Statement | Effect |
| --- | --- |
| `task` | Start the task and wait until it finishes (or fails) |
| `setRoe`, `setSpeed`, `setAltitude`, `setFormation` | Change a setting instantly and continue |
| `setReactions` | Change the [reactions](#reactions) it names (others are kept) and continue |
| `waitUntil` *condition* | Wait until the condition holds |
| `if` *condition* `then` [...] `else` [...] | Check the condition once, now, and carry out one branch (`else` is optional) |
| `while` *condition* `body` [...] | Check the condition; while it holds, carry out the body and check again |
| `sendCodeword` *word* | Send a [codeword](#codewords) to the owner's force and continue |
| `report` *text* | Put a radio message from the owner in the event log (*radio*) and continue |

Conditions:

| Condition | True when |
| --- | --- |
| `simTime` *t* | Simulation time ≥ *t* seconds |
| `inArea` *area* | The entity (or the unit's leader) is inside the area graphic |
| `enemyDetected` | Any member has a hostile contact |
| `underFire` | Any member was shot at in the last 15 s |
| `entityDestroyed` *id* | That entity is destroyed or gone |
| `enemyInArea` *area* | A living hostile (to the plan's owner) is inside the area |
| `strengthBelow` *fraction* | Fewer than that fraction of the members are alive (an entity counts as one member) |
| `fuelBelow`, `ammoBelow` *fraction* | The members' average fuel, or ammunition (share of full loads), is below the fraction |
| `codeword` *word* | The owner's force has received the codeword, and the owner's radio is not jammed |
| `all` [*conditions*] | Every one holds |
| `any` [*conditions*] | At least one holds |
| `not` *condition* | It does not hold |

`if` and `while` blocks can be nested (up to 8 deep, 200 statements in all). A
plan is turned into a flat list of steps with jumps, and *Current activity*
counts those steps: *Plan 3/9* is the third of nine. An `if` does not wait:
to wait for something, use `waitUntil`, or a `while` with a `wait` task in its
body. Instant statements (settings, codewords, reports, tests) run straight
on, up to 50 in one tick.

With `loop: true` the plan starts over when it ends. When a non-looping plan
finishes, the event log reports *plan … complete*. Plans can be given to
entities or units. Tasks inside a unit's plan are carried out unit-style (see
above).

Plans run one step at a time. To react to something *while* moving, use ROE
(units fire on the move), [reactions](#reactions), or split the route into legs
separated by `waitUntil` steps.

## Codewords

A **codeword** is a word sent to a whole force: *EXECUTE*, *PHASE 2*, *BRAVO*.
It is upper-cased and may have up to 40 letters, digits, spaces, `-` and `_`.
It is sent by a plan's `sendCodeword` statement, by exercise control or a player
(their own force; REST `POST /api/v1/codewords`, MCP `send_codeword`), or by a
[synchronization matrix](#synchronization-matrix) phase as it starts (its name).
The event log notes it (*Blue codeword EXECUTE*, or as a radio message from the
unit that sent it).

Once a force has a codeword it keeps it, so a plan that reaches *wait until
codeword EXECUTE* after it was sent goes straight on. A unit whose radio is
[jammed](#electronic-warfare) does not hear codewords until its radio is back.
Codewords are per force: Red can't hear Blue's. `GET /api/v1/codewords` lists
them with the time each was first sent; checkpoints save them.

## Synchronization matrix

A **synchronization matrix** (or global plan) is a force's operation in
**phases**. Each phase has a name, a **trigger** and **orders**: a task, an
ROE or *stop* for a unit or entity of that force. Phases start in order; a
phase is only checked once the one before it has started. When a phase starts,
the event log says *Assault begins (codeword EXECUTE)*, every order of the
phase is given at once (through the chain of command, with any
[order delay](#chain-of-command) or jamming delay), and the phase's name goes
out to the force as a codeword (*ASSAULT*).

| Trigger | Starts the phase |
| --- | --- |
| `manual` | Only by hand: the GUI's **▶ Start now**, `POST /api/v1/sync-matrix/{force}/phases/{id}/start`, MCP `start_phase` |
| `time` *t* | At simulation time *t* |
| `codeword` *word* | When the force has the codeword |
| `previousDone` *delay* | When every order of the previous phase has been carried out (nothing still running or on its way), plus *delay* seconds. A first phase with this trigger starts at once |
| `condition` *ownerId, condition* | When a plan [condition](#plans) holds for that unit or entity |

Orders are carried out like any order: a later order to the same unit (typed,
from a plan, or by hand) replaces the phase's order. An order that never ends,
such as *Defend* or *Overwatch* without a duration, keeps a following
`previousDone` phase waiting; use another trigger after such a phase. Phases
are checked once a simulated second. Each force has its own matrix and its own
record of which phases have started. Up to 20 phases of up to 100 orders each.

Over the API, `PUT /api/v1/sync-matrix/{force}` takes the whole matrix, and an
order can be given in words (`{"targetId": "U1", "text": "move to Calloway
covered"}`): the server turns it into a task as the [order
line](user-guide.md#typed-orders) would. The [quick battle](user-guide.md#quick-battle)
gives each side a matrix. Scenario files keep them in `syncMatrices`.

## Reactions

Reactions are standing orders that run alongside whatever task or plan is
going on. Set them in the inspector, with a plan's `setReactions` step, or
through the API.

| Reaction | Effect |
| --- | --- |
| `onContact: "halt"` | Stop moving while a hostile seen in the last 3 s is within range of a direct-fire weapon with ammunition; fight; then carry on with the task where it left off. The activity line shows *HALTED (contact)* |
| `withdrawBelow` *fraction* | A unit whose share of living members drops below the fraction abandons its plan, switches to *return fire* and moves to `withdrawTo` (default: where it was when the reaction was set). For an entity, the trigger is a firepower kill |
| `callForFire: true` | The entity is an observer: see [Indirect fire](#indirect-fire-and-call-for-fire) |

Setting reactions on a unit sets *on contact* and *call for fire* on every member.

## Rules of engagement

| ROE | Fires at |
| --- | --- |
| **Fire at will** (default) | Any detected hostile in range |
| **Return fire** | Only hostiles that shot at it in the last 60 s |
| **Hold fire** | Nothing, except the target of its own *Attack* task |

## Sensors and detection

Each entity scans **once per second** with each of its sensors. A target is
detected when all of these hold:

1. it is of another force and not destroyed;
2. it is within the sensor's **range** and of a **domain** the sensor can see
   (e.g. air-search radars only see aircraft);
3. it is inside the sensor's **field of view**, measured from the entity's
   heading (thermal sights cover 120°; eyes and binoculars cover 360°);
4. there is **line of sight** to it;
5. a random draw succeeds with probability:

   *P* = 0.9 × (1 − 0.7 × (range / sensor range)²)

   then multiplied by:

   | Situation | Factor |
   | --- | --- |
   | Target in forest (ground or people; not for radar) | × 0.35 |
   | Target is a person | × 0.6 |
   | Target moving faster than 1 m/s | × 1.3 |
   | Target fired in the last 5 s | × 2 |
   | Target already tracked | at least 0.95 |

   The result is capped at 0.99.

A contact is dropped if it is not seen again for 15 s. The first time an entity
detects a hostile, the event log shows *X detected Y*.

## Combat and damage

Every tick, each entity that can fire picks a target and a weapon.

**Target.** Candidates are the *Attack* task's target first, then the current
target, then the nearest detected hostiles allowed by ROE.

Members of a unit **spread their fire**: a target that unit-mates already
engage counts as further away (× 1.6 for each of them), so a platoon shares out
what it sees instead of all firing at the nearest.

**Weapon.** The weapon with the highest effective kill probability against
that target, among those in range and with ammunition. Guided missiles count as
0.15 worse than they are, so guns are preferred unless a missile is clearly
better.

**Firing:**

- one shot per entity per tick;
- the weapon then reloads for its reload time (±10 %);
- line of sight is required;
- only one guided missile is kept in flight at the same target.

**Flight time.** The round arrives after range ÷ projectile speed. Guided
munitions track the target. Unguided rounds are aimed where a moving target
will be when they arrive (fire control leads it, at its current velocity), and
miss if the target ends up more than 6 m from that point: a target that stops,
speeds up or turns while the round is in flight is missed.

**Effective Pk.** Start from the weapon's Pk against the target's armour class
(see the [catalog](reference/catalog.md#weapons)), then multiply by:

| Condition | Factor |
| --- | --- |
| Range | × (1 − 0.5 × (range / max range)²) |
| Shooter moving > 2 m/s (unguided) | × 0.7 |
| Target moving > 8 m/s (unguided) | × 0.8 |
| Ground or person target in forest | × 0.75 |
| Shooter suppressed | × (1 − 0.6 × suppression) |
| Shooter's unit shaken / broken | × 0.8 / × 0.6 |
| Target pinned | × 0.5 |
| Target dug in / hull-down | × 0.4 / × 0.6 |
| Infantry target among buildings | × 0.6 |

**Outcome.**

- The round hits with probability min(1, 1.8 × Pk).
- A hit destroys the target with probability Pk ÷ hit chance. Overall, the
  chance of a kill per shot is exactly Pk.
- Other hits on vehicles cause a **mobility or firepower kill**, picking a system
  that still works. Losing both means destroyed.
- Hits on people and aircraft either destroy them or have no effect.

**Wire-guided missiles.** TOW, Konkurs and Shturm are command guided: the
launcher must stay alive, able to fire, and in line of sight of the target until
impact. Otherwise the missile *loses guidance and misses*. Killing the launcher
of a missile in flight saves its target.

**Remote targets.** Damage to remote (DIS) entities is decided by the
simulation that owns them. WeRForces only sends the detonation.

## Suppression and morale

**Suppression** (0–1) builds up on whatever is under fire: a near miss or hit on
it (0.25 for a miss, 0.35 for a hit), and blast within three times a round's
radius. It halves every 6 s. A suppressed entity is less accurate (Pk ×
(1 − 0.6 × suppression)), reloads slower (× (1 + suppression)) and spots less
(× (1 − 0.5 × suppression)). Infantry at 0.6 or more are **pinned**: they stop
moving and are half as easy to hit, until suppression falls below 0.45.

**Morale** (0–1, per unit; entities not in units have their own) falls with
losses (1.5 ÷ unit size per member lost) and with sustained suppression, and
recovers slowly when not under fire (up to a ceiling set by losses):

| Morale | State | Effect |
| --- | --- | --- |
| ≥ 0.5 | steady | – |
| ≥ 0.25 | shaken | less accurate (× 0.8) |
| < 0.25 | broken | drops its plan, switches to return fire and falls back 1.5 km away from the nearest known enemy by a covered route; **rallies** at 0.4 |

## Optional models

Simulation settings (and `PUT /api/v1/simulation/rules`) turn parts of the model
on and off per scenario, for comparison runs:

| Rule | Default | What it does |
| --- | --- | --- |
| `suppression` | on | Suppression and pinning (above) |
| `morale` | on | Shaken and broken units (above) |
| `fuel` | on | Fuel use and running out (below) |
| `orderDelay` | off | Orders take time to pass down the [chain of command](#chain-of-command) |

## Night and weather

The scenario's **environment** sets the date and local time of day at the start,
visibility (m), precipitation (none, rain, heavy rain, snow) and wind. The sun's
altitude at the terrain's location gives the **light**: full by day, falling
through civil and nautical twilight to 8 % at night. The clock runs on with the
simulation, past midnight.

| Sensor | Range |
| --- | --- |
| Eyes, binoculars | max range × light, at most the visibility |
| Image intensifiers (night-vision goggles) | as eyes, but keep 60 % of their range in the dark |
| Thermal sights (tanks, IFVs, Apache, observers, UAVs) | max range, unaffected by darkness, at most 3 × the visibility |
| Radar | max range |

Rain cuts optical ranges (× 0.8; heavy rain × 0.55; snow × 0.6; thermals a
little less), and slows movement off roads (rain × 0.9, heavy rain × 0.75, snow
× 0.7). A shooter's **muzzle flash** shows it up at night: for 5 s after firing
it can be seen as if at half daylight. **Wind** drifts smoke clouds.

## Smoke, minefields, obstacles and engineers

**Smoke.** Smoke rounds (155 mm, 152 mm, 81 mm, 120 mm) make a cloud of 40–75 m
radius for 2–3 minutes; tanks and IFVs with smoke grenades fire them (two
salvos) when a guided missile is launched at them: a 25 m cloud between them and
the shooter for 45 s. A cloud blocks sight lines that pass through at least 20 m
of it (or all of it, if smaller) below its 25 m top. Radar sees through it.

**Minefields** are areas with a density: the chance of a mine strike per 100 m
driven through (default 0.5). A strike kills or immobilises vehicles depending
on their armour (an armoured vehicle: 10 % kill, 75 % mobility kill) and kills
people half the time. The force that laid it, and any force that strikes a mine
in it, **knows** it: their routes avoid it, with a margin (25× the cost),
unless there is no other way. Moving units replan as soon as a minefield
becomes known, so after the first strike the rest go round. Engineers sent to
breach a minefield make it known to their side. Players only see enemy
minefields they know about.

**Obstacles** are lines (anti-tank ditches, wire): vehicles stop at them and
routes go round; infantry climb through at a third of their speed.

**Engineers** (US Combat Engineer, M1150 Assault Breacher, RU Sapper) breach a
30 m **lane** through a minefield or obstacle: 4 minutes for sappers on foot,
90 s for the M1150, slower under fire. Lanes are safe passages; routes thread
through them, and a unit's followers find their own way through the lane to
their place in formation.

## Fuel, ammunition and resupply

Vehicles burn fuel by distance (a full tank lasts the type's range: M1A2 426 km,
T-72B3 500 km...) and aircraft by time aloft (AH-64 2.5 h, F-16 2 h). Below
20 % the log warns; out of fuel, vehicles stop and aircraft come down.

**Supply vehicles** (M977 HEMTT, Ural-4320 supply truck) carry ten vehicle loads
of fuel and ammunition. When one is halted, friendly entities halted within 60 m
take on fuel (a full tank in 60 s) and ammunition (a full load in 40 s), using
up its stock (a full load of fuel and ammunition is one load). The *Resupply*
task drives there; helicopters fly there and set down beside it. Plans can wait
until *fuel below* or *ammunition below* a level.

## Electronic warfare

**Jammers** are entity types with a `jammer` (see the
[catalog](reference/catalog.md)):

| Type | Jams | Reach |
| --- | --- | --- |
| R-330Zh Zhitel (`ru-r330zh`) | radios | 15 km |
| 1L269 Krasukha-2 (`ru-krasukha`) | radars | 25 km |
| M1133 Stryker EW, MFEW (`us-mfew`) | radios | 10 km |

A jammer starts switched on. It jams while it is alive, switched on, not
firepower-killed and not mounted, and only entities of forces hostile to it,
within its reach (measured on the map). Who is jammed is worked out once a
simulated second. Switch it with the inspector's **Jamming** section, `PATCH
/api/v1/entities/{id}` with `{"jamming": false}`, or MCP `set_jamming`.

**Radio jamming.** A unit is jammed when its leader is (a loose entity when it
is itself). A jammed unit:

- gets its **orders 60 s late** (by runner or relay). Orders pass down the
  chain of command level by level, so a jammed company's order reaches its
  jammed platoons after 60 s more; this adds to any [order
  delay](#chain-of-command);
- does not **share contacts**: each member only knows what it sees itself;
- cannot **call for fire**, and a jammed battery or gun is not called;
- does not hear **codewords** (a plan waiting for one waits on);
- sends nothing on the radio (no contact reports or acknowledgements).

The event log notes *US Combined Arms Team: radio jammed* and *radio back*, the
[alerts](#explanations-and-alerts) list a *jammed* alert while it lasts, and
the inspector shows *RADIO JAMMED*.

**Radar jamming.** A jammed radar sees only part of its range: the distance to
the jammer as a share of the jammer's reach, and never less than 30 %. Closing
on the jammer burns through. The inspector shows *RADAR JAMMED*.

## Pattern of life

**Background civilians** fill the map so targets must be told from bystanders.
Set how many with **Simulation settings** (or `PUT
/api/v1/simulation/pattern-of-life`, MCP `set_pattern_of_life`, the scenario's
`patternOfLife`): up to 300 cars and 300 people. The engine keeps the numbers up,
adding (quietly, without *created* events) and removing them as needed.

- **Cars** (`civ-car`) start on the roads. Each drives to another town (more
  than 1 km away) or another stretch of road, waits 10–60 s, and sets off
  again.
- **People** (`civ-person`) start within 250 m of a town's centre and walk
  about it, pausing 20–120 s.
- They are Neutral, on *hold fire*. Within 700 m of a shot or a detonation
  they **run** 1.5 km away from it at top speed, and keep away for two
  minutes.

Neutral is not hostile to Blue or Red by default, so nobody aims at them, but
blast and stray rounds can kill them, and the log reports it. Jammers ignore
them, and they raise no alerts. A scenario saved at time 0 keeps only the
numbers; checkpoints keep the civilians themselves.

## Indirect fire and call for fire

Howitzers and mortars (M109A7, 2S19, 81 mm and 120 mm mortar teams) carry
**indirect-fire** weapons. These never fire on their own at what they see: they
fire **fire missions** at a location, with no line of sight needed.

- **Flight.** A round takes range ÷ 320 m/s (howitzers) or 200–220 m/s (mortars)
  to land: about a minute at 20 km.
- **Accuracy.** Each round lands off the aim point by a normal error with a
  standard deviation of the weapon's `dispersion` at maximum range (120 m for
  155 mm), half that at short range.
- **Effect.** Every entity, of any force, within the **blast radius** (50 m for
  155 mm, 25 m for 81 mm) is damaged with probability Pk × (1 − d / radius)²,
  where *d* is its distance from the burst; people in forest get × 0.7. Entities
  within three blast radii come under fire (for *underFire* and *return fire*).
  Armour is hard to kill this way; troops in the open and soft vehicles are not.

**Call for fire.** An entity with the `callForFire` reaction (forward observer
teams have it by default) watches its contacts once a second. For a hostile
ground or surface target it has seen in the last 2 s, it calls the **nearest idle
friendly firing unit** that can reach it: a battery (every tube in range fires
3 rounds over a 50 m sheaf) or a single gun or mortar. "Idle" means no running
task (holding formation counts as idle), no plan in progress and not on *hold
fire*. It will not call:

- within **150 m of friendly troops** (danger close);
- on a point already covered by a mission or rounds in flight (within 150 m);
- more than once a minute.

## Mounted infantry

Carriers have **seats**: M2A3 6, BMP-2 7, UH-60 11, Mi-24 8, Ural truck 20. Only
dismounted infantry (lifeform entities) can ride. Passengers:

- move with the carrier and keep their own state;
- cannot see, shoot, or be seen or shot at; they do not appear on the map, over
  DIS or on TAK (the carrier's label shows *+N*);
- do not carry out their own tasks until they get out.

If the carrier is **destroyed**, each passenger dies with it with probability
0.5 and the rest bail out; after a **mobility kill** they all bail out.

## Fog of war and roles

A server started with `--player blue:KEY` (and `--api-key` for exercise control)
gives each player key a **player role**:

- they see their own force in full, other forces only as **contacts** their
  force currently holds, at the position last seen, named by type
  (*T-72B3 (E15)*), fading on the map as they go stale;
- their event log only has events involving their own force, with enemy names
  hidden;
- they can only order their own force and refer to objects they can see; time
  control, editing, recordings and exports stay with exercise control.

This applies to the GUI, the REST API and MCP alike.

## Recording and after-action review

The server records the run as it goes: every entity's position, heading, speed
and damage once per simulated second (`--record-interval`), plus the event log
and bookmarks. Long runs stay within a memory budget by halving the frame rate.
Rewinding or loading a checkpoint cuts the recording back to that time; a new
scenario starts a new recording.

The **after-action review** replays the recording on the map with a timeline,
and builds a report: strength and losses per force, every kill with killer,
weapon and time, rounds fired per weapon and strength over time. Recordings can
be saved on the server and reviewed later.

## Explanations and alerts

**Why?** For any entity or unit the server can explain what it is doing and
what stops it (`GET /api/v1/entities/{id}/explain`, `/units/{id}/explain`, MCP
`explain`, the inspector's **Why?** section). The answer has a one-line
`summary`, the `activity` (task or plan step in words), and findings under
`movement`, `fire` and `sensing` (units also `unit`: strength, morale, orders
on their way, subordinates, and how many members share each problem). Each
finding has a `severity`:

| Severity | Meaning | Examples |
| --- | --- | --- |
| `block` | Stops the activity | destroyed, immobilised, out of fuel, pinned, halted on contact, broken, hold fire, out of range, no line of sight (and what blocks it, where) |
| `warn` | Hampers it | low fuel, stuck, return-fire ROE, suppressed, radio or radar jammed, sensors cut by darkness or weather, no task |
| `info` | Explains it | waiting for a plan condition, keeping formation, holding a position, slowed by forest, reloading, engaging |

Most come with a `fix` (*Set ROE to "fire at will"*), and those about a place
or another entity give `at` (x, y) and `aboutId`. Exercise control is also told
about the nearest enemies the entity has *not* detected, and why: beyond its
sensors, outside their field of view, hidden by the ground, forest, buildings
or smoke, or in sight but not spotted yet (each scan only has a chance).
Players only hear about what their side knows. Asking changes nothing in the
run: the random generator is not touched.

**Alerts** are the attention queue: idle after its orders (10 s with nothing to
do), task failed, broken, out of fuel or low on fuel, out of ammunition,
leader lost, losses, under fire or first contact after a quiet minute, and
radio jammed. Each is about a unit or a loose entity, with a severity
(critical, warning, info), the time it was last raised and a count. An alert
about a lasting condition (broken, fuel, ammunition, jammed) closes by itself
when the condition clears. Acknowledged alerts are kept (up to 200 in all) and
listed with `GET /api/v1/alerts?all=true`. Alerts are checked once a simulated
second and only read the simulation.

## Travel estimates

An entity moving along a planned path (a unit: its leader) reports a
**travel estimate**: `remaining`, the metres left along the path, and `eta`,
the simulation time it should arrive, with `etaLocal`, the local time of day.
The path is sampled every 100 m at the speed the ground there allows for that
vehicle (roads, off-road, forest, slope, land cover, weather), capped at the
speed it was told to go, plus a little to get going from a stop. Out of fuel
there is no arrival time: `stalled` says why. It does not foresee halts for
contact, suppression or traffic. It appears on entity and unit snapshots
(`travel`), in the inspector and at the end of the path on the map.

## Time

- The engine advances in fixed **0.1 s** steps, and every random draw comes from
  a seeded generator. The same scenario and seed always give the same result.
  Loading a scenario seeds the generator from the terrain seed; `Engine.reseed()`
  starts a different replication.
- **Real-time** running uses a multiplier from 0.5× to 64×.
- **Step** advances time immediately, as fast as the CPU allows:
  - ⏭ in the GUI;
  - `POST /api/v1/simulation/step` (up to 3600 s per call);
  - the MCP tool `advance_time`;
  - headless `--duration`.

A 40-minute engagement with about 35 entities computes in roughly a second.
`npm run bench` measures larger scenes: on a typical laptop core, 1000 moving
and fighting entities run about 20× faster than real time. Sensor scans use a
spatial grid, so their cost grows with how crowded the battlefield is, not with
the square of the entity count.

**Checkpoints.** Saving a scenario while it runs (or `GET /api/v1/scenario`)
writes a full checkpoint: damage, ammunition, contacts, plan and task progress
(a route resumes from its current waypoint, a fire mission keeps the rounds
still to fire), munitions in flight, passengers and the random number state.
Loading it continues the run from that state, but route planning restarts
from the current positions (and patrols rejoin their route at the nearest
point), so it drifts from the run that was saved. Loading the same checkpoint
twice gives the same run.
