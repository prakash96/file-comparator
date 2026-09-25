import type { CellValue, FieldInfo } from '../../models/dataset';
import { AppError } from '../../models/issues';
import type { ParseOptions } from '../../models/parseOptions';
import { ColumnInterner } from '../common/interner';
import { TypeTracker } from '../common/typeInference';
import { readTextChunks, readTextHead, headLines } from '../common/textStream';
import { uniqueHeaders } from '../common/values';
import type { FileParser, ParseContext, ParsedFile } from '../types';
import { sniffDelimited } from './sniff';
import { DelimitedTokenizer } from './tokenizer';

export const DELIMITER_LABELS: Record<string, string> = {
  ',': 'comma (,)',
  '|': 'pipe (|)',
  '\t': 'tab',
  ';': 'semicolon (;)',
};

export function describeDelimiter(d: string): string {
  return DELIMITER_LABELS[d] ?? `"${d}"`;
}

export const delimitedParser: FileParser = {
  format: 'delimited',

  async parse(file: Blob, options: ParseOptions, ctx: ParseContext): Promise<ParsedFile> {
    const opts = { ...options.delimited };
    const head = await readTextHead(file, options.encoding);
    if (!opts.delimiter) {
      opts.delimiter = sniffDelimited(head, opts.quoteChar).delimiter;
    }
    if (opts.delimiter === '\n' || opts.delimiter === '\r') {
      throw new AppError('BAD_DELIMITER', 'A line break cannot be used as the field delimiter.');
    }

    let names: string[] | null = null;
    let expected = 0;
    let trackers: TypeTracker[] = [];
    const records: CellValue[][] = [];
    let fieldCountMismatches = 0;
    let extraColumns = 0;
    let headerLine = 0;
    const interner = new ColumnInterner();

    const growTo = (n: number) => {
      while (trackers.length < n) trackers.push(new TypeTracker());
    };

    const tokenizer = new DelimitedTokenizer(opts, {
      record: (fields, line, anyQuoted) => {
        if (opts.skipEmptyLines && fields.length === 1 && fields[0] === '' && !anyQuoted) return;
        if (names === null) {
          if (opts.hasHeader) {
            names = uniqueHeaders(fields, (n) => ctx.issues.warn('DUPLICATE_HEADER', `Column name "${n}" appears more than once in the header; later copies were renamed (${n}_2, ...).`, { line }));
            expected = names.length;
            headerLine = line;
            growTo(expected);
            return;
          }
          expected = fields.length;
          names = fields.map((_, i) => `COL_${i + 1}`);
          growTo(expected);
        }
        if (fields.length !== expected) {
          fieldCountMismatches++;
          ctx.issues.warn(
            'FIELD_COUNT',
            `Record ${(records.length + 1).toLocaleString('en-US')} (line ${line.toLocaleString('en-US')}) has ${fields.length} field(s); the ${opts.hasHeader ? 'header' : 'first record'} has ${expected}. ` +
              (fields.length > expected
                ? 'Check for an unquoted delimiter inside a value, or a wrong delimiter / quote setting.'
                : 'Missing trailing fields are read as NULL.'),
            { record: records.length + 1, line },
          );
          if (fields.length > names!.length) {
            for (let i = names!.length; i < fields.length; i++) names!.push(`COL_${i + 1}`);
            extraColumns = Math.max(extraColumns, fields.length - expected);
            growTo(fields.length);
          }
        }
        for (let i = 0; i < fields.length; i++) {
          trackers[i].observeText(fields[i]);
          fields[i] = interner.intern(i, fields[i]);
        }
        records.push(fields);
      },
      textAfterQuote: (line) => ctx.issues.warn('TEXT_AFTER_QUOTE', `Line ${line.toLocaleString('en-US')}: characters found after a closing quote; they were kept as part of the value.`, { line }),
      unterminatedQuote: (line) =>
        ctx.issues.error('UNTERMINATED_QUOTE', `A quoted value that starts on line ${line.toLocaleString('en-US')} is never closed. Everything to the end of the file was read into one value. Check the quote character setting.`, { line }),
    });

    let lastReport = 0;
    for await (const chunk of readTextChunks(file, options.encoding, (bytes) => {
      ctx.progress({ stage: 'parsing', bytesProcessed: bytes, totalBytes: file.size, records: records.length });
    })) {
      ctx.checkCancelled();
      tokenizer.feed(chunk);
      if (records.length - lastReport > 100000) {
        lastReport = records.length;
        ctx.progress({ stage: 'parsing', bytesProcessed: -1, totalBytes: file.size, records: records.length });
      }
    }
    tokenizer.end();
    interner.clear();

    if (names === null) {
      if (file.size === 0) throw new AppError('EMPTY_FILE', 'The file is empty.');
      names = [];
    }
    if (records.length === 0) {
      ctx.issues.warn('NO_RECORDS', opts.hasHeader ? 'The file has a header row but no data records.' : 'The file contains no data records.');
    }
    if (extraColumns > 0) {
      ctx.issues.warn('EXTRA_COLUMNS', `Some records have up to ${extraColumns} more field(s) than the header. The extra values were placed in columns COL_${expected + 1}… so no data is lost.`);
    }
    if (fieldCountMismatches > 0 && fieldCountMismatches > records.length * 0.5) {
      ctx.issues.error('FIELD_COUNT_MOSTLY', `Most records (${fieldCountMismatches.toLocaleString('en-US')}) do not match the header's field count. The delimiter (${describeDelimiter(opts.delimiter)}) or quote setting is probably wrong for this file.`);
    }

    const fields: FieldInfo[] = names.map((name, i) => ({ name, type: trackers[i]?.type ?? 'empty' }));
    return {
      dataset: { fields, records },
      meta: {
        details: [
          { label: 'Delimiter', value: describeDelimiter(opts.delimiter) },
          { label: 'Header row', value: opts.hasHeader ? `yes${headerLine > 1 ? ` (line ${headerLine})` : ''}` : 'no' },
          { label: 'Quote', value: opts.quoteChar ? opts.quoteChar : 'none' },
        ],
        resolved: { delimited: opts },
        sampleLines: headLines(head, 20),
      },
    };
  },
};
