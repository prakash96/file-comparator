import * as XLSX from 'xlsx';
import type { CellValue } from '../models/dataset';
import type { ResultView, ViewRow } from '../models/views';
import { APP_NAME, APP_VERSION, countRows, fileRows, formatMs, optionRows, reconciliationText } from './summaryData';
import type { ReportContext, ReportGenerator } from './types';

/** Excel hard limits. */
export const EXCEL_MAX_ROWS = 1_048_576;
const EXCEL_MAX_CELL_CHARS = 32_767;

type Cell = string | number | null;

const cell = (v: CellValue | number | undefined): Cell => {
  if (v === undefined || v === null) return null;
  if (typeof v === 'number') return v;
  return v.length > EXCEL_MAX_CELL_CHARS ? `${v.slice(0, EXCEL_MAX_CELL_CHARS - 20)}…[truncated]` : v;
};

function sheetFromView(
  ctx: ReportContext,
  view: ResultView,
  header: string[],
  toRow: (r: ViewRow) => Cell[][],
  notes: string[],
  sheetName: string,
): XLSX.WorkSheet {
  const rows: Cell[][] = [header];
  const limit = EXCEL_MAX_ROWS - 1;
  let truncated = false;
  for (const r of ctx.views.rows(view)) {
    for (const out of toRow(r)) {
      if (rows.length > limit) {
        truncated = true;
        break;
      }
      rows.push(out);
    }
    if (truncated) break;
  }
  if (truncated) notes.push(`Sheet "${sheetName}" was truncated at ${limit.toLocaleString('en-US')} rows (Excel's limit). Use the CSV export for the full list.`);
  return XLSX.utils.aoa_to_sheet(rows);
}

function withWidths(ws: XLSX.WorkSheet, widths: number[]): XLSX.WorkSheet {
  ws['!cols'] = widths.map((wch) => ({ wch }));
  return ws;
}

export const excelReport: ReportGenerator = {
  kind: 'excel',
  label: 'Excel workbook',
  async generate(ctx: ReportContext) {
    const notes: string[] = [];
    const s = ctx.result.summary;
    const keys = ctx.views.keyColumns.map((k) => `KEY_${k}`);
    const wb = XLSX.utils.book_new();

    const detailSheets: [string, () => XLSX.WorkSheet][] = [
      ['Added', () => sheetFromView(ctx, 'added', ['TARGET_RECORD', ...ctx.views.columns('added')], (r) => [[r.targetRecord!, ...(r.values ?? []).map(cell)]], notes, 'Added')],
      ['Removed', () => sheetFromView(ctx, 'removed', ['SOURCE_RECORD', ...ctx.views.columns('removed')], (r) => [[r.sourceRecord!, ...(r.values ?? []).map(cell)]], notes, 'Removed')],
      [
        'Modified',
        () =>
          sheetFromView(
            ctx,
            'modified',
            [...keys, 'SOURCE_RECORD', 'TARGET_RECORD', 'FIELD', 'SOURCE_VALUE', 'TARGET_VALUE'],
            (r) => (r.diffs ?? []).map((d) => [...r.key.map(cell), r.sourceRecord!, r.targetRecord!, d.column, cell(d.source), cell(d.target)]),
            notes,
            'Modified',
          ),
      ],
      [
        'Unchanged',
        () => sheetFromView(ctx, 'unchanged', ['SOURCE_RECORD', 'TARGET_RECORD', ...ctx.views.columns('unchanged')], (r) => [[r.sourceRecord!, r.targetRecord!, ...(r.values ?? []).map(cell)]], notes, 'Unchanged'),
      ],
      [
        'Duplicate Keys',
        () =>
          sheetFromView(
            ctx,
            'duplicates',
            ['GROUP', 'SIDE', 'RECORD', ...keys, ...ctx.views.columns('duplicates')],
            (r) => [[r.group!, r.side!.toUpperCase(), (r.side === 'source' ? r.sourceRecord : r.targetRecord)!, ...r.key.map(cell), ...(r.values ?? []).map(cell)]],
            notes,
            'Duplicate Keys',
          ),
      ],
    ];

    const matched = s.counts.modified + s.counts.unchanged;
    const colDiff = withWidths(
      XLSX.utils.aoa_to_sheet([
        ['COLUMN', 'DIFFERENCES', '% OF MATCHED RECORDS'],
        ...s.columnStats.map((c) => [c.column, c.differences, matched ? +((c.differences / matched) * 100).toFixed(4) : 0]),
      ]),
      [32, 14, 22],
    );
    const schema = withWidths(
      XLSX.utils.aoa_to_sheet([
        ['COLUMN', 'STATUS', 'SOURCE TYPE', 'TARGET TYPE', 'TYPE DIFFERS', 'NESTED/FLAT DIFFERS'],
        ...s.schema.fields.map((f) => [
          f.name,
          { common: 'In both', sourceOnly: 'Source only', targetOnly: 'Target only' }[f.status],
          f.sourceDeclaredType ?? f.sourceType ?? '',
          f.targetDeclaredType ?? f.targetType ?? '',
          f.typeMismatch ? 'YES' : '',
          f.nestedMismatch ? 'YES' : '',
        ]),
      ]),
      [32, 14, 20, 20, 14, 20],
    );

    // Build detail sheets first so truncation notes can go on the Summary sheet.
    const built = detailSheets.map(([name, make]) => [name, make()] as const);

    const summaryRows: Cell[][] = [
      [APP_NAME, `version ${APP_VERSION}`],
      ['Generated', ctx.generatedAt.toISOString()],
      ['Comparison time', formatMs(s.timing.totalMs)],
      [],
      ['SOURCE FILE'],
      ...fileRows(ctx.source),
      [],
      ['TARGET FILE'],
      ...fileRows(ctx.target),
      [],
      ['RESULT'],
      ...countRows(ctx),
      [],
      ['RECONCILIATION'],
      ...reconciliationText(ctx).map((t) => [t]),
      [],
      ['CONFIGURATION'],
      ...optionRows(s.options),
      ...(notes.length ? [[], ['NOTES'], ...notes.map((n) => [n])] : []),
      ...(s.issues.length ? [[], ['WARNINGS'], ...s.issues.map((i) => [i.severity.toUpperCase(), i.message])] : []),
    ];
    XLSX.utils.book_append_sheet(wb, withWidths(XLSX.utils.aoa_to_sheet(summaryRows), [36, 90]), 'Summary');
    for (const [name, ws] of built) XLSX.utils.book_append_sheet(wb, ws, name);
    XLSX.utils.book_append_sheet(wb, colDiff, 'Column Differences');
    XLSX.utils.book_append_sheet(wb, schema, 'Schema');

    const data = XLSX.write(wb, { type: 'array', bookType: 'xlsx', compression: true }) as ArrayBuffer;
    return {
      fileName: 'comparison-report.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      blob: new Blob([data], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
      notes,
    };
  },
};
