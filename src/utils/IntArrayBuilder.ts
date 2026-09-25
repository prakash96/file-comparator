/** Growable Int32Array. Keeps result index lists compact (4 bytes per entry, no boxing). */
export class IntArrayBuilder {
  private buf: Int32Array;
  private len = 0;

  constructor(initialCapacity = 1024) {
    this.buf = new Int32Array(Math.max(16, initialCapacity));
  }

  push(v: number): void {
    if (this.len === this.buf.length) {
      const next = new Int32Array(this.buf.length * 2);
      next.set(this.buf);
      this.buf = next;
    }
    this.buf[this.len++] = v;
  }

  get length(): number {
    return this.len;
  }

  /** Returns a right-sized copy and releases the internal buffer. */
  finish(): Int32Array {
    const out = this.buf.slice(0, this.len);
    this.buf = new Int32Array(16);
    this.len = 0;
    return out;
  }
}
