// Downloads the open-dis JavaScript library (IEEE 1278.1, Naval Postgraduate School MOVES
// Institute, BSD-2-Clause) and its one runtime dependency into vendor-test/ (git-ignored).
// test/dis-interop.test.ts uses it as an independent implementation to cross-check
// WeRForces' DIS PDU encoding. Test-only: nothing at runtime loads it, and node_modules is
// not touched. Packages are fetched with `npm pack` and checked against pinned SHA-512s.
//
//   node scripts/fetch-open-dis.mjs
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

const VENDOR = path.resolve(process.argv[2] ?? 'vendor-test');
const PACKAGES = [
  { name: 'open-dis', version: '1.3.6', integrity: 'sha512-bV1am6pibs73kT6eB1aXjeWTXaGYXGp1P/yCJ/QU+kqePhhXYu/YH/XfhVGfkqTck5ndL+GaLjzggn/R+N+vqw==' },
  { name: 'long', version: '3.2.0', integrity: 'sha512-ZYvPPOMqUwPoDsbJaR10iQJYnMuZhRTvHYl62ErLIEX7RgFlziSBUUvrt3OVfc47QlHHpzPZYP17g3Fv7oeJkg==' },
];

mkdirSync(VENDOR, { recursive: true });
for (const p of PACKAGES) {
  const tarball = path.join(VENDOR, `${p.name}-${p.version}.tgz`);
  if (!existsSync(tarball)) {
    execFileSync('npm', ['pack', `${p.name}@${p.version}`, '--pack-destination', VENDOR, '--silent'], { stdio: ['ignore', 'ignore', 'inherit'] });
  }
  const digest = `sha512-${createHash('sha512').update(readFileSync(tarball)).digest('base64')}`;
  if (digest !== p.integrity) {
    rmSync(tarball);
    throw new Error(`${p.name}@${p.version}: integrity mismatch (got ${digest})`);
  }
  const dest = path.join(VENDOR, p.name);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest);
  execFileSync('tar', ['-xzf', tarball, '-C', dest, '--strip-components=1']);
  console.log(`${p.name}@${p.version} -> ${path.relative(process.cwd(), dest)}`);
}
