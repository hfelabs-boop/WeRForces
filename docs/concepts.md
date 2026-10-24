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

Terrain is generated from a **seed**, so the same seed always produces the same
map.

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
| Surface vessel | only on water | – | – | – | – |
| Aircraft | unaffected | | | | |

**Route planning.** *Move to* and *Follow route* plan a ground or water path with
A\* over the terrain grid. Paths minimise travel time, so vehicles use roads when
that is faster, and avoid water and cliffs. If a vehicle gets blocked for 3 s, it
replans. Aircraft fly straight.

**Line of sight.** Line of sight is sampled every 25 m along the line from the
observer's eyes to the target. Terrain blocks it outright. Forest canopy (15 m)
blocks it only once the line has passed through **more than 150 m of
forest**, so vehicles at a wood's edge, or close together inside a wood, can
still see each other.

## Forces and hostility

| Force id | Name | Default colour |
| --- | --- | --- |
| 1 | Blue | blue |
| 2 | Red | red |
| 3 | Neutral | green |
| 0 | Other | yellow |

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
  blocked by terrain. *Attack* is different: every member attacks.
- **Shared contacts.** When one member detects something, every member knows
  about it.
- **Succession.** If the leader is destroyed, or immobilised while another
  member can still move, the next member takes command and carries on the unit's
  task.

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

Every task accepts an optional `speed` (m/s) where it makes sense. The plan
setting *Set speed* changes the default cruise speed.

## Plans

A **plan** is a list of statements carried out **in order**:

| Statement | Effect |
| --- | --- |
| `task` | Start the task and wait until it finishes (or fails) |
| `setRoe`, `setSpeed`, `setAltitude`, `setFormation` | Change a setting instantly and continue |
| `waitUntil` *condition* | Wait until the condition holds |

Conditions:

| Condition | True when |
| --- | --- |
| `simTime` *t* | Simulation time ≥ *t* seconds |
| `inArea` *area* | The entity (or the unit's leader) is inside the area graphic |
| `enemyDetected` | Any member has a hostile contact |
| `underFire` | Any member was shot at in the last 15 s |
| `entityDestroyed` *id* | That entity is destroyed or gone |

With `loop: true` the plan starts over when it ends. When a non-looping plan
finishes, the event log reports *plan … complete*. Plans can be given to
entities or units. Tasks inside a unit's plan are carried out unit-style (see
above).

Plans run one step at a time. To react to something *while* moving, use ROE
(units fire on the move), or split the route into legs separated by
`waitUntil` steps.

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
munitions track the target. An unguided round misses if the target moved more
than 6 m from where it was aimed.

**Effective Pk.** Start from the weapon's Pk against the target's armour class
(see the [catalog](reference/catalog.md#weapons)), then multiply by:

| Condition | Factor |
| --- | --- |
| Range | × (1 − 0.5 × (range / max range)²) |
| Shooter moving > 2 m/s (unguided) | × 0.7 |
| Target moving > 8 m/s (unguided) | × 0.8 |
| Ground or person target in forest | × 0.75 |

**Outcome.**

- The round hits with probability min(1, 1.8 × Pk).
- A hit destroys the target with probability Pk ÷ hit chance. Overall, the
  chance of a kill per shot is exactly Pk.
- Other hits on vehicles cause a **mobility or firepower kill**, picking a system
  that still works. Losing both means destroyed.
- Hits on people and aircraft either destroy them or have no effect.

**Remote targets.** Damage to remote (DIS) entities is decided by the
simulation that owns them. WeRForces only sends the detonation.

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
