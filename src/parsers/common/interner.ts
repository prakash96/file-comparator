/**
 * Per-column string interning. DataStage extracts are full of low-cardinality
 * columns (status codes, flags, currency, dates); sharing one string instance
 * per distinct value saves ~30-40 bytes per cell. A column stops interning once
 * it proves high-cardinality, so unique columns (ids, names) cost nothing extra.
 */
export class ColumnInterner {
  private maps: (Map<string, string> | null)[] = [];

  constructor(private readonly maxDistinct = 4096) {}

  intern(column: number, value: string): string {
    let m = this.maps[column];
    if (m === null) return value;
    if (m === undefined) {
      m = new Map();
      this.maps[column] = m;
    }
    const hit = m.get(value);
    if (hit !== undefined) return hit;
    if (m.size >= this.maxDistinct) {
      this.maps[column] = null; // high cardinality: give up on this column
      return value;
    }
    m.set(value, value);
    return value;
  }

  /** Release the lookup maps once parsing is done (the interned strings stay shared). */
  clear(): void {
    this.maps = [];
  }
}
