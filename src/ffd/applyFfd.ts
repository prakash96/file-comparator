import { IssueCollector, type Issue } from '../models/issues';
import type { FfdItem, FfdSchema, FfdSegment, FfdValue } from './model';

export type FfdRecordMode = 'auto' | 'lines' | 'stream';
export type FfdJson = string | number | boolean | null | FfdJson[] | { [k: string]: FfdJson };

export interface ApplyOptions {
  /** `lines` = one record per line; `stream` = records back to back, each as long as its segment. */
  recordMode: FfdRecordMode;
  /** Trim padding from values. */
  trim: boolean;
  /** Structure id to group records by; '' = plain list of records. */
  structureId: string;
}

export const defaultApplyOptions = (schema?: FfdSchema): ApplyOptions => ({
  recordMode: 'auto',
  trim: true,
  structureId: schema?.structures[0]?.id ?? '',
});

export interface FfdRecord {
  segment: string;
  /** 1-based line number (line mode) or record number (stream mode). */
  line: number;
  values: Record<string, FfdJson>;
}

export interface ApplyResult {
  records: FfdRecord[];
  output: FfdJson;
  mode: 'lines' | 'stream';
  segmentCounts: Record<string, number>;
  issues: Issue[];
}

interface TagRule {
  offset: number;
  value: string;
}

interface CompiledSegment {
  seg: FfdSegment;
  length: number;
  tags: TagRule[];
}

function compile(schema: FfdSchema): CompiledSegment[] {
  return schema.segments.map((seg) => {
    const tags: TagRule[] = [];
    let offset = 0;
    for (const v of seg.values) {
      if (v.tagValue !== undefined) tags.push({ offset, value: v.tagValue });
      offset += v.length;
    }
    if (seg.tag !== undefined && schema.tagLength) tags.push({ offset: schema.tagStart ?? 0, value: seg.tag.padEnd(schema.tagLength).slice(0, schema.tagLength) });
    return { seg, length: offset, tags };
  });
}

/** Find the segment whose tag(s) match the text at `pos`: exact first, then ignoring padding. */
function identify(text: string, pos: number, segs: CompiledSegment[], recordLength?: number): CompiledSegment | undefined {
  const tagged = segs.filter((s) => s.tags.length);
  const at = (s: CompiledSegment, exact: boolean) =>
    s.tags.every((t) => {
      const got = text.slice(pos + t.offset, pos + t.offset + t.value.length);
      return exact ? got === t.value : got.trim() === t.value.trim() && got.length === t.value.length;
    });
  const hit = tagged.find((s) => at(s, true)) ?? tagged.find((s) => at(s, false));
  if (hit) return hit;
  const untagged = segs.filter((s) => !s.tags.length);
  if (untagged.length <= 1) return untagged[0];
  return (recordLength !== undefined && untagged.find((s) => s.length === recordLength)) || untagged[0];
}

const SAFE_DIGITS = 15;

function convert(raw: string, v: FfdValue, trim: boolean): FfdJson {
  const t = raw.trim();
  switch (v.type) {
    case 'Integer': {
      if (t === '') return null;
      if (/^[+-]?\d+$/.test(t) && t.replace(/^[+-]?0*/, '').length <= SAFE_DIGITS) return Number(t);
      return t;
    }
    case 'Decimal': {
      if (t === '') return null;
      let s = t;
      const implicit = v.format?.implicit ?? 0;
      if (implicit > 0 && /^[+-]?\d+$/.test(s)) {
        const sign = /^[+-]/.test(s) ? s[0] : '';
        const digits = s.replace(/^[+-]/, '').padStart(implicit + 1, '0');
        s = `${sign}${digits.slice(0, -implicit)}.${digits.slice(-implicit)}`;
      }
      if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s) && s.replace(/[^\d]/g, '').replace(/^0+/, '').length <= SAFE_DIGITS) return Number(s);
      return s;
    }
    case 'Boolean': {
      const l = t.toLowerCase();
      if (['true', 't', 'y', 'yes', '1'].includes(l)) return true;
      if (['false', 'f', 'n', 'no', '0'].includes(l)) return false;
      return t === '' ? null : t;
    }
    default:
      return trim ? t : raw;
  }
}

function readRecord(text: string, pos: number, cs: CompiledSegment, trim: boolean): Record<string, FfdJson> {
  const values: Record<string, FfdJson> = {};
  let offset = pos;
  for (const v of cs.seg.values) {
    values[v.name] = convert(text.slice(offset, offset + v.length), v, trim);
    offset += v.length;
  }
  return values;
}

