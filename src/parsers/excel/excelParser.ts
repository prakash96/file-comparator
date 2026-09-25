import * as XLSX from 'xlsx';
import type { CellValue, FieldInfo } from '../../models/dataset';
import { AppError } from '../../models/issues';
import type { ParseOptions } from '../../models/parseOptions';
import { TypeTracker } from '../common/typeInference';
import { uniqueHeaders } from '../common/values';
import type { FileParser, ParseContext, ParsedFile } from '../types';

/** The last workbook read, so switching worksheets does not re-read the file. */
const workbookCache = new WeakMap<Blob, XLSX.WorkBook>();

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/**
 * Excel stores numbers as IEEE doubles and shows at most 15 significant digits;
 * rounding to 15 removes binary noise such as 0.30000000000000004.
 */
export function excelNumberToCell(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (Number.isInteger(n)) return String(n);
  return String(Number(n.toPrecision(15)));
}

/** SheetJS builds dates from local-time components; read them back the same way. */
export function excelDateToCell(d: Date): string | null {
  if (Number.isNaN(d.getTime())) return null;
  const date = `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const h = d.getHours();
  const m = d.getMinutes();
  const s = d.getSeconds();
  if (!h && !m && !s) return date;
  return `${date} ${pad(h)}:${pad(m)}:${pad(s)}`;
}

function toExcelCell(v: unknown): CellValue {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return excelNumberToCell(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v instanceof Date) return excelDateToCell(v);
  return String(v);
}

async function readWorkbook(file: Blob, ctx: ParseContext): Promise<XLSX.WorkBook> {
  const cached = workbookCache.get(file);
  if (cached) return cached;
  ctx.progress({ stage: 'reading', bytesProcessed: 0, totalBytes: file.size, records: 0 });
  const data = new Uint8Array(await file.arrayBuffer());
  ctx.progress({ stage: 'parsing', bytesProcessed: file.size, totalBytes: file.size, records: 0 });
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(data, { type: 'array', cellDates: true, dense: true, cellFormula: false, cellHTML: false, cellStyles: false });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/password|EncryptionInfo|EncryptedPackage/i.test(msg)) {
      throw new AppError('EXCEL_PROTECTED', 'This workbook is password-protected or encrypted. Save an unprotected copy in Excel and load that instead.', { details: msg });
    }
    throw new AppError('EXCEL_UNSUPPORTED', 'This file could not be read as an Excel workbook (.xlsx / .xls). It may be damaged, or be another format with an Excel extension.', { details: msg });
  }
  if (!wb.SheetNames.length) throw new AppError('EXCEL_NO_SHEETS', 'The workbook contains no worksheets.');
  workbookCache.set(file, wb);
  return wb;
}

function sheetRowCount(ws: XLSX.WorkSheet): number {
  const ref = ws['!ref'];
  if (!ref) return 0;
  const r = XLSX.utils.decode_range(ref);
  return r.e.r - r.s.r + 1;
}

export const excelParser: FileParser = {
  format: 'excel',

  async parse(file: Blob, options: ParseOptions, ctx: ParseContext): Promise<ParsedFile> {
    const wb = await readWorkbook(file, ctx);
    const sheets = wb.SheetNames.map((name) => ({ name, rows: sheetRowCount(wb.Sheets[name]) }));
    let sheet = options.excel.sheet;
    if (!sheet || !wb.Sheets[sheet]) {
      if (sheet) ctx.issues.warn('EXCEL_SHEET_MISSING', `Worksheet "${sheet}" does not exist in this workbook; the first non-empty sheet was used.`);
      sheet = (sheets.find((s) => s.rows > 0) ?? sheets[0]).name;
    }
    const ws = wb.Sheets[sheet];
    const headerRow = Math.max(1, Math.floor(options.excel.headerRow || 1));
    const range = ws['!ref'] ? XLSX.utils.decode_range(ws['!ref']) : null;
    const rows: unknown[][] = range
      ? XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: false, range: { s: { r: headerRow - 1, c: range.s.c }, e: range.e } })
      : [];
    ctx.checkCancelled();

    let names: string[];
    let dataRows: unknown[][];
    if (options.excel.hasHeader) {
      const header = rows[0] ?? [];
      names = uniqueHeaders(header.map((h) => (h === null || h === undefined ? '' : String(h))), (n) =>
        ctx.issues.warn('DUPLICATE_HEADER', `Column name "${n}" appears more than once in the header row; later copies were renamed.`),
      );
      dataRows = rows.slice(1);
    } else {
      names = [];
      dataRows = rows;
    }
    const width = Math.max(names.length, ...dataRows.slice(0, 1000).map((r) => r.length), 0);
    for (let i = names.length; i < width; i++) names.push(`COL_${i + 1}`);

    const trackers = names.map(() => new TypeTracker());
    const records: CellValue[][] = new Array(dataRows.length);
    for (let r = 0; r < dataRows.length; r++) {
      const src = dataRows[r];
      if (src.length > names.length) {
        for (let i = names.length; i < src.length; i++) {
          names.push(`COL_${i + 1}`);
          trackers.push(new TypeTracker());
        }
      }
      const rec: CellValue[] = new Array(src.length);
      for (let c = 0; c < src.length; c++) {
        const v = src[c];
        trackers[c].observeValue(v);
        rec[c] = toExcelCell(v);
      }
      records[r] = rec;
      if (r % 20000 === 0) ctx.progress({ stage: 'parsing', bytesProcessed: file.size, totalBytes: file.size, records: r });
    }
    if (records.length === 0) ctx.issues.warn('NO_RECORDS', `Worksheet "${sheet}" has no data rows${options.excel.hasHeader ? ' below the header' : ''}.`);

    const fields: FieldInfo[] = names.map((name, i) => ({ name, type: trackers[i].type }));
    return {
      dataset: { fields, records },
      meta: {
        details: [
          { label: 'Worksheet', value: sheet },
          { label: 'Worksheets in file', value: String(sheets.length) },
          { label: 'Header row', value: options.excel.hasHeader ? `row ${headerRow}` : 'none' },
        ],
        sheets,
        resolved: { excel: { ...options.excel, sheet } },
      },
    };
  },
};
