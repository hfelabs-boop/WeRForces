# Tutorial 6: DIS interoperability

**Time:** 15 minutes · **You will learn:** federating WeRForces with another
DIS simulation so each sees, and can engage, the other's entities.

**DIS** (IEEE 1278.1) is the long-standing protocol simulations use to share a
battlespace over UDP. VR-Forces, VBS, Bohemia's tools, many trainers and
open-source viewers all speak it. WeRForces:

- sends *Entity State*, *Fire* and *Detonation* PDUs for its own entities, and
  radio (*Transmitter*, *Signal*) PDUs for its units' radio messages;
- turns other simulations' PDUs into **remote entities**;
- follows *Start/Resume* and *Stop/Freeze* from a simulation manager.

Details are in the [DIS reference](../reference/dis.md).

## 1. Two WeRForces instances on one machine

The simplest federation is two copies of WeRForces. Open two terminals.

**Terminal 1**: site 1, the Calloway scenario, web UI on port 8080:

```bash
npm start -- -s calloway-crossroads --dis --dis-address 127.255.255.255
```

**Terminal 2**: site 2, the Lakeside scenario, web UI on port 8081, running:

```bash
npm start -- -s lakeside-patrol --port 8081 --dis --dis-address 127.255.255.255 --site 2 --run
```

Both print `DIS enabled: exercise 1, site …, app 3001, udp 127.255.255.255:3000`.

Open **http://127.0.0.1:8080**. Within a second, Lakeside's boats, infantry,
BRDMs and Hind appear around the southern lake. They have a **dashed yellow
ring** around the symbol, which marks them as remote. The Objects tree lists
them with *(remote)*, and the toolbar pill reads something like *DIS ex 1 ·
1:3001 · tx 150 rx 300 · 15 remote*.

Click a remote entity. The inspector shows its position and damage, and notes
that it is simulated by another application. You cannot task it, but your forces
can **detect** it and, if it is hostile, **engage** it.

Open **http://127.0.0.1:8081** for the other side's view: Calloway's forces
appear there as remote entities.

### What crosses the wire

| Situation | PDUs |
| --- | --- |
| A moving entity | An Entity State PDU whenever the receiver's dead-reckoned estimate would be more than 1 m or 3° off. Between PDUs the receiver extrapolates, so the remote entity moves smoothly |
| A stationary entity | One PDU every 5 s (heartbeat). If an entity is silent for 12 s, receivers remove it |
| A shot | A Fire PDU, then a Detonation PDU when the round lands. If the target is remote, **its own simulation decides the damage** from the detonation |
| A radio message (contact report, call for fire, order acknowledged) | A Signal PDU carrying the text. The receiver logs it as a `radio` event, e.g. *Viper Lead (DIS radio): Viper: contact, Mi-24V Hind at 1500 9000* (tick **radio** in the log header to see them) |

### Watch it: combat across simulations

Keep both instances running. Instance 1 (Calloway) is paused, so press **Run**
in its browser tab. Within the first minute, its **Viper** F-16 flight, flying
CAP over Eastwick, detects instance 2's **Hind 21** heading for the lake, and
fires AIM-120s at it:

- **Instance 1's event log:** *Viper Lead fired AIM-120 AMRAAM at Hind 21
  (13484 m)*. A Fire PDU, then a Detonation PDU, go out.
- **Instance 2's event log:** *external detonation on Hind 21: kill*. The owning
  simulation decided the damage from the detonation.
- The destroyed state returns to instance 1 in the Hind's next Entity State PDU,
  and the Hind's symbol gets a red ✕ there too.

Ground combat across instances works the same way. Place a **Red** T-72 platoon
in instance 1 within sight of instance 2's Blue infantry on the lake's north
shore.

## 2. Joining another DIS simulation

Agree on these settings with the other simulation's operator:

| Setting | WeRForces option | Notes |
| --- | --- | --- |
| UDP port | `--dis-port` (default 3000) | 3000 is the usual DIS port |
| Destination | `--dis-address` | The LAN broadcast address (e.g. `192.168.1.255`), a multicast group (e.g. `239.1.2.3`), or the other host's IP |
| Exercise id | `--exercise` (default 1) | Must match. PDUs from other exercises are ignored |
| Site / application | `--site`, `--application` | Must be **unique** per simulation |
| Protocol version | | WeRForces sends version 7 and accepts 4–7. Most tools accept 7; some older ones need 6 |

```bash
npm start -- -s calloway-crossroads --dis --dis-address 192.168.1.255 --exercise 1 --site 10 --application 1
```

### Entity types

WeRForces matches incoming entity types to its catalog by
kind/domain/country/category, so a remote T-72 variant shows as a T-72, an
unknown US tank as an Abrams, and so on. The DIS types WeRForces sends are listed
in the [catalog](../reference/catalog.md). They are representative values; if
the other side shows the wrong models, compare the enumerations.

### Checking the traffic

- **Wireshark** has a built-in DIS dissector. Capture on the interface and
  filter with `dis`.
- The WeRForces DIS pill shows PDUs sent (tx), received (rx) and the number of
  remote entities.
- Nothing received? Check:
  - the exercise id and port match;
  - the firewall allows UDP 3000;
  - both use the same broadcast or multicast address;
  - each simulation has its own site/application pair.

  See the [FAQ](../faq.md#dis-entities-from-my-other-simulation-dont-appear).

## 3. Using DIS together with the other interfaces

Remote entities are first-class in the rest of WeRForces:

- they appear in the REST API (`GET /api/v1/entities?remote=true`) and in MCP
  `list_entities`;
- they appear in GeoJSON/KML exports;
- they go to TAK when CoT has `includeRemote: true`.

WeRForces can therefore bridge a DIS exercise to TAK devices or GIS tools.

## Limitations

- **HLA** is not spoken directly. A separate bridge federate translates
  between DIS and an HLA RPR FOM federation: see [HLA](../hla.md).
- Articulated parts and collisions are not handled, and radios carry text
  only (no voice).

**Next:** [Tutorial 7: TAK, webhooks and GIS](07-tak-webhooks-and-gis.md).
