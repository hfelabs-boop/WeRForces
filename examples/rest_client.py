"""Query and control WeRForces from Python using only the standard library.

    python3 examples/rest_client.py [http://127.0.0.1:8080]
    WERFORCES_API_KEY=secret python3 examples/rest_client.py   # if the server uses --api-key

Shows terrain queries, route planning, creating and tasking an entity, advancing
time and reading the GeoJSON export.
"""

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

BASE = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("WERFORCES_URL", "http://127.0.0.1:8080")
KEY = os.environ.get("WERFORCES_API_KEY")


def api(method, path, body=None):
    headers = {"Content-Type": "application/json"}
    if KEY:
        headers["Authorization"] = f"Bearer {KEY}"
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(f"{BASE}/api/v1{path}", data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req) as res:
            raw = res.read()
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as err:
        message = json.loads(err.read()).get("error", {}).get("message", err.reason)
        raise SystemExit(f"{method} {path} failed: {message}") from None


api("POST", "/scenario/new", {"name": "Python example"})
sim = api("GET", "/simulation")
towns = {t["name"]: t for t in sim["terrain"]["towns"]}
print("Towns:", ", ".join(towns))

# Terrain at each town, and whether two of them can see each other.
for name in ("Calloway", "Fallow Cross"):
    p = api("GET", f"/terrain/point?town={urllib.parse.quote(name)}")
    print(f"  {name:13s} elevation {p['elevation']:6.1f} m  road={p['road']}  forest={p['forest']}")
los = api("POST", "/terrain/line-of-sight", {"from": {"town": "Calloway"}, "to": {"town": "Fallow Cross"}})
print(f"Calloway -> Fallow Cross: {'visible' if los['visible'] else 'masked'} at {los['distance']} m")

# Plan a road route without moving anything.
route = api("POST", "/terrain/route", {"from": {"town": "Calloway"}, "to": {"town": "Fallow Cross"}, "domain": "ground"})
print(f"Ground route: {len(route['waypoints'])} waypoints, {route['length'] / 1000:.1f} km")

# A HMMWV drives it; advance five minutes and see where it is.
jeep = api("POST", "/entities", {"typeId": "us-hmmwv", "force": 1, "position": {"town": "Calloway"}, "name": "Courier"})
api("POST", f"/entities/{jeep['id']}/task", {"type": "moveTo", "target": {"town": "Fallow Cross"}})
api("POST", "/simulation/step", {"seconds": 300})
jeep = api("GET", f"/entities/{jeep['id']}")
print(f"After 5 min the courier is at {jeep['lat']:.5f}, {jeep['lon']:.5f} doing {jeep['speed'] * 3.6:.0f} km/h: {jeep.get('task') or 'arrived'}")

# The same position via the GeoJSON export (what QGIS or a web map would read).
geo = api("GET", "/export/entities.geojson")
feature = next(f for f in geo["features"] if f["id"] == jeep["id"])
print("GeoJSON:", json.dumps(feature["geometry"]), feature["properties"]["cotType"])
