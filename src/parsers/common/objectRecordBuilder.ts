import type { CellValue, Dataset, FieldInfo, FieldType } from '../../models/dataset';
import type { NestedMode } from '../../models/parseOptions';
import { TypeTracker } from './typeInference';
import { isPlainObject, toCell } from './values';

/**
 * Turns JS objects (from JSON, XML, Avro, Parquet) into the common row model.
 *
 * - `flatten`: nested objects become dotted columns (`address.city`).
 * - `nested`:  only top-level properties become columns; nested values are kept
 *              as canonical JSON (sorted keys) and compared as a whole.
 * Arrays are always stored as canonical JSON, so an array is compared as one value.
 *
 * Columns are discovered as records arrive; a record that lacks a column simply
 * has no cell there (read back as NULL).
 */
export class ObjectRecordBuilder {
  private readonly names: string[] = [];
  private readonly index = new Map<string, number>();
  private readonly trackers: TypeTracker[] = [];
  private readonly declared = new Map<string, string>();
  private readonly declaredFieldTypes = new Map<string, FieldType>();
  readonly records: CellValue[][] = [];

  constructor(
    private readonly mode: NestedMode,
    private readonly transforms: Map<string, (v: unknown) => unknown> = new Map(),
  ) {}

  /** Pre-register columns (e.g. from an Avro/Parquet schema) so they keep schema order. */
  declareColumn(name: string, declaredType?: string, fieldType?: FieldType): void {
    this.column(name);
    if (declaredType) this.declared.set(name, declaredType);
    if (fieldType) this.declaredFieldTypes.set(name, fieldType);
  }

  private column(name: string): number {
    let i = this.index.get(name);
    if (i === undefined) {
      i = this.names.length;
      this.names.push(name);
      this.index.set(name, i);
      this.trackers.push(new TypeTracker());
    }
    return i;
  }

  private set(row: CellValue[], name: string, value: unknown): void {
    const t = this.transforms.get(name);
    const v = t ? t(value) : value;
    const i = this.column(name);
    this.trackers[i].observeValue(v);
    row[i] = toCell(v);
  }

  private walk(row: CellValue[], prefix: string, value: unknown): void {
    if (isPlainObject(value)) {
      const keys = Object.keys(value);
      if (keys.length === 0) {
        this.set(row, prefix, null);
        return;
      }
      for (const k of keys) this.walk(row, prefix ? `${prefix}.${k}` : k, value[k]);
      return;
    }
    this.set(row, prefix, value);
  }

  add(obj: unknown): void {
    const row: CellValue[] = new Array(this.names.length);
    if (!isPlainObject(obj)) {
      this.set(row, 'value', obj);
    } else if (this.mode === 'flatten') {
      this.walk(row, '', obj);
    } else {
      for (const k of Object.keys(obj)) this.set(row, k, obj[k]);
    }
    this.records.push(row);
  }

  get recordCount(): number {
    return this.records.length;
  }

  toDataset(): Dataset {
    const fields: FieldInfo[] = this.names.map((name, i) => ({
      name,
      type: this.trackers[i].type === 'empty' && this.declaredFieldTypes.has(name) ? this.declaredFieldTypes.get(name)! : this.trackers[i].type,
      declaredType: this.declared.get(name),
    }));
    return { fields, records: this.records };
  }
}
