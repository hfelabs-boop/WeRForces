# DIS reference

WeRForces implements the parts of the **Distributed Interactive Simulation**
protocol (IEEE 1278.1) that a CGF needs to share a battlespace:

- publishing its entities;
- reflecting other simulations' entities;
- exchanging fire and detonation events;
- radio presence and text messages;
- simulation management (run, pause, comments).

Code: `src/dis/`. For a walkthrough see [Tutorial 6](../tutorials/06-dis-interoperability.md).

## PDUs

| PDU | Type | Family | Size | Sent | Received |
| --- | --- | --- | --- | --- | --- |
| Entity State | 1 | Entity Information (1) | 144 bytes | yes | yes (variable parameters skipped) |
| Fire | 2 | Warfare (2) | 96 bytes | yes | yes (logged; marks the target as under fire) |
| Detonation | 3 | Warfare (2) | 104 bytes | yes | yes (damage applied to local targets) |
| Start/Resume | 13 | Simulation Management (5) | 44 bytes | with `--dis-announce` | yes (runs the clock) |
| Stop/Freeze | 14 | Simulation Management (5) | 40 bytes | with `--dis-announce` | yes (pauses the clock) |
| Acknowledge | 15 | Simulation Management (5) | 32 bytes | in answer to Start/Resume and Stop/Freeze | no |
| Comment | 22 | Simulation Management (5) | variable | bookmarks | yes (logged) |
| Transmitter | 25 | Radio Communications (4) | 104 bytes | yes | yes (tracked) |
| Signal | 26 | Radio Communications (4) | variable | yes (text) | yes (text logged; audio ignored) |
| Receiver | 27 | Radio Communications (4) | 36 bytes | yes | no |

- Version 7 (IEEE 1278.1-2012) is sent; versions 4–7 are accepted.
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

With `--dis-announce`, WeRForces acts as a simulation manager itself: running
the clock sends Start/Resume (with the simulation time), pausing sends
Stop/Freeze (reason 1, *recess*), both addressed to all simulations. Adding a
recording **bookmark** sends a Comment PDU `Bookmark: <text>` so the other
simulations' logs line up with the after-action review.

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
- Received variable parameters (articulated parts) and Collision PDUs are ignored.
  So are Create/Remove Entity, Set/Data Query and other Simulation Management
  PDUs besides those above.
- Voice is not transmitted or played; radios carry text only.
- Entity-type enumerations are representative. Check them against SISO-REF-010
  before joining a federation that depends on exact types.
