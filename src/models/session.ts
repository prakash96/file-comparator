import type { CellValue, FieldInfo, FileFormat } from './dataset';
import type { Issue } from './issues';
import type { ParseOptions } from './parseOptions';
import type { FormatMeta } from '../parsers/types';
import type { Detection } from '../parsers/detect';

export type Slot = 'source' | 'target';

export const SLOT_LABEL: Record<Slot, string> = { source: 'SOURCE', target: 'TARGET' };

/** What the UI knows about a loaded file. Holds only a small preview, never the full data. */
export interface DatasetSummary {
  slot: Slot;
  fileName: string;
  fileSize: number;
  format: FileFormat;
  detection?: Detection;
  /** Options actually used (after detection), fed back into the option forms. */
  options: ParseOptions;
  recordCount: number;
  fields: FieldInfo[];
  preview: CellValue[][];
  meta: FormatMeta;
  issues: Issue[];
  parseMs: number;
}

export type StageId =
  | 'reading-source'
  | 'parsing-source'
  | 'reading-target'
  | 'parsing-target'
  | 'indexing'
  | 'comparing'
  | 'generating'
  | 'complete';

export const STAGE_LABELS: Record<StageId, string> = {
  'reading-source': 'Reading source…',
  'parsing-source': 'Parsing source…',
  'reading-target': 'Reading target…',
  'parsing-target': 'Parsing target…',
  indexing: 'Building indexes…',
  comparing: 'Comparing records…',
  generating: 'Generating results…',
  complete: 'Complete',
};

export interface ProgressInfo {
  task: 'load' | 'compare' | 'export';
  slot?: Slot;
  stage: StageId;
  /** 0-100 when it can be computed. */
  percent?: number;
  records: number;
  bytes?: number;
  totalBytes?: number;
  elapsedMs: number;
}

export type ReportKind =
  | 'csv-added'
  | 'csv-removed'
  | 'csv-modified'
  | 'csv-unchanged'
  | 'csv-duplicates'
  | 'csv-column-differences'
  | 'excel'
  | 'html'
  | 'json-summary';

export interface ExportedFile {
  fileName: string;
  mimeType: string;
  blob: Blob;
  /** Notes such as "Excel sheet truncated at 1,048,575 rows". */
  notes: string[];
}
