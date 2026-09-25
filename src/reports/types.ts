import type { ComparisonResult } from '../comparison/engine';
import type { ResultViews } from '../comparison/resultViews';
import type { FieldInfo, FileFormat } from '../models/dataset';
import type { ExportedFile, ReportKind } from '../models/session';

export interface ReportFileInfo {
  fileName: string;
  fileSize: number;
  format: FileFormat;
  recordCount: number;
  fields: FieldInfo[];
  parseMs: number;
}

export interface ReportContext {
  result: ComparisonResult;
  views: ResultViews;
  source: ReportFileInfo;
  target: ReportFileInfo;
  generatedAt: Date;
  onProgress?: (done: number, total: number) => void;
}

/**
 * A report format. To add one: implement this, register it in
 * `reports/registry.ts`, add its id to `ReportKind`, and add a button in
 * `components/ExportBar.tsx`. Generators read rows through `ResultViews`, so
 * they never touch parser or engine internals.
 */
export interface ReportGenerator {
  kind: ReportKind;
  label: string;
  generate(ctx: ReportContext): Promise<ExportedFile>;
}
