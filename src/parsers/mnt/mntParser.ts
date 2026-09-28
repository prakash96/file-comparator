import { uniqueHeaders } from '../common/values';
import { headLines, readTextHead } from '../common/textStream';
import { describeDelimiter, parseDelimited } from '../csv/delimitedParser';
import type { FileParser, MetaDetail } from '../types';

/** `<Header line_count="732" download_id="..." .../>` - a single self-closing element on one line. */
const HEADER_LINE = /^\s*<([A-Za-z_][\w.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*\/?>\s*$/;
const ATTRIBUTE = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

const unescapeXml = (s: string) =>
  s.replace(/&(lt|gt|quot|apos|amp);/g, (_, e: string) => ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' })[e]!);

export interface MntHeader {
  element: string;
  attributes: { name: string; value: string }[];
}

/** Parse an MNT header line, or null when the line is not one. */
export function parseMntHeader(line: string): MntHeader | null {
  const m = HEADER_LINE.exec(line.replace(/^﻿/, ''));
  if (!m) return null;
  const attributes = [...m[2].matchAll(ATTRIBUTE)].map((a) => ({ name: a[1], value: unescapeXml(a[2] ?? a[3] ?? '') }));
  return { element: m[1], attributes };
}

/** True when the text starts with an MNT header line followed by non-XML record lines. */
export function looksLikeMnt(text: string): boolean {
  const lines = headLines(text, 3);
  return lines.length >= 2 && parseMntHeader(lines[0]) !== null && !lines[1].trimStart().startsWith('<');
}

/** Byte offset just past the first line break, located on raw bytes so it is exact for any encoding. */
function firstLineEnd(bytes: Uint8Array, encoding: string): number {
  const enc = encoding.toLowerCase();
  const unit = enc === 'utf-16le' || enc === 'utf-16be' ? 2 : 1;
  const lo = enc === 'utf-16be' ? 1 : 0; // byte of each 16-bit unit that holds the ASCII value
  const at = (i: number) => (unit === 2 && bytes[i + 1 - lo] !== 0 ? -1 : bytes[i + lo]);
  for (let i = 0; i + unit <= bytes.length; i += unit) {
    const c = at(i);
    if (c === 0x0a) return i + unit;
    if (c === 0x0d) return at(i + unit) === 0x0a ? i + 2 * unit : i + unit;
  }
  return bytes.length;
}

/**
 * MNT download files: an XML-style header element on the first line whose
 * attributes describe the batch (line_count, download_id, target_org_node...),
 * followed by headerless delimited records. The records become the dataset;
 * the header attributes are shown as file details and `line_count` is checked.
 */
export const mntParser: FileParser = {
  format: 'mnt',

  async parse(file, options, ctx) {
    const head = await readTextHead(file, options.encoding, 64 * 1024);
    const firstLine = headLines(head, 1)[0] ?? head;
    const header = parseMntHeader(firstLine);

    let body: Blob = file;
    if (header) {
      const bytes = new Uint8Array(await file.slice(0, 64 * 1024).arrayBuffer());
      body = file.slice(firstLineEnd(bytes, options.encoding));
    } else {
      ctx.issues.warn('MNT_NO_HEADER', 'The first line is not an MNT header element (<Header ... />). The whole file was read as records.', { line: 1 });
    }

    const delimited = { delimiter: options.mnt.delimiter, hasHeader: false, quoteChar: '', escapeChar: '', skipEmptyLines: true };
    const parsed = await parseDelimited(body, { ...options, delimited }, ctx, header ? 2 : 1);
    const { dataset } = parsed;
    const delimiter = parsed.meta.resolved?.delimited?.delimiter ?? options.mnt.delimiter;

    const given = options.mnt.columnNames.map((n) => n.trim());
    if (given.some(Boolean)) {
      if (given.length > dataset.fields.length) {
        ctx.issues.warn('MNT_COLUMN_NAMES', `${given.length} column names were given but the records have only ${dataset.fields.length} field(s); the extra names were ignored.`);
      }
      const names = uniqueHeaders(
        dataset.fields.map((f, i) => given[i] || f.name),
        (n) => ctx.issues.warn('DUPLICATE_HEADER', `Column name "${n}" was given more than once; later copies were renamed (${n}_2, ...).`),
      );
      dataset.fields.forEach((f, i) => (f.name = names[i]));
    }

    const details: MetaDetail[] = [{ label: 'Delimiter', value: describeDelimiter(delimiter) }];
    if (header) {
      details.push({ label: 'Header element', value: `<${header.element}>` });
      for (const a of header.attributes) details.push({ label: a.name, value: a.value || '(empty)' });

      const declared = header.attributes.find((a) => a.name.toLowerCase() === 'line_count')?.value;
      if (declared !== undefined) {
        const n = Number(declared);
        const records = dataset.records.length;
        if (!Number.isInteger(n)) {
          ctx.issues.warn('MNT_LINE_COUNT', `The header's line_count "${declared}" is not a whole number.`, { line: 1 });
        } else if (n !== records + 1 && n !== records) {
          ctx.issues.warn(
            'MNT_LINE_COUNT',
            `The header declares line_count=${n.toLocaleString('en-US')}, but the file has ${records.toLocaleString('en-US')} record(s) (${(records + 1).toLocaleString('en-US')} lines including the header). The file may be truncated or have extra lines.`,
            { line: 1 },
          );
        }
      }
    }

    return {
      dataset,
      meta: {
        details,
        resolved: { mnt: { delimiter, columnNames: options.mnt.columnNames } },
        sampleLines: headLines(head, 20),
      },
    };
  },
};
