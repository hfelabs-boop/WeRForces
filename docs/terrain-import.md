# Terrain import

WeRForces can run on real terrain. `werforces-terrain` takes:

- an **elevation model** (DEM) as a GeoTIFF, and optionally
- **map features** as GeoJSON (an OpenStreetMap export, or your own),

and writes a **terrain dataset** (`terrains/<name>.json`). Scenarios then refer
to it by name, and everything else (mobility, line of sight, route planning, the
2D and 3D views, DIS and TAK coordinates) works on it as on generated terrain.

A sample is included: **`fulda`**, 10 km around Fulda, Germany, from the
Copernicus DEM (elevation only).

## Use a dataset

- **GUI:** File → **New scenario** → **Terrain** → pick it.
- **REST:** `POST /api/v1/scenario/new` with `{"name": "...", "terrain": {"dataset": "fulda"}}`.
- **Scenario file:** `"terrain": {"dataset": "fulda"}`. The other terrain fields
  are taken from the dataset. Saving a scenario keeps the reference, not a copy
  of the terrain, so share the dataset file along with it.

`GET /api/v1/terrains` lists the datasets a server has. The server reads them
from `./terrains` (change with `--terrains <dir>`).

## Get elevation data

Any GeoTIFF DEM works if it is in one of these coordinate systems:

- geographic WGS-84 (EPSG:4326), or NAD83 / ETRS89, which are within a metre of it;
- UTM on WGS-84 (EPSG:326xx north, 327xx south);
- Web Mercator (EPSG:3857).

Reproject anything else first, e.g. `gdalwarp -t_srs EPSG:4326 in.tif out.tif`.
Good free sources:

| Source | Resolution | Notes |
| --- | --- | --- |
| [Copernicus DEM GLO-30](https://registry.opendata.aws/copernicus-dem/) | 30 m, worldwide | 1° tiles as cloud-optimised GeoTIFFs on AWS, e.g. `https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_N50_00_E009_00_DEM/Copernicus_DSM_COG_10_N50_00_E009_00_DEM.tif`. It is a surface model: towns and woods add their height |
| [SRTM](https://www.earthdata.nasa.gov/data/instruments/srtm) | 30 m, 60°N–56°S | Via NASA Earthdata or OpenTopography |
| National DEMs (USGS 3DEP, IGN, Ordnance Survey…) | 1–10 m | Often UTM or a national grid: reproject if needed |

## Get map features

Export an area from [OpenStreetMap](https://www.openstreetmap.org/export) (or
with Overpass Turbo → *Export → GeoJSON*), or draw your own in QGIS. The
importer reads WGS-84 GeoJSON and recognises:

| Layer | OpenStreetMap tags | Or `kind` | Becomes |
| --- | --- | --- | --- |
| Roads | `highway` = motorway, trunk, primary, secondary, tertiary, unclassified, residential, service, track (and `_link`s) | `road` | Roads (fast going), cut at the map edge |
| Lakes and reservoirs | `natural=water`, any `water=*`, `landuse=reservoir`/`basin`, `waterway=riverbank` (polygons) | `water` | Water: impassable to ground, navigable by boats at the lake's level |
| Rivers and canals | `waterway=river`/`canal` (lines) | `river` | Water one grid cell wide, **except where a road crosses** (a bridge) |
| Forest | `natural=wood`, `landuse=forest` (polygons) | `forest` | Forest: slows vehicles, hides and protects troops, blocks sight after 150 m |
| Towns | `place` = city, town, village, hamlet (points with a `name`) | `town` | Named towns (labels; `{"town": "Name"}` positions in the API) |

Everything else is ignored, so a full OSM export is fine. Ground below sea level
in the DEM is water too.

## Run the import

This is how the bundled sample was made, from the Copernicus tile above
(elevation only, so no roads, water, forest or towns):

```bash
npm run terrain:import -- --dem Copernicus_DSM_COG_10_N50_00_E009_00_DEM.tif \
  --name fulda --title "Fulda (Copernicus GLO-30)" --center 50.553,9.68 --size 10000 --cell 50 \
  --attribution "Copernicus DEM GLO-30: © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018, provided under COPERNICUS by the European Union and ESA"
```

```
Wrote terrains/fulda.json
  10.0 km square, 50 m grid (201x201), SW corner 50.50805, 9.60945
  relief 250 m, water 0.0%, forest 0.0%, 0 roads, 0 towns
```

Add `--features area.geojson` to bring in roads, water, forest and towns; the
summary line then counts them.

| Option | Default | Notes |
| --- | --- | --- |
| `--center lat,lon` | the DEM's centre | Centre of the square extent |
| `--size m` | largest square inside the DEM, at most 40 km | |
| `--cell m` | about the DEM's resolution, at least 20 m | At most 1201 × 1201 posts: big areas get a coarser grid. 50 m suits most scenarios; 25–30 m for close terrain |
| `--out dir` | `./terrains` | |

The local map is a square in a tangent plane whose south-west corner is the
dataset's `origin`; latitude/longitude conversions use it, so DIS, TAK and
GeoJSON output line up with real maps.

To install a dataset on a running server without file access,
`PUT /api/v1/terrains/<name>` with the dataset JSON as the body (exercise
control only, up to 8 MB).

## Licensing

Datasets are derived from your sources, so their licences apply. Copernicus DEM
GLO-30 may be redistributed with its notice (see `terrains/README.md`);
OpenStreetMap data is under the ODbL and needs "© OpenStreetMap contributors".
Put the credit in `--attribution`; it is stored in the dataset and listed by
`GET /api/v1/terrains`.

See [Tutorial 12](tutorials/12-real-terrain.md) for a worked example.
