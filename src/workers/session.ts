import { compareDatasets, type ComparisonResult } from '../comparison/engine';
import { ResultViews } from '../comparison/resultViews';
import { compareSchemas } from '../comparison/schemaCompare';
import type { Dataset, FileFormat } from '../models/dataset';
import { AppError, IssueCollector } from '../models/issues';
import type { ComparisonOptions, ComparisonSummary, SchemaComparison } from '../models/comparison';
import type { ParseOptions } from '../models/parseOptions';
import type { DatasetSummary, ExportedFile, ProgressInfo, ReportKind, Slot, StageId } from '../models/session';
import type { ViewPage, ViewQuery } from '../models/views';
import { detectFormat, type Detection } from '../parsers/detect';
import { getParser } from '../parsers/registry';
import { getReport } from '../reports/registry';
import type { ReportFileInfo } from '../reports/types';

const PREVIEW_ROWS = 100;

interface LoadedSlot {
  summary: DatasetSummary;
  dataset: Dataset;
}

export type ProgressSink = (p: ProgressInfo) => void;

const now = () => performance.now();

/**
 * Everything the worker keeps in memory: the two parsed datasets and the last
 * comparison result. Pure TypeScript (no postMessage), so it is unit-tested in Node.
 */
export class ComparatorSession {
  private slots: Partial<Record<Slot, LoadedSlot>> = {};
  private loadToken: Record<Slot, number> = { source: 0, target: 0 };
  private result: ComparisonResult | null = null;
  private views: ResultViews | null = null;

  async load(slot: Slot, file: Blob, fileName: string, options: ParseOptions, onProgress: ProgressSink = () => {}): Promise<DatasetSummary> {
    const token = ++this.loadToken[slot];
    delete this.slots[slot];
    this.invalidateResult();
    const started = now();
    const checkCancelled = () => {
      if (this.loadToken[slot] !== token) throw new AppError('CANCELLED', 'Loading was cancelled because the file was replaced or removed.');
    };

    let detection: Detection | undefined;
    const resolved: ParseOptions = structuredClone(options);
    if (resolved.format === 'auto') {
      detection = await detectFormat(file, fileName, resolved.encoding);
      resolved.format = detection.format;
      if (detection.format === 'delimited') {
        if (!resolved.delimited.delimiter && detection.delimiter) resolved.delimited.delimiter = detection.delimiter;
        if (detection.hasHeader !== undefined) resolved.delimited.hasHeader = detection.hasHeader;
      }
    }
    const format = resolved.format as FileFormat;
    checkCancelled();

    const issues = new IssueCollector();
    if (file.size === 0) throw new AppError('EMPTY_FILE', 'The file is empty (0 bytes).');
    if (file.size > 2 * 1024 ** 3) {
      issues.warn('VERY_LARGE_FILE', `This file is ${(file.size / 1024 ** 3).toFixed(1)} GB. Browsers usually cannot hold more than 2–4 GB of data per tab; if loading fails, compare smaller extracts.`);
    }

    const parsed = await getParser(format).parse(file, resolved, {
      issues,
      checkCancelled,
      progress: (p) => {
        const known = p.bytesProcessed >= 0;
        onProgress({
          task: 'load',
          slot,
          stage: `${p.stage}-${slot}` as StageId,
          percent: known && p.totalBytes ? Math.min(100, (p.bytesProcessed / p.totalBytes) * 100) : undefined,
          records: p.records,
          bytes: known ? p.bytesProcessed : undefined,
          totalBytes: p.totalBytes,
          elapsedMs: now() - started,
        });
      },
    });
    checkCancelled();

    const r = parsed.meta.resolved;
    if (r?.delimited) resolved.delimited = { ...resolved.delimited, ...r.delimited };
    if (r?.mnt) resolved.mnt = { ...resolved.mnt, ...r.mnt };
    if (r?.json) resolved.json = { ...resolved.json, ...r.json };
    if (r?.xml) resolved.xml = { ...resolved.xml, ...r.xml };
    if (r?.excel) resolved.excel = { ...resolved.excel, ...r.excel };
    if (detection && detection.confidence !== 'high') {
      issues.info('FORMAT_GUESSED', `The format was detected as ${format} (${detection.reason}). If this is wrong, choose the format manually.`);
    }

    const { dataset } = parsed;
    const summary: DatasetSummary = {
      slot,
      fileName,
      fileSize: file.size,
      format,
      detection,
      options: resolved,
      recordCount: dataset.records.length,
      fields: dataset.fields,
      preview: dataset.records.slice(0, PREVIEW_ROWS).map((rec) => dataset.fields.map((_, i) => rec[i] ?? null)),
      meta: parsed.meta,
      issues: issues.toArray(),
      parseMs: now() - started,
    };
    this.slots[slot] = { summary, dataset };
    onProgress({ task: 'load', slot, stage: 'complete', percent: 100, records: dataset.records.length, elapsedMs: now() - started });
    return summary;
  }

