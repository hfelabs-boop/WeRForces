import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { catalogMarkdown, mcpToolsMarkdown } from '../scripts/docs-gen.js';
import { DocsSite, headingAnchors } from '../src/server/docs.js';
import { DEFAULT_CATALOG, mergeCatalog } from '../src/sim/catalog.js';

function markdownFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? markdownFiles(p) : p.endsWith('.md') ? [p] : [];
  });
}

const files = [...markdownFiles('docs'), 'README.md'];

describe('documentation', () => {
  it('has up-to-date generated references (run `npm run docs:gen`)', async () => {
    expect(readFileSync('docs/reference/catalog.md', 'utf8')).toBe(catalogMarkdown());
    expect(readFileSync('docs/reference/mcp-tools.md', 'utf8')).toBe(await mcpToolsMarkdown());
  });

  it('has no broken relative links or anchors', () => {
    const broken: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8').replace(/```[\s\S]*?```/g, '');
      for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
        const href = m[1];
        if (/^[a-z]+:/i.test(href) || href.startsWith('/')) continue;
        const [p, hash] = href.split('#');
        const target = p ? path.normalize(path.join(path.dirname(file), p)) : file;
        if (!existsSync(target)) {
          broken.push(`${file}: ${href} (missing file)`);
          continue;
        }
        if (hash && target.endsWith('.md') && !headingAnchors(readFileSync(target, 'utf8')).has(hash)) {
          broken.push(`${file}: ${href} (missing anchor)`);
        }
      }
    }
    expect(broken).toEqual([]);
  });

  it('renders every page in the docs site with rewritten links', () => {
    const site = new DocsSite('docs', 'https://github.com/example/repo/blob/main');
    for (const file of markdownFiles('docs')) {
      const rel = path.relative('docs', file);
      const res = site.serve(`/docs/${rel.split(path.sep).join('/')}`);
      expect(res.status, rel).toBe(200);
      const html = String(res.body);
      expect(html).toContain('<h1 id=');
      // Links inside docs point at /docs/…; links outside go to the repository.
      expect(html).not.toMatch(/href="[^"]*\.\.\//);
    }
    expect(site.serve('/docs/../package.json').status).toBe(404);
    expect(site.serve('/docs/images/screenshot-2d.png').contentType).toBe('image/png');
  });

  it('tutorial 8 refers to the right objects in the bundled scenario', () => {
    const s = JSON.parse(readFileSync('scenarios/calloway-crossroads.json', 'utf8'));
    expect(s.entities.find((e: { id: string }) => e.id === 'E29').name).toBe('Osa 1');
    expect(s.units.find((u: { id: string }) => u.id === 'U1').name).toBe('Team ARMOR');
  });
});

describe('catalog extension', () => {
  it('merges by id: replaces existing entries and appends new ones', () => {
    const ext = JSON.parse(readFileSync('examples/catalog-extension.json', 'utf8'));
    const merged = mergeCatalog(DEFAULT_CATALOG, {
      ...ext,
      sensors: [{ ...DEFAULT_CATALOG.sensors[0], maxRange: 99999 }],
    });
    expect(merged.entityTypes.find((t) => t.id === 'de-leopard2a6')?.name).toBe('Leopard 2A6');
    expect(merged.unitTemplates.some((u) => u.id === 'de-tank-platoon')).toBe(true);
    expect(merged.sensors).toHaveLength(DEFAULT_CATALOG.sensors.length);
    expect(merged.sensors.find((s) => s.id === DEFAULT_CATALOG.sensors[0].id)?.maxRange).toBe(99999);
  });
});
