# HLA (IEEE 1516e) bridge

WeRForces speaks [DIS](reference/dis.md) natively. To join an **HLA 1516e
(HLA Evolved)** federation it uses a separate **bridge federate**, written in
Java against the standard IEEE 1516e API (`hla.rti1516e.*`). The bridge:

- listens for WeRForces' DIS PDUs on UDP and publishes them into the federation
  using a subset of the **SISO RPR FOM 2.0**;
- reflects other federates' entities and interactions back to WeRForces as DIS
  PDUs.

```
WeRForces ──DIS/UDP──▶ bridge federate ──HLA──▶ RTI ◀──HLA── other federates
          ◀──DIS/UDP──                 ◀──HLA──
```

It is tested against [OHLA](https://sourceforge.net/projects/ohla/) 0.6.1, an
Apache-2.0 RTI, running as a real RTI process. Nothing in the bridge is
specific to OHLA except how it turns `--rti-host`/`--rti-port` into a connect
string (see [Other RTIs](#other-rtis)).

Source: [`hla/`](../hla/fetch-ohla.sh) (scripts), `hla/src/` (bridge),
[`hla/fom/werforces-rpr.xml`](../hla/fom/werforces-rpr.xml) (FOM module).

## Requirements

- Java 17 or later (`java`, `javac`, `jar` on the `PATH`), tested on Java 21.
- `bash`, `curl`, `unzip`.
- Network access to SourceForge, once, to download OHLA.

## Fetch and build

```bash
npm run hla:build        # = hla/fetch-ohla.sh && hla/build.sh
```

- `hla/fetch-ohla.sh` downloads `ohla-0.6.1.zip` from SourceForge into
  `hla/vendor/` (git-ignored), checks its SHA-256 and unpacks it. Set `OHLA_URL`
  to use a mirror, or `OHLA_HOME` to point the scripts at an existing copy.
- `hla/build.sh` compiles with plain `javac` (no Maven) and writes `hla/build/`:

| File | What it is |
| --- | --- |
| `werforces-hla-bridge.jar` | The bridge, compiled against `ieee-1516e.jar` only |
| `ieee-1516e-java9.jar` | OHLA's copy of the IEEE 1516e `RtiFactoryFactory` and `LogicalTimeFactoryFactory`, rebuilt from its sources to use `java.util.ServiceLoader`. The shipped classes use `javax.imageio.spi.ServiceRegistry`, which Java 9+ restricts to ImageIO classes (`IllegalArgumentException: hla.rti1516e.RtiFactory is not an ImageIO SPI class`) |
| `ohla-rti-port.jar` | OHLA's `RTI` server class rebuilt so its port comes from `-Dohla.rti.port` (stock OHLA always listens on 15000) and saves go to the temp directory instead of `c:\Temp` |

Both patches are `sed` edits applied to OHLA's own sources at build time; no
OHLA code is committed.

## Run

Start the RTI, then the bridge, then WeRForces with DIS:

```bash
hla/run-rti.sh                     # OHLA RTI on port 15000 (or: hla/run-rti.sh 15001)
hla/run-bridge.sh --federation WeRForces --federate WeRForces-1
npm start -- --scenario calloway-crossroads --dis
```

With the defaults the bridge and WeRForces both use DIS broadcast on UDP port
3000, exercise 1. Both hear each other and themselves; each ignores PDUs with
its own site and application, so nothing loops. Any other DIS simulation on the
same LAN segment is bridged too.

To keep the DIS traffic on one host (Linux), use unicast and give the bridge
its own loopback address:

```bash
hla/run-bridge.sh --dis-bind 127.0.0.3 --dis-address 127.0.0.1
npm start -- --scenario calloway-crossroads --dis --dis-address 127.0.0.3
```

Run one RTI per federation and one bridge per WeRForces instance. Each bridge
needs a distinct `--federate` name and a distinct `--site`/`--application`.
`OHLA_LOG_LEVEL=INFO` (or `DEBUG`) shows the RTI's own logging.

### Bridge options

| Option | Default | Meaning |
| --- | --- | --- |
| `--rti-host`, `--rti-port` | RTI default | Where the RTI is (OHLA: `localhost:15000`) |
| `--rti-settings <string>` | | Local settings designator passed verbatim to `connect()`; overrides host/port |
| `--federation <name>` | `WeRForces` | Federation execution; created with the FOM if it does not exist |
| `--federate <name>` | `WeRForcesBridge` | Federate name (federate type `WeRForcesDisBridge`) |
| `--fom <file>` | `hla/fom/werforces-rpr.xml` | FOM module used to create the federation |
| `--refresh <s>` | 10 | Full attribute refresh of DIS entities (0 = off) |
| `--dis-port <port>` | 3000 | UDP port to listen on |
| `--dis-bind <addr>` | 0.0.0.0 | Interface to listen on |
| `--dis-address <addr>` | 255.255.255.255 | Destination: broadcast, multicast group (joined) or unicast host |
| `--dis-send-port <port>` | `--dis-port` | Destination port |
| `--exercise <id>` | 1 | DIS exercise; other exercises are ignored |
| `--site`, `--application` | 1, 3100 | DIS simulation address for entities reflected from HLA |
| `--heartbeat <s>` | 5 | Entity State heartbeat for entities reflected from HLA |
| `--timeout <s>` | 12 | DIS entity deleted from the federation after this long without an Entity State |
| `--verbose` | | Log every registered, discovered and removed object and every interaction |

The bridge prints `READY` once it has joined and subscribed. On `SIGINT` or
`SIGTERM` it resigns with `CANCEL_THEN_DELETE_THEN_DIVEST` (so its objects are
deleted for everybody) and destroys the federation if it was the last member.

## Behaviour

**DIS to HLA.** The first Entity State PDU from a DIS entity registers an object
instance of the RPR class matching its entity type (below). Each later PDU
updates only the attributes whose encoded value changed. Location, orientation,
velocity and dead-reckoning algorithm are one dead-reckoning state, so if any
of them changed all four are sent together. Every `--refresh` seconds, and when
another federate asks (`provideAttributeValueUpdate`), all attributes are sent,
with the location dead-reckoned to the current time. A PDU with the
*deactivated* appearance bit (23), or `--timeout` seconds of silence, deletes the
instance. Fire and Detonation PDUs become `WeaponFire` and `MunitionDetonation`
interactions. The user-supplied tag carries the DIS timestamp as eight hex
digits, the RPR convention.

**HLA to DIS.** A discovered `BaseEntity.PhysicalEntity` (or subclass) instance
gets a DIS entity id `--site:--application:n`, and the bridge asks its owner
for all attributes. Each reflection sends an Entity State PDU, and a heartbeat
follows every `--heartbeat` seconds. Heartbeats carry the dead-reckoned
location, so receivers don't jump back to the last reflected one. Removing the
instance sends a deactivated Entity State PDU. Interactions become Fire and
Detonation PDUs.

**Identifiers.** RPR interactions name entities by HLA object instance name
(`RTIobjectId`). The bridge maps names to DIS entity ids in both directions:
for instances it registered, the original DIS id; for discovered ones, the id
it assigned. So a WeRForces round fired at an entity that came from HLA arrives
at that entity's owner with the right target, and a detonation reported by
another federate on a WeRForces entity is adjudicated by WeRForces. Event
identifiers keep their event count; the issuing object is the firing entity.

**No echoes.** A federate never receives its own HLA updates or interactions.
On the DIS side the bridge drops PDUs carrying its own site and application,
which are the ones it sent itself.

## FOM subset and mapping

[`hla/fom/werforces-rpr.xml`](../hla/fom/werforces-rpr.xml) is one IEEE
1516-2010 FOM module. It uses RPR FOM 2.0 names, datatypes and encodings:
big-endian HLA basic types, `RPRunsignedInteger16BE`/`32BE`, fixed records
with field alignment.

Object classes (all publish/subscribe):

| RPR class | Used for DIS entity type |
| --- | --- |
| `BaseEntity.PhysicalEntity.Platform.GroundVehicle` | kind 1, domain 1 (land) |
| `BaseEntity.PhysicalEntity.Platform.Aircraft` | kind 1, domain 2 (air) |
| `BaseEntity.PhysicalEntity.Platform.SurfaceVessel` | kind 1, domain 3 |
| `BaseEntity.PhysicalEntity.Platform.SubmersibleVessel` | kind 1, domain 4 |
| `BaseEntity.PhysicalEntity.Platform.Spacecraft` | kind 1, domain 5 |
| `BaseEntity.PhysicalEntity.Platform` | other platform domains |
| `BaseEntity.PhysicalEntity.Lifeform.Human` / `.NonHuman` | kind 3, category below / from 200 |
| `BaseEntity.PhysicalEntity.Munition` | kind 2 |
| `BaseEntity.PhysicalEntity` | anything else; the bridge subscribes here, so it discovers every subclass |

Attributes:

| Attribute (class) | Datatype | Encoding | DIS Entity State field |
| --- | --- | --- | --- |
| `EntityType` (BaseEntity) | `EntityTypeStruct` | 8 octets | Entity type |
| `EntityIdentifier` (BaseEntity) | `EntityIdentifierStruct` | 3 × UnsignedInteger16 | Entity id (the sender's; receivers use their own) |
| `WorldLocation` (BaseEntity) | `WorldLocationStruct` | 3 × HLAfloat64BE, ECEF m | Location |
| `Orientation` (BaseEntity) | `OrientationStruct` | 3 × HLAfloat32BE, ψ θ φ rad | Orientation |
| `VelocityVector` (BaseEntity) | `VelocityVectorStruct` | 3 × HLAfloat32BE, ECEF m/s | Linear velocity |
| `DeadReckoningAlgorithm` (BaseEntity) | `DeadReckoningAlgorithmEnum8` | HLAoctet | Dead-reckoning algorithm |
| `DamageState` (PhysicalEntity) | `DamageStatusEnum32` | RPRunsignedInteger32BE | Appearance bits 3–4 |
| `ForceIdentifier` (PhysicalEntity) | `ForceIdentifierEnum8` | HLAoctet | Force id |
| `Marking` (PhysicalEntity) | `MarkingStruct` | encoding octet + 11 ASCII | Marking |
| `Immobilized` (PhysicalEntity) | `RPRboolean` | HLAoctet | Appearance bit 1 (mobility kill) |
| `FirePowerDisabled` (PhysicalEntity) | `RPRboolean` | HLAoctet | Appearance bit 2 (firepower kill) |
| `FlamesPresent` (PhysicalEntity) | `RPRboolean` | HLAoctet | Appearance bit 15 |
| `EngineSmokeOn` (PhysicalEntity) | `RPRboolean` | HLAoctet | Appearance smoke bits 5–6 = 2 or 3 |

Interactions:

| Interaction | Parameters | DIS PDU |
| --- | --- | --- |
| `WeaponFire` | `EventIdentifier`, `FireControlSolutionRange`, `FireMissionIndex`, `FiringLocation`, `FiringObjectIdentifier`, `FuseType`, `InitialVelocityVector`, `MunitionObjectIdentifier`, `MunitionType`, `QuantityFired`, `RateOfFire`, `TargetObjectIdentifier`, `WarheadType` | Fire |
| `MunitionDetonation` | `DetonationLocation`, `DetonationResultCode`, `EventIdentifier`, `FiringObjectIdentifier`, `FinalVelocityVector`, `FuseType`, `MunitionObjectIdentifier`, `MunitionType`, `QuantityFired`, `RateOfFire`, `RelativeDetonationLocation`, `TargetObjectIdentifier`, `WarheadType` | Detonation |

`RTIobjectId` (the `…ObjectIdentifier` parameters) is RPR's
`RPRnullTerminatedArray` of `HLAASCIIchar`: the instance name followed by a
NUL octet; empty when the DIS id is unknown or none. `EventIdentifierStruct` is
the event count (UnsignedInteger16) followed by the firing entity's
`RTIobjectId`.

### Deviations from RPR FOM 2.0

- **Spatial.** RPR 2.0 carries location, orientation, velocity, acceleration and
  angular velocity in a single `Spatial` attribute (`SpatialVariantStruct`,
  a variant record keyed by the dead-reckoning algorithm). This module uses the
  RPR 1.0-style separate attributes `WorldLocation`, `Orientation`,
  `VelocityVector` and `DeadReckoningAlgorithm` on `BaseEntity`. The bridge
  always updates them together, so they behave as one record.
  `AccelerationVector`, `AngularVelocityVector` and articulated parts are not
  carried (WeRForces sends zeros and no articulation).
- **One module, a subset.** RPR 2.0 is split into modules (Foundation, Base,
  Physical, Warfare, …). This is a single self-contained module with only the
  classes and datatypes above. It cannot be loaded alongside the official RPR
  modules (same class names, different attributes), so every federate in the
  federation must use this module, or a superset with identical definitions.
- **Simplified datatypes.** `EntityTypeStruct` uses `Octet`/`UnsignedInteger16`
  fields as in RPR, but the enumerations (`FuseTypeEnum16`, `WarheadTypeEnum16`,
  `DetonationResultCodeEnum8`, …) list only a few enumerators. Other values pass
  through unchanged. The `MunitionDetonation` `ArticulatedPartData` parameter is
  omitted.
- **Radio and simulation management.** `RadioSignal`, `RadioTransmitter`, text
  and simulation-management interactions are not bridged; only Entity State,
  Fire and Detonation are.

## Limitations

- The bridge only uses receive-order messaging. It neither regulates nor is
  constrained by HLA time management, which is how RPR federations normally
  run.
- No ownership transfer: entities stay owned by the side that created them.
- Discovered entities get the bridge's own DIS ids. The RPR `EntityIdentifier`
  of a remote federate's entity is not reused, because non-DIS federates often
  leave it unset or duplicate it.
- HLA has no entity timeout. If a federate dies without deleting its objects,
  the bridge keeps sending DIS heartbeats for them for as long as the RTI keeps
  them, which varies between RTIs.
- OHLA is a small open-source RTI that has not been updated since 2014. It works
  for this bridge on Java 21 with the two build-time patches above, but it is
  not a production RTI.
- The bridge has no DIS multicast TTL or interface options; put it on the
  interface WeRForces uses.

## Other RTIs

The bridge calls only the standard API: `RtiFactoryFactory.getRtiFactory()`,
`connect`, `createFederationExecution`, `joinFederationExecution`, the
publish/subscribe and object/interaction services, and `evokeMultipleCallbacks`
(HLA_EVOKED callback model). To run it on another IEEE 1516e Java RTI, put that
RTI's jars on the classpath instead of OHLA's:

```bash
HLA_RTI_CLASSPATH=/opt/prti1516e/lib/prti1516e.jar hla/run-bridge.sh --rti-host crc.example.org --rti-port 8989
```

The local settings designator passed to `connect()` is RTI-specific:

| RTI | `--rti-host`/`--rti-port` become | Notes |
| --- | --- | --- |
| OHLA | a generated properties resource `host=…`, `port=…` on the context class loader | Default `localhost:15000` |
| Pitch pRTI | `crcAddress=host:port` | CRC default port 8989 |
| Portico | not used (warning printed) | Portico finds peers through its `RTI.rid` configuration; leave host/port unset |
| MAK RTI | not used (warning printed) | Configure `rid.mtl`, or pass MAK's settings with `--rti-settings` |

For any RTI, `--rti-settings '<designator>'` is passed through unchanged. The
FOM module is a standard IEEE 1516-2010 OMT file. RTIs that validate FOMs
strictly may also want the HLA standard MIM, which they supply themselves.
