# Tutorial 7: TAK, webhooks and GIS

**Time:** 20 minutes · **You will learn:**

- streaming the simulation to TAK clients;
- posting events to chat or your own service;
- viewing live positions in QGIS and Google Earth.

All three can be set up from the command line, from the **Integrations** dialog
in the toolbar, or through the REST API. Formats are in the
[Integrations reference](../reference/integrations.md).

---

## Part A: TAK / Cursor-on-Target

TAK (ATAK on Android, WinTAK, iTAK and TAK Server) uses **Cursor-on-Target**
XML messages. WeRForces sends one CoT event per entity every few seconds. Each
carries a MIL-STD-2525-derived type (friendly armour, hostile helicopter…),
the callsign, course and speed.

### A1. Try it without a TAK device

Terminal 1, a listener that prints CoT traffic:

```bash
node examples/cot-listener.mjs 16969
```

Terminal 2, WeRForces sending to it:

```bash
npm start -- -s calloway-crossroads --cot udp://127.0.0.1:16969 --run --time-scale 8
```

The listener shows:

```
listening for CoT on udp 0.0.0.0:16969
a-f-G-U-C-A    Team ARMOR Lead          50.7885763, 10.0497392  course 52.5°  3.8 m/s
a-f-G-U-C-A    Team ARMOR 2             50.7878570, 10.0508216  course 304.0°  3.7 m/s
…
```

### A2. ATAK / WinTAK on the same network

ATAK and WinTAK listen for situational-awareness traffic on the multicast group
**239.2.3.1:6969**, which is also WeRForces' default:

```bash
npm start -- -s calloway-crossroads --cot udp://239.2.3.1:6969 --run
```

Or enable it at runtime: **Integrations → TAK / Cursor-on-Target**, tick
**enabled**, keep `udp://239.2.3.1:6969`, and press **Apply**.

The simulated forces appear on the TAK map as Blue/Red/Green MIL-STD-2525
symbols, moving with the simulation. Destroyed units fade after a few
seconds; deleted ones disappear at once.

Multicast must reach the device. Phones on guest Wi-Fi, VPNs and containers
often block it; if nothing shows, use a TAK Server.

### A3. TAK Server

TAK Server accepts CoT over a plain TCP **streaming input**. Many installs
already have one on port 8087. If not, add an input to `CoreConfig.xml`:

```xml
<input _name="stdtcp" protocol="tcp" port="8087"/>
```

Then point WeRForces at it:

```bash
npm start -- -s calloway-crossroads --cot tcp://takserver.example:8087
```

All clients connected to the server now see the simulation, even over the
internet. WeRForces reconnects automatically if the connection drops. The
dialog's status line shows *Streaming · N events sent* (or the last error).

### A4. Options

| Option | Where | Effect |
| --- | --- | --- |
| Interval | `--cot-interval 1`, or the dialog | Report rate. 1–2 s looks smooth |
| Include DIS remote entities | dialog / API `includeRemote` | Also forward entities from other DIS simulations ([Tutorial 6](06-dis-interoperability.md)), bridging a DIS exercise to TAK |
| Stale time | API `stale` | How long TAK keeps a report without updates |

```bash
curl -s -H 'Content-Type: application/json' -X PUT http://127.0.0.1:8080/api/v1/integrations/cot \
  -d '{"enabled":true,"url":"udp://239.2.3.1:6969","interval":1,"includeRemote":true}'
```

---

## Part B: Webhooks

Webhooks push events (kills, damage, task changes) to Slack, Discord or your own
HTTP service as they happen.

### B1. Your own receiver, with signatures

Terminal 1:

```bash
WEBHOOK_SECRET=s3cret node examples/webhook-receiver.mjs 9000
```

Terminal 2:

```bash
npm start -- -s calloway-crossroads --run --time-scale 32
```

Register the webhook with a secret and the event kinds you want:

