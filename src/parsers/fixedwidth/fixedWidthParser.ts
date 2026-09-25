import type { CellValue, FieldInfo, FieldType } from '../../models/dataset';
import { AppError } from '../../models/issues';
import type { FixedWidthColumn, FixedWidthOptions, ParseOptions } from '../../models/parseOptions';
import { headLines, readTextChunks, readTextHead } from '../common/textStream';
import { ColumnInterner } from '../common/interner';
import { TypeTracker } from '../common/typeInference';
import type { FileParser, ParseContext, ParsedFile } from '../types';

/** Check a layout for problems the user must fix before parsing. Returns messages (empty = valid). */
export function validateLayout(columns: FixedWidthColumn[]): string[] {
  const errors: string[] = [];
  const names = new Set<string>();
  columns.forEach((c, i) => {
    const label = c.name || `row ${i + 1}`;
    if (!c.name.trim()) errors.push(`Column ${i + 1} has no name.`);
    else if (names.has(c.name.trim().toLowerCase())) errors.push(`Column name "${c.name}" is used more than once.`);
    names.add(c.name.trim().toLowerCase());
    if (!Number.isInteger(c.start) || c.start < 1) errors.push(`${label}: start position must be 1 or more.`);
    if (!Number.isInteger(c.length) || c.length < 1) errors.push(`${label}: length must be 1 or more.`);
  });
  const sorted = [...columns].filter((c) => c.start >= 1 && c.length >= 1).sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    if (sorted[i].start < prev.start + prev.length) {
      errors.push(`"${sorted[i].name}" (starts at ${sorted[i].start}) overlaps "${prev.name}" (${prev.start}–${prev.start + prev.length - 1}).`);
    }
  }
  return errors;
}

/**
 * Suggest a layout from sample lines: a column boundary is a position that is
 * blank on every line and followed by a non-blank character.
 */
export function suggestLayout(lines: string[]): FixedWidthColumn[] {
  const sample = lines.filter((l) => l.trim() !== '').slice(0, 200);
  if (sample.length === 0) return [];
  const width = Math.max(...sample.map((l) => l.length));
  const blank = new Array<boolean>(width).fill(true);
  for (const l of sample) {
    for (let i = 0; i < width; i++) if (i < l.length && l[i] !== ' ') blank[i] = false;
  }
  const cols: FixedWidthColumn[] = [];
  let start = 0;
  for (let i = 1; i <= width; i++) {
    const boundary = i === width || (blank[i - 1] && !blank[i]);
    if (boundary) {
      cols.push({ name: `COL_${cols.length + 1}`, start: start + 1, length: i - start, type: 'string' });
      start = i;
    }
  }
  return cols;
}

const TYPE_MAP: Record<FixedWidthColumn['type'], FieldType> = {
  string: 'string',
  integer: 'integer',
  decimal: 'decimal',
  date: 'date',
};

