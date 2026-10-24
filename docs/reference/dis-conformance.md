# DIS conformance matrix

What WeRForces does with each **DIS 7** (IEEE 1278.1-2012) PDU type, which fields it
fills in, which tests cover it, and where it deviates from the standard. For how the
supported PDUs are used, see [DIS](dis.md).

## How the PDUs are checked

Every PDU type WeRForces sends or reads is cross-checked against an independent
implementation, the [open-dis](https://github.com/open-dis/open-dis-javascript)
JavaScript library (version 1.3.6, BSD-2-Clause, Naval Postgraduate School MOVES
Institute):

- **ours → theirs:** a PDU encoded by WeRForces is decoded by open-dis. Every field is
  compared, and open-dis must read exactly the PDU's length.
- **theirs → ours:** a PDU built and encoded by open-dis is decoded by WeRForces, and
  every field is compared.
- **end to end:** a gateway runs a scenario (tanks with radios, a fighter radar, a radar
  jammer, a shot, a radio call, a bookmark, run/pause, a Data Query and an Action
  Request). Every PDU it sends is decoded by open-dis and compared with the simulated
  state. PDUs built with open-dis are then fed to a gateway, and their effect on the
  simulation is checked.

The tests are in `test/dis-interop.test.ts`. open-dis is a test-only dependency, never
loaded at runtime. To fetch it into the git-ignored `vendor-test/` folder (with
`npm pack`, checked against pinned SHA-512 hashes):

```bash
npm run interop:fetch     # = node scripts/fetch-open-dis.mjs
npx vitest run test/dis-interop.test.ts
```

Without `vendor-test/` the cross-check is skipped with a warning.
`WERFORCES_INTEROP=1` turns a missing library into a failure; CI sets it.

### Which open-dis classes check which PDUs

open-dis' DIS 7 build is incomplete for some PDUs. For each of those PDUs the layout
did not change between DIS 6 (IEEE 1278.1a-1998) and DIS 7, apart from header octet 10
(PDU status in DIS 7, padding in DIS 6). Those PDUs are checked with open-dis' DIS 6
classes, and octet 10 is checked separately.

| open-dis 1.3.6 defect | Effect | How the tests handle it |
| --- | --- | --- |
| DIS 7 `SignalPdu`, `ReceiverPdu` have no radio reference id or radio number | Fields shifted by 8 octets | DIS 6 classes |
| DIS 7 `DesignatorPdu` has no designator wavelength | Fields shifted by 4 octets | DIS 6 class |
| DIS 7 `ElectronicEmissionsPdu` reads one flattened system | Wrong for any real PDU | DIS 6 class |
| DIS 7 `DataQueryPdu` reads datum records (8+ octets) instead of 32-bit datum ids | Wrong for any query | DIS 6 class (`UnsignedIntegerWrapper` ids) |
| No DIS 7 IFF PDU | – | DIS 6 `IffAtcNavAidsLayer1Pdu` (layer 1 is unchanged; DIS 6's 16-bit `pad2` is DIS 7's system designator and system specific data) |
| `InputStream.readLong` does not advance the read position | Every field after a 64-bit field is misread (Transmitter frequency) | The test stream advances it, as `writeLong` does |
| Variable datums are not padded to 64 bits (read or write) | A datum after one whose length is not a whole number of 64-bit words is misread | Tests put such a datum last, and expect open-dis to stop short of the final padding |
| DIS 6 `SignalPdu` writes `samples` octets of data instead of `dataLength / 8` | Encoding only | `samples` is set to the octet count when open-dis encodes |
| Variable parameters are generic 16-octet records | – | Re-read with open-dis' `ArticulatedParts` / `AttachedParts` classes |
| `RangeCoordinates.ENUtoECEF` passes degrees to `sin`/`cos` | – | The geodesy check uses its `ECEFtoENU` and `CoordinateConversion` instead |

## Summary

| | PDU types |
| --- | --- |
| Sent and received | Entity State, Fire, Detonation, Start/Resume, Stop/Freeze, Acknowledge, Comment, Data, Action Response, Electromagnetic Emission, Transmitter, Signal, Receiver |
| Received only | Entity State Update, Collision, Designator, Create Entity, Remove Entity, Action Request, Data Query, Set Data, IFF |
| Encoded and decoded, never sent by the gateway | Collision, Entity State Update, Designator, Create/Remove Entity, Set Data, Data Query, Action Request, IFF (for tests and tools) |
| Not supported (ignored when received) | Everything else (see the full table) |

Every PDU WeRForces sends:

- has protocol version 7 (configurable, default) and the exercise id;
- has a relative timestamp (time past the hour, least significant bit 0);
- has its length;
- carries a PDU status of *constructive* (LVC = 3), or for radio PDUs also *radio
  attached* (RAI = 2). When the protocol version is set below 7, octet 10 is sent as
  padding (0).

Received PDUs are accepted with versions 4 to 7 and the configured exercise id. PDUs
with this simulation's own site and application are ignored.

## Supported PDUs

| Type | PDU | Family | WeRForces | Fields populated / used | Cross-check tests | Known deviations |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Entity State | Entity information | Both | All. Sent: id, force, type (alternate type = type), ECEF velocity and location, ψθφ, appearance (damage, smoke, flames, mobility/firepower kill, deactivated), DR algorithm 1/2 with zero acceleration, angular velocity and other parameters, ASCII marking (11 characters), capabilities 0, no variable parameters. Received: all; variable parameters (articulated and attached parts, other records as raw octets), the 15 DR other-parameter octets and the marking character set are decoded and kept on the PDU | *Entity State: ours -> open-dis …*, *Entity State: open-dis -> ours …*, *short marking …*, end-to-end tests | Articulated parts are not sent: turrets and guns are not modelled. Received articulation and DR other parameters do not move anything. Received positions are extrapolated to first order, with acceleration for algorithms 4 and 5; body-axis algorithms (6–9) are treated as world-axis ones, and rotation is not extrapolated |
| 2 | Fire | Warfare | Both | All. Sent: firing, target and munition (none) ids, event id, fire mission index 0, ECEF launch location, burst descriptor (munition type, warhead 1000/5000, fuse 1000, quantity 1, rate 0), velocity, range. Status FTI = munition | *Fire: both directions*, end to end | Expendables (FTI = 1) are not sent |
| 3 | Detonation | Warfare | Both | All. Sent: firing, target (on a hit) and munition (none) ids, event id, velocity 0, ECEF location, burst descriptor, location in entity 0, result 1, 3 or 5, no variable parameters. Status DTI = munition. Received: target, location, munition type, result; variable parameters decoded | *Detonation: both directions, with variable parameters*, end to end | Velocity and location in entity coordinates are zero |
| 4 | Collision | Entity information | Received | All decoded. A collision with a local entity is logged | *Collision: both directions*, end to end (open-dis built) | WeRForces does not model collisions, so it never sends one, and a collision does no damage |
| 11 | Create Entity | Simulation management | Received | Originating, receiving and request id | *Create Entity and Remove Entity …*, *refuses Create Entity …* | Always answered *unable to comply*: the request carries no entity type |
| 12 | Remove Entity | Simulation management | Received | Originating, receiving and request id. Naming one of this application's entities removes it (deactivated Entity State) and is acknowledged *able to comply*, unless `--dis-ignore-siman` | Same, end to end (open-dis built) | Removing *all* entities (entity 0xFFFF) is refused |
| 13 | Start/Resume | Simulation management | Both | All. Sent with `--dis-announce`: real-world time, simulation time, request id | *Start/Resume: both directions*, end to end | |
| 14 | Stop/Freeze | Simulation management | Both | All. Sent with `--dis-announce`: reason 1 (recess), frozen behaviour 0 | *Stop/Freeze: both directions*, end to end | |
| 15 | Acknowledge | Simulation management | Both | All. Sent for Start/Resume, Stop/Freeze, Create Entity and Remove Entity | *Acknowledge: both directions*, end to end (decoded by open-dis) | Received Acknowledges are only counted |
| 16 | Action Request | Simulation management | Received | All, including datums | *Action Request and Action Response …* | Every action is rejected (Action Response status 5) and logged |
| 17 | Action Response | Simulation management | Both | All. Sent: request id, status 5 (*request rejected*), no datums. Received (addressed to this application): logged | Same, end to end | |
| 18 | Data Query | Simulation management | Received | Request id, datum ids (fixed and variable lists). The time interval is decoded | *Data Query: both directions*, *answers a Data Query …*, end to end | Answered once: a non-zero time interval asking for repeated Data PDUs is not honoured |
| 19 | Set Data | Simulation management | Received | All, including datums. Logged and answered with a Data PDU holding the *current* values | *Set Data and Data: both directions …*, *does not apply Set Data …* | Nothing is set |
| 20 | Data | Simulation management | Both | All. Sent in answer to Data Query and Set Data: see [the datum ids](dis.md#data-query-and-set-data). Received (addressed to this application): logged | *Set Data and Data …*, end to end (decoded by open-dis) | Ids WeRForces does not know are left out of the answer |
| 22 | Comment | Simulation management | Both | All. Sent for bookmarks (datum id 0, UTF-8 text). Received: every variable datum logged as text | *Comment: both directions*, end to end | Fixed datums in a received Comment are ignored |
| 23 | Electromagnetic Emission | Distributed emission regeneration | Both | All (systems, beams, track/jam targets) encoded and decoded. Sent for radars and switched-on jammers: [mapping](dis.md#electromagnetic-emissions). Received: decoded and counted | *Electromagnetic Emission: both directions …*, *is sent for radars and switched-on jammers …*, end to end | Representative beam parameters by role, not per system. No track/jam target lists. Received emissions do not affect sensors or the EW model |
| 24 | Designator | Warfare | Received | All decoded. Logged when a designator starts lasing an entity or a spot, or changes target | *Designator: both directions …*, end to end (open-dis built) | No laser designation is modelled, so none is sent and a designation does not guide weapons |
| 25 | Transmitter | Radio communications | Both | All fixed fields. Sent: radio 1 on the force net (30/32/34/36 MHz), AM, 25 kHz, 40 dBm, antenna location, state off/on/transmitting. Status RAI = attached | *Transmitter: both directions, 64-bit frequency*, end to end | No modulation parameters, antenna patterns or variable transmitter parameters. The radio type has kind 7, the platform's domain and country, and zero category, subcategory, specific and extra |
| 26 | Signal | Radio communications | Both | All. Sent: raw binary (class 1), one message of UTF-8 text. Received: raw binary and application-specific data logged as text | *Signal: both directions …*, end to end | Encoded audio is ignored; voice is not sent |
| 27 | Receiver | Radio communications | Both | All. Sent: state on/idle, received power 0, no transmitter | *Receiver: both directions …*, end to end | Received Receivers are only counted |
| 28 | IFF | Distributed emission regeneration | Received | Layer 1 (system id, designator, specific data, fundamental operational data) decoded; counted | *IFF (layer 1): both directions …*, end to end (open-dis built) | Layers 2 to 5 are not decoded. No IFF is simulated, so none is sent |
| 67 | Entity State Update | Entity information | Received | All, including variable parameters. Moves a remote entity already known from an Entity State, and updates its damage | *Entity State Update: both directions*, *Entity State Update moves …*, end to end (open-dis built) | An update for an entity never seen in an Entity State is ignored: type, force and marking only come with Entity State |

Also checked: the PDU status bit positions (TEI, LVC, CEI, type-specific bits; padding for
DIS 6), and WGS-84 geodetic ↔ ECEF and east-north-up vectors against open-dis' own
coordinate conversion.

## Not supported

These PDU types are ignored when received and never sent:

| Family | PDUs (type) |
| --- | --- |
| Logistics | Service Request (5), Resupply Offer (6), Resupply Received (7), Resupply Cancel (8), Repair Complete (9), Repair Response (10) |
| Simulation management | Event Report (21) |
| Distributed emission regeneration | Underwater Acoustic (29), Supplemental Emission/Entity State (30) |
| Radio communications | Intercom Signal (31), Intercom Control (32) |
| Entity management | Aggregate State (33), IsGroupOf (34), Transfer Ownership (35), IsPartOf (36) |
| Minefield | Minefield State (37), Query (38), Data (39), Response NACK (40) |
| Synthetic environment | Environmental Process (41), Gridded Data (42), Point (43), Linear (44) and Areal (45) Object State |
| Live entity | TSPI (46), Appearance (47), Articulated Parts (48), LE Fire (49), LE Detonation (50) |
| Simulation management with reliability | Create Entity-R to Record Query-R (51–65) |
| Entity information | Collision-Elastic (66) |
| Warfare | Directed Energy Fire (68), Entity Damage Status (69) |
| Information operations | IO Action (70), IO Report (71) |
| Other | Attribute (72) |

## Fixed in v0.6

The cross-check found these differences from the standard in WeRForces 0.5. They are
fixed now.

- **PDU status (header octet 10)** was always 0 (*no statement*) and was not decoded. It
  is now set as above, and decoded into `PduHeader.status`.
- **Variable parameter records** were skipped on receipt and could not be sent. Entity
  State, Entity State Update and Detonation now encode and decode them.
- **Dead-reckoning other parameters** (15 octets) and the **marking character set** were
  thrown away on decode.
- **Radio type** used the DIS 6 field names (nomenclature version, nomenclature). It now
  has the DIS 7 entity-type layout (kind, domain, country, category, subcategory,
  specific, extra). The octets on the wire are the same.
- **Short PDUs:** some decoders read past the end of a short PDU and relied on the
  exception. Each fixed-size decoder now checks the length first.

Fields that WeRForces 0.5 already filled in were found to be encoded correctly.