```bash
curl -s -H 'Content-Type: application/json' http://127.0.0.1:8080/api/v1/webhooks \
  -d '{"url":"http://127.0.0.1:9000/hook","secret":"s3cret","kinds":["destroyed","task"]}'
```

The receiver verifies each payload's `X-WeRForces-Signature` header and prints
the events:

```
webhook receiver on http://127.0.0.1:9000/hook (verifying signatures)
[Calloway Crossroads] destroyed  Tank Plt 1 Lead destroyed by Gunslinger Lead
[Calloway Crossroads] destroyed  Tank Plt 1 3 destroyed by Gunslinger Lead
[Calloway Crossroads] destroyed  Tank Plt 1 2 destroyed by Gunslinger 2
[Calloway Crossroads] destroyed  Convoy 7 Lead destroyed by Gunslinger 2
…
```

The [Integrations reference](../reference/integrations.md#signature) has the
payload format and verification code for Node and Python.

### B2. Slack

1. In Slack, create an app with **Incoming Webhooks** enabled and add a webhook
   to a channel. Copy its URL (`https://hooks.slack.com/services/…`).
2. In WeRForces: **Integrations → Webhooks**, paste the URL. The format switches
   to **slack** automatically. Keep the default kinds (damage, kills, tasks,
   info) and press **Add**. Then **Test**.
3. Run a scenario. Kills and plan completions appear in the channel, batched
   once per second.

Or from the command line: `npm start -- --webhook https://hooks.slack.com/services/…`.

### B3. Discord

In Discord: **Channel settings → Integrations → Webhooks → New webhook → Copy
URL** (`https://discord.com/api/webhooks/…`). Add it the same way; the format
becomes **discord**.

> Avoid sending *fire* and *detected* events to chat: there are hundreds per
> battle. Webhooks deliver at most one batch per second each, and failed batches
> are not retried.

---

## Part C: GIS

Every running server serves live map feeds:

| URL | Content |
| --- | --- |
| `/api/v1/export/entities.geojson` | Entity positions with properties (force, type, damage, task, CoT type…) |
| `/api/v1/export/graphics.geojson` | Routes, phase lines, areas, points |
| `/api/v1/export/scene.kml` | Both, styled, for Google Earth |
| `/api/v1/export/live.kml` | A self-refreshing Google Earth link |

The **Integrations → GIS export** section links to all of them.

### C1. QGIS (live layer)

1. **Layer → Add Layer → Add Vector Layer…**
2. Source type **Protocol: HTTP(S), cloud, etc.**, type **GeoJSON**, URI
   `http://127.0.0.1:8080/api/v1/export/entities.geojson`, then **Add**.
3. Layer **Properties → Rendering**: tick **Refresh layer at interval** and set
   2 seconds.
4. Style by the `forceName` field (Categorized) and label with `name`.

Add `graphics.geojson` the same way for routes and objective areas. With an API
key, append `?api_key=<key>` to the URLs.

### C2. Google Earth

Open `http://127.0.0.1:8080/api/v1/export/live.kml` in the browser. It
downloads `werforces-live.kml`. Open that in Google Earth Pro. It reloads the
scene every 5 seconds (change with `?refresh=2`).

- Entities appear as placemarks coloured by force and rotated to their heading.
  Aircraft are shown at their altitude, and destroyed vehicles with a distinct
  icon.
- Graphics show as lines and translucent polygons.
- Click a placemark for its type, damage, speed and task.

Positions are real latitude/longitude around the scenario's `terrain.origin`.
To put the battle somewhere else on the globe, change `origin`
([Tutorial 3](03-building-a-scenario.md#6-edit-the-file-by-hand)).

### C3. Web maps

GeoJSON loads directly in Leaflet, Mapbox GL or OpenLayers. If the page is
served from another origin, allow it:

```bash
npm start -- --cors https://my-dashboard.example
```

**Next:** [Tutorial 8: Batch runs and Monte Carlo analysis](08-batch-and-monte-carlo.md).
