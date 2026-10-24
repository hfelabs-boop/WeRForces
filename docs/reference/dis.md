# DIS reference

WeRForces implements the parts of the **Distributed Interactive Simulation**
protocol (IEEE 1278.1) that a CGF needs to share a battlespace:

- publishing its entities;
- reflecting other simulations' entities;
- exchanging fire and detonation events;
- radio presence and text messages;
- radar and jammer emissions;
- simulation management (run, pause, comments, data queries).

Code: `src/dis/`. For a walkthrough see [Tutorial 6](../tutorials/06-dis-interoperability.md).
The [DIS conformance matrix](dis-conformance.md) lists every DIS 7 PDU type, the fields
WeRForces fills in, the deviations, and the tests that cross-check each PDU against an
independent DIS implementation.

## PDUs

| PDU | Type | Family | Size | Sent | Received |
| --- | --- | --- | --- | --- | --- |
| Entity State | 1 | Entity Information (1) | 144 bytes + 16 per variable parameter | yes | yes (variable parameters decoded, not used) |
| Fire | 2 | Warfare (2) | 96 bytes | yes | yes (logged; marks the target as under fire) |
| Detonation | 3 | Warfare (2) | 104 bytes + 16 per variable parameter | yes | yes (damage applied to local targets) |
| Collision | 4 | Entity Information (1) | 60 bytes | no (not modelled) | yes (logged when a local entity is hit) |
| Create Entity | 11 | Simulation Management (5) | 28 bytes | no | yes (refused) |
| Remove Entity | 12 | Simulation Management (5) | 28 bytes | no | yes (removes the named entity) |
| Start/Resume | 13 | Simulation Management (5) | 44 bytes | with `--dis-announce` | yes (runs the clock) |
| Stop/Freeze | 14 | Simulation Management (5) | 40 bytes | with `--dis-announce` | yes (pauses the clock) |
| Acknowledge | 15 | Simulation Management (5) | 32 bytes | in answer to Start/Resume, Stop/Freeze, Create and Remove Entity | counted |
| Action Request | 16 | Simulation Management (5) | variable | no | yes (rejected) |
| Action Response | 17 | Simulation Management (5) | variable | in answer to Action Request | yes (logged) |
| Data Query | 18 | Simulation Management (5) | variable | no | yes (answered with Data) |
| Set Data | 19 | Simulation Management (5) | variable | no | yes (not applied; answered with Data) |
| Data | 20 | Simulation Management (5) | variable | in answer to Data Query and Set Data | yes (logged) |
| Comment | 22 | Simulation Management (5) | variable | bookmarks | yes (logged) |
| Electromagnetic Emission | 23 | Distributed Emission Regeneration (6) | variable | radars and jammers | yes (counted) |
| Designator | 24 | Warfare (2) | 88 bytes | no (not modelled) | yes (logged) |
| Transmitter | 25 | Radio Communications (4) | 104 bytes | yes | yes (tracked) |
| Signal | 26 | Radio Communications (4) | variable | yes (text) | yes (text logged; audio ignored) |
| Receiver | 27 | Radio Communications (4) | 36 bytes | yes | counted |
| IFF | 28 | Distributed Emission Regeneration (6) | 60 bytes (layer 1) | no | yes (layer 1 decoded, counted) |
| Entity State Update | 67 | Entity Information (1) | 72 bytes + 16 per variable parameter | no | yes (moves a known remote entity) |

- Version 7 (IEEE 1278.1-2012) is sent; versions 4–7 are accepted.
- The PDU status octet of every PDU sent says *constructive* (LVC 3). Radio PDUs also
  say *radio attached* (RAI 2). With an older protocol version the octet is padding.
- All fields are big-endian.
- Only PDUs with the configured **exercise id** are processed.
- PDUs carrying this simulation's own **site:application** are ignored, which
  matters with broadcast loopback.

## Coordinates

