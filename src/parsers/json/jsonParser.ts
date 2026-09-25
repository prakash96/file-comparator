import { AppError } from '../../models/issues';
import type { ParseOptions } from '../../models/parseOptions';
import { ObjectRecordBuilder } from '../common/objectRecordBuilder';
import { readAllText, readTextChunks, readTextHead } from '../common/textStream';
import { isPlainObject } from '../common/values';
import type { FileParser, ParseContext, ParsedFile } from '../types';

/** 1-based line/column of a character offset. */
export function lineColumnAt(text: string, pos: number): { line: number; column: number } {
  let line = 1;
  let last = -1;
  for (let i = 0; i < pos && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      last = i;
    }
  }
  return { line, column: pos - last };
}

/** Turn a JSON.parse SyntaxError into a message with line/column. */
export function describeJsonError(err: unknown, text: string, lineOffset = 0): AppError {
  const msg = err instanceof Error ? err.message : String(err);
  let where = '';
  let line: number | undefined;
  const lc = /line (\d+) column (\d+)/.exec(msg);
  const pos = /position (\d+)/.exec(msg);
  if (lc) {
    line = +lc[1] + lineOffset;
    where = ` at line ${line}, column ${lc[2]}`;
  } else if (pos) {
    const p = lineColumnAt(text, +pos[1]);
    line = p.line + lineOffset;
    where = ` at line ${line}, column ${p.column}`;
  } else if (/Unexpected end/i.test(msg)) {
    where = ' (the file ends before the JSON is complete - it may be truncated)';
  }
  return new AppError('JSON_MALFORMED', `The file is not valid JSON${where}. Check for a missing comma, bracket or quote near that position.`, { details: msg, line });
}

/** Split `a.b[2].c` into path segments. */
export function parsePath(path: string): (string | number)[] {
  const out: (string | number)[] = [];
  for (const part of path.split('.').filter(Boolean)) {
    const re = /([^[\]]+)|\[(\d+)\]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(part))) out.push(m[1] !== undefined ? m[1] : +m[2]);
  }
  return out;
}

export function resolvePath(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const seg of parsePath(path)) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string | number, unknown>)[seg];
  }
  return cur;
}

/** Find arrays of objects inside a document (breadth-first, a few levels deep). */
export function findRecordArrays(root: unknown, maxDepth = 5): { path: string; count: number }[] {
  const out: { path: string; count: number }[] = [];
  const queue: { v: unknown; path: string; depth: number }[] = [{ v: root, path: '', depth: 0 }];
  while (queue.length) {
    const { v, path, depth } = queue.shift()!;
    if (Array.isArray(v)) {
      const objects = v.slice(0, 50).filter(isPlainObject).length;
      if (v.length > 0 && objects >= Math.min(v.length, 50) * 0.5) out.push({ path, count: v.length });
      continue;
    }
    if (isPlainObject(v) && depth < maxDepth) {
      for (const k of Object.keys(v)) queue.push({ v: v[k], path: path ? `${path}.${k}` : k, depth: depth + 1 });
    }
  }
  return out.sort((a, b) => b.count - a.count);
}

/** JSON Lines: several lines, each a complete JSON object. */
export function looksLikeJsonLines(head: string): boolean {
  const lines = head.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2 || !lines[0].startsWith('{') || !lines[1].startsWith('{')) return false;
  try {
    JSON.parse(lines[0]);
    return true;
  } catch {
    return false;
  }
}

