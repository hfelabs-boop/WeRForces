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

### Nobody is shooting

Check these in order:

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
with `npm run terrain:import`, then pick the terrain in **File → New
scenario**. A 10 km Fulda sample is included. See
[Terrain import](terrain-import.md). Generated terrain also converts to real
latitude/longitude (set `terrain.origin`), so exports and TAK feeds land
wherever you place the map.

### `403 exercise control only` or *players cannot …*

You are using a player key (`--player`). Players can only see and order their
own force; time, scenarios, recordings and exports need the `--api-key`. See
[Concepts → Fog of war and roles](concepts.md#fog-of-war-and-roles).

### The artillery doesn't answer my observer's calls

A call needs: an observer with **Call for fire** set that currently sees a
hostile ground target; a friendly gun, mortar or battery that is idle (no
running task or plan, not on hold fire) and in range (155 mm: 2–22 km, 81 mm:
80 m – 5.6 km); no friendly troops within 150 m of the target; and no other
mission already on that spot. Observers call at most once a minute. See
[Concepts → Indirect fire](concepts.md#indirect-fire-and-call-for-fire).

### My infantry won't get in

Only dismounted infantry can mount, the carrier must be stopped (a helicopter
must have landed: *Set altitude 0*), and it needs free seats (M2A3 6, BMP-2 7,
UH-60 11, Mi-24 8, Ural 20). The task fails with *no free seats* otherwise.

### The AAR button says "Nothing recorded yet"

The recording starts when a scenario is loaded and samples once per simulated
second. Run or step the simulation first. A server started with
`--record-interval 0` does not record.
