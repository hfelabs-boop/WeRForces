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

Legged robots (robot dogs, `mobility: "legged"`) are ground vehicles that move
by the dismounted rules (steep slopes, forest, among buildings) at their own
speed and off-road factor.

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

**Line of sight.** Line of sight is sampled every half grid cell (25 m on a
50 m grid) along the line from the observer's eyes to the target. Terrain blocks
it outright. Forest canopy (15 m) blocks it only once the line has passed through
**more than 150 m of forest**, so vehicles at a wood's edge, or close together
inside a wood, can still see each other. Smoke clouds block it too (except for
radar), and so do buildings (above).

**Earth curvature.** Over long distances the earth curves away below a sight
line. A point at distance *d* lies *d*² / (2*kR*) below the observer's horizontal,
with *R* = 6371 km and *k* = 4/3 for standard atmospheric refraction, which bends
light and radar a little round the earth; a sight line of length *d* therefore
clears the ground by up to *d*² / (8*kR*) less in its middle than on a flat earth.
That is 6 cm at 2 km, 1.5 m at 10 km and 13 m at 30 km, so the effect is
applied to lines longer than 2 km (shorter ones are unchanged). It sets the
horizon: an eye 2 m up sees ground out to about 5.8 km, and another 2 m eye out
to about 11.7 km over flat ground; a 100 m mast sees a 2 m eye 47 km away; an
aircraft 100 m up is below a 10 m radar's horizon beyond about 54 km. The same
correction applies to radar line of sight, the viewshed and the covered-route
threat map. It is a [rule](#optional-models) (`curvature`), on by default.

**Large terrain.** Terrain bigger than one grid can hold (for example 200 km ×
200 km at 30 m, 44 million posts) comes as a **tiled dataset**: tiles of 256 ×
256 cells read on demand into a memory-bounded cache (see
[Terrain import](terrain-import.md#large-areas-tiled-datasets)). Everything above
works the same on it, with identical results for the same posts. Long sight
lines skip tiles they pass high above without reading them. Long routes are
planned on a coarser level of the tiles first, then refined leg by leg on the
full grid in windows along that route, so a 250 km route takes a few seconds
rather than a search over the whole grid.

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
| **Strike** *entity* | One-way attack drones: fly into the target and detonate the warhead ([Unmanned systems](#unmanned-systems-and-swarms)). *Attack* does the same for them | Warhead delivered (or the target is gone) |
| **Loiter** *area or point* | Unmanned: sweep the area again and again (or circle the point); with `attack`, go for the first suitable enemy found, by `prefer` | `duration` elapsed, the drone spent; otherwise never |
| **Swarm search** *area* | A unit of drones shares the area out and sweeps it; with `attack`, each strikes a different target | Every member done |
| **Swarm attack** *targets or area* | A unit of drones spreads over the targets, one each before any gets two | No target left (with an area: never) |
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
| `sendCodeword` *word* | Send a [codeword](#codewords) to the owner's force and continue. While the owner's radio is jammed the plan waits here |
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
[jammed](#electronic-warfare) does not hear codewords until its radio is back,
and a plan cannot send one while its unit's radio is jammed: it waits at that
step.
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
`previousDone` phase waiting: give such orders in a phase of their own, with
another trigger after it (a quick battle puts its support's orders in a first
*Deploy* phase for this reason). An order to a unit with no one left alive
counts as failed, so it doesn't hold up the next phase. Phases
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
   (e.g. air-search radars only see aircraft). A radar's range depends on the
   target's size (see [Radar range](#radar-range) below);
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

**Small targets.** What the eye and thermal sights resolve scales with the
target's size, so a type with a `size` under 3 m is seen only that much closer:
the sensor's range is multiplied by size ÷ 3 m. A 0.4 m quadcopter is seen by
binoculars (3 km) from 400 m, by the unaided eye from 200 m; a 0.3 m FPV drone
from 150 m. Types without a size are seen at full range. (Radars use the radar
cross-section instead.)

A contact is dropped if it is not seen again for 15 s. The first time an entity
detects a hostile, the event log shows *X detected Y*.

### Radar range

Radars follow the **radar range equation**: the echo's signal-to-noise ratio
falls as RCS ÷ range⁴, so the range at which a radar detects a target grows with
the fourth root of the target's **radar cross-section** (RCS). A radar with a
reference range `refRange` against a target of `refRcs` m² detects a target of
σ m² out to

*R* = refRange × (σ ÷ refRcs)^¼, but never beyond the radar's `maxRange`.

A sixteenth of the cross-section halves the range. The SA-8's search radar, for
example, sees 25 km against 5 m²: a Black Hawk (10 m²) at 29.7 km, an Apache
(3 m²) at 22 km, an F-16 (1.2 m²) at 17.5 km. Entity types give their `rcs`;
otherwise it defaults by symbol (fixed wing 5 m², helicopter 10, UAV 1, ship
5000, boat 50) or domain (aircraft 5, vessels 500, ground vehicles 20, people
1). The range then goes into the detection probability above in place of the
sensor range, and [radar jamming](#electronic-warfare) multiplies it as before.
Radars without a `refRange` see every target out to `maxRange`.

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
| Range | the [range factor](#ballistics) |
| Shooter moving > 2 m/s (unguided) | × 0.7 |
| Target moving > 8 m/s (unguided) | × 0.8 |
| Ground or person target in forest | × 0.75 |
| Shooter suppressed | × (1 − 0.6 × suppression) |
| Shooter's unit shaken / broken | × 0.8 / × 0.6 |
| Target pinned | × 0.5 |
| Target dug in / hull-down | × 0.4 / × 0.6 |
| Infantry target among buildings | × 0.6 |
| Armour of the face hit | × the [perforation chance](#armour-by-aspect) |

**Outcome.**

- The round hits with probability min(1, 1.8 × Pk), with Pk taken before the
  armour factor (hitting does not depend on the armour).
- A hit that does not defeat the armour has no effect (*hit T-72B3: front
  armour held*). One that does destroys the target with probability Pk ÷ hit
  chance. Overall, the chance of a kill per shot is exactly the effective Pk.
- Other hits on vehicles cause a **mobility or firepower kill**, picking a system
  that still works. Losing both means destroyed.
- Hits on people and aircraft either destroy them or have no effect.

**Wire-guided missiles.** TOW, Konkurs and Shturm are command guided: the
launcher must stay alive, able to fire, and in line of sight of the target until
impact. Otherwise the missile *loses guidance and misses*. Killing the launcher
of a missile in flight saves its target.

**Remote targets.** Damage to remote (DIS) entities is decided by the
simulation that owns them. WeRForces only sends the detonation.

### Armour by aspect

Armoured vehicles give their `protection` on each face in mm of rolled
homogeneous armour (RHA) equivalent, and anti-armour weapons their
`penetration` (see the [catalog](reference/catalog.md)). The face a round strikes
comes from where it was fired, relative to the target's hull heading:

| Face | When |
| --- | --- |
| top | indirect fire, top-attack weapons (Javelin, Hellfire), or a round arriving steeper than 45° |
| front | the shooter within 30° of the target's nose |
| rear | the shooter within 30° of its tail |
| side | anything else |

A hit defeats the armour with probability Φ(ln(penetration ÷ protection) ÷
0.35), Φ being the standard normal distribution: one half when they are equal,
about 0.1 when the armour is half again as thick as the round penetrates, and
about 0.98 when the round penetrates twice the armour. The spread stands for
weak spots and the angle of impact. Weapon Pk is the kill chance once the armour
is defeated. Some figures at short range:

| Shot | Front | Side | Rear |
| --- | --- | --- | --- |
| RPG-7 (450 mm) on an M1A2 (700 / 300 / 100 mm) | 2.6 % | 22 % | 25 % |
| 120 mm (750 mm) on a T-72B3 (550 / 150 / 60 mm), 1 km | 57 % | 70 % | 70 % |
| 125 mm (650 mm) on an M1A2, 1 km | 25 % | 59 % | 60 % |

Weapons without a penetration, and types without protection, skip this step
(factor 1). Blast and fragments from indirect fire meet the **top** armour, so
a 120 mm mortar (45 mm) rarely hurts an M1A2 (60 mm roof) but easily wrecks a
BMP-2 (10 mm).

### Ballistics

The **range factor** depends on the weapon. Unguided direct-fire weapons with a
`spreadMrad` (tank guns, autocannons, RPG-7, AT4) use a ballistic model; the
others (guided missiles, machine guns and rifles, whose bursts are area fire)
keep 1 − 0.5 × (range / max range)².

The round's one-sigma miss distance at range *R* combines two errors:

- **spread:** `spreadMrad` ÷ 1000 × *R* (aim and round-to-round dispersion);
- **drop:** gravity pulls the round down by ½ g t², t = *R* ÷ projectile speed.
  The sight allows for it at the range the gunner estimated; with an estimate
  off by `rangeError` (one sigma, 1 % with a laser rangefinder, 10 % by eye) the
  round lands high or low by 2 × drop × rangeError.

σ = √(spread² + (2 × drop × rangeError)²), and the round lands within the
target's presented radius *a* (1.5 m for vehicles, 0.4 m for people, 2.5 m for
aircraft, 5 m for vessels) with probability 1 − exp(−a² ÷ 2σ²). The range factor
is that probability relative to its value at 100 m, where Pk is quoted. Slow
rounds lose the most: an RPG-7 (240 m/s, 2 mrad, by eye) keeps about 0.34 at
300 m; a 30 mm 2A42 (960 m/s, stadia rangefinder) 0.15 at 2 km; a 120 mm tank
gun (1650 m/s, laser rangefinder) over 0.9 at 2 km.

### Models

The hit/kill (armour by aspect), ballistic, radar and navigation models are
named functions in `src/sim/models.ts`, each behind one small interface
(`HitKillModel`, `BallisticModel`, `RadarModel`, `NavigationModel`). An engine
uses `engine.models`, which starts with the defaults (`aspect-armour`,
`drop-and-spread`, `radar-equation`, `inertial-drift`); a
study can put its own in, e.g.
`engine.models = { ...engine.models, ballistic: myModel }`.

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
| `curvature` | on | [Earth curvature and refraction](#terrain) in line of sight and radar horizon, beyond 2 km |

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
| Pole-21 (`ru-pole21`) | satellite navigation (GNSS) | 25 km |
| Shipovnik-Aero (`ru-shipovnik`) | drone datalinks; GNSS, spoofing | 10 km |
| Silok (`ru-silok`) | drone datalinks, GNSS | 4 km |
| L-MADIS (`us-lmadis`) | drone datalinks, GNSS | 3 km |
| Stupor anti-drone rifle team (`ru-stupor-team`) | drone datalinks, GNSS | 1.5 km |
| DroneBuster team (`us-dronebuster-team`) | drone datalinks, GNSS | 1 km |

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
the jammer as a share of the jammer's reach, and never less than 30 %, of the
range it would have against that target (see [Radar range](#radar-range)).
Closing on the jammer burns through. The inspector shows *RADAR JAMMED*.

**Datalink jamming** cuts a radio-linked unmanned system's control link
(`unmanned.link: "rf"`; fibre-optic and autonomous ones cannot be jammed, and
`antiJam` makes the jammer come closer). What a drone does without its link is
set out in [Unmanned systems](#unmanned-systems-and-swarms). The inspector shows *DATALINK JAMMED*.

### Satellite navigation (GNSS)

Entity types with `gnss: true`, and unmanned systems, navigate by satellite. A
GNSS jammer hostile to them denies it within its reach, and they fall back on
**inertial navigation**: where they think they are drifts away from where they
are. The default navigation model (`inertial-drift`) puts the error after *t*
seconds without satellites at

> error = drift × *t* × (1 + *t* / 300 s), at most 5 km

with `drift` the type's `insDrift` (default 1 m/s, a small drone's MEMS unit):
70 m after a minute, 170 m after two, 1 km after eight. The error points in a
direction drawn when the fix is lost. Tasks steer by the believed position, so
a move ends that far off its destination and a route, orbit or search is flown
that far off track. Tasks that keep station by sight (formation, follow,
attack, mount, resupply) are not thrown off. When the jamming stops (the
jammer is switched off, destroyed or left behind) the fix comes back at once.
The event log notes *Scout drone: GNSS jammed, navigating by inertial* and
*GNSS back*, the [alerts](#explanations-and-alerts) list *GNSS denied*, the
inspector shows *GNSS DENIED (~120 m)*, and Why? says *GNSS denied: navigating
by inertial for 90 s, error ~120 m*.

A jammer with `spoof: true` **spoofs** instead: the receiver keeps a fix, but a
false one that walks away from the spoofer at 5 m/s, up to 3 km. The navigator
does not know: it raises no alert, and its own side is not told (exercise
control sees *GNSS SPOOFED*). Steering by the false fix, it ends up displaced
toward the spoofer.

**GNSS-guided munitions** (`gnss: true` on the weapon: Excalibur, GMLRS,
9M544) land within a few metres with satellites. When their path, as a
straight line from the launcher to the aim point, comes within reach of a GNSS
jammer hostile to the shooter, they fly the rest of the way on inertial
guidance and add its error (`insDrift`, default 3 m/s) to their dispersion: an
Excalibur round flying its last 27 s into a jammed area is about 90 m off.
Against an entity target, the kill chance is multiplied by the chance the
error still puts the round within its blast radius of the target.

### Emission control

Each unit or entity has **emission control** (EMCON) settings, in the
inspector, `PATCH /api/v1/entities/{id}` or `/units/{id}` with `{"emcon":
{...}}`, or MCP `set_emcon` (on a unit they apply to its members and
subordinate units):

- **Radio silence**: it transmits nothing, so enemy direction finders cannot
  find it by its radio. The price is the radio itself, as if jammed: orders
  reach it a minute late, it shares no contacts, calls no fire, hears no
  codewords and sends no reports. The inspector shows *RADIO SILENCE*.
- **Radar off**: its radars neither radiate nor detect. It cannot be found by
  its radar, sends no Electromagnetic Emission PDU for it, and an
  anti-radiation missile on its way loses it.
- **Jamming** on or off (as the **Jamming** switch).

What an entity **radiates** (`emitting` in its state): its radars while on,
its jammer while jamming, its **radio** for 10 s after each transmission (a
contact report, a call for fire, acknowledging an order, a codeword), and the
**datalink** of a radio-linked unmanned system and of a ground control station
(`groundControl`) flying one within its reach.

### Direction finding

Direction finders are sensors with `df`: the Prophet (`us-prophet`) and R-381T
Taran (`ru-r381t`) take bearings to enemy radars, jammers, radios and
datalinks out to 30 km with a 1.5° error; the ARM targeting receiver of the
F-16CJ and Su-34 to radars and jammers out to 120 km with a 1° error. Once a
second each station takes a bearing to every enemy emitter it hears within
range and line of sight, and reports it on the radio: a station that is radio
jammed or keeps radio silence adds nothing. A force's bearings are pooled into
**DF contacts**, one per emitter:

- **one station** gives a fix along its bearing, at a range estimated from the
  signal strength (good to about 35 %): a long, thin ellipse;
- **two or more** stations cross their bearings (weighted least squares, each
  bearing weighted by the cross-track error it implies): a much tighter fix,
  best when the bearings cross near a right angle. Two Prophets 10 km apart fix
  an emitter 9 km away to a few hundred metres.

Each contact has an **uncertainty ellipse** about 86 % likely to hold the
emitter, drawn on the map; it is dropped 30 s after the last bearing, or when
the emitter is destroyed. DF contacts belong to the force that found them
(`GET /api/v1/df-contacts`, MCP `get_df_contacts`). They are not sensor
contacts: nothing shoots at them directly. Instead:

- a DF station with the **call for fire** reaction (Prophet and Taran have it)
  calls for fire on a fix of a ground emitter no longer than 1 km
  (semi-major), with the rounds spread over half its length; or give a **fire
  mission** at the fix yourself;
- anti-radiation missiles are fired at them (below).

### Anti-radiation missiles

An anti-radiation missile (`antiRadiation`: AGM-88 HARM on the F-16CJ, Kh-31P
on the Su-34) is fired at a radar or jammer its force has located and still
hears, within its range, and never at anything else. It homes on the emission:
if the emitter still radiates when it arrives, it is hit as by any guided
missile. If the emitter has fallen silent (radar off, jammer off), the missile
flies on to where it last heard it and bursts there with a 30 m error of its
own: a stationary SA-8 that switches its radar off just after launch is
rarely hurt. The event log says *AGM-88 HARM anti-radiation missile lost its
emitter and burst at (x, y)*.

### Counter-UAS

Small drones have their own armour class, `drone`: small (a radar sees one of
0.01 m² at a third of the range it sees a 1 m² target), and killed or missed
outright. Against them:

- **counter-drone jammers** cut their datalinks and GNSS: L-MADIS and Silok
  vehicles (3–4 km), the handheld DroneBuster and the Stupor rifle (1–1.5 km,
  carried by an infantry team), Shipovnik-Aero (10 km, spoofing);
- **gun air defence** with a radar that sees small drones (`cuas-radar`,
  3.5 km against 0.01 m²; `spaag-radar`, 4 km): Stryker M-SHORAD (30 mm
  proximity rounds, kill chance 0.45 a burst at short range, and Stinger) and
  2K22 Tunguska (twin 30 mm, 0.4, and 9M311 missiles);
- **interceptors**: the Coyote launcher (Block 2 interceptors out to 10 km,
  0.85) and an FPV interceptor-drone team (3 km, 0.6);
- existing air-defence weapons have a kill chance against drones too (Stinger
  0.5, Osa 0.45; a 12.7 mm machine gun 0.08).

### Active protection and decoys

**Active protection systems** (`aps` on a type: Trophy on the M1A2 SEPv3, 8
charges, 0.9; Arena-M on the T-72B3 variant, 22 charges, 0.75, over the 270°
about the front) fire a charge at an incoming guided missile, slow rocket
(RPG, AT4) or loitering munition just before it strikes, if it comes from
inside the protected arc (and, for top attack, only if the system covers the
roof). The charge defeats it with the system's probability: the event log
says *M1A2 SEPv3 Abrams (Trophy) 3: Trophy defeated an incoming RPG-7 (5
charges left)* and *RPG-7 intercepted short of …*. Charges run out; kinetic
rounds and artillery are not engaged. The inspector shows the charges left,
and an *APS spent* alert is raised when the last one is used.

**Flares and chaff** (`decoys` on aircraft: AH-64E, Mi-24P, F-16CJ, Su-34) are
released automatically when a guided missile is fired at the aircraft, one
salvo a missile while salvos last, multiplying that missile's kill chance by
the type's `pkFactor` (0.35–0.4).

Both act on the shot and leave the armour and ballistic models alone: a
missile that gets through is adjudicated as before. Plain M1A2, T-72B3, AH-64D
and Mi-24V have neither, so existing scenarios play out as they did.
## Unmanned systems and swarms

**Unmanned systems** are entity types with `unmanned` set (see the
[catalog](reference/catalog.md#unmanned-systems)): small recon quadcopters, FPV
one-way attack drones on a radio link or a fibre-optic cable, loitering
munitions (Switchblade 300 / 600, Lancet-3), small fixed-wing UAVs (Raven,
Orlan-10), a swarm drone, the MQ-9, armed and logistics UGVs (THeMIS, Uran-9,
S-MET) and robot dogs. Small drones have the armour class `drone`, which
counter-drone weapons are rated against. **Ground control stations** are types
with `groundControl` (its `range`): the drone operator teams (`us-uas-operator`,
`ru-uas-operator`, 50 km) and the control station vehicles (`us-uas-gcs`,
`ru-uas-gcs`). Datalinks end at them, and they radiate on the datalink (enemy
direction finders can find them). The drone templates (`us-uas-team`,
`ru-fpv-team`, `us-drone-swarm`, …) place an operator team 60 m behind the
drones, outside the unit, and assign the drones to it.

**The datalink.** Once a simulated second every unmanned system works out its
link:

| Link | Up when |
| --- | --- |
| `rf` (radio) | its operator (or a relay) is within its `linkRange` (and the station's `groundControl.range`) with line of sight (a crest, more than 150 m of forest or a block of buildings cuts it; smoke does not), and no enemy datalink jammer reaches it |
| `rf` with `satcom` (MQ-9) | no enemy datalink jammer reaches it: the ground station is far behind the lines |
| `fiber` | its operator is alive and within the cable's length. Jamming cannot touch it; once it flies past the end of the cable, the fibre breaks and the link is gone for good |
| `autonomous` | always: it needs no link |

Its operator is the one it is assigned to (templates assign it; inspector
**Datalink**, `PATCH /api/v1/entities/{id}` with `controllerId`, MCP
`set_drone_control`), or, if none is assigned, any ground control station of its force,
or the leader of its unit if that is not a drone (a squad leader working its
robot dog). If the assigned operator is killed, the link is lost. A fibre-optic
drone is tied to the operator nearest to it within the cable's length.

**Mesh relay.** Drones whose type has `relay` (the swarm drone, the Orlan-10)
pass on other own drones' links: a drone is linked when there is a chain of
radio hops, each within both ends' range and in line of sight, from an operator
through relaying drones to it. A jammed drone does not relay.

**Jamming.** A jammer with the `datalink` band cuts radio links within its
reach, less an anti-jam share: with `antiJam` 0.5 the jammer must be within half
its reach (frequency hopping, directional antennas). See [Electronic
warfare](#electronic-warfare).

**Without a link** a system does what its **autonomy** allows, and falls back
on its **lost-link behaviour** (both from the type; override them per drone in
the inspector or with `lostLink` / `autonomy`):

| Autonomy | Without a link |
| --- | --- |
| `remote` (FPV, quadcopters, UGVs) | it is flown or driven by a person, so its task waits and its lost-link behaviour takes over; it sends no picture (it spots nothing) and fires at nothing |
| `supervised` (loitering munitions, Raven, MQ-9, S-MET, recon robot dog) | it carries on with its task, and finishes an attack on a target it was given, but starts no new attack and fires at nothing else; with nothing to do, its lost-link behaviour takes over |
| `autonomous` (swarm drone) | it carries on: searches, finds and attacks targets by itself; its lost-link behaviour only when it has nothing to do |

| Lost-link behaviour | What it does |
| --- | --- |
| `hover` | holds where it is (fixed wing: circles there; ground: stops) |
| `return` | goes back to its operator (where it last had a link to it), then holds there |
| `land` | comes down where it is (fixed wing: returns instead; ground: stops) |
| `continue` | carries on with its task, blind (with nothing to do, holds) |

When the link comes back, a landed drone takes off again and the task carries
on. A remotely piloted drone therefore cannot be flown out of radio range: at
the edge it loses the link, turns back, regains it and is stopped there.
Orders sent to a system without a link wait until it is back (*Order to … (waits
for its datalink)*); what it sees is not shared with its unit; a drone spotting
for artillery cannot call for fire. The event log notes *datalink lost (jammed
by …)* and *datalink back* (once per unit), the [alerts](#explanations-and-alerts)
list *datalink lost*, the inspector shows the link and **Why?** says why it is
down and what to do. Snapshots have `link`: `mode`, `up`, `reason` (`jammed`,
`range`, `terrain`, `noController`, `controllerLost`, `tether`), `controllerId`,
`operatorId` (the one it is assigned to), `hops`, `lostFor`, `autonomy` and
`lostLink`. Satellite navigation denial is the [navigation
model's](#satellite-navigation-gnss): a drone's moves, searches and loiters are
flown that far off. Unmanned units have no morale.

**One-way attack.** FPV drones, loitering munitions and the swarm drone carry a
**warhead** (`unmanned.warhead`), not a gun: *Strike* (or *Attack*) flies at the
target at top speed, leading it, and dives in from its `terminalRange` (FPV
120 m, Switchblade 600 400 m, Lancet 500 m) with line of sight. The warhead is
then a guided shot from where the drone is, through the usual weapon path: the
hit, the armour of the face it strikes (loitering munitions and the swarm
drone's warheads attack the top, an FPV the face it comes in on) and the
damage. Active protection (Trophy, Arena) fires at it as at a missile, but
only systems that cover the roof stop a top attack. The drone is spent: it
leaves the map (`expended` in snapshots), is not counted as a loss, and is
credited with the kill. Tanks fire no smoke grenades at drones. A remotely piloted drone needs its link until it dives.

**Loiter and search.** *Loiter* (`loiter`) keeps a drone over an area,
sweeping it again and again (or circling a point at `radius`), for `duration`
s or until its battery or fuel runs out. With `attack`, it goes for the first
suitable enemy its side has seen in the area in the last 5 s: one its warhead
(or weapons) can hurt, of the kinds in `prefer` in order (armour classes
`armored`, `light`, `soft`, `lifeform`; symbols such as `artillery` or
`air-defense`; type ids; `any` for anything else), the one fewest friends are
going for, then the nearest. Targets further down the list are only taken once
it has swept the whole area (or circled for 5 minutes) without finding a
better one. Armed drones (MQ-9) attack with their weapons instead.

**Drones spotting for artillery.** A recon drone with the `callForFire`
reaction (Raven and Orlan-10 have it) calls for fire on what it sees through its
operator: the call needs its link up and the operator's radio free, and goes
out as the operator's (*US Raven Team Operator (US Raven Team Lead): fire
mission, …*).

**Swarms.** A unit of drones carries out these tasks together (and *Loiter*,
when given to a unit, the same way):

| Task | What the members do |
| --- | --- |
| *Swarm search* (`swarmSearch`) | share the area out: the sweep is divided into at least one track line per member, and each sweeps its own share (members in order across the area, so their tracks do not cross). With `attack`, a member that sees a suitable target no other friend is going for strikes it; the rest search on. The unit reports what it found when the last member is done |
| *Swarm attack* (`swarmAttack`) | spread over the targets (those in `targetIds`, or the enemies the unit knows of in `areaId`, preferred kinds first): every target gets one member, the nearest free one, before any gets two. When a member's target goes down before it gets there, it takes the best remaining one fewest friends are going for. With an area and nothing to attack yet, they wait over it |
| *Loiter* | each member loiters, starting at a different point of the sweep |

Any task given to the unit retasks them all at once. While moving, a unit's
drones also keep apart (flocking): a drone closer than about 60 % of the unit's
spacing to another turns away from it, keeping its distance to where it is
heading. Only autonomous drones carry on attacking without their link; the
swarm drone's mesh relay keeps far members linked through near ones.

**Ground robots.** UGVs and robot dogs take the usual ground tasks: *Patrol*,
*Overwatch*, *Follow* (a robot dog or the S-MET following a squad), *Defend*,
*Search*. The S-MET and the RU logistics UGV carry half a vehicle load of
supplies, which they hand out like supply vehicles.

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
  where *d* is its distance from the burst, times the chance the blast defeats
  the [top armour](#armour-by-aspect); people in forest get × 0.7. Entities
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

## Aggregate level

A unit can be **aggregated**: simulated as one object instead of entity by
entity (inspector **Aggregate**, `POST /api/v1/units/{id}/aggregate`, MCP
`aggregate_unit`). Use it for forces away from the action, so a large scenario
stays fast; they split back into entities when the enemy comes near.
Aggregating a unit aggregates the units under it too, each as its own
aggregate.

**What changes.** The members leave the entity-level simulation: they are not
in the entity list, on the map, over DIS or on TAK, and they neither see nor
shoot nor are shot at as entities. They keep their own state (damage,
ammunition, fuel) inside the aggregate. Members already destroyed stay on the
map as wrecks. The aggregate has:

| Property | Value |
| --- | --- |
| Position, heading | where its living members were (their centre) and its leader's heading |
| Speed | its slowest member's: the lowest of each member's cruise speed and top speed × the ground's mobility for its type, where the aggregate is (roads, off-road, forest, slope, weather) |
| Strength | living members per entity type (whole members), and *effective* strength (less losses still being taken, below) |
| Combat power | potential kills a minute against its best targets at short range, summed over members (shown, not used by the model) |
| Sensor range | its best member's sensor against ground targets, in the current light and weather, all round |
| Ammunition, fuel | pooled: shown as a share of the full load; rounds are taken from the member with the most, fuel is burned by each vehicle as it drives |
| Morale | the unit's (losses and fire count as for any unit) |
| Posture | *moving*, *halted*, *defending*, or *dug in* after holding a defended position for 90 s (infantry) or 30 s (vehicles only) |

**Orders.** An aggregate carries out *Move to*, *Follow route*, *Wait*,
*Defend*, *Overwatch* and *Attack* itself: it plans a route for its most
restricted member (vehicles if it has any) and drives it at unit speed;
*Defend* and *Overwatch* take the position and hold it; *Attack* closes on the
target's unit (the aggregate, or the entity) until it is within 80 % of its
longest direct-fire range with line of sight, then holds and fires. Any other
order (patrol, fire mission, mount, screen, search…) splits it into entities
first, and they carry it out. Plans, reactions, ROE and orders down the chain
of command work as for any unit. Air units, units with members mounted,
carrying passengers or immobilised, and units on a task an aggregate cannot do
cannot be aggregated.

**Detection.** Once a second an aggregate sees every enemy aggregate within
its sensor range to which there is line of sight from its position (at its
best sensor height) to the other's (2 m up). An enemy force sees an aggregate
when one of its aggregates does, or one of its entities has a sensor that
reaches it with line of sight, or the aggregate fires on it. There is no random
draw: an aggregate is a large, busy target.

**Aggregate combat (Lanchester square law).** An aggregate fires on the enemy
aggregate it attacks, otherwise the nearest one it sees within its direct-fire
reach (ROE apply: *return fire* answers aggregates that fired on it in the
last minute). Every shooter type *i* spreads its fire over the target types it
can hurt, in proportion to their numbers, and every step each target type *j*
loses

  d*m*<sub>j</sub>/d*t* = − Σ<sub>i</sub> *n*<sub>i</sub> × (*m*<sub>j</sub> ÷ Σ<sub>l</sub> *m*<sub>l</sub>) × *k*<sub>ij</sub>

where *n*<sub>i</sub> and *m*<sub>j</sub> are effective strengths (shooters
that have ammunition for the weapon and no firepower kill) and *k*<sub>ij</sub>
is one shooter's kill rate against one target, with the weapon that does best:

  *k*<sub>ij</sub> = *Pk*(armour of *j*) × (1 − 0.5 × (range / max range)²) × 0.2 ÷ reload time × shooter × exposure × cover

| Factor | Value |
| --- | --- |
| Pk, range | the weapon's Pk against the target's armour class, falling with range as at entity level; 0 beyond its range or below its minimum range |
| 0.2 ÷ reload time | shots a second: the rate of fire, times the share of the time a shooter has a target acquired and laid on (0.2) |
| Shooter | × 0.5 on the move; × 0.8 shaken, × 0.6 broken |
| Exposure (target posture) | moving × 1, halted × 0.9, defending × 0.75, dug in × 0.4 (infantry) or × 0.6 (vehicles, hull-down) |
| Cover (where the target is) | forest × 0.75 (vehicles and infantry); infantry among buildings × 0.6 |

For two homogeneous aggregates (*A* shooters with kill rate α against *B*'s
type, *B* with β back) this is the square law, dA/dt = −β*B*, dB/dt = −α*A*,
with the closed form *A*(*t*) = *A*₀ cosh(√(αβ) *t*) − √(β/α) *B*₀
sinh(√(αβ) *t*); the side with the larger α*A*₀² wins with
√(*A*₀² − (β/α) *B*₀²) left. All aggregates fire, then all losses are taken,
so the order does not matter. The tests check the model against this result.

**Losses.** Losses build up as fractions per entity type; each time they pass
a whole member, a member of that type is destroyed (the seeded random generator
picks which, so runs repeat) and left on the map as a wreck where the
aggregate is. The event log has a hit and a *destroyed by* event naming the
member of the shooting type that did most of the damage and its weapon, so the
after-action review counts kills as usual. Rounds are taken from the members as
they are fired. An aggregate that loses its leader gets a new one; one that
loses everyone becomes an ordinary unit of wrecks.

**Aggregates and entities.** Aggregates do not fight entities: an aggregate
**disaggregates** (splits into its members) when an enemy entity (not
aggregated, alive, not a passenger) comes within `disaggregateRange` (3 km by
default, checked once a second), and the fight is then fought entity by
entity. With automatic disaggregation off, aggregates and enemy entities
ignore each other until told otherwise. Members are put back **in formation**
around the aggregate's position (the unit's formation and spacing, centred on
it, facing its heading), each with its own damage, ammunition and fuel, dug in
or hull-down if the aggregate was, and the unit carries on with its order at
entity level. Aggregating it again puts it back where its members' centre is,
so a round trip keeps strength and position.

**Joining up again.** A unit that split up by itself (near the enemy, or for
an order an aggregate cannot carry out) aggregates again once no enemy entity
has been within `reaggregateRange` (5 km) of it for `reaggregateDelay` (120 s),
and an aggregate could carry out what it is doing. The two distances are
hysteresis: it does not flip back and forth at one range. Disaggregating on
command keeps it at entity level.

| Policy (`PUT /api/v1/simulation/aggregation`, Simulation settings, scenario `aggregation`) | Default |
| --- | --- |
| `autoDisaggregate` | on |
| `disaggregateRange` | 3000 m |
| `autoReaggregate` | on |
| `reaggregateRange` | 5000 m (at least `disaggregateRange`) |
| `reaggregateDelay` | 120 s |

**Everywhere else.** Snapshots show an aggregated unit with an `aggregate`
field (strength, posture, speed, pooled ammunition and fuel, what it engages)
and without its members among the entities; the map draws it as one unit
symbol with a strength bar. Scenarios and checkpoints save it (`units[].aggregate`).
The recorder keeps its members at its position, so replays show it as one
symbol and strength curves stay whole. Players see enemy aggregates as unit
contacts once their force has seen them: where, which types and how many, not
their orders or supplies. **Why?** starts with *Aggregated:* and gives its
strength, posture, fire and sensors.

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

## Commanders

A force can be run by software: a **commander**. It decides at an interval
(default every 45 simulated seconds) and sooner when something happens:
a new enemy contact, a loss, a new phase of the force's
[synchronization matrix](#synchronization-matrix), or one of its units done
with the commander's order. Such early decisions come at most once every 10
seconds, or every quarter of the interval if that is longer.

Each decision starts from the **force's view**, the same one a
[player](#fog-of-war-and-roles) of that force gets: its own units in full
(strength, combat power, fuel, ammunition, morale, under fire or pinned, what
each is doing and whose order that is), the enemy only as the force's contacts
at their last seen positions with their age, its graphics, the towns, its
phases and codewords, and the time. The orders go through the **same commands
and permission check as a player of that force** (`checkCommand`): own units
only, enemy entities only if the force has seen them, no editing or time
control. Typed orders are read by the [order line](user-guide.md#typed-orders)
parser. Refused orders are recorded with the reason.

Orders a commander did not give (a person's, a plan's or a phase's) are left
alone for `holdOff` seconds (default 300) while they last, so people can
**override** it: order a unit by hand and the commander works around it.
Its decisions go to the event log as *Red commander: Attack (3 contacts, enemy
power 2.4 against our 6.1); concentrating on BMP-2 (E15). Orders: …*, from the
force's headquarters, so only that force's players (and exercise control) see
them. The latest decisions are kept with the commander's status (in the
**Commander** dialog, `GET /api/v1/forces/{force}/commander`, MCP
`get_commander`). Commanders are saved with the scenario (settings only, plus
where each is in its cycle in checkpoints) and are off unless set.

| Option | Default | Meaning |
| --- | --- | --- |
| `interval` | 45 | Seconds between decisions (10–600) |
| `aggressiveness` | 0.5 | 0 cautious … 1 bold: how strong the force must feel before attacking |
| `holdOff` | 300 | Seconds an order the commander did not give is left alone (0–3600) |
| `seed` | from the terrain seed and force | The commander's own random choices |
| `intent` | — | LLM: the commander's intent, added to what the model is told |
| `maxCallsPerMinute` | 4 | LLM: model calls per simulated minute |
| `maxTokens` | 2048 | LLM: output tokens per call |
| `maxToolCalls` | 12 | LLM: tool calls per decision |
| `tokenBudget` | 500000 | LLM: tokens in and out in all; it stops when they are spent |

### Rule-based commander

The doctrinal commander works offline and is deterministic: the same scenario
and seed give the same decisions, also after loading a checkpoint. It weighs
**combat power**: each entity type's best direct-fire weapon (mostly its
lethality against armour), scaled by its reach, times how hard the type is to
kill (an M1A2 counts about 2.8, a T-72B3 1.9, an M2A3 or BMP-2 1.2, a rifleman
0.08), less for damage and low ammunition. Enemy contacts count fully for a
minute after they were last seen and fade to 30 % over 15 minutes, after which
it forgets them. What is seen is rarely all there is, so it allows for more:
the enemy's power it knows times 1 + 1 / (1 + *n*/2) for *n* contacts (half as
much again with two, a fifth more with eight). The ratio of its power to that
estimate sets the posture; holding an objective it has taken, or a battle
position, it needs half as much again to attack:

| Posture | When | What the force does |
| --- | --- | --- |
| Advance | No enemy known and an objective to take | Scouts go ahead to watch the objective from 1.5 km short of it; the main body waits until they are there (or 2 minutes) and then moves on the objective, units side by side, set to halt on contact |
| Attack | Ratio ≥ 2.2 − 1.4 × aggressiveness (1.5 by default) | The longest-reaching, strongest element supports by fire from a flank; the others concentrate on the strongest contact of the group nearest the objective (or close on where it was last seen) |
| Defend | Ratio ≥ 0.6 − 0.35 × aggressiveness | Hold the objective once taken, a battle position (*BP …*) or the ground it stands on, in a line facing the enemy; the element least engaged reinforces one facing a group over 1.5 times its strength |
| Delay | Weaker still | Screen and fall back to the next phase line away from the enemy (or 2 km back), then defend there |
| Hold | Nothing to do | Defend where it is, facing the expected enemy |

Objectives are its own force's areas and points named *OBJ …*, nearest first;
one is taken when its units are within 450 m of it and no enemy has been seen
within a kilometre of it in the last two minutes. Whatever the posture:

- **Fires**: artillery and mortars fire on the group of contacts (within 500 m
  of one another, seen in the last 90 s) worth most, 3–6 rounds over 50 m, never
  within 450 m of its own units nor where rounds went in 90 s ago, each battery
  at most once in 45 s;
- **Resupply**: units below 25 % fuel or 30 % ammunition go to a supply vehicle
  when no enemy is within 2.5 km; supply vehicles follow 1.5 km behind the main
  body;
- **Casualties**: broken units, and units down to a third with the enemy within
  3 km, pull back 1.5 km by a covered route;
- **Helicopters** attack the strongest ground contact more than 4.5 km from any
  known air defence, else hold behind the main body.

It does not order units with subordinates (orders to them would pass down and
replace the subordinates' own).

### LLM commander

The LLM commander gets the same situation, as JSON in the first message of a
short conversation with a large language model through the Messages API, and
answers with tools: `give_order` (an order in words, as on the order line),
`set_roe`, `call_fire`, `start_phase`, `send_codeword` and `report` (its
assessment, which becomes the decision's rationale). Each tool call is carried
out as the force's player would give it, and the result (the order as
understood, or why it was refused) goes back to the model, until it ends its
turn or reaches `maxToolCalls`. The model calls run in the background: the
simulation goes on, and the orders are carried out at the next simulated second
after the reply arrives (while paused, they wait). Calls are limited per
simulated minute and by the token budget; errors (no answer, a refusal, a bad
reply) are logged, and it tries again after twice its interval. It needs a key
and a model configured on the server ([Deployment](deployment.md#llm-commanders));
without them it shows as *unavailable*. Only exercise control can start one.

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
| `warn` | Hampers it | low fuel, stuck, return-fire ROE, suppressed, radio or radar jammed, radio silence, radar off, GNSS denied (*navigating by inertial for 90 s, error ~120 m*), active protection spent, datalink lost (a supervised or autonomous drone carrying on), sensors cut by darkness or weather, no task |
| `info` | Explains it | waiting for a plan condition, keeping formation, holding a position, slowed by forest, reloading, engaging, what it radiates, active protection and decoys left, emitters located by direction finding |

Most come with a `fix` (*Set ROE to "fire at will"*), and those about a place
or another entity give `at` (x, y) and `aboutId`. Exercise control is also told
about the nearest enemies the entity has *not* detected, and why: beyond its
sensors, outside their field of view, hidden by the ground, forest, buildings
or smoke, or in sight but not spotted yet (each scan only has a chance).
Players only hear about what their side knows. Asking changes nothing in the
run: the random generator is not touched.

**Alerts** are the attention queue: idle after its orders (10 s with nothing to
do), task failed, broken, out of fuel or low on fuel, out of ammunition,
leader lost, losses, under fire or first contact after a quiet minute, radio
jammed, GNSS denied, active protection spent, and datalink lost (unmanned systems). Each is about a unit or a loose entity, with a severity
(critical, warning, info), the time it was last raised and a count. An alert
about a lasting condition (broken, fuel, ammunition, jammed) closes by itself
when the condition clears. Acknowledged while the condition lasts, it is not
raised again until the condition has cleared and come back. Acknowledged alerts are kept (up to 200 in all) and
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