| Quantity | DIS field | Conversion |
| --- | --- | --- |
| Position | World location (ECEF, metres, float64) | local x/y/z → WGS-84 latitude/longitude/height (local curvature at `terrain.origin`) → ECEF |
| Velocity | Linear velocity (ECEF, float32) | local east/north/up velocity rotated into ECEF |
| Orientation | ψ, θ, φ (radians, float32) | Z-Y-X Euler angles of the body (x forward, y right, z down) relative to ECEF, built from local heading/pitch/roll |

Remote entities are converted back the same way. Local altitude is treated as
height above the ellipsoid.

## Publishing (dead reckoning)

Each locally owned entity gets an Entity State PDU when any of these happen:

- the position predicted from its last PDU (first-order: position + velocity × Δt)
  is off by more than **1 m**;
- heading, pitch or roll changed by more than **3°**;
- its appearance changed (damage, smoke, flames);
- **5 s** passed since the last PDU (heartbeat);
- the simulation was paused, resumed or changed time scale.

| Field | Value |
| --- | --- |
| Dead-reckoning algorithm | 2 (FPW) while moving, 1 (static) when stopped or paused |
| Velocity | Simulated velocity × time multiplier, so receivers extrapolate in wall-clock time. 0 while paused |
| Marking | ASCII character set; the first 11 characters of the entity name |
| Force id | 1 Blue (friendly), 2 Red (opposing), 3 Neutral, 0 Other |
| Entity type | From the [catalog](catalog.md) |

### Appearance bits (land platforms)

| Bits | Meaning | WeRForces sets |
| --- | --- | --- |
| 1 | Mobility kill | on mobility kill (ground) |
| 2 | Firepower kill | on firepower kill (ground) |
| 3–4 | Damage: 0 none, 2 moderate, 3 destroyed | 2 for a mobility/firepower kill, 3 when destroyed |
| 5–6 | Smoke | 2 (engine smoke) when destroyed |
| 15 | Flaming | when destroyed |
| 23 | Deactivated | once, when an entity is deleted |

## Receiving

| Remote event | What WeRForces does |
| --- | --- |
| A new Entity State | Creates a **remote entity** with id `R<site>-<app>-<entity>`. Its type is the closest catalog match by kind/domain, then country, category and subcategory. Its name is the marking |
| Between updates | Extrapolates position with the received velocity (and acceleration for algorithms 4/5) |
| Entity State Update | Moves an entity already known from an Entity State, and updates its damage. Updates for unknown entities are ignored |
| No update for **12 s** | Removes the entity |
| Deactivated appearance bit | Removes the entity immediately |
| Damage bits = 3 | Marks it destroyed |

Remote entities appear with a dashed yellow outline. They can be detected,
followed and attacked, but not tasked.

## Fire and detonation

- **Fire PDU** (sent when a local entity shoots):
  - firing and target entity ids;
  - event id = (site, application, event number);
  - launch location;
  - burst descriptor:
    - munition = the weapon's DIS type;
    - warhead 1000 (HE) for guided weapons, 5000 (kinetic) for guns;
    - fuse 1000 (contact);
    - quantity 1;
  - velocity along the line of fire;
  - range.
- **Detonation PDU** (sent when the round arrives):
  - location;
  - target id (only on a hit);
  - result: 1 entity impact; 3 ground impact for a ground miss; 5 detonation for
    an air miss.

  **Damage to remote targets is not applied locally.** The owning simulation is
  expected to decide it from the detonation.
- **Received detonation** aimed at a local entity (within 30 m of it):
  WeRForces applies damage. It uses the Pk of the catalog weapon with the same
  munition type if there is one, otherwise 0.3.

- **Collision PDU** naming a local entity as the colliding entity: logged as an `info`
  event. WeRForces does not model collisions, so nothing is damaged and none are sent.
- **Designator PDU**: logged when a remote laser designator starts lasing an entity (or
  a spot) or switches target, not on every update. WeRForces does not model laser
  designation.

## Radio

Each **unit leader**, and each entity that is not in a unit, carries one radio
(radio number 1) on its force's net:

| Force | Frequency |
| --- | --- |
| Blue | 30 MHz |
| Red | 32 MHz |
| Neutral | 34 MHz |
| Other | 36 MHz |

