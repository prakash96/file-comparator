import { IssueCollector, type Issue } from '../models/issues';
import type { FfdItem, FfdSchema, FfdSegment, FfdType, FfdValue } from './model';

export interface InferOptions {
  /** 0-based tag position; null = detect. */
  tagStart: number | null;
  /** Tag length; null = detect, 0 = no tag (one record type). */
  tagLength: number | null;
  /** Mark all-numeric fields as Integer / Decimal instead of String. */
  inferTypes: boolean;
  /** Id of the generated structure. */
  structureId: string;
}

export const defaultInferOptions = (): InferOptions => ({ tagStart: null, tagLength: null, inferTypes: false, structureId: 'Records' });

export interface InferReport {
  recordCount: number;
  mode: 'lines' | 'length-prefixed stream';
  /** How record types are told apart. */
  tag: { start: number; length: number; reason: string; lengthPrefix: boolean } | null;
  segments: { id: string; records: number; length: number; fields: number }[];
}

export interface InferResult {
  schema: FfdSchema;
  report: InferReport;
  issues: Issue[];
}

// ---------------------------------------------------------------- record splitting

/**
 * A record length prefix: the first `w` characters hold the length of the rest
 * of the record (or of the whole record), e.g. ` 0630` + 630 characters.
 */
function lengthPrefixWidth(lines: string[]): { width: number; inclusive: boolean } | null {
  for (let w = 2; w <= 8; w++) {
    for (const inclusive of [false, true]) {
      const ok = lines.every((l) => {
        const p = l.slice(0, w);
        if (!/^\s*\d+$/.test(p)) return false;
        return Number(p) === (inclusive ? l.length : l.length - w);
      });
      if (ok) return { width: w, inclusive };
    }
  }
  return null;
}

/** Split a single-line text whose records carry a length prefix. */
function splitLengthPrefixed(text: string): { records: string[]; width: number; inclusive: boolean } | null {
  for (let w = 2; w <= 8; w++) {
    for (const inclusive of [false, true]) {
      const records: string[] = [];
      let pos = 0;
      let ok = true;
      while (pos < text.length) {
        while (text[pos] === '\r' || text[pos] === '\n') pos++;
        if (pos >= text.length) break;
        const p = text.slice(pos, pos + w);
        const n = /^\s*\d+$/.test(p) ? Number(p) : NaN;
        const len = inclusive ? n : n + w;
        if (!(n > 0) || len <= w || pos + len > text.length) {
          ok = false;
          break;
        }
        records.push(text.slice(pos, pos + len));
        pos += len;
      }
      if (ok && records.length >= 2) return { records, width: w, inclusive };
    }
  }
  return null;
}

// ---------------------------------------------------------------- tag detection

function modalShare(lengths: number[]): number {
  const f = new Map<number, number>();
  for (const l of lengths) f.set(l, (f.get(l) ?? 0) + 1);
  return Math.max(...f.values()) / lengths.length;
}

/** Share of records whose length equals the most common length of their group. */
function purity(lines: string[], start: number, k: number): { purity: number; groups: number } {
  const groups = new Map<string, number[]>();
  for (const l of lines) {
    const key = l.slice(start, start + k);
    const g = groups.get(key);
    if (g) g.push(l.length);
    else groups.set(key, [l.length]);
  }
  let pure = 0;
  for (const g of groups.values()) pure += modalShare(g) * g.length;
  return { purity: pure / lines.length, groups: groups.size };
}

const charClass = (c: string | undefined) => (c === undefined || c === ' ' ? 's' : /\d/.test(c) ? 'd' : /[A-Za-z]/.test(c) ? 'a' : 'o');

function detectTag(lines: string[], start: number): { length: number; reason: string } | null {
  if (lines.length < 2) return null;
  if (modalShare(lines.map((l) => l.length)) === 1) return null; // all the same length: nothing tells types apart
  const maxGroups = lines.length >= 10 ? Math.ceil(lines.length / 2) : lines.length;
  let best: { k: number; purity: number } | null = null;
  for (let k = 1; k <= 12; k++) {
    const p = purity(lines, start, k);
    if (p.groups < 2 || p.groups > maxGroups) continue;
    if (!best || p.purity > best.purity + 1e-9) best = { k, purity: p.purity };
  }
  if (!best || best.purity < 0.6) return null;
  // Extend over the rest of the token (e.g. ` 063` -> ` 0630`) while the grouping does not change.
  let k = best.k;
  const groups = purity(lines, start, k).groups;
  while (k < 12) {
    const next = lines.map((l) => l[start + k]);
    const sameClass = lines.every((l, i) => charClass(next[i]) !== 's' && charClass(next[i]) === charClass(l[start + k - 1]));
    if (!sameClass || purity(lines, start, k + 1).groups !== groups) break;
    k++;
  }
  return { length: k, reason: `characters ${start + 1}–${start + k} identify ${groups} record types` };
}