  /** Cancel an in-flight load and drop the slot's data. */
  clear(slot: Slot): void {
    this.loadToken[slot]++;
    delete this.slots[slot];
    this.invalidateResult();
  }

  reset(): void {
    this.clear('source');
    this.clear('target');
  }

  private invalidateResult(): void {
    this.result = null;
    this.views = null;
  }

  schema(options: Pick<ComparisonOptions, 'ignoreColumnOrder' | 'columnNamesCaseInsensitive'>): SchemaComparison | null {
    const s = this.slots.source;
    const t = this.slots.target;
    if (!s || !t) return null;
    return compareSchemas(s.dataset.fields, t.dataset.fields, options);
  }

  compare(options: ComparisonOptions, onProgress: ProgressSink = () => {}): ComparisonSummary {
    const s = this.slots.source;
    const t = this.slots.target;
    if (!s || !t) throw new AppError('NOT_READY', 'Load both a SOURCE and a TARGET file before comparing.');
    if (s.dataset.fields.length === 0 || t.dataset.fields.length === 0) {
      throw new AppError('NO_FIELDS', 'One of the files has no columns yet (for fixed-width files, define and apply the layout first).');
    }
    this.invalidateResult();
    const started = now();
    const stageOf = { indexing: 'indexing', comparing: 'comparing', finishing: 'generating' } as const;
    this.result = compareDatasets(s.dataset, t.dataset, options, (p) =>
      onProgress({
        task: 'compare',
        stage: stageOf[p.phase],
        percent: p.total ? (p.processed / p.total) * 100 : undefined,
        records: p.processed,
        elapsedMs: now() - started,
      }),
    );
    this.views = new ResultViews(this.result, s.dataset, t.dataset);
    onProgress({ task: 'compare', stage: 'complete', percent: 100, records: s.dataset.records.length + t.dataset.records.length, elapsedMs: now() - started });
    return this.result.summary;
  }

  query(q: ViewQuery): ViewPage {
    if (!this.views) throw new AppError('NO_RESULT', 'Run a comparison first.');
    return this.views.query(q);
  }

  async exportReport(kind: ReportKind, onProgress: ProgressSink = () => {}): Promise<ExportedFile> {
    if (!this.result || !this.views) throw new AppError('NO_RESULT', 'Run a comparison first.');
    const started = now();
    const info = (slot: Slot): ReportFileInfo => {
      const x = this.slots[slot]!.summary;
      return { fileName: x.fileName, fileSize: x.fileSize, format: x.format, recordCount: x.recordCount, fields: x.fields, parseMs: x.parseMs };
    };
    return getReport(kind).generate({
      result: this.result,
      views: this.views,
      source: info('source'),
      target: info('target'),
      generatedAt: new Date(),
      onProgress: (done, total) =>
        onProgress({ task: 'export', stage: 'generating', percent: total ? (done / total) * 100 : undefined, records: done, elapsedMs: now() - started }),
    });
  }

  /** For tests / the AI hook: the current result. */
  currentResult(): { result: ComparisonResult; views: ResultViews } | null {
    return this.result && this.views ? { result: this.result, views: this.views } : null;
  }
}
