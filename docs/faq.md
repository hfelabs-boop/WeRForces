# FAQ and troubleshooting

### The page says "Front-end not built"

Run `npm run build` (or `npm run build:web`). The server serves the browser app
from `dist/web`.

### `EADDRINUSE` when starting

Another process is using the port. Pick another with `npm start -- --port 9000`.
For DIS, another program may hold UDP 3000; use `--dis-port`.

### My tanks won't go where I clicked

- The destination may be unreachable for that domain (water, or a cliff over
  ~31°). The event log then shows *Move to … failed: no route to destination*.
- Vehicles prefer roads when that is faster, so the route can look indirect.
  Turn on **Layers → Planned paths** and select the vehicle to see its route.
- A unit's followers keep formation on the leader. Task the unit, not the
  individual members.

### Why isn't my unit doing what I ordered?

Select it and read **Why?** in the inspector (**Details** for every reason). It
says what stops it moving, shooting or seeing, such as *Pinned down*, *Halted on
contact*, *Rules of engagement: hold fire*, *No line of sight to T-72B3: blocked
by the ground (a crest or ridge) at (9070, 7813)* or *Radio jammed*, with a fix.
Click a finding with a place to mark it on the map. Scripts use `GET
/api/v1/entities/{id}/explain`; AI agents the MCP tool `explain`. See
[Concepts](concepts.md#explanations-and-alerts).

### Nobody is shooting

Read **Why?** first (above). Otherwise check these in order:

1. **ROE.** *Hold fire* and *Return fire* restrict engagement (see
   [Concepts](concepts.md#rules-of-engagement)).
2. **Detection.** The shooter must have the target in its *Contacts*. Forest
   canopy, terrain and sensor field of view all matter. Turn on **Layers →
   Sensor contacts**.
3. **Hostility.** Only hostile forces engage each other. Blue and Neutral are
   not hostile by default.
4. **Weapon.** Some weapons cannot engage some targets (an anti-tank missile
   cannot hit aircraft, a SAM cannot hit tanks), and ammunition runs out. Check
   **Weapons** in the inspector and turn on **Layers → Weapon/sensor ranges**.

### The same scenario always plays out identically

That is intended: runs are deterministic for a seed. For different outcomes,
call `engine.reseed(n)` after loading (see
[Tutorial 8](tutorials/08-batch-and-monte-carlo.md)), or change the terrain seed.

### The 3D view is blank or slow

- The 3D view needs WebGL. Check that hardware acceleration is enabled in the
  browser.
- In a VM or remote desktop the browser may be using software rendering. Use 2D,
  or lower the window size.
- **Reset view** returns the camera to the overview if you get lost.

### `401 missing or invalid API key`

The server was started with `--api-key` or `WERFORCES_API_KEY`. Send
`Authorization: Bearer <key>` (or `X-API-Key: <key>`, or `?api_key=` in a URL).
The browser asks for the key once. To change a stored key, clear the site's
local storage.

### `415 Content-Type must be application/json`

`POST` and `PUT` requests must send `Content-Type: application/json`, even with
an empty body `{}`. This stops other web pages from controlling your simulation
with form posts.

### `403 host not allowed`

On a loopback-only server (the default), requests must use `localhost` or
`127.0.0.1` as the host name. To accept other host names, listen on a real
interface with `--host 0.0.0.0` (and set `--api-key`).

### A web page on another origin can't call the API

Cross-origin access is off by default. Allow an origin with
`--cors https://my.dashboard` (repeat for more, or `--cors '*'` for any).

### DIS entities from my other simulation don't appear

- Make sure both use the same **exercise id** and **UDP port**. Use a broadcast
  or multicast address both can reach.
- Each application must have a unique **site:application** pair, because
  WeRForces ignores PDUs carrying its own pair.
- Remote entities disappear after 12 s without an update. Check that the other
  side sends heartbeats.
- See [Tutorial 6](tutorials/06-dis-interoperability.md) and
  [DIS reference](reference/dis.md).

### ATAK doesn't show anything

- ATAK listens for the SA multicast group `239.2.3.1:6969` on the same network.
  Containers, VPNs and many Wi-Fi networks block multicast. Try a TAK Server
  over TCP instead (`--cot tcp://server:8087`).
- Check WeRForces' side with `node examples/cot-listener.mjs 6969 239.2.3.1`.

### Webhook deliveries fail

Open **Integrations → Webhooks**: each webhook shows its last error and its
sent/failed counts. Use **Test** to send a sample. Slack and Discord URLs need
the matching *format*.

### Where are scenarios saved?

**Save on server…** writes `scenarios/<name>.json` on the machine running the
server. **Export to file** downloads the same JSON to your computer.

### Can I use real terrain or maps?

Yes. Import a GeoTIFF elevation model and, optionally, OpenStreetMap features
and buildings (a file, or straight from Overpass) and ESA WorldCover land cover
with `npm run terrain:import`, then pick the terrain in **File → New
scenario**. A 10 km Fulda sample is included. See
[Terrain import](terrain-import.md). Generated terrain also converts to real
latitude/longitude (set `terrain.origin`), so exports and TAK feeds land
wherever you place the map.

### `403 exercise control only` or *players cannot …*

You are using a player key (`--player`). Players can only see and order their
own force; time, scenarios, recordings and exports need the `--api-key`. See
[Concepts → Fog of war and roles](concepts.md#fog-of-war-and-roles).

### Orders arrive a minute late, and contacts aren't shared

The unit's radio is jammed: its activity shows *RADIO JAMMED* and the alerts list
*radio jammed*. An enemy jammer within reach (15 km for the R-330Zh, 10 km for
the Stryker MFEW) delays every order by 60 s at each level of the chain of
command, stops contact sharing and calls for fire, and keeps codewords from it.
Its reach is the purple dashed circle on the map. Move out of it, destroy the
jammer, or switch it off (exercise control: the jammer's inspector, or `PATCH
/api/v1/entities/{id}` with `{"jamming": false}`). See
[Concepts](concepts.md#electronic-warfare).

### A phase of the synchronization matrix doesn't start

Phases start in order, so check that the one before it has started (**Phases**
shows *started* and the time). A *when previous done* trigger waits until every
order of the previous phase is carried out: an order that never ends, such as
*Defend* or *Overwatch* without a duration, keeps it waiting (orders to units
wiped out count as done). Move such orders to a phase of their own, or give the
next phase another trigger. A *codeword* trigger needs exactly that codeword
(`GET /api/v1/codewords` lists those sent); send it from the codeword box at
the bottom of the **Phases** dialog. **▶ Start now** starts a phase by hand.

### The order line says *which one?* or *where?*

The order names something more than one object answers to, or a place it
doesn't know. *which one?* lists the candidates with their ids: type the id
(*E31*) or the name with its id (*T-72B3 (E31)*). For a place, use a town, a
graphic name or id (*G5*), an object, coordinates (*9382 7938*) or *2 km north
of Brenham*. Two different graphics with the same name can't be told apart
(*where?*): use the id. A graphic drawn once for each force with the same name
and shape, like a quick battle's *OBJ RAVEN*, counts as one place. Check an order
without carrying it out with `POST /api/v1/orders` and `"dryRun": true`.

### The artillery doesn't answer my observer's calls

A call needs: an observer with **Call for fire** set that currently sees a
hostile ground target; a friendly gun, mortar or battery that is idle (no
running task or plan, not on hold fire) and in range (155 mm: 2–22 km, 81 mm:
80 m – 5.6 km); no friendly troops within 150 m of the target; and no other
mission already on that spot. Observers call at most once a minute, and
neither the observer nor the guns may have their radio jammed. See
[Concepts → Indirect fire](concepts.md#indirect-fire-and-call-for-fire).

### My infantry won't get in

Only dismounted infantry can mount, the carrier must be stopped (a helicopter
must have landed: *Set altitude 0*), and it needs free seats (M2A3 6, BMP-2 7,
UH-60 11, Mi-24 8, Ural 20). The task fails with *no free seats* otherwise.

### The AAR button says "Nothing recorded yet"

The recording starts when a scenario is loaded and samples once per simulated
second. Run or step the simulation first. A server started with
`--record-interval 0` does not record.

### Does WeRForces speak HLA?

Yes, through a separate bridge federate in `hla/`: a small Java program that
joins an HLA 1516e (HLA Evolved) federation with a subset of the RPR FOM 2.0,
and relays entities, fire and detonations between the federation and
WeRForces' DIS gateway. `npm run hla:build` downloads the open-source OHLA RTI
and builds the bridge with plain `javac` (Java 17 or later). It is tested with
OHLA only; other RTIs (Pitch pRTI, MAK RTI, Portico) should work through the
standard API but are untested. Radio and simulation management PDUs are not
bridged. See [HLA](hla.md).

### The simulation clock runs slower than the time scale I set

The scenario is more than one core can simulate at that speed. The server keeps
responding, but the clock falls behind; `load` in `GET /api/v1/simulation` is
near 1. Lower the time scale, use a coarser terrain grid, or split the exercise
into sessions. `npm run bench` shows what your machine can do.

### Sign-in says *has no role in this exercise*

The user signed in at your identity provider, but no `--oidc-role` rule matched
their ID token. Check which claims the provider puts in the ID token (a group
claim often has to be enabled) and that the rule names that claim and value
exactly, or set `--oidc-default-role`. See
[Deployment → Sign in with OpenID Connect](deployment.md#sign-in-with-openid-connect).

### The radio or DIS log shows *start/resume (ignored)*

Another simulation on the DIS network sent a simulation-management PDU, and
WeRForces was started with `--dis-ignore-siman`. Without that flag it runs and
pauses with the simulation manager.
