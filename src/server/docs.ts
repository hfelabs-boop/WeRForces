// Serves the Markdown documentation in docs/ as HTML pages at /docs, with a sidebar,
// GitHub-compatible heading anchors and rewritten links (so the same files read well
// on GitHub and in the app).

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { Marked, type Tokens } from 'marked';

/** GitHub's heading anchor algorithm (lowercase, drop punctuation, spaces to hyphens). */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/<[^>]+>/g, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

/** Anchors GitHub would generate for a Markdown document's headings. */
export function headingAnchors(markdown: string): Set<string> {
  const seen = new Map<string, number>();
  const out = new Set<string>();
  let inFence = false;
  for (const line of markdown.split('\n')) {
    if (/^```/.test(line)) inFence = !inFence;
    if (inFence) continue;
    const m = /^#{1,6}\s+(.*)$/.exec(line);
    if (!m) continue;
    const base = slugify(m[1].replace(/`/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1'));
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n === 0 ? base : `${base}-${n}`);
  }
  return out;
}

const NAV: { title: string; items: string[] }[] = [
  { title: 'Start', items: ['README.md', 'getting-started.md'] },
  { title: 'Tutorials', items: [] }, // filled from docs/tutorials
  { title: 'Guides', items: ['user-guide.md', 'concepts.md', 'architecture.md', 'faq.md'] },
  { title: 'Reference', items: [] }, // filled from docs/reference
];

const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.gif': 'image/gif' };

export interface DocResponse {
  status: number;
  contentType: string;
  body: string | Buffer;
}

export class DocsSite {
  private titles = new Map<string, string>();

  constructor(
    readonly root: string,
    /** e.g. https://github.com/owner/repo/blob/main, for links to files outside docs/. */
    readonly repoBlobUrl?: string,
  ) {}

  /** Handle a request path under /docs. */
  serve(urlPath: string): DocResponse {
    let rel = decodeURIComponent(urlPath.replace(/^\/docs\/?/, ''));
    if (rel === '' || rel.endsWith('/')) rel += 'README.md';
    const file = path.resolve(this.root, rel);
    if (!file.startsWith(path.resolve(this.root) + path.sep) || !existsSync(file) || !statSync(file).isFile()) {
      return { status: 404, contentType: 'text/html; charset=utf-8', body: this.page('Not found', '<h1>Not found</h1><p>That page does not exist. <a href="/docs/">Documentation home</a></p>', '') };
    }
    const ext = path.extname(file).toLowerCase();
    if (ext === '.md') {
      const { html, title } = this.render(rel);
      return { status: 200, contentType: 'text/html; charset=utf-8', body: this.page(title, html, rel) };
    }
    if (MIME[ext]) return { status: 200, contentType: MIME[ext], body: readFileSync(file) };
    return { status: 404, contentType: 'text/plain', body: 'Not found' };
  }

