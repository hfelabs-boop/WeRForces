# Integrations reference

Code: `src/integrations/`. For a walkthrough see
[Tutorial 7](../tutorials/07-tak-webhooks-and-gis.md).

## Cursor-on-Target (TAK)

### Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | Publish or not |
| `url` | `udp://239.2.3.1:6969` | `udp://host:port`: datagrams, unicast or multicast. ATAK/WinTAK listen on the SA multicast group 239.2.3.1:6969. `tcp://host:port`: a streaming connection to a TAK Server input (commonly 8087); reconnects every 5 s if dropped |
| `interval` | `2` | Seconds between reports (0.2–3600) |
| `stale` | `30` | Seconds until a report expires in TAK clients |
| `includeRemote` | `false` | Also publish entities received over DIS |

Set it with `--cot <url>` (and `--cot-interval`), with **Integrations → TAK** in
the GUI, or with `PUT /api/v1/integrations/cot`.

### Event format

Each interval, every entity is sent as one CoT event:

```xml
<event version="2.0" uid="WeRForces-E1" type="a-f-G-U-C-A" how="m-s"
       time="2026-10-24T08:00:00.000Z" start="2026-10-24T08:00:00.000Z" stale="2026-10-24T08:00:30.000Z">
  <point lat="50.7885763" lon="10.0497392" hae="84.9" ce="5.0" le="5.0"/>
  <detail>
    <contact callsign="Team ARMOR Lead"/>
    <track course="52.5" speed="3.8"/>
    <__group name="U1" role="Team Lead"/>
    <remarks>us-m1a2; Move to (8000, 7158)</remarks>
  </detail>
</event>
```

- `uid` is `WeRForces-<entity id>`. The callsign is the entity name. `course` is
  in degrees and `speed` in m/s.
- **Destroyed** entities are reported with a short stale time, so they fade.
  **Deleted** entities get one event whose `stale` equals `time`, so clients
  drop them immediately.
- `hae` is the simulation's altitude (MSL). The difference from true height
  above ellipsoid is the local geoid separation.

### CoT type mapping

`a-<affiliation>-<function>`, where affiliation is `f` (Blue), `h` (Red),
`n` (Neutral) or `u` (Other):

| Symbol | Function | Example (Blue) |
| --- | --- | --- |
| armor | `G-U-C-A` | `a-f-G-U-C-A` |
| mech | `G-U-C-I-Z` | `a-f-G-U-C-I-Z` |
| infantry | `G-U-C-I` | `a-f-G-U-C-I` |
| recon | `G-U-C-R` | `a-f-G-U-C-R` |
| air-defense | `G-U-C-D` | `a-f-G-U-C-D` |
| artillery | `G-U-C-F` | `a-f-G-U-C-F` |
| wheeled | `G-E-V` | `a-f-G-E-V` |
| generic ground / person | `G` | `a-f-G` |
| rotary wing | `A-M-H` | `a-f-A-M-H` |
| fixed wing | `A-M-F` | `a-f-A-M-F` |
| UAV | `A-M-F-Q` | `a-f-A-M-F-Q` |
| ship | `S-C` | `a-f-S-C` |
| boat | `S-C-P` | `a-f-S-C-P` |

## Webhooks

### Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| `url` | required | `http` or `https` URL |
| `format` | `json` | `json`, `slack` or `discord` |
| `kinds` | `damaged, destroyed, task, info` | Which event kinds to send: any of `fire`, `detonation`, `damaged`, `destroyed`, `detected`, `task`, `created`, `deleted`, `info` |
| `secret` | none | If set, each delivery is signed |
| `name` | the URL's host | Label shown in the GUI |

Add webhooks with `--webhook <url>` (format guessed from the URL), with
**Integrations → Webhooks**, or with `POST /api/v1/webhooks`.

### Delivery

- Events are queued per webhook and sent **once per second** in batches of up to
  100. Each webhook has at most one request in flight. The timeout is 5 s.
- Failed deliveries are counted and the last error is recorded. Failed batches
  are **not** retried.
- At most 1000 events are queued per webhook; older ones are dropped.

### Payloads

`json`:

```json
{
  "source": "werforces",
  "scenario": "Calloway Crossroads",
  "events": [
    { "seq": 412, "time": 1755.3, "kind": "destroyed", "text": "Tank Plt 1 3 destroyed by Team MECH Lead", "entityId": "E25", "targetId": "E7" }
  ]
}
```

`slack`: `{"text": "*WeRForces — Calloway Crossroads*\n`00:29:15` 💥 Tank Plt 1 3 destroyed by Team MECH Lead"}`

`discord`: `{"content": "…same text…"}`. Chat payloads are cut to 1900 characters.

### Signature

With a `secret`, each request carries:

```
X-WeRForces-Signature: sha256=<hex HMAC-SHA256 of the raw request body, keyed with the secret>
```

Verify it before trusting the payload. Node.js example (from
`examples/webhook-receiver.mjs`):

```js
import { createHmac, timingSafeEqual } from 'node:crypto';
const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
const ok = got.length === expected.length && timingSafeEqual(Buffer.from(got), Buffer.from(expected));
```

Python:

```python
import hashlib, hmac
expected = "sha256=" + hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()
ok = hmac.compare_digest(expected, request.headers["X-WeRForces-Signature"])
```

Other headers sent: `Content-Type: application/json` and
`User-Agent: WeRForces-Webhook/1`.

## GIS export

| Endpoint | Content |
| --- | --- |
| `GET /api/v1/export/entities.geojson` | `FeatureCollection` of `Point`s with `[lon, lat, alt]` |
| `GET /api/v1/export/graphics.geojson` | Routes and phase lines as `LineString`, areas as closed `Polygon`, points as `Point` |
| `GET /api/v1/export/scene.kml` | KML document: a folder per force (placemarks styled by force, rotated to heading, aircraft at absolute altitude), a *Tactical graphics* folder, and destroyed entities with a distinct icon |
| `GET /api/v1/export/live.kml?refresh=5` | KML **NetworkLink** that makes Google Earth re-fetch `scene.kml` every *refresh* seconds (downloads as `werforces-live.kml`) |

Entity feature properties:

| Property | Meaning |
| --- | --- |
| `id`, `name`, `type` | Identity |
| `force`, `forceName` | Force |
| `domain`, `symbol`, `cotType` | Classification |
| `damage` | Damage state |
| `heading` | Degrees |
| `speed` | m/s |
| `altitudeAgl` | Metres above ground |
| `unitId`, `task`, `plan`, `roe` | Tasking |
| `remote` | Received over DIS |

When an API key is in use:

- add `?api_key=<key>` to feed URLs that tools open directly;
- `live.kml` passes the key it was fetched with on to `scene.kml`.

Allow browser maps on other origins to fetch the feeds with `--cors <origin>`.
