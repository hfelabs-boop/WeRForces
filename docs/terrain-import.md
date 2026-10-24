# Terrain import

WeRForces can run on real terrain. `werforces-terrain` takes:

- an **elevation model** (DEM) as a GeoTIFF, and optionally
- **map features**: GeoJSON (an OpenStreetMap export, or your own), an
  OpenStreetMap XML file, or straight from the Overpass API;
- **land cover**: an ESA WorldCover GeoTIFF, or the public WorldCover tiles,

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
| Buildings | `building=*` (polygons, not `building=no`) | – (use a `building` property) | Building footprints: they block sight and movement and give troops cover ([Concepts](concepts.md#terrain)) |

Everything else is ignored, so a full OSM export is fine. Ground below sea level
in the DEM is water too.

A building's height is its `height` (or `building:height`) tag, else
`building:levels` × 3 m + 1 m, else a typical height for its type: 3 m for
garages and sheds, 7 m for houses, 15 m for apartments, offices and hotels,
20 m for churches and towers, 8 m otherwise.

There are three ways to bring in OpenStreetMap data:

| Option | Source |
| --- | --- |
| `--features area.geojson` | A GeoJSON file (Overpass Turbo → *Export → GeoJSON*, QGIS, your own) |
| `--osm area.osm` | OpenStreetMap XML: *Export* on openstreetmap.org, or saved from JOSM. Multipolygon relations become polygons |
| `--overpass` | Queries the Overpass API for the roads, water, forest, towns and buildings in the extent. `--overpass-url` picks another server (for example a private Overpass instance). Big areas with many buildings can take a minute |

## Get land cover

[ESA WorldCover 2021](https://esa-worldcover.org/) is a free 10 m land cover map
of the world. With land cover the importer knows shrub, built-up areas,
wetland, bare ground and snow, and fills in forest and water the features
don't have:

| WorldCover class | Becomes |
| --- | --- |
| 10 tree cover | forest |
| 20 shrubland | shrub |
| 30 grassland, 40 cropland, 100 moss and lichen | open |
| 50 built-up | built-up |
| 60 bare / sparse vegetation | bare |
| 70 snow and ice | snow |
| 80 permanent water | water |
| 90 herbaceous wetland, 95 mangroves | wetland |

Each grid post takes the class most of its cell is covered by.

- `--worldcover` reads the classes for the extent straight from the public
  cloud-optimised tiles on AWS (only the part needed is downloaded) and adds
  the WorldCover credit to the attribution.
- `--landcover file.tif` reads a local raster with the same class codes in
  EPSG:4326, for example a WorldCover tile you downloaded, or your own
  classification.

Land cover shows as a tint on the 2D map and the 3D ground.

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

Add `--features area.geojson` (or `--osm`, `--overpass`) to bring in roads,
water, forest, towns and buildings, and `--worldcover` for land cover; the
summary line then counts them. For example:

```bash
npm run terrain:import -- --dem Copernicus_DSM_COG_10_N50_00_E009_00_DEM.tif \
  --name fulda-town --center 50.553,9.68 --size 4000 --cell 25 --overpass --worldcover \
  --attribution "Copernicus DEM GLO-30 © DLR e.V./Airbus; © OpenStreetMap contributors (ODbL)"
```

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
OpenStreetMap data is under the ODbL and needs "© OpenStreetMap contributors";
ESA WorldCover is CC BY 4.0 (the importer adds its credit with `--worldcover`).
Put the credit in `--attribution`; it is stored in the dataset and listed by
`GET /api/v1/terrains`.

See [Tutorial 12](tutorials/12-real-terrain.md) for a worked example.