  /** Render one Markdown file (path relative to the docs root) to an HTML fragment. */
  render(rel: string): { html: string; title: string } {
    const markdown = readFileSync(path.join(this.root, rel), 'utf8');
    const dir = path.posix.dirname(rel.split(path.sep).join('/'));
    const seen = new Map<string, number>();
    let title = '';
    const marked = new Marked({ gfm: true });
    marked.use({
      renderer: {
        heading(this: { parser: { parseInline(t: Tokens.Generic[]): string } }, { tokens, depth, text }: Tokens.Heading) {
          const inner = this.parser.parseInline(tokens);
          const base = slugify(text.replace(/`/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1'));
          const n = seen.get(base) ?? 0;
          seen.set(base, n + 1);
          const id = n === 0 ? base : `${base}-${n}`;
          if (depth === 1 && !title) title = inner.replace(/<[^>]+>/g, '');
          return `<h${depth} id="${id}"><a class="anchor" href="#${id}">#</a>${inner}</h${depth}>\n`;
        },
      },
      walkTokens: (token) => {
        if (token.type === 'link' || token.type === 'image') {
          const t = token as Tokens.Link | Tokens.Image;
          t.href = this.rewrite(t.href, dir, token.type === 'image');
        }
      },
    });
    const html = marked.parse(markdown, { async: false }) as string;
    return { html, title: title || rel };
  }

  private rewrite(href: string, dir: string, image: boolean): string {
    if (/^[a-z]+:|^#|^\//i.test(href)) return href;
    const [p, hash] = href.split('#');
    const target = path.posix.normalize(path.posix.join(dir, p));
    if (target.startsWith('..')) {
      // Outside docs/: point at the repository when we know it.
      const repoPath = target.replace(/^(\.\.\/)+/, '');
      return this.repoBlobUrl ? `${this.repoBlobUrl}/${repoPath}${hash ? `#${hash}` : ''}` : href;
    }
    const url = `/docs/${target}`;
    return image ? url : `${url}${hash ? `#${hash}` : ''}`;
  }

  private navHtml(current: string): string {
    const list = (dir: string) =>
      existsSync(path.join(this.root, dir))
        ? readdirSync(path.join(this.root, dir))
            .filter((f) => f.endsWith('.md'))
            .sort()
            .map((f) => `${dir}/${f}`)
        : [];
    const sections = NAV.map((s) => ({
      title: s.title,
      items: s.title === 'Tutorials' ? list('tutorials') : s.title === 'Reference' ? list('reference') : s.items,
    }));
    return sections
      .map(
        (s) =>
          `<h4>${s.title}</h4><ul>${s.items
            .filter((i) => existsSync(path.join(this.root, i)))
            .map((i) => `<li><a href="/docs/${i}"${i === current ? ' class="current"' : ''}>${this.titleOf(i)}</a></li>`)
            .join('')}</ul>`,
      )
      .join('');
  }

  private titleOf(rel: string): string {
    let t = this.titles.get(rel);
    if (!t) {
      const first = /^#\s+(.*)$/m.exec(readFileSync(path.join(this.root, rel), 'utf8'));
      t = (first?.[1] ?? rel).replace(/^Tutorial (\d+): /, '$1. ').replace(/`/g, '');
      if (rel === 'README.md') t = 'Overview';
      this.titles.set(rel, t);
    }
    return t;
  }

  private page(title: string, content: string, current: string): string {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title.replace(/</g, '&lt;')} · WeRForces docs</title>
<style>
:root{color-scheme:dark;--bg:#15191e;--panel:#1e242b;--border:#353e48;--text:#d7dee6;--muted:#8995a3;--accent:#7fb6ff;--code:#11151a}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.6 system-ui,-apple-system,'Segoe UI',sans-serif}
.layout{display:grid;grid-template-columns:260px 1fr;min-height:100vh}
nav{background:var(--panel);border-right:1px solid var(--border);padding:16px 14px;position:sticky;top:0;height:100vh;overflow:auto}
nav .brand{font-weight:700;color:#fff;text-decoration:none;display:block;margin-bottom:4px}
nav .app{font-size:13px}
nav h4{margin:18px 0 6px;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
nav ul{list-style:none;margin:0;padding:0}
nav li a{display:block;padding:3px 8px;border-radius:4px;color:var(--text);text-decoration:none;font-size:14px}
nav li a:hover{background:#2c3742}
nav li a.current{background:#24364f;color:#fff}
main{padding:28px 40px 80px;max-width:980px;min-width:0}
a{color:var(--accent)}
h1,h2,h3,h4{line-height:1.25;color:#fff;position:relative}
h1{font-size:30px;margin-top:0}
h2{margin-top:36px;padding-bottom:6px;border-bottom:1px solid var(--border)}
.anchor{position:absolute;left:-18px;opacity:0;text-decoration:none;color:var(--muted)}
h1:hover .anchor,h2:hover .anchor,h3:hover .anchor,h4:hover .anchor{opacity:1}
code{font-family:ui-monospace,'SF Mono',Menlo,monospace;font-size:.88em;background:var(--code);border:1px solid var(--border);border-radius:4px;padding:1px 5px}
pre{background:var(--code);border:1px solid var(--border);border-radius:6px;padding:12px 14px;overflow:auto;line-height:1.45}
pre code{background:none;border:none;padding:0;font-size:13px}
table{border-collapse:collapse;margin:12px 0;display:block;overflow-x:auto}
th,td{border:1px solid var(--border);padding:6px 10px;text-align:left;vertical-align:top}
th{background:var(--panel)}
blockquote{margin:12px 0;padding:6px 14px;border-left:3px solid var(--accent);background:var(--panel);color:var(--text)}
img{max-width:100%;border:1px solid var(--border);border-radius:6px}
hr{border:none;border-top:1px solid var(--border);margin:28px 0}
@media (max-width:800px){.layout{grid-template-columns:1fr}nav{position:static;height:auto}main{padding:20px 16px}}
</style></head><body><div class="layout">
<nav><a class="brand" href="/docs/">WeRForces docs</a><a class="app" href="/">← Open the app</a> · <a class="app" href="/api/docs">API reference</a>${this.navHtml(current)}</nav>
<main>${content}</main></div></body></html>`;
  }
}