// ---------------------------------------------------------------- field inference

/** Field start offsets within [from, to): a field starts where a non-blank run follows a blank column. */
function fieldStarts(lines: string[], from: number, to: number): number[] {
  const starts = [from];
  const blank = (i: number) => lines.every((l) => i >= l.length || l[i] === ' ');
  let leadingBlank = blank(from);
  for (let i = from + 1; i < to; i++) {
    if (blank(i - 1) && !blank(i)) {
      // Blank columns at the start of a region are padding of the first field, not a field of their own.
      if (!(leadingBlank && starts.length === 1)) starts.push(i);
      leadingBlank = false;
    } else if (!blank(i)) leadingBlank = false;
  }
  return starts;
}

function inferType(values: string[], infer: boolean): FfdType {
  if (!infer) return 'String';
  const v = values.map((s) => s.trim()).filter(Boolean);
  if (!v.length) return 'String';
  if (v.every((s) => /^-?(0|[1-9]\d{0,14})$/.test(s))) return 'Integer';
  if (v.every((s) => /^-?\d{1,15}\.\d+$/.test(s))) return 'Decimal';
  return 'String';
}

function buildSegment(id: string, lines: string[], tag: { start: number; length: number; name: string } | null, opts: InferOptions): FfdSegment {
  const width = Math.max(...lines.map((l) => l.length));
  const bounds: { start: number; end: number; tag: boolean }[] = [];
  const addRegion = (from: number, to: number) => {
    if (to <= from) return;
    const s = fieldStarts(lines, from, to);
    s.forEach((st, i) => bounds.push({ start: st, end: i + 1 < s.length ? s[i + 1] : to, tag: false }));
  };
  if (tag) {
    addRegion(0, tag.start);
    bounds.push({ start: tag.start, end: tag.start + tag.length, tag: true });
    addRegion(tag.start + tag.length, width);
  } else {
    addRegion(0, width);
  }

  let n = 0;
  const values: FfdValue[] = bounds.map((b) => {
    const slice = lines.map((l) => l.slice(b.start, b.end));
    if (b.tag) return { name: tag!.name, type: 'String', length: b.end - b.start, tagValue: lines[0].slice(b.start, b.end) };
    n++;
    return { name: `Field${n}`, type: inferType(slice, opts.inferTypes), length: b.end - b.start };
  });
  return { id, name: tag ? `Record ${id}` : 'Record', values };
}

// ---------------------------------------------------------------- structure

function buildStructure(sequence: string[], id: string): FfdItem[] {
  const runs: { id: string; n: number }[] = [];
  for (const s of sequence) {
    const last = runs[runs.length - 1];
    if (last && last.id === s) last.n++;
    else runs.push({ id: s, n: 1 });
  }
  const runCount = new Map<string, number>();
  for (const r of runs) runCount.set(r.id, (runCount.get(r.id) ?? 0) + 1);
  const repeated = (r: { id: string }) => (runCount.get(r.id) ?? 0) > 1;
  const seg = (sid: string, many: boolean): FfdItem => ({ kind: 'segment', idRef: sid, usage: 'O', max: many ? Infinity : 1 });

  const first = runs.findIndex(repeated);
  if (first === -1) return runs.map((r) => seg(r.id, r.n > 1));
  let last = runs.length - 1;
  while (!repeated(runs[last])) last--;

  // Segments that recur after other segments form a repeating group.
  const inGroup: string[] = [];
  const many = new Set<string>();
  for (const r of runs.slice(first, last + 1)) {
    if (!inGroup.includes(r.id)) inGroup.push(r.id);
    if (r.n > 1) many.add(r.id);
  }
  return [
    ...runs.slice(0, first).map((r) => seg(r.id, r.n > 1)),
    { kind: 'group', groupId: `${id}Group`, usage: 'O', max: Infinity, items: inGroup.map((s) => seg(s, many.has(s))) },
    ...runs.slice(last + 1).map((r) => seg(r.id, r.n > 1)),
  ];
}

// ---------------------------------------------------------------- entry point

