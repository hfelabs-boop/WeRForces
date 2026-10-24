# Terrain import

WeRForces can run on real terrain. `werforces-terrain` takes:

- an **elevation model** (DEM) as a GeoTIFF, and optionally
- **map features**: GeoJSON (an OpenStreetMap export, or your own), an
  OpenStreetMap XML file, or straight from the Overpass API;
- **land cover**: an ESA WorldCover GeoTIFF, or the public WorldCover tiles,

and writes a **terrain dataset** (`terrains/<name>.json`, or for large areas a
[tiled dataset](#large-areas-tiled-datasets) in `terrains/<name>/`). Scenarios then refer
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

`GET /api/v1/terrains` lists the datasets a server has (tiled ones with
`"tiled": true`). The server reads them from `./terrains` (change with
`--terrains <dir>`).

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
| `--cell m` | about the DEM's resolution, at least 20 m | At most 1201 × 1201 posts: big areas get a coarser grid (unless `--tiled`). 50 m suits most scenarios; 25–30 m for close terrain |
| `--out dir` | `./terrains` | |
| `--tiled` | off | Write a [tiled dataset](#large-areas-tiled-datasets) for a large area |

The local map is a square in a tangent plane whose south-west corner is the
dataset's `origin`; latitude/longitude conversions use it, so DIS, TAK and
GeoJSON output line up with real maps.

To install a dataset on a running server without file access,
`PUT /api/v1/terrains/<name>` with the dataset JSON as the body (exercise
control only, up to 8 MB).

## Large areas: tiled datasets

One dataset file holds at most 1201 × 1201 posts (40 km at about 33 m). For
larger areas, up to hundreds of kilometres at full resolution, write a **tiled
dataset** with `--tiled`: a folder `terrains/<name>/` with a `manifest.json` and
the posts in tiles of 256 × 256 cells, which the server reads on demand. There
is no size limit and no limit on the grid: 200 km × 200 km at 30 m is 6668 ×
6668 posts (44 million) in 995 tiles, about 60 MB.

```bash
# A 200 km square from a mosaic of Copernicus GLO-30 tiles (gdalbuildvrt + gdal_translate),
# with OpenStreetMap features and WorldCover land cover:
gdalbuildvrt dem.vrt Copernicus_DSM_COG_10_N5*_E00*_DEM.tif
gdal_translate -co COMPRESS=DEFLATE -co TILED=YES dem.vrt dem.tif
npm run terrain:import -- --dem dem.tif --name hessen200 --center 50.5,9.5 --size 200000 --cell 30 \
  --tiled --osm hessen.osm --worldcover --attribution "Copernicus DEM GLO-30 © DLR e.V./Airbus; © OpenStreetMap contributors (ODbL)"
```

The importer works one tile at a time: each finest tile reads only its window of
the DEM (and of the land cover), and rasterises the features that touch it, so
it runs in modest memory whatever the size; the input DEM file itself is read
into memory. A tiled import gives exactly the same posts as a single-file import
of the same area would. With `--worldcover` the land cover is read per tile from
the public cloud-optimised tiles: many small requests, so allow time.

Scenarios use a tiled dataset like any other, by name
(`"terrain": {"dataset": "hessen200"}`), and every terrain query, line of sight,
route and the GUI work on it unchanged. `PUT /api/v1/terrains/<name>` only takes
single-file datasets: copy tiled ones into the server's terrains folder.

**A synthetic large terrain** for tests and benchmarks, with hills, lakes,
forest, land cover, towns about 16 km apart with built-up centres, and roads
between them, needs no data:

```bash
npm run terrain:import -- --synthetic --name synthetic200 --size 200000 --cell 30   # about 30 s
npm run bench:terrain   # makes it if missing, then times loading, line of sight and routes
```

### How it runs

The server keeps the tiles it has read in a **least-recently-used cache** shared
by every session and batch run on the dataset, 192 MB per dataset by default
(`werforces --terrain-cache <MB>`); a tile takes about 650 KB in memory, so the
default holds some 290 tiles, a 75 km square at 30 m. Measured on the synthetic
200 km dataset (`npm run bench:terrain`, one core of a cloud VM):

| | |
| --- | --- |
| Open the dataset | 1 ms (the manifest only) |
| Read one tile (gunzip, decode) | 2 ms |
| Line of sight within a 40 km area, tiles cached | 4 µs at 1 km, 5 µs at 5 km, 12 µs at 30 km |
| Route 15 km / 54 km / 254 km (cold cache) | 0.25 s / 0.6 s / 3 s |
| A 300 s scenario with 21 entities | 0.2 s |
| Process memory with a 64 MB / 192 MB cache | about 250 MB / 400 MB |

Sight lines that cross tiles they pass high above skip them without reading
them (the manifest has each tile's highest point). Routes longer than 640 posts
(19 km at 30 m) are planned on a coarser level of the tiles first and then on
the full grid, leg by leg, in windows along that route. Work spread over the
whole 200 km at once (more tiles than the cache holds) is slower, as tiles are
read again and again: raise the cache for that.

The GUI does not download the whole dataset: it loads one overview tile, then
the tiles for what is on screen at about one post per screen pixel (half a
megabyte for the whole map in view, a few megabytes zoomed in), and in the 3D
view the full-detail tiles for some 23 km around the point the camera looks at.

### Tile format

`terrains/<name>/manifest.json` describes the dataset: `spec` (size, cell size,
origin as for any dataset), `cols` (posts per side), `tileSize` (cells per
tile side), `maxZoom`, the `layers` present, the `elevation` range, `tileTops`
(the highest ground plus canopy or buildings in each finest tile, for line of
sight), `towns`, and `roads` (all of them for small road networks, else the
main roads, for the overview; every road is in the tiles).

Tiles form a pyramid: level `maxZoom` holds every post, each coarser level
every second post of the one below, and level 0 is one tile over the whole
extent. Tile (`z`, `x`, `y`) — `x` from the west, `y` from the south — covers
`tileSize` × 2^(maxZoom − z) cells from post (`x`, `y`) × `tileSize` × 2^(maxZoom
− z), with `tileSize + 1` posts per side: neighbouring tiles share their edge
posts, so every grid cell lies in one tile. Posts past the edge of the extent
repeat the edge. On coarser levels a post is a road if any post around it is
(so the network stays connected), and water if it is or most around it are
(so rivers stay barriers).

Each tile is a gzipped file `tiles/<z>/<x>/<y>.wft`, also what
`GET /api/v1/terrain/tiles/{z}/{x}/{y}` sends. Unzipped, little-endian:

| Bytes | Content |
| --- | --- |
| 0–3 | `WFT1` |
| 4–5 | posts per side, *n* |
| 6–7 | layers present: 1 forest, 2 water, 4 land cover, 8 roads, 16 buildings |
| 8–15 | metres per height unit (float64; 0.1 unless heights pass 3.2 km) |
| 16–19 | bytes of feature JSON at the end |
| 20–25 | `z`, `x`, `y` (uint16 each), then 2 spare bytes |
| 28– | heights: *n* × *n* int16, row by row from the south-west post |
| | then one byte per post for each layer present, in order: forest (1 = canopy), water (1 = inland water), land cover class, road (1), building cover (0–100 % of the cell), building height (m) |
| | feature JSON: `{"roads": [[{x, y}, …], …], "buildings": [{pts, h}, …]}`: road lines cut at the tile's edges and the buildings whose first corner is in the tile (finest level only) |

## Licensing

Datasets are derived from your sources, so their licences apply. Copernicus DEM
GLO-30 may be redistributed with its notice (see `terrains/README.md`);
OpenStreetMap data is under the ODbL and needs "© OpenStreetMap contributors";
ESA WorldCover is CC BY 4.0 (the importer adds its credit with `--worldcover`).
Put the credit in `--attribution`; it is stored in the dataset and listed by
`GET /api/v1/terrains`.

See [Tutorial 12](tutorials/12-real-terrain.md) for a worked example.
