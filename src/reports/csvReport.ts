import type { CellValue } from '../models/dataset';
import type { ReportKind } from '../models/session';
import type { ResultView, ViewRow } from '../models/views';
import type { ReportContext, ReportGenerator } from './types';

/** RFC 4180 field: quoted only when it contains a delimiter, quote or line break. */
export function csvField(v: CellValue | number | undefined): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const line = (values: (CellValue | number | undefined)[]) => `${values.map(csvField).join(',')}\r\n`;

/** Accumulates CSV text in ~1 MB parts so no single giant string is built. */
class CsvBuffer {
  private parts: string[] = [];
  private cur = '';
  add(s: string) {
    this.cur += s;
    if (this.cur.length > 1 << 20) {
      this.parts.push(this.cur);
      this.cur = '';
    }
  }
  blob(): Blob {
    if (this.cur) this.parts.push(this.cur);
    return new Blob(this.parts, { type: 'text/csv;charset=utf-8' });
  }
}

interface CsvSpec {
  kind: ReportKind;
  label: string;
  fileName: string;
  write(ctx: ReportContext, out: CsvBuffer): void;
}

function writeRows(ctx: ReportContext, view: ResultView, out: CsvBuffer, header: string[], toValues: (r: ViewRow) => (CellValue | number | undefined)[]) {
  out.add(line(header));
  const total = ctx.views.size(view);
  let n = 0;
  for (const r of ctx.views.rows(view)) {
    out.add(line(toValues(r)));
    if (++n % 50000 === 0) ctx.onProgress?.(n, total);
  }
}

const keyHeader = (ctx: ReportContext) => ctx.views.keyColumns.map((k) => `KEY_${k}`);

const SPECS: CsvSpec[] = [
  {
    kind: 'csv-added',
    label: 'added.csv',
    fileName: 'added.csv',
    write: (ctx, out) => writeRows(ctx, 'added', out, ['TARGET_RECORD', ...ctx.views.columns('added')], (r) => [r.targetRecord, ...(r.values ?? [])]),
  },
  {
    kind: 'csv-removed',
    label: 'removed.csv',
    fileName: 'removed.csv',
    write: (ctx, out) => writeRows(ctx, 'removed', out, ['SOURCE_RECORD', ...ctx.views.columns('removed')], (r) => [r.sourceRecord, ...(r.values ?? [])]),
  },
  {
    kind: 'csv-unchanged',
    label: 'unchanged.csv',
    fileName: 'unchanged.csv',
    write: (ctx, out) =>
      writeRows(ctx, 'unchanged', out, ['SOURCE_RECORD', 'TARGET_RECORD', ...ctx.views.columns('unchanged')], (r) => [r.sourceRecord, r.targetRecord, ...(r.values ?? [])]),
  },
  {
    kind: 'csv-modified',
    label: 'modified.csv',
    fileName: 'modified.csv',
    write: (ctx, out) => {
      // One line per changed field: easy to filter and pivot.
      out.add(line([...keyHeader(ctx), 'SOURCE_RECORD', 'TARGET_RECORD', 'FIELD', 'SOURCE_VALUE', 'TARGET_VALUE']));
      const total = ctx.views.size('modified');
      let n = 0;
      for (const r of ctx.views.rows('modified')) {
        for (const d of r.diffs ?? []) out.add(line([...r.key, r.sourceRecord, r.targetRecord, d.column, d.source, d.target]));
        if (++n % 50000 === 0) ctx.onProgress?.(n, total);
      }
    },
  },
  {
    kind: 'csv-duplicates',
    label: 'duplicate-keys.csv',
    fileName: 'duplicate-keys.csv',
    write: (ctx, out) =>
      writeRows(ctx, 'duplicates', out, ['GROUP', 'SIDE', 'RECORD', ...keyHeader(ctx), ...ctx.views.columns('duplicates')], (r) => [
        r.group,
        r.side?.toUpperCase(),
        r.side === 'source' ? r.sourceRecord : r.targetRecord,
        ...r.key,
        ...(r.values ?? []),
      ]),
  },
  {
    kind: 'csv-column-differences',
    label: 'column-differences.csv',
    fileName: 'column-differences.csv',
    write: (ctx, out) => {
      const matched = ctx.result.summary.counts.modified + ctx.result.summary.counts.unchanged;
      out.add(line(['COLUMN', 'DIFFERENCES', 'PERCENT_OF_MATCHED_RECORDS']));
      for (const c of ctx.result.summary.columnStats) {
        out.add(line([c.column, c.differences, matched ? ((c.differences / matched) * 100).toFixed(4) : '0']));
      }
    },
  },
];

export const CSV_REPORTS: ReportGenerator[] = SPECS.map((spec) => ({
  kind: spec.kind,
  label: spec.label,
  async generate(ctx: ReportContext) {
    const out = new CsvBuffer();
    spec.write(ctx, out);
    return { fileName: spec.fileName, mimeType: 'text/csv', blob: out.blob(), notes: [] };
  },
}));
