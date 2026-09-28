import type { Dataset, FileFormat } from '../models/dataset';
import type { IssueCollector } from '../models/issues';
import type { FixedWidthColumn, ParseOptions } from '../models/parseOptions';

export interface ParseProgress {
  stage: 'reading' | 'parsing';
  bytesProcessed: number;
  totalBytes: number;
  records: number;
}

export interface ParseContext {
  issues: IssueCollector;
  /** Report progress. Cheap to call often; the caller throttles delivery to the UI. */
  progress(p: ParseProgress): void;
  /** Throws an AppError('CANCELLED') when the user replaced/removed the file mid-parse. */
  checkCancelled(): void;
}

export interface MetaDetail {
  label: string;
  value: string;
}

/** Format-specific facts shown next to the file and fed back into the option forms. */
export interface FormatMeta {
  details: MetaDetail[];
  /** Options the parser settled on (detected delimiter, record node, sheet...). The UI adopts these. */
  resolved?: Partial<Pick<ParseOptions, 'delimited' | 'mnt' | 'json' | 'xml' | 'excel' | 'fixedWidth'>>;
  sheets?: { name: string; rows: number }[];
  xmlRecordCandidates?: { name: string; count: number }[];
  jsonRootCandidates?: { path: string; count: number }[];
  /** Declared schema, pretty-printed (Avro / Parquet). */
  schemaText?: string;
  /** Row count declared in file metadata (Parquet). */
  declaredRecordCount?: number;
  /** First raw lines, used by the fixed-width layout editor ruler. */
  sampleLines?: string[];
  /** Layout guessed from blank columns in the sample (fixed-width without a layout). */
  suggestedLayout?: FixedWidthColumn[];
}

export interface ParsedFile {
  dataset: Dataset;
  meta: FormatMeta;
}

/**
 * A file adapter. Implement this to add a format; register it in
 * `parsers/registry.ts` and teach `parsers/detect.ts` to recognise it.
 */
export interface FileParser {
  format: FileFormat;
  parse(file: Blob, options: ParseOptions, ctx: ParseContext): Promise<ParsedFile>;
}