- A **Transmitter PDU** (state *on, not transmitting*; AM, generic radio) and a
  **Receiver PDU** (state *on, idle*) are sent for each radio on the same 5 s
  heartbeat as Entity State. When the entity is destroyed, deleted, mounts
  a vehicle or stops leading its unit, a Transmitter PDU with state *off* is
  sent.
- **Radio messages** — contact reports, calls for fire, "wilco" when an order
  arrives (all shown with the `radio` event kind) — key the radio: Transmitter
  *transmitting*, then a **Signal PDU** with encoding class 1 (raw binary) that
  carries the text as UTF-8 (at most 1000 characters), then Transmitter *on*
  again.
- Received **Signal PDUs** with raw-binary or application-specific data are
  decoded as text and logged as `radio` events from the sending entity (or its
  `site:application:entity` if it is not known). Encoded audio (voice) is
  ignored. Remote radios are tracked from their Transmitter PDUs and dropped
  after 12 s of silence.

## Simulation management

| Received | What WeRForces does |
| --- | --- |
| Start/Resume addressed to all or to this site/application | Runs the clock, logs it, and answers with an **Acknowledge** (response 1, *able to comply*) |
| Stop/Freeze | Pauses the clock, the same way |
| Either one, with `--dis-ignore-siman` | Logs it as ignored and answers with response 2 (*unable to comply*) |
| Comment | Logs its text (variable datums of any id) as an `info` event |
| Create Entity | Logs it and answers *unable to comply* (the request has no entity type) |
| Remove Entity naming one of this application's entities | Removes the entity (other simulations see it deactivated) and answers *able to comply*. With `--dis-ignore-siman`, or for any other address, *unable to comply* |
| Data Query, Set Data | See [below](#data-query-and-set-data) |
| Action Request | Logs it and answers with an Action Response, status 5 (*request rejected*) |
| Data, Action Response addressed to this application | Logged |

With `--dis-announce`, WeRForces acts as a simulation manager itself: running
the clock sends Start/Resume (with the simulation time), pausing sends
Stop/Freeze (reason 1, *recess*), both addressed to all simulations. Adding a
recording **bookmark** sends a Comment PDU `Bookmark: <text>` so the other
simulations' logs line up with the after-action review.

### Data Query and Set Data

A **Data Query** addressed to one of this application's entities (site, application and
entity number) is answered once with a **Data PDU** from that entity. The Data PDU
holds the datums asked for that WeRForces knows. A query that lists no datum ids gets
the ones marked *default*. A query addressed to the application as a whole (entity 0
or 0xFFFF) can ask for *Entities* only. A **Set Data** PDU changes nothing: it is logged
and answered with a Data PDU of the current values of the datums it names.

Values of 32 bits go in fixed datums, longer ones in variable datums, whichever list
the requester used:

| Datum id (SISO-REF-010) | Value | Record |
| --- | --- | --- |
| 11000 Entity Type *(default)*, 12000 Alternative Entity Type | Entity type record, 8 octets | variable |
| 11110–11170 Kind, Domain, Country, Category, Subcategory, Specific, Extra | Integer | fixed |
| 11200 (or 11180) Force ID *(default)* | 0 other, 1 friendly, 2 opposing, 3 neutral | fixed |
| 13000 Entity Marking *(default)* | Character set 1 and 11 ASCII characters | variable |
| 15100, 15200, 15300 DIS Site, Host, Entity ID | Integer | fixed |
| 31000 Position, 31200 Geocentric Coordinates *(default)* | ECEF x, y, z (float64, m) | variable |
| 31300 Latitude, 31400 Longitude, 31600 Altitude | Float64 degrees, degrees, metres above the ellipsoid | variable |
| 32000 Orientation *(default)* | ψ, θ, φ (float32, rad) | variable |
| 32100, 32200, 32300 Hull Heading, Hull Pitch, Roll Angle | Float32, rad; heading clockwise from true north | fixed |
| 33000 Appearance *(default)* | The Entity State appearance bits | fixed |
| 35100 Mobility Kill, 35200 Fire-Power Kill | 0 or 1 | fixed |
| 36000 Velocity *(default)* | ECEF x, y, z (float32, m/s), as in Entity State | variable |
| 36400 Speed *(default)* | Float32, m/s | fixed |
| 43200 Entities (application only) | Number of local entities | fixed |

