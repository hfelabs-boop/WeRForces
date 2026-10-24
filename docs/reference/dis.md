# DIS reference

WeRForces implements the parts of the **Distributed Interactive Simulation**
protocol (IEEE 1278.1) that a CGF needs to share a battlespace:

- publishing its entities;
- reflecting other simulations' entities;
- exchanging fire and detonation events.

Code: `src/dis/`. For a walkthrough see [Tutorial 6](../tutorials/06-dis-interoperability.md).

## PDUs

| PDU | Type | Family | Size | Sent | Received |
| --- | --- | --- | --- | --- | --- |
| Entity State | 1 | Entity Information (1) | 144 bytes | yes | yes (variable parameters skipped) |
| Fire | 2 | Warfare (2) | 96 bytes | yes | yes (logged; marks the target as under fire) |
| Detonation | 3 | Warfare (2) | 104 bytes | yes | yes (damage applied to local targets) |

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

- No HLA (the gateway is designed so an HLA/RPR-FOM binding can be added
  alongside it).
- Received variable parameters (articulated parts), Collision, Signal/Transmitter
  and Simulation Management PDUs are ignored.
- Entity-type enumerations are representative. Check them against SISO-REF-010
  before joining a federation that depends on exact types.