/** Generate an FFD from sample fixed-width text. */
export function inferFfd(text: string, opts: InferOptions): InferResult {
  const issues = new IssueCollector();
  const input = text.replace(/^﻿/, '');
  let lines = input.split(/\r\n|\n|\r/).filter((l) => l.trim() !== '');
  let mode: InferReport['mode'] = 'lines';
  let prefix = lines.length > 1 ? lengthPrefixWidth(lines) : null;

  if (lines.length === 1) {
    const split = splitLengthPrefixed(lines[0]);
    if (split) {
      lines = split.records;
      mode = 'length-prefixed stream';
      prefix = { width: split.width, inclusive: split.inclusive };
    }
  }
  if (lines.length === 0) {
    issues.error('FFD_EMPTY', 'The sample text is empty.');
    return { schema: { form: 'FIXEDWIDTH', structures: [], segments: [{ id: 'Record', values: [] }] }, report: { recordCount: 0, mode, tag: null, segments: [] }, issues: issues.toArray() };
  }

  // Where is the record-type tag?
  let tag: InferReport['tag'] = null;
  const start = opts.tagStart ?? 0;
  if (opts.tagLength !== null && opts.tagLength > 0) {
    tag = { start, length: opts.tagLength, reason: 'set manually', lengthPrefix: false };
  } else if (opts.tagLength === null) {
    if (prefix && opts.tagStart === null) {
      const types = new Set(lines.map((l) => l.slice(0, prefix!.width))).size;
      tag = { start: 0, length: prefix.width, reason: `the first ${prefix.width} characters hold the record length (${types} record types)`, lengthPrefix: true };
    } else {
      const found = detectTag(lines, start);
      if (found) tag = { start, length: found.length, reason: found.reason, lengthPrefix: false };
    }
  }
  if (!tag && lines.length > 1 && opts.tagLength === null && modalShare(lines.map((l) => l.length)) < 1) {
    issues.warn('FFD_NO_TAG', 'Records have different lengths but no record-type tag was found, so one record type was generated. Set the tag position and length if the file has several record types.');
  }
  if (!tag && opts.tagLength === null && modalShare(lines.map((l) => l.length)) === 1 && lines.length > 1) {
    issues.info('FFD_ONE_TYPE', 'All records have the same length, so they were treated as one record type. Set the tag position and length if the file has several record types.');
  }

  // Group records by tag.
  const groups = new Map<string, string[]>();
  const sequence: string[] = [];
  const idFor = new Map<string, string>();
  for (const l of lines) {
    const raw = tag ? l.slice(tag.start, tag.start + tag.length) : '';
    if (!idFor.has(raw)) {
      const trimmed = raw.trim() || `Record${idFor.size + 1}`;
      const taken = new Set(idFor.values());
      idFor.set(raw, taken.has(trimmed) ? `${trimmed}_${idFor.size + 1}` : trimmed);
    }
    const id = tag ? idFor.get(raw)! : 'Record';
    sequence.push(id);
    const g = groups.get(id);
    if (g) g.push(l);
    else groups.set(id, [l]);
  }
  if (tag && groups.size > 50) {
    issues.warn('FFD_MANY_TYPES', `${groups.size} record types were found. The tag position or length is probably wrong.`);
  }

  const tagName = tag?.lengthPrefix ? 'MsgLength' : 'RecordType';
  const segments = [...groups].map(([id, ls]) => buildSegment(id, ls, tag ? { start: tag.start, length: tag.length, name: tagName } : null, opts));
  for (const [id, ls] of groups) {
    const lens = new Set(ls.map((l) => l.length));
    if (lens.size > 1) {
      issues.warn('FFD_VARIABLE_LENGTH', `Records of type "${id}" have different lengths (${[...lens].slice(0, 5).join(', ')}). The segment uses the longest; check the last field's length.`);
    }
  }

  const schema: FfdSchema =
    tag || segments.length > 1
      ? { form: 'FLATFILE', structures: [{ id: opts.structureId || 'Records', name: 'Generated structure', data: buildStructure(sequence, opts.structureId || 'Records') }], segments }
      : { form: 'FIXEDWIDTH', structures: [], segments };

  return {
    schema,
    report: {
      recordCount: lines.length,
      mode,
      tag,
      segments: segments.map((s) => ({ id: s.id, records: groups.get(s.id)!.length, length: s.values.reduce((n, v) => n + v.length, 0), fields: s.values.length })),
    },
    issues: issues.toArray(),
  };
}
