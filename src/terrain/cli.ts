#!/usr/bin/env node
// werforces-terrain: import a real-world terrain dataset from a GeoTIFF DEM and
// optional GeoJSON map features (OpenStreetMap export or your own).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { type GeoJsonCollection, importTerrain } from './import.js';
import { landCoverFromFile, landCoverFromWorldCover, WORLDCOVER_ATTRIBUTION } from './landcover.js';
import { fetchOverpass, osmXmlToGeoJson } from './osm.js';

const HELP = `werforces-terrain - import real terrain for WeRForces

Usage: werforces-terrain --dem <file.tif> --name <name> [options]

  --dem <file>          GeoTIFF elevation model (EPSG:4326, NAD83/ETRS89, UTM WGS-84 or Web Mercator)
  --features <file>     GeoJSON map features in WGS-84: roads (highway=*), water (natural=water,
                        landuse=reservoir, waterway=river|canal), forest (natural=wood, landuse=forest),
                        towns (place=city|town|village|hamlet with a name). A "kind" property of
                        road|water|river|forest|town works too. Buildings: building=* polygons, with
                        height or building:levels when known.
  --osm <file.osm>      OpenStreetMap XML (e.g. Export on openstreetmap.org, or JOSM): same features
  --overpass            Fetch OpenStreetMap features for the extent from the Overpass API
  --overpass-url <url>  Overpass server (default https://overpass-api.de/api/interpreter)
  --landcover <file>    Land cover GeoTIFF with ESA WorldCover class codes (EPSG:4326)
  --worldcover          Read land cover for the extent from the public ESA WorldCover 2021 tiles
  --name <name>         Dataset name (letters, digits, - and _); scenarios use terrain.dataset = name
  --title <text>        Display title
  --center <lat,lon>    Centre of the extent (default: centre of the DEM)
  --size <m>            Extent in metres (default: largest square in the DEM, at most 40 km)
  --cell <m>            Grid spacing in metres (default: about the DEM resolution, at least 20 m)
  --attribution <text>  Data source credit stored with the dataset
  --out <dir>           Output folder (default: ./terrains)
  -h, --help
`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      dem: { type: 'string' },
      features: { type: 'string' },
      osm: { type: 'string' },
      overpass: { type: 'boolean', default: false },
      'overpass-url': { type: 'string' },
      landcover: { type: 'string' },
      worldcover: { type: 'boolean', default: false },
      name: { type: 'string' },
      title: { type: 'string' },
      center: { type: 'string' },
      size: { type: 'string' },
      cell: { type: 'string' },
      attribution: { type: 'string' },
      out: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help || !values.dem || !values.name) {
    process.stdout.write(HELP);
    if (!values.help) process.exitCode = 1;
    return;
  }
  const num = (v: string | undefined, what: string) => {
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`--${what} must be a positive number`);
    return n;
  };
  let center: { lat: number; lon: number } | undefined;
  if (values.center) {
    const [lat, lon] = values.center.split(',').map(Number);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error('--center must be lat,lon');
    center = { lat, lon };
  }
  const demBuf = readFileSync(values.dem);
  const collections: GeoJsonCollection[] = [];
  if (values.features) collections.push(JSON.parse(readFileSync(values.features, 'utf8')) as GeoJsonCollection);
  if (values.osm) collections.push(osmXmlToGeoJson(readFileSync(values.osm, 'utf8')));
  const sources = [values.features, values.osm].filter(Boolean).map((f) => path.basename(f!));
  if (values.overpass) sources.push('OpenStreetMap via Overpass API');
  const credits = [values.attribution];
  if (values.osm || values.overpass) credits.push('© OpenStreetMap contributors (ODbL)');
  if (values.worldcover) credits.push(WORLDCOVER_ATTRIBUTION);
  const landBuf = values.landcover ? readFileSync(values.landcover) : null;
  const dataset = await importTerrain({
    dem: demBuf.buffer.slice(demBuf.byteOffset, demBuf.byteOffset + demBuf.byteLength),
    features: { type: 'FeatureCollection', features: collections.flatMap((c) => c.features) },
    fetchFeatures: values.overpass
      ? (bbox) => {
          console.log(`Fetching OpenStreetMap features for ${bbox.south.toFixed(4)},${bbox.west.toFixed(4)} - ${bbox.north.toFixed(4)},${bbox.east.toFixed(4)} ...`);
          return fetchOverpass(bbox, values['overpass-url']);
        }
      : undefined,
    landCover: landBuf
      ? (bbox) => landCoverFromFile(landBuf.buffer.slice(landBuf.byteOffset, landBuf.byteOffset + landBuf.byteLength), bbox)
      : values.worldcover
        ? (bbox) => {
            console.log('Reading ESA WorldCover land cover ...');
            return landCoverFromWorldCover(bbox);
          }
        : undefined,
    name: values.name,
    title: values.title,
    center,
    size: num(values.size, 'size'),
    cellSize: num(values.cell, 'cell'),
    source: {
      dem: path.basename(values.dem),
      features: sources.length ? sources.join(', ') : undefined,
      landCover: values.landcover ? path.basename(values.landcover) : values.worldcover ? 'ESA WorldCover 2021 v200' : undefined,
      attribution: credits.filter(Boolean).join('; ') || undefined,
    },
  });
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const outDir = values.out ?? path.join(root, 'terrains');
  mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${values.name}.json`);
  writeFileSync(file, JSON.stringify(dataset));
  const s = dataset.spec;
  console.log(`Wrote ${file}`);
  console.log(`  ${(s.size / 1000).toFixed(1)} km square, ${s.cellSize} m grid (${dataset.cols}x${dataset.rows}), SW corner ${s.origin.lat.toFixed(5)}, ${s.origin.lon.toFixed(5)}`);
  console.log(`  relief ${s.relief} m, water ${(s.waterFraction * 100).toFixed(1)}%, forest ${(s.forestFraction * 100).toFixed(1)}%, ${dataset.roads.length} roads, ${dataset.towns.length} towns, ${dataset.buildings?.length ?? 0} buildings${dataset.landCoverB64 ? ', land cover' : ''}`);
  console.log(`Use it: werforces with a scenario whose terrain is {"dataset": "${values.name}"}, or New scenario in the GUI.`);
}

main().catch((err) => {
  console.error(`werforces-terrain: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
