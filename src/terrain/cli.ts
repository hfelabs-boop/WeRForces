#!/usr/bin/env node
// werforces-terrain: import a real-world terrain dataset from a GeoTIFF DEM and
// optional GeoJSON map features (OpenStreetMap export or your own).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { type GeoJsonCollection, type ImportOptions, importTerrain } from './import.js';
import { importTiledTerrain } from './importTiled.js';
import { landCoverFromFile, landCoverFromWorldCover, WORLDCOVER_ATTRIBUTION } from './landcover.js';
import { fetchOverpass, osmXmlToGeoJson } from './osm.js';
import { SyntheticTiles } from './synthetic.js';
import { type WriteResult, writeTileset } from './tiles.js';

const HELP = `werforces-terrain - import real terrain for WeRForces

Usage: werforces-terrain --dem <file.tif> --name <name> [options]
       werforces-terrain --synthetic --name <name> --size <m> --cell <m> [--seed <n>]

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
  --size <m>            Extent in metres (default: largest square in the DEM, at most 40 km; no limit with --tiled)
  --cell <m>            Grid spacing in metres (default: about the DEM resolution, at least 20 m;
                        one file holds at most 1201 x 1201 posts: bigger areas get a coarser grid unless --tiled)
  --attribution <text>  Data source credit stored with the dataset
  --out <dir>           Output folder (default: ./terrains)
  --tiled               Write a tiled dataset (terrains/<name>/: a manifest and tiles loaded on
                        demand) instead of one file: for large areas, e.g. 200 km at 30 m
  --synthetic           Generate a synthetic tiled terrain (hills, lakes, forest, towns, roads)
                        of --size metres at --cell metres, for tests and benchmarks; no DEM needed
  --seed <n>            Seed for --synthetic (default 2026)
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
      tiled: { type: 'boolean', default: false },
      synthetic: { type: 'boolean', default: false },
      seed: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const outDir = values.out ?? path.join(root, 'terrains');
  if (values.synthetic && values.name && !values.help) return synthetic(values.name, values, outDir);
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
  let saidWorldCover = false;
  const importOpts: ImportOptions = {
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
            if (!saidWorldCover) console.log('Reading ESA WorldCover land cover ...');
            saidWorldCover = true;
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
  };
  if (values.tiled) {
    const started = Date.now();
    const dir = path.join(outDir, values.name);
    console.log(`Importing tiled into ${dir} ...`);
    const r = await importTiledTerrain({ ...importOpts, dir, progress: progressLine(started) });
    reportTiles(dir, r, started);
    return;
  }
  const dataset = await importTerrain(importOpts);
  mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${values.name}.json`);
  writeFileSync(file, JSON.stringify(dataset));
  const s = dataset.spec;
  console.log(`Wrote ${file}`);
  console.log(`  ${(s.size / 1000).toFixed(1)} km square, ${s.cellSize} m grid (${dataset.cols}x${dataset.rows}), SW corner ${s.origin.lat.toFixed(5)}, ${s.origin.lon.toFixed(5)}`);
  console.log(`  relief ${s.relief} m, water ${(s.waterFraction * 100).toFixed(1)}%, forest ${(s.forestFraction * 100).toFixed(1)}%, ${dataset.roads.length} roads, ${dataset.towns.length} towns, ${dataset.buildings?.length ?? 0} buildings${dataset.landCoverB64 ? ', land cover' : ''}`);
  console.log(`Use it: werforces with a scenario whose terrain is {"dataset": "${values.name}"}, or New scenario in the GUI.`);
}

/** Report progress on one line while a tileset is written. */
function progressLine(started: number): (done: number, total: number) => void {
  let last = 0;
  return (done, total) => {
    const now = Date.now();
    if (done < total && now - last < 1000) return;
    last = now;
    process.stdout.write(`\r  ${done}/${total} tiles, ${((now - started) / 1000).toFixed(0)} s`);
    if (done === total) process.stdout.write('\n');
  };
}

function reportTiles(dir: string, r: WriteResult, started: number): void {
  const s = r.manifest.spec;
  console.log(`Wrote ${dir}`);
  console.log(`  ${(s.size / 1000).toFixed(1)} km square, ${s.cellSize} m grid (${r.manifest.cols}x${r.manifest.cols} posts), ${r.tiles} tiles of ${r.manifest.tileSize}x${r.manifest.tileSize} cells in ${r.manifest.maxZoom + 1} levels, ${(r.bytes / 1e6).toFixed(0)} MB, ${((Date.now() - started) / 1000).toFixed(0)} s`);
  console.log(`  relief ${s.relief} m, ${r.manifest.towns.length} towns, ${r.manifest.roads?.length ?? 0} main roads`);
  console.log(`Use it: a scenario whose terrain is {"dataset": "${r.manifest.name}"}, or New scenario in the GUI.`);
}

async function synthetic(name: string, values: { size?: string; cell?: string; seed?: string; title?: string }, outDir: string): Promise<void> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) throw new Error('dataset name may only contain letters, digits, - and _');
  const size = Number(values.size ?? 50000);
  const cell = Number(values.cell ?? 30);
  if (!(size >= 1000) || !(cell >= 5)) throw new Error('--size must be at least 1000 m and --cell at least 5 m');
  const started = Date.now();
  const maker = new SyntheticTiles({ name, title: values.title, size, cellSize: cell, seed: values.seed === undefined ? undefined : Number(values.seed) });
  const dir = path.join(outDir, name);
  console.log(`Generating ${(maker.manifest.spec.size / 1000).toFixed(1)} km at ${cell} m into ${dir} ...`);
  const r = await writeTileset(maker, dir, progressLine(started));
  reportTiles(dir, r, started);
}

main().catch((err) => {
  console.error(`werforces-terrain: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
