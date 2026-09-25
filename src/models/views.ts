import type { CellValue } from './dataset';
import type { FieldDifference } from './comparison';

export type ResultView = 'added' | 'removed' | 'modified' | 'unchanged' | 'duplicates' | 'missingKey';

export const RESULT_VIEW_LABELS: Record<ResultView, string> = {
  added: 'Added',
  removed: 'Removed',
  modified: 'Modified',
  unchanged: 'Unchanged',
  duplicates: 'Duplicate Keys',
  missingKey: 'Missing Keys',
};

export type SortDirection = 'asc' | 'desc';

/** Special sort columns besides data column names. */
export const SORT_RECORD = '__record';
export const SORT_CHANGES = '__changes';

export interface ViewQuery {
  view: ResultView;
  offset: number;
  limit: number;
  /** Case-insensitive substring. Matches key columns, or every column when `searchAllColumns`. */
  search?: string;
  searchAllColumns?: boolean;
  /** Modified view only: keep records where this column changed. */
  changedColumn?: string;
  sortColumn?: string;
  sortDir?: SortDirection;
}

export interface ViewRow {
  /** Stable position of the row in the unfiltered view. */
  id: number;
  key: CellValue[];
  /** 1-based record numbers in the files. */
  sourceRecord?: number;
  targetRecord?: number;
  side?: 'source' | 'target';
  /** Duplicate group number (1-based). */
  group?: number;
  /** Values aligned with `ViewPage.columns`. */
  values?: CellValue[];
  /** Modified view: every differing field. */
  diffs?: FieldDifference[];
}

export interface ViewPage {
  view: ResultView;
  total: number;
  unfilteredTotal: number;
  offset: number;
  columns: string[];
  keyColumns: string[];
  rows: ViewRow[];
}
