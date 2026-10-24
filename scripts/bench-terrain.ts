// Large terrain benchmark: a synthetic 200 km x 200 km tiled dataset at 30 m posts, read
// on demand through the tile cache. Generates the dataset on first use (about 60 MB,
// half a minute), then times loading, line of sight, route planning and a short scenario.
//
//   npm run bench:terrain [-- --out <dir>] [--size <m>] [--cell <m>] [--cache <MB>]

import { existsSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { dist2d } from '../src/shared/math.js';
import type { Vec2 } from '../src/shared/types.js';
import { Engine } from '../src/sim/engine.js';
import { Rng } from '../src/sim/rng.js';
import { TileCache, TiledTerrain } from '../src/sim/tiledTerrain.js';
import { SyntheticTiles } from '../src/terrain/synthetic.js';
import { FileTileSource, MANIFEST, writeTileset } from '../src/terrain/tiles.js';

const { values } = parseArgs({ options: { out: { type: 'string' }, size: { type: 'string' }, cell: { type: 'string' }, cache: { type: 'string' } } });
const size = Number(values.size ?? 200000);
const cell = Number(values.cell ?? 30);
const name = `synthetic${Math.round(size / 1000)}`;
const dir = path.join(values.out ?? 'terrains', name);
const cacheBytes = Number(values.cache ?? 192) * 1024 * 1024;
const mb = (b: number) => `${(b / 1024 / 1024).toFixed(0)} MB`;
const rss = () => mb(process.memoryUsage().rss);

async function main(): Promise<void> {
  if (!existsSync(path.join(dir, MANIFEST))) {
    const t0 = Date.now();
    console.log(`Generating ${size / 1000} km at ${cell} m into ${dir} ...`);
    const r = await writeTileset(new SyntheticTiles({ name, size, cellSize: cell }), dir);
    console.log(`  ${r.tiles} tiles, ${mb(r.bytes)} on disk, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  }
  console.log(`RSS at start: ${rss()}`);
  let t = performance.now();
  const src = new FileTileSource(dir);
  const terrain = new TiledTerrain(new TileCache(src, cacheBytes));
  console.log(`Open: ${(performance.now() - t).toFixed(1)} ms; ${terrain.cols} x ${terrain.rows} posts (${((terrain.cols * terrain.rows) / 1e6).toFixed(1)} M), ${terrain.towns.length} towns`);
  t = performance.now();
  for (let i = 0; i < 20; i++) src.read(terrain.pyramid.maxZoom, i, 7);
  console.log(`Tile read + gunzip + decode: ${((performance.now() - t) / 20).toFixed(1)} ms each`);

  const rng = new Rng(1);
  const eye = (p: Vec2, h: number) => ({ x: p.x, y: p.y, z: terrain.surfaceHeight(p.x, p.y) + h });
  // Sight lines in a 40 km square in the middle (an engagement area), then anywhere on the map.
  for (const [range, area] of [
    [1000, 40000],
    [5000, 40000],
    [30000, 40000],
    [5000, size - 10000],
  ]) {
    const lines: [Vec2, Vec2][] = [];
    for (let i = 0; i < 2000; i++) {
      const a = { x: rng.range((size - area) / 2, (size + area) / 2), y: rng.range((size - area) / 2, (size + area) / 2) };
      const ang = rng.range(0, Math.PI * 2);
      lines.push([a, { x: a.x + Math.cos(ang) * range, y: a.y + Math.sin(ang) * range }]);
    }
    for (const pass of ['cold', 'warm']) {
      t = performance.now();
      let seen = 0;
      for (const [a, b] of lines) if (terrain.lineOfSight(eye(a, range > 10000 ? 50 : 3), eye(b, 3))) seen++;
      const us = ((performance.now() - t) * 1000) / lines.length;
      console.log(`Line of sight ${range / 1000} km within ${area / 1000} km (${pass}): ${us.toFixed(0)} µs each, ${((seen / lines.length) * 100).toFixed(0)}% clear; cache ${terrain.cache.stats().tiles} tiles, ${mb(terrain.cache.bytes)}`);
    }
  }
  const towns = terrain.towns;
  const near = (p: Vec2) => towns.reduce((best, x) => (dist2d(x, p) < dist2d(best, p) ? x : best));
  for (const [from, to] of [
    [near({ x: 100000, y: 100000 }), near({ x: 112000, y: 104000 })],
    [near({ x: 60000, y: 60000 }), near({ x: 110000, y: 80000 })],
    [near({ x: 10000, y: 10000 }), near({ x: 190000, y: 190000 })],
  ]) {
    t = performance.now();
    const r = terrain.planRoute(from, to, 'ground', 0.6);
    let len = 0;
    let p: Vec2 = from;
    for (const q of r ?? []) {
      len += dist2d(p, q);
      p = q;
    }
    console.log(`Route ${(dist2d(from, to) / 1000).toFixed(0)} km: ${((performance.now() - t) / 1000).toFixed(2)} s, ${r ? `${r.length} waypoints, ${(len / 1000).toFixed(0)} km` : 'none'}; cache ${terrain.cache.stats().tiles} tiles, ${mb(terrain.cache.bytes)}`);
  }

  const engine = new Engine({ terrain });
  engine.newScenario('Large terrain bench', terrain.spec);
  const c = near({ x: 100000, y: 100000 });
  for (let i = 0; i < 6; i++) {
    const at = near({ x: c.x + (i - 3) * 9000, y: c.y + (i % 2) * 9000 });
    const u = engine.createUnitFromTemplate(i % 2 ? 'ru-tank-platoon' : 'us-tank-platoon', i % 2 ? 2 : 1, at.x, at.y);
    engine.assignTask(u.id, { type: 'moveTo', target: c });
  }
  t = performance.now();
  engine.runFor(300);
  console.log(`Scenario: ${engine.entities.size} entities, 300 s simulated in ${((performance.now() - t) / 1000).toFixed(2)} s`);
  const s = terrain.cache.stats();
  console.log(`Tile cache: ${s.tiles} tiles, ${mb(s.bytes)} of ${mb(s.capacity)}; ${s.loads} loads, ${s.evictions} evictions. RSS ${rss()}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