export const fixedWidthParser: FileParser = {
  format: 'fixedwidth',

  async parse(file: Blob, options: ParseOptions, ctx: ParseContext): Promise<ParsedFile> {
    const fw: FixedWidthOptions = options.fixedWidth;
    const head = await readTextHead(file, options.encoding, 64 * 1024);
    const sampleLines = headLines(head, 40);
    if (fw.columns.length === 0) {
      ctx.issues.error(
        'FW_NO_LAYOUT',
        'This is a fixed-width file, but no column layout is defined yet. In "Fixed-width layout", add the columns (name, start, length) or click "Suggest layout", then apply.',
      );
      return {
        dataset: { fields: [], records: [] },
        meta: { details: [{ label: 'Layout', value: 'not defined' }], sampleLines, suggestedLayout: suggestLayout(sampleLines.slice(fw.skipLines)) },
      };
    }
    const layoutErrors = validateLayout(fw.columns);
    if (layoutErrors.length) {
      throw new AppError('FW_BAD_LAYOUT', `The fixed-width layout is not valid: ${layoutErrors.join(' ')}`);
    }

    const cols = fw.columns;
    const layoutEnd = Math.max(...cols.map((c) => c.start - 1 + c.length));
    const trackers = cols.map(() => new TypeTracker());
    const records: CellValue[][] = [];
    let lineNo = 0;
    let skipped = 0;
    let shortLines = 0;
    let longLines = 0;
    const interner = new ColumnInterner();

    const handleLine = (line: string) => {
      lineNo++;
      if (skipped < fw.skipLines) {
        skipped++;
        return;
      }
      if (fw.recordLength === 0 && line.length === 0) return;
      if (line.length < layoutEnd) {
        shortLines++;
        ctx.issues.warn(
          'FW_SHORT_LINE',
          `Line ${lineNo.toLocaleString('en-US')} is ${line.length} characters long; the layout needs ${layoutEnd}. Columns beyond the end of the line are read as NULL.`,
          { line: lineNo, record: records.length + 1 },
        );
      } else if (line.length > layoutEnd) {
        longLines++;
      }
      const rec: CellValue[] = new Array(cols.length);
      for (let c = 0; c < cols.length; c++) {
        const s = cols[c].start - 1;
        if (s >= line.length) {
          rec[c] = null;
          continue;
        }
        let v = line.slice(s, s + cols[c].length);
        if (fw.trim) v = v.trim();
        rec[c] = interner.intern(c, v);
        trackers[c].observeText(v);
      }
      records.push(rec);
    };

    let carry = '';
    let pendingCr = false;
    for await (const chunk of readTextChunks(file, options.encoding, (bytes) =>
      ctx.progress({ stage: 'parsing', bytesProcessed: bytes, totalBytes: file.size, records: records.length }),
    )) {
      ctx.checkCancelled();
      let text = carry + chunk;
      if (fw.recordLength > 0) {
        const n = Math.floor(text.length / fw.recordLength) * fw.recordLength;
        for (let i = 0; i < n; i += fw.recordLength) handleLine(text.slice(i, i + fw.recordLength));
        carry = text.slice(n);
        continue;
      }
      if (pendingCr && text.startsWith('\n')) text = text.slice(1);
      pendingCr = false;
      let start = 0;
      for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        if (c === 10 || c === 13) {
          handleLine(text.slice(start, i));
          if (c === 13) {
            if (i + 1 < text.length) {
              if (text.charCodeAt(i + 1) === 10) i++;
            } else {
              pendingCr = true;
            }
          }
          start = i + 1;
        }
      }
      carry = text.slice(start);
    }
    if (carry.length) {
      if (fw.recordLength > 0) {
        ctx.issues.warn('FW_PARTIAL_RECORD', `The file ends with a partial record of ${carry.length} characters (record length is ${fw.recordLength}).`);
      }
      handleLine(carry);
    }

    if (records.length === 0) {
      if (file.size === 0) throw new AppError('EMPTY_FILE', 'The file is empty.');
      ctx.issues.warn('NO_RECORDS', 'No data records were found after skipping header lines.');
    }
    if (longLines > 0) {
      ctx.issues.info(
        'FW_LONG_LINES',
        `${longLines.toLocaleString('en-US')} line(s) are longer than the layout (${layoutEnd} characters). Characters beyond the layout were ignored. Add columns to the layout if they hold data.`,
      );
    }
    if (shortLines > records.length * 0.5 && records.length > 0) {
      ctx.issues.error('FW_LAYOUT_MISMATCH', 'Most lines are shorter than the layout. Check the start positions and lengths, and whether the file uses a fixed record length without line breaks.');
    }

    const fields: FieldInfo[] = cols.map((c, i) => ({
      name: c.name.trim(),
      type: trackers[i].type === 'empty' ? TYPE_MAP[c.type] : c.type === 'string' ? 'string' : trackers[i].type,
      declaredType: `${c.type}(${c.start}:${c.length})`,
    }));

    return {
      dataset: { fields, records },
      meta: {
        details: [
          { label: 'Columns in layout', value: String(cols.length) },
          { label: 'Record width', value: `${layoutEnd} characters` },
          { label: 'Records', value: fw.recordLength > 0 ? `fixed length ${fw.recordLength}` : 'one per line' },
          { label: 'Trim', value: fw.trim ? 'yes' : 'no' },
        ],
        sampleLines,
      },
    };
  },
};
