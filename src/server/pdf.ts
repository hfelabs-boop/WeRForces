// A minimal PDF writer: pages of text (standard Helvetica fonts), lines, rectangles and
// polylines. Enough for printable reports without a PDF library.

type Rgb = [number, number, number];

export class PdfDoc {
  private pages: string[] = [];
  private ops: string[] = [];
  readonly width = 595.28; // A4 in points
  readonly height = 841.89;

  constructor() {
    this.addPage();
  }

  addPage(): void {
    if (this.ops.length) this.pages.push(this.ops.join('\n'));
    this.ops = [];
  }

  /** Text at (x, y) from the top-left, in points. */
  text(x: number, y: number, s: string, size = 10, bold = false, color: Rgb = [0, 0, 0]): void {
    this.ops.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${rgb(color)} rg ${x.toFixed(2)} ${(this.height - y).toFixed(2)} Td (${escapeText(s)}) Tj ET`);
  }

  line(x1: number, y1: number, x2: number, y2: number, color: Rgb = [0, 0, 0], width = 0.5): void {
    this.ops.push(`${rgb(color)} RG ${width} w ${x1.toFixed(2)} ${(this.height - y1).toFixed(2)} m ${x2.toFixed(2)} ${(this.height - y2).toFixed(2)} l S`);
  }

  polyline(pts: [number, number][], color: Rgb = [0, 0, 0], width = 1): void {
    if (pts.length < 2) return;
    const path = pts.map(([x, y], i) => `${x.toFixed(2)} ${(this.height - y).toFixed(2)} ${i ? 'l' : 'm'}`).join(' ');
    this.ops.push(`${rgb(color)} RG ${width} w ${path} S`);
  }

  rect(x: number, y: number, w: number, h: number, fill: Rgb): void {
    this.ops.push(`${rgb(fill)} rg ${x.toFixed(2)} ${(this.height - y - h).toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f`);
  }

  /** Approximate width of Helvetica text, for layout. */
  textWidth(s: string, size: number): number {
    return s.length * size * 0.52;
  }

  toBytes(): Uint8Array {
    const pages = [...this.pages, this.ops.join('\n')];
    const objects: string[] = [];
    const add = (body: string) => objects.push(body) - 1 + 1; // 1-based object numbers
    const catalog = add('');
    const pagesObj = add('');
    const font1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    const font2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    const kids: number[] = [];
    for (const content of pages) {
      const stream = add(`<< /Length ${latin1Length(content)} >>\nstream\n${content}\nendstream`);
      kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${this.width} ${this.height}] /Resources << /Font << /F1 ${font1} 0 R /F2 ${font2} 0 R >> >> /Contents ${stream} 0 R >>`));
    }
    objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
    objects[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
    let out = '%PDF-1.4\n%âãÏÓ\n';
    const offsets: number[] = [];
    objects.forEach((body, i) => {
      offsets.push(latin1Length(out));
      out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    });
    const xref = latin1Length(out);
    out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
    out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    const bytes = new Uint8Array(out.length);
    for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
    return bytes;
  }
}

function rgb([r, g, b]: Rgb): string {
  return `${(r / 255).toFixed(3)} ${(g / 255).toFixed(3)} ${(b / 255).toFixed(3)}`;
}

/** PDF string escaping; characters outside Latin-1 become '?'. */
function escapeText(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === '(' || ch === ')' || ch === '\\') out += `\\${ch}`;
    else if (c === 0x2013 || c === 0x2014) out += '-';
    else if (c === 0x2019) out += "'";
    else if (c === 0x2026) out += '\x85'; // WinAnsi ellipsis
    else if (c === 0xb7 || (c >= 32 && c < 127) || (c >= 160 && c <= 255)) out += ch;
    else out += '?';
  }
  return out;
}

function latin1Length(s: string): number {
  return s.length;
}
