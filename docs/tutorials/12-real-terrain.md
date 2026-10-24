# Tutorial 12: Real terrain

**Time:** 15 minutes (plus a 30 MB download) · **You will learn:** importing real
elevation data, adding your own map features, starting a scenario on the result,
and checking line of sight and routes on it.

The area is the Fulda valley in Hesse, Germany: the Cold War's "Fulda Gap".
The repository already contains `terrains/fulda.json`, made exactly as in
step 2. This tutorial rebuilds it with an extra overlay.

## 1. Download the elevation data

The [Copernicus DEM GLO-30](https://registry.opendata.aws/copernicus-dem/) covers
the world at 30 m in 1° × 1° tiles, free to use with attribution. Fulda lies in
the tile whose south-west corner is 50°N 9°E:

```bash
curl -O https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_N50_00_E009_00_DEM/Copernicus_DSM_COG_10_N50_00_E009_00_DEM.tif
```

Any GeoTIFF elevation model in WGS-84 latitude/longitude, UTM or Web Mercator
works the same way ([Terrain import](../terrain-import.md#get-elevation-data)).

## 2. Import a 10 km square

```bash
npm run terrain:import -- --dem Copernicus_DSM_COG_10_N50_00_E009_00_DEM.tif \
  --name fulda-exercise --title "Fulda exercise" \
  --center 50.553,9.68 --size 10000 --cell 50 \
  --features examples/fulda-overlay.geojson \
  --attribution "Copernicus DEM GLO-30 (c) DLR/Airbus; overlay: exercise planners"
```

```
Wrote terrains/fulda-exercise.json
  10.0 km square, 50 m grid (201x201), SW corner 50.50805, 9.60945
  relief 250 m, water 0.0%, forest 2.7%, 1 roads, 2 towns, 0 buildings
Use it: werforces with a scenario whose terrain is {"dataset": "fulda-exercise"}, or New scenario in the GUI.
```

The tile is 3600 × 3600 posts; the importer cuts out a 10 km square centred on
Fulda and resamples it to a 50 m grid. The whole tile is about 70 × 111 km;
without `--size` you get the largest square that fits, capped at 40 km.

## 3. The overlay

Without features, imported terrain is bare ground: no roads, water, forest or
towns. Normally you take them from an
[OpenStreetMap export](../terrain-import.md#get-map-features). Here
[`examples/fulda-overlay.geojson`](../../examples/fulda-overlay.geojson) is a
small overlay an exercise planner might draw in geojson.io or QGIS instead:

| Feature | GeoJSON | Becomes |
| --- | --- | --- |
| `OBJ DOM` at the cathedral, `LD WEST` (a line of departure) | Points with `"kind": "town"` and a `name` | Named places: usable as `{"town": "OBJ DOM"}` in the API, labelled on the map |
| *Exercise track* from the west edge to the objective | A LineString with `"highway": "track"` | A road: vehicles drive faster on it and route planning prefers it |
| *Wood A*, *Wood B* | Polygons with `"landuse": "forest"` / `"natural": "wood"` | Forest: concealment and slow going |

Tags and `kind` values are interchangeable, so an OpenStreetMap export and a
hand-drawn overlay can be combined into one file.

## 4. Start a scenario on it

The server picks up new files in `terrains/` straight away: choose **File →
New scenario → Terrain → Fulda exercise**. Or through the API:

```bash
curl -s localhost:8080/api/v1/terrains | jq -c '.[] | [.name, .title, .size, .relief, .towns]'
```

```json
["fulda-exercise","Fulda exercise",10000,250,2]
["fulda","Fulda (Copernicus GLO-30)",10000,250,0]
```

```bash
curl -s -X POST localhost:8080/api/v1/scenario/new -H 'Content-Type: application/json' \
  -d '{"name": "Fulda exercise", "terrain": {"dataset": "fulda-exercise"}}'
```

The 2D map now shows the real relief: the Fulda valley running north–south
through the middle, the hills to the east and west, with height tints and
contours scaled to this terrain's own range. The 3D view is the real landscape.

## 5. Ask the terrain

Elevation and features at the objective, and at a point given by latitude and
longitude:

```bash
curl -s 'localhost:8080/api/v1/terrain/point?town=OBJ%20DOM'
curl -s 'localhost:8080/api/v1/terrain/point?lat=50.559&lon=9.689'
```

```json
{"x":4444,"y":5178,"lat":50.5546005,"lon":9.6720951,"elevation":263.1,"water":false,"forest":false,"road":true,"slopeDeg":4.1,"nearestTown":"OBJ DOM"}
{"x":5643.189078005778,"y":5667.396459442151,"lat":50.559,"lon":9.689,"elevation":292.8,"water":false,"forest":false,"road":false,"slopeDeg":6.5,"nearestTown":"OBJ DOM"}
```

The cathedral square is at 263 m, as on the map; the second point is on the
slope east of the town. Can a tank commander at the line of departure see the
objective?

```bash
curl -s -X POST localhost:8080/api/v1/terrain/line-of-sight -H 'Content-Type: application/json' \
  -d '{"from": {"town": "LD WEST", "height": 2}, "to": {"town": "OBJ DOM", "height": 2}}'
```

```json
{"visible":false,"distance":4051,"from":{"x":1458,"y":2441,"z":303.34935437011717},"to":{"x":4444,"y":5178,"z":265.0911931640625}}
```

No: high ground in between blocks the 4 km sight line. The ground route uses the
track:

```bash
curl -s -X POST localhost:8080/api/v1/terrain/route -H 'Content-Type: application/json' \
  -d '{"from": {"town": "LD WEST"}, "to": {"town": "OBJ DOM"}, "domain": "ground"}'
```

```json
{"waypoints":[{"x":3300,"y":3850},{"x":4450,"y":5200},{"x":4444,"y":5178}],"length":4115}
```

## 6. Fight on it

```bash
curl -s -X POST localhost:8080/api/v1/units -H 'Content-Type: application/json' \
  -d '{"templateId": "us-tank-platoon", "force": 1, "position": {"town": "LD WEST"}, "name": "Team TANK"}'
curl -s -X POST localhost:8080/api/v1/units -H 'Content-Type: application/json' \
  -d '{"templateId": "ru-mech-platoon", "force": 2, "position": {"lat": 50.5546, "lon": 9.676}, "name": "Red Mech"}'
curl -s -X POST localhost:8080/api/v1/units/U1/task -H 'Content-Type: application/json' \
  -d '{"type": "moveTo", "target": {"town": "OBJ DOM"}}'
curl -s -X POST localhost:8080/api/v1/simulation/step -H 'Content-Type: application/json' -d '{"seconds": 900}'
```

The event log:

```
00:02:25  Team TANK Lead detected Red Mech 2
00:02:27  Red Mech 2 destroyed by Team TANK Lead
00:02:29  Team TANK Lead detected Red Mech Lead
00:02:29  Team TANK Lead detected Red Mech 3
00:02:33  Red Mech Lead destroyed by Team TANK 3
00:02:34  Red Mech: Red Mech Lead lost, Red Mech 3 takes command
00:02:34  Red Mech broke and is falling back
…
00:03:50  Team TANK 2 destroyed by Red Mech 3
00:05:05  Red Mech rallied
00:06:05  Red Mech 3 destroyed by Team TANK Lead
```

The BMPs are seen when the tanks come over a rise about 2.7 km out, and two of
them are destroyed within eight seconds. The third breaks and falls back. The
tanks, still driving towards the objective, miss it again and again, and one of
its Konkurs missiles destroys a tank before the platoon leader hits it at 6:05. Positions given as latitude/longitude
land where you expect, and everything the simulator sends out (DIS, Cursor on
Target, GeoJSON, KML) lines up with real maps: open
`/api/v1/export/scene.kml` in Google Earth to check.

## Things to try

- Import a bigger area at a coarser grid (`--size 30000 --cell 100`) and run a
  battalion-sized scenario.
- Export roads, rivers, lakes, woods and villages for the same area from
  OpenStreetMap and import them with `--features`. Rivers become obstacles that
  ground forces cross only at bridges.
- Put the dataset on another server: `PUT /api/v1/terrains/fulda-exercise` with
  the JSON file as the body.

**Next:** [Tutorial 13: Obstacles, smoke and breaching](13-obstacles-smoke-and-breaching.md).
