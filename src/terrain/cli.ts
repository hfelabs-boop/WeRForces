#!/usr/bin/env node
// werforces-terrain: import a real-world terrain dataset from a GeoTIFF DEM and
// optional GeoJSON map features (OpenStreetMap export or your own).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { importTerrain } from './import.js';

const HELP = `werforces-terrain - import real terrain for WeRForces

Usage: werforces-terrain --dem <file.tif> --name <name> [options]

  --dem <file>          GeoTIFF elevation model (EPSG:4326, NAD83/ETRS89, UTM WGS-84 or Web Mercator)
  --features <file>     GeoJSON map features in WGS-84: roads (highway=*), water (natural=water,
                        landuse=reservoir, waterway=river|canal), forest (natural=wood, landuse=forest),
                        towns (place=city|town|village|hamlet with a name). A "kind" property of
                        road|water|river|forest|town works too.
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
  const dataset = await importTerrain({
    dem: demBuf.buffer.slice(demBuf.byteOffset, demBuf.byteOffset + demBuf.byteLength),
    features: values.features ? JSON.parse(readFileSync(values.features, 'utf8')) : undefined,
    name: values.name,
    title: values.title,
    center,
    size: num(values.size, 'size'),
    cellSize: num(values.cell, 'cell'),
    source: { dem: path.basename(values.dem), features: values.features ? path.basename(values.features) : undefined, attribution: values.attribution },
  });
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const outDir = values.out ?? path.join(root, 'terrains');
  mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${values.name}.json`);
  writeFileSync(file, JSON.stringify(dataset));
  const s = dataset.spec;
  console.log(`Wrote ${file}`);
  console.log(`  ${(s.size / 1000).toFixed(1)} km square, ${s.cellSize} m grid (${dataset.cols}x${dataset.rows}), SW corner ${s.origin.lat.toFixed(5)}, ${s.origin.lon.toFixed(5)}`);
  console.log(`  relief ${s.relief} m, water ${(s.waterFraction * 100).toFixed(1)}%, forest ${(s.forestFraction * 100).toFixed(1)}%, ${dataset.roads.length} roads, ${dataset.towns.length} towns`);
  console.log(`Use it: werforces with a scenario whose terrain is {"dataset": "${values.name}"}, or New scenario in the GUI.`);
}

main().catch((err) => {
  console.error(`werforces-terrain: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