Other datum ids are left out of the answer. A Data Query's time interval (asking for
repeated answers) is not honoured: each query is answered once.

## Electromagnetic emissions

Each local entity that radiates sends an **Electromagnetic Emission PDU** when what it
radiates changes, every **10 s** while it stays the same, and once more, with the same
systems but no beams, when it stops: switched off, destroyed, mounted or deleted.
`--dis-no-emissions` turns this off.

| Emitter | When | System function | Beam function | Beam (one per system) |
| --- | --- | --- | --- | --- |
| Each radar sensor (`radar: true` in the [catalog](catalog.md)) with an all-round field of view | The entity is alive and not mounted, and its radar is not switched off by [emission control](../concepts.md#emission-control) | 2 Early Warning/Surveillance | 1 Search | 3 GHz, 200 MHz wide, 90 dBm ERP, PRF 1 kHz, pulse width 1 µs, azimuth sweep ±180°, elevation ±15° |
| A radar sensor with a sector field of view | The same | 4 Fire Control | 4 Tracking | 9.5 GHz, 500 MHz wide, 80 dBm ERP, PRF 3 kHz, pulse width 0.5 µs, azimuth sweep ± half the field of view, elevation up to ±30° |
| A jammer (`jammer` in the catalog) | Switched on, not firepower-killed or mounted | 42 Jammer | 12 Jamming | One beam per band jammed. Radio: 59 MHz, 58 MHz wide (30–88 MHz), 63 dBm. Radar: 10 GHz, 4 GHz wide (8–12 GHz), 70 dBm. Drone datalinks: 4.1 GHz, 3.6 GHz wide (the 2.4 and 5.8 GHz control bands), 50 dBm. GNSS: 1.4 GHz, 400 MHz wide (L1/L2), 50 dBm. Sweep ±180° |

- Emitters are numbered from 1 on each entity and are located at sensor height above
  the entity origin.
- Beams are numbered from 1 on each system and are always active.
- Track/jam target lists are empty.
- The emitter name is the SISO-REF-010 name of the real system for the catalog types
  that have one:

  | Catalog type | Emitter name |
  | --- | --- |
  | F-16C, F-16CJ | 1890 AN/APG-68 |
  | Su-27 | 21881 N001V |
  | DDG-51 | 7260 AN/SPY-1D |
  | SA-8 | 19260 Land Roll (target acquisition) |
  | Krasukha-2 | 19053 Krasukha-2 |
  | MFEW | 21981 MFEW jammer |

  Other types send 0.

The numbers are representative values by role, not data for the real systems. Received
Electromagnetic Emission and IFF PDUs are decoded and counted. They do not affect
WeRForces' own sensors or [electronic warfare](../concepts.md#electronic-warfare) model.

## Network setup

| Situation | Options |
| --- | --- |
| Same machine, two instances | `--dis --dis-address 127.255.255.255` on both, with different `--site` (and different HTTP `--port`) |
| LAN broadcast | `--dis --dis-address 192.168.1.255` (your subnet's broadcast address) |
| Multicast | `--dis --dis-address 239.1.2.3` (joined automatically) |
| Point-to-point | `--dis --dis-address <other host IP>` |

The socket binds `0.0.0.0:<dis-port>` with address reuse, so several local
applications can share the port.

## Limitations

- HLA is a separate bridge process, not part of this gateway: see [HLA](../hla.md).
- Articulated parts (turrets, guns) are not modelled. None are sent, and received ones
  are decoded but move nothing.
- Collisions, laser designation and IFF are not modelled. The PDUs are received and
  logged or counted, never sent.
- Reliable simulation management PDUs (51–65), aggregates, minefields, environment and
  the other PDU types are not supported. See the
  [conformance matrix](dis-conformance.md#not-supported).
- Voice is not transmitted or played; radios carry text only.
- Entity-type enumerations are representative. Check them against SISO-REF-010
  before joining a federation that depends on exact types.
