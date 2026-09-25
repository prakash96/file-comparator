import type { ComparisonOptions, ComparisonSummary, SchemaComparison } from '../models/comparison';
import type { FriendlyError } from '../models/issues';
import type { ParseOptions } from '../models/parseOptions';
import type { DatasetSummary, ExportedFile, ProgressInfo, ReportKind, Slot } from '../models/session';
import type { ViewPage, ViewQuery } from '../models/views';

/** Requests from the UI thread to the comparator worker. */
export type WorkerRequest =
  | { type: 'load'; slot: Slot; file: File; options: ParseOptions }
  | { type: 'clear'; slot: Slot }
  | { type: 'reset' }
  | { type: 'schema'; options: Pick<ComparisonOptions, 'ignoreColumnOrder' | 'columnNamesCaseInsensitive'> }
  | { type: 'compare'; options: ComparisonOptions }
  | { type: 'query'; query: ViewQuery }
  | { type: 'export'; kind: ReportKind };

export interface ResponseMap {
  load: DatasetSummary;
  clear: null;
  reset: null;
  schema: SchemaComparison | null;
  compare: ComparisonSummary;
  query: ViewPage;
  export: ExportedFile;
}

export type WorkerMessageIn = WorkerRequest & { id: number };

export type WorkerMessageOut =
  | { id: number; kind: 'result'; payload: unknown }
  | { id: number; kind: 'error'; error: FriendlyError }
  | { id: number; kind: 'progress'; progress: ProgressInfo };
