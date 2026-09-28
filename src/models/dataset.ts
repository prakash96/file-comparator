/**
 * Common internal data model.
 *
 * Every file adapter (CSV, fixed-width, JSON, XML, Excel, Avro, Parquet)
 * produces a `Dataset`. The comparison engine, the result views and the report
 * generators only ever see this model, so they never need to know which file
 * format the data came from.
 *
 * Storage is deliberately compact: one `CellValue[]` per record, aligned with
 * `fields` by position. Records are never wrapped in per-row objects, and all
 * values are canonical strings (or null), which keeps memory predictable for
 * multi-million-row DataStage extracts.
 */

export type FileFormat = 'delimited' | 'fixedwidth' | 'mnt' | 'json' | 'xml' | 'excel' | 'avro' | 'parquet';

export const FILE_FORMAT_LABELS: Record<FileFormat, string> = {
  delimited: 'CSV / Delimited',
  fixedwidth: 'Fixed-width',
  mnt: 'MNT (header + delimited)',
  json: 'JSON',
  xml: 'XML',
  excel: 'Excel',
  avro: 'Avro',
  parquet: 'Parquet',
};

/** A single cell. `null` means "no value" (SQL NULL / missing element / empty Avro union). */
export type CellValue = string | null;

/** One record, aligned with `Dataset.fields`. May be shorter than `fields` - missing trailing cells are null. */
export type NormalizedRecord = CellValue[];

export type FieldType =
  | 'string'
  | 'integer'
  | 'decimal'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'nested'
  | 'empty';

export interface FieldInfo {
  /** Column name. For flattened nested data this is a dotted path, e.g. `address.city`. */
  name: string;
  /** Type inferred from the data (or mapped from the declared schema). */
  type: FieldType;
  /** Type as declared by the file's own schema (Avro, Parquet, fixed-width layout), when available. */
  declaredType?: string;
}

export interface Dataset {
  fields: FieldInfo[];
  records: NormalizedRecord[];
}

export function cellAt(record: NormalizedRecord, index: number): CellValue {
  if (index < 0) return null;
  const v = record[index];
  return v === undefined ? null : v;
}
