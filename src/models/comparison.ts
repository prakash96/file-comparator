import type { CellValue, FieldType } from './dataset';
import type { Issue } from './issues';

/** What to do with a column that exists in only one of the two files. */
export type MissingColumnMode =
  /** Compare only the columns both files have; report the rest in the schema comparison. */
  | 'skip'
  /** Compare the column anyway, treating the side that lacks it as NULL. */
  | 'null'
  /** Stop with an error. */
  | 'error';

export interface ComparisonOptions {
  /** Key columns (composite when more than one). Empty = compare whole records as a multiset. */
  keyColumns: string[];
  caseSensitive: boolean;
  trimWhitespace: boolean;
  /** Treat NULL and '' as equal. */
  nullEqualsEmpty: boolean;
  /** Compare numbers by value: `007`, `7`, `7.00`, `+7` are equal. */
  numericNormalization: boolean;
  /** Compare dates by value across formats (see `dateFormats`). */
  dateNormalization: boolean;
  /** Date patterns to recognise, e.g. `yyyy-MM-dd`, `MM/dd/yyyy`, `yyyyMMdd`. ISO-8601 is always recognised. */
  dateFormats: string[];
  /** Match columns by name (true) or by position (false). */
  ignoreColumnOrder: boolean;
  /** Match column names ignoring case and surrounding whitespace. */
  columnNamesCaseInsensitive: boolean;
  /** Columns excluded from value comparison. */
  ignoreColumns: string[];
  /** When non-empty, only these columns are compared. */
  compareOnlyColumns: string[];
  missingColumns: MissingColumnMode;
  /** Absolute tolerance for numeric comparison. 0 = exact. */
  numericTolerance: number;
}

export function defaultComparisonOptions(): ComparisonOptions {
  return {
    keyColumns: [],
    caseSensitive: true,
    trimWhitespace: true,
    nullEqualsEmpty: true,
    numericNormalization: false,
    dateNormalization: false,
    dateFormats: ['yyyy-MM-dd', 'yyyy-MM-dd HH:mm:ss', 'MM/dd/yyyy', 'yyyyMMdd'],
    ignoreColumnOrder: true,
    columnNamesCaseInsensitive: true,
    ignoreColumns: [],
    compareOnlyColumns: [],
    missingColumns: 'skip',
    numericTolerance: 0,
  };
}

/* ------------------------------------------------------------------ schema */

export type SchemaFieldStatus = 'common' | 'sourceOnly' | 'targetOnly';

export interface SchemaFieldComparison {
  name: string;
  sourceName?: string;
  targetName?: string;
  sourceIndex: number;
  targetIndex: number;
  sourceType?: FieldType;
  targetType?: FieldType;
  sourceDeclaredType?: string;
  targetDeclaredType?: string;
  status: SchemaFieldStatus;
  typeMismatch: boolean;
  /** True when one side holds this as a nested structure and the other as flattened fields (or vice versa). */
  nestedMismatch: boolean;
}

export interface SchemaComparison {
  fields: SchemaFieldComparison[];
  common: string[];
  sourceOnly: string[];
  targetOnly: string[];
  typeMismatches: string[];
  nestedMismatches: string[];
  /** Common columns appear in a different order in the two files. */
  orderDiffers: boolean;
  matchedBy: 'name' | 'position';
}

/* ------------------------------------------------------------------ results */

export interface ColumnPair {
  name: string;
  sourceIndex: number;
  targetIndex: number;
}

export interface ColumnDifferenceStat {
  column: string;
  /** Number of modified records where this column differs. */
  differences: number;
}

export interface ComparisonCounts {
  sourceTotal: number;
  targetTotal: number;
  added: number;
  removed: number;
  modified: number;
  unchanged: number;
  /** Distinct key values that occur more than once in either file. */
  duplicateKeys: number;
  duplicateSourceRecords: number;
  duplicateTargetRecords: number;
  /** Records whose key columns are all empty. */
  missingKeySource: number;
  missingKeyTarget: number;
}

export interface Reconciliation {
  /** removed + modified + unchanged + duplicateSourceRecords + missingKeySource */
  sourceAccounted: number;
  /** added + modified + unchanged + duplicateTargetRecords + missingKeyTarget */
  targetAccounted: number;
  sourceBalanced: boolean;
  targetBalanced: boolean;
}

export interface ComparisonSummary {
  mode: 'key' | 'fullRecord';
  counts: ComparisonCounts;
  reconciliation: Reconciliation;
  keyColumns: string[];
  comparedColumns: string[];
  skippedColumns: string[];
  columnStats: ColumnDifferenceStat[];
  schema: SchemaComparison;
  options: ComparisonOptions;
  timing: { indexMs: number; compareMs: number; totalMs: number };
  issues: Issue[];
}

/** A field that differs in a modified record. */
export interface FieldDifference {
  column: string;
  source: CellValue;
  target: CellValue;
}

/** A record difference as delivered to the UI, report generators or a future AI layer. */
export interface RecordDifference {
  key: CellValue[];
  sourceRecord: number;
  targetRecord: number;
  differences: FieldDifference[];
}