export const jsonParser: FileParser = {
  format: 'json',

  async parse(file: Blob, options: ParseOptions, ctx: ParseContext): Promise<ParsedFile> {
    const builder = new ObjectRecordBuilder(options.nestedMode);
    const headText = await readTextHead(file, options.encoding, 64 * 1024);

    if (looksLikeJsonLines(headText.replace(/^﻿/, ''))) {
      return parseJsonLines(file, options, ctx, builder);
    }

    ctx.progress({ stage: 'reading', bytesProcessed: 0, totalBytes: file.size, records: 0 });
    const text = await readAllText(file, options.encoding, (b) => ctx.progress({ stage: 'reading', bytesProcessed: b, totalBytes: file.size, records: 0 }));
    if (!text.trim()) throw new AppError('EMPTY_FILE', 'The file is empty.');
    ctx.progress({ stage: 'parsing', bytesProcessed: 0, totalBytes: file.size, records: 0 });

    let doc: unknown;
    try {
      doc = JSON.parse(text);
    } catch (e) {
      throw describeJsonError(e, text);
    }
    ctx.checkCancelled();

    const candidates = findRecordArrays(doc);
    let rootPath = options.json.rootPath.trim();
    let records: unknown;
    if (rootPath) {
      records = resolvePath(doc, rootPath);
      if (records === undefined) {
        throw new AppError(
          'JSON_ROOT_NOT_FOUND',
          `The root path "${rootPath}" does not exist in this JSON document.${candidates.length ? ` Arrays found: ${candidates.slice(0, 5).map((c) => c.path || '(top level)').join(', ')}.` : ''}`,
        );
      }
    } else if (Array.isArray(doc)) {
      records = doc;
    } else if (candidates.length) {
      rootPath = candidates[0].path;
      records = resolvePath(doc, rootPath);
      ctx.issues.info('JSON_ROOT_DETECTED', `Records were read from "${rootPath}" (${candidates[0].count.toLocaleString('en-US')} items). Change the root path if another array holds the records.`);
    } else {
      records = [doc];
      ctx.issues.info('JSON_SINGLE_RECORD', 'The document contains no array of records; it was read as a single record.');
    }

    const list = Array.isArray(records) ? records : [records];
    let nonObjects = 0;
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      if (!isPlainObject(r)) nonObjects++;
      builder.add(r);
      if (i % 20000 === 0) {
        ctx.checkCancelled();
        ctx.progress({ stage: 'parsing', bytesProcessed: file.size, totalBytes: file.size, records: i });
      }
    }
    if (nonObjects) {
      ctx.issues.warn('JSON_NON_OBJECT', `${nonObjects.toLocaleString('en-US')} item(s) in the record array are not objects; they were read into a column named "value".`);
    }
    if (list.length === 0) ctx.issues.warn('NO_RECORDS', 'The record array is empty.');

    return {
      dataset: builder.toDataset(),
      meta: {
        details: [
          { label: 'Layout', value: 'JSON document' },
          { label: 'Root path', value: rootPath || '(top level)' },
          { label: 'Nested fields', value: options.nestedMode === 'flatten' ? 'flattened (a.b.c)' : 'kept nested (compared as JSON)' },
        ],
        jsonRootCandidates: candidates.slice(0, 20),
        resolved: { json: { rootPath } },
      },
    };
  },
};

async function parseJsonLines(file: Blob, options: ParseOptions, ctx: ParseContext, builder: ObjectRecordBuilder): Promise<ParsedFile> {
  let carry = '';
  let lineNo = 0;
  const handle = (line: string) => {
    lineNo++;
    const t = line.trim();
    if (!t) return;
    try {
      builder.add(JSON.parse(t));
    } catch (e) {
      const err = describeJsonError(e, t, lineNo - 1);
      ctx.issues.error('JSONL_BAD_LINE', `Line ${lineNo.toLocaleString('en-US')} is not valid JSON and was skipped.`, { line: lineNo, details: err.details });
    }
  };
  for await (const chunk of readTextChunks(file, options.encoding, (b) =>
    ctx.progress({ stage: 'parsing', bytesProcessed: b, totalBytes: file.size, records: builder.recordCount }),
  )) {
    ctx.checkCancelled();
    const text = carry + chunk;
    const parts = text.split('\n');
    carry = parts.pop() ?? '';
    for (const p of parts) handle(p);
  }
  if (carry) handle(carry);
  return {
    dataset: builder.toDataset(),
    meta: {
      details: [
        { label: 'Layout', value: 'JSON Lines (one object per line)' },
        { label: 'Nested fields', value: options.nestedMode === 'flatten' ? 'flattened (a.b.c)' : 'kept nested (compared as JSON)' },
      ],
    },
  };
}