function splitRecords(text: string, mode: FfdRecordMode, segs: CompiledSegment[], opts: ApplyOptions, issues: IssueCollector) {
  const records: FfdRecord[] = [];
  const resolved: 'lines' | 'stream' = mode === 'auto' ? (/\r|\n/.test(text.replace(/[\r\n]+$/, '')) ? 'lines' : 'stream') : mode;

  if (resolved === 'lines') {
    const lines = text.split(/\r\n|\n|\r/);
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    lines.forEach((line, i) => {
      if (line.trim() === '') return;
      const cs = identify(line, 0, segs, line.length);
      if (!cs) {
        issues.error('FFD_UNKNOWN_RECORD', `Line ${i + 1} does not match any segment tag: "${line.slice(0, 20)}…"`, { line: i + 1 });
        return;
      }
      if (line.length < cs.length) {
        issues.warn('FFD_SHORT_RECORD', `Line ${i + 1} (${cs.seg.id}) is ${line.length} characters; the segment defines ${cs.length}. Missing fields are empty.`, { line: i + 1 });
      } else if (line.length > cs.length) {
        issues.warn('FFD_LONG_RECORD', `Line ${i + 1} (${cs.seg.id}) is ${line.length} characters; the segment defines ${cs.length}. The extra ${line.length - cs.length} character(s) were ignored.`, { line: i + 1 });
      }
      records.push({ segment: cs.seg.id, line: i + 1, values: readRecord(line, 0, cs, opts.trim) });
    });
  } else {
    let pos = 0;
    while (pos < text.length) {
      while (text[pos] === '\r' || text[pos] === '\n') pos++;
      if (pos >= text.length) break;
      const cs = identify(text, pos, segs);
      if (!cs) {
        issues.error('FFD_UNKNOWN_RECORD', `Record ${records.length + 1} at character ${pos + 1} does not match any segment tag: "${text.slice(pos, pos + 20)}…". Reading stopped here.`, { record: records.length + 1 });
        break;
      }
      if (pos + cs.length > text.length) {
        issues.warn('FFD_SHORT_RECORD', `The last record (${cs.seg.id}) is ${text.length - pos} characters; the segment defines ${cs.length}. Missing fields are empty.`, { record: records.length + 1 });
      }
      records.push({ segment: cs.seg.id, line: records.length + 1, values: readRecord(text, pos, cs, opts.trim) });
      pos += cs.length;
    }
  }
  return { records, mode: resolved };
}

/** Segment ids that can start this item (a group can start with any leading optional item or its first mandatory one). */
function firstSegments(item: FfdItem): Set<string> {
  if (item.kind === 'segment') return new Set([item.idRef]);
  const out = new Set<string>();
  for (const it of item.items) {
    for (const s of firstSegments(it)) out.add(s);
    if (it.usage === 'M') break;
  }
  return out;
}

function matchItems(items: FfdItem[], records: FfdRecord[], start: number, issues: IssueCollector, path: string): { value: Record<string, FfdJson>; pos: number } {
  const value: Record<string, FfdJson> = {};
  let pos = start;
  for (const item of items) {
    const key = item.kind === 'segment' ? item.idRef : item.groupId;
    const starts = firstSegments(item);
    const found: FfdJson[] = [];
    while (found.length < item.max && pos < records.length && starts.has(records[pos].segment)) {
      if (item.kind === 'segment') {
        found.push(records[pos].values);
        pos++;
      } else {
        const inner = matchItems(item.items, records, pos, issues, `${path}${key}.`);
        if (inner.pos === pos) break;
        found.push(inner.value);
        pos = inner.pos;
      }
    }
    if (found.length === 0) {
      if (item.usage === 'M') {
        const at = records[pos];
        issues.warn('FFD_MISSING', `Mandatory ${item.kind} "${path}${key}" is missing${at ? ` before line ${at.line} (${at.segment})` : ' at the end of the file'}.`, at ? { line: at.line } : {});
      }
      continue;
    }
    value[key] = item.max > 1 ? found : found[0];
  }
  return { value, pos };
}

/** Apply an FFD to fixed-width text and build the JSON view (grouped by a structure, or a record list). */
export function applyFfd(text: string, schema: FfdSchema, options: ApplyOptions): ApplyResult {
  const issues = new IssueCollector();
  const segs = compile(schema);
  const input = text.replace(/^﻿/, '');
  const { records, mode } = splitRecords(input, options.recordMode, segs, options, issues);

  const segmentCounts: Record<string, number> = {};
  for (const r of records) segmentCounts[r.segment] = (segmentCounts[r.segment] ?? 0) + 1;

  let output: FfdJson;
  const structure = schema.structures.find((s) => s.id === options.structureId);
  if (structure) {
    const { value, pos } = matchItems(structure.data, records, 0, issues, '');
    output = value;
    if (pos < records.length) {
      const rest = records.slice(pos);
      issues.warn(
        'FFD_UNMATCHED',
        `${rest.length.toLocaleString('en-US')} record(s) from line ${rest[0].line} (${rest[0].segment}) on do not fit structure "${structure.id}" and are listed under "_unmatched".`,
        { line: rest[0].line },
      );
      value._unmatched = rest.map((r) => ({ segment: r.segment, line: r.line, values: r.values }));
    }
  } else {
    output = records.map((r) => ({ segment: r.segment, line: r.line, values: r.values }));
  }
  if (records.length === 0) issues.warn('FFD_NO_RECORDS', 'No records were read from the text.');

  return { records, output, mode, segmentCounts, issues: issues.toArray() };
}
