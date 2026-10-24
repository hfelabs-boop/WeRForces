// Route cost multipliers per terrain grid post (minefields, obstacles, threats), stored in
// square blocks only where something applies, so a large terrain needs no whole-grid array.

const BLOCK = 64;

export class PostOverlay {
  private readonly blocks = new Map<number, Float32Array>();
  private readonly blockCols: number;

  constructor(
    readonly cols: number,
    readonly rows: number,
    /** The value of every post not set. */
    readonly fill = 1,
  ) {
    this.blockCols = Math.ceil(cols / BLOCK);
  }

  private block(c: number, r: number, create: boolean): Float32Array | undefined {
    const k = Math.floor(r / BLOCK) * this.blockCols + Math.floor(c / BLOCK);
    let b = this.blocks.get(k);
    if (!b && create) {
      b = new Float32Array(BLOCK * BLOCK).fill(this.fill);
      this.blocks.set(k, b);
    }
    return b;
  }

  /** The value at post i (row * cols + col). */
  get(i: number): number {
    const c = i % this.cols;
    const r = (i - c) / this.cols;
    const b = this.block(c, r, false);
    return b ? b[(r % BLOCK) * BLOCK + (c % BLOCK)] : this.fill;
  }

  set(i: number, v: number): void {
    const c = i % this.cols;
    const r = (i - c) / this.cols;
    this.block(c, r, true)![(r % BLOCK) * BLOCK + (c % BLOCK)] = v;
  }

  /** Raise the value at post i to at least v. */
  max(i: number, v: number): void {
    if (v > this.get(i)) this.set(i, v);
  }

  add(i: number, v: number): void {
    this.set(i, this.get(i) + v);
  }

  /** A new overlay of f(value) (f(fill) everywhere nothing was set). */
  map(f: (v: number) => number): PostOverlay {
    const out = new PostOverlay(this.cols, this.rows, f(this.fill));
    for (const [k, b] of this.blocks) out.blocks.set(k, b.map(f));
    return out;
  }

  /** The post-by-post product of two overlays over the same grid. */
  static product(a: PostOverlay, b: PostOverlay): PostOverlay {
    const out = new PostOverlay(a.cols, a.rows, a.fill * b.fill);
    for (const k of new Set([...a.blocks.keys(), ...b.blocks.keys()])) {
      const x = a.blocks.get(k);
      const y = b.blocks.get(k);
      const p = new Float32Array(BLOCK * BLOCK);
      for (let i = 0; i < p.length; i++) p[i] = (x ? x[i] : a.fill) * (y ? y[i] : b.fill);
      out.blocks.set(k, p);
    }
    return out;
  }

  /** Bytes held. */
  get bytes(): number {
    return this.blocks.size * BLOCK * BLOCK * 4;
  }
}
