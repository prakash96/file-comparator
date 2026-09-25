import type { FieldType } from '../../models/dataset';

const INT_RE = /^[+-]?\d+$/;
const DEC_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const DATE_RE = /^(?:\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4}|\d{4}\/\d{2}\/\d{2})$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/;
const BOOL_RE = /^(?:true|false)$/i;

const enum Bit {
  Int = 1,
  Dec = 2,
  Date = 4,
  DateTime = 8,
  Bool = 16,
  Nested = 32,
  Other = 64,
}

/**
 * Infers a column type from a sample of its values. Only the first
 * `sampleLimit` non-empty values are inspected, so inference cost stays flat
 * for very large files.
 */
export class TypeTracker {
  private bits = 0;
  private seen = 0;

  constructor(private readonly sampleLimit = 2000) {}

  observeText(v: string | null): void {
    if (v === null || this.seen >= this.sampleLimit) return;
    const s = v.trim();
    if (s === '') return;
    this.seen++;
    if (INT_RE.test(s)) this.bits |= Bit.Int;
    else if (DEC_RE.test(s)) this.bits |= Bit.Dec;
    else if (DATETIME_RE.test(s)) this.bits |= Bit.DateTime;
    else if (DATE_RE.test(s)) this.bits |= Bit.Date;
    else if (BOOL_RE.test(s)) this.bits |= Bit.Bool;
    else this.bits |= Bit.Other;
  }

  observeValue(v: unknown): void {
    if (v === null || v === undefined || this.seen >= this.sampleLimit) return;
    switch (typeof v) {
      case 'number':
        this.seen++;
        this.bits |= Number.isInteger(v) ? Bit.Int : Bit.Dec;
        return;
      case 'bigint':
        this.seen++;
        this.bits |= Bit.Int;
        return;
      case 'boolean':
        this.seen++;
        this.bits |= Bit.Bool;
        return;
      case 'string':
        this.observeText(v);
        return;
      case 'object':
        this.seen++;
        if (v instanceof Date) this.bits |= Bit.DateTime;
        else if (v instanceof Uint8Array) this.bits |= Bit.Other;
        else this.bits |= Bit.Nested;
        return;
      default:
        this.seen++;
        this.bits |= Bit.Other;
    }
  }

  get type(): FieldType {
    const b = this.bits;
    if (b === 0) return 'empty';
    if (b & Bit.Other) return 'string';
    if (b & Bit.Nested) return b === Bit.Nested ? 'nested' : 'string';
    if (b === Bit.Int) return 'integer';
    if ((b & ~(Bit.Int | Bit.Dec)) === 0) return 'decimal';
    if (b === Bit.Date) return 'date';
    if ((b & ~(Bit.Date | Bit.DateTime)) === 0) return 'datetime';
    if (b === Bit.Bool) return 'boolean';
    return 'string';
  }
}
