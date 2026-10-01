/**
 * Pure, immutable editing operations on an FFD schema, used by the layout
 * editor. Columns are 0-based character offsets within a record.
 */
import { segmentLength, type FfdItem, type FfdSchema, type FfdSegment, type FfdValue } from './model';

export function fieldOffsets(seg: FfdSegment): number[] {
  const out: number[] = [];
  let o = 0;
  for (const v of seg.values) {
    out.push(o);
    o += v.length;
  }
  return out;
}

/** Index of the field covering `col`, or -1 past the end. */
export function fieldAt(seg: FfdSegment, col: number): number {
  let o = 0;
  for (let i = 0; i < seg.values.length; i++) {
    if (col < o + seg.values[i].length) return col >= o ? i : -1;
    o += seg.values[i].length;
  }
  return -1;
}

export function uniqueFieldName(seg: FfdSegment, base: string, ignore = -1): string {
  const taken = new Set(seg.values.filter((_, i) => i !== ignore).map((v) => v.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}_${n}`.toLowerCase())) return `${base}_${n}`;
}

const withValues = (seg: FfdSegment, values: FfdValue[]): FfdSegment => ({ ...seg, values });

/** Split the field covering `col` so a new field starts at `col`. */
export function splitAt(seg: FfdSegment, col: number): FfdSegment {
  const i = fieldAt(seg, col);
  if (i < 0) return seg;
  const start = fieldOffsets(seg)[i];
  if (col <= start) return seg;
  const f = seg.values[i];
  const left: FfdValue = { ...f, length: col - start };
  if (left.tagValue !== undefined) left.tagValue = left.tagValue.slice(0, left.length);
  const right: FfdValue = { name: uniqueFieldName(seg, `${f.name}_2`), type: 'String', length: f.length - left.length };
  const values = [...seg.values];
  values.splice(i, 1, left, right);
  return withValues(seg, values);
}

/** Move the boundary at the start of field `i` (i >= 1) to `col`, resizing the two neighbours. */
export function moveBoundary(seg: FfdSegment, i: number, col: number): FfdSegment {
  if (i < 1 || i >= seg.values.length) return seg;
  const offs = fieldOffsets(seg);
  const lo = offs[i - 1] + 1;
  const hi = offs[i] + seg.values[i].length - 1;
  const c = Math.min(hi, Math.max(lo, Math.round(col)));
  if (c === offs[i]) return seg;
  const values = [...seg.values];
  values[i - 1] = { ...values[i - 1], length: c - offs[i - 1] };
  values[i] = { ...values[i], length: offs[i] + seg.values[i].length - c };
  for (const k of [i - 1, i]) {
    const tv = values[k].tagValue;
    if (tv !== undefined && tv.length > values[k].length) values[k] = { ...values[k], tagValue: tv.slice(0, values[k].length) };
  }
  return withValues(seg, values);
}

/** Merge field `i` with the one after it; the merged field keeps field `i`'s name and type. */
export function mergeWithNext(seg: FfdSegment, i: number): FfdSegment {
  if (i < 0 || i + 1 >= seg.values.length) return seg;
  const values = [...seg.values];
  values.splice(i, 2, { ...values[i], length: values[i].length + values[i + 1].length });
  return withValues(seg, values);
}

/** Remove field `i`; the record gets shorter by its length. */
export function removeField(seg: FfdSegment, i: number): FfdSegment {
  if (seg.values.length <= 1) return seg;
  return withValues(
    seg,
    seg.values.filter((_, k) => k !== i),
  );
}

/** Change the length of field `i`; later fields shift. */
export function setFieldLength(seg: FfdSegment, i: number, length: number): FfdSegment {
  const len = Math.max(1, Math.floor(length) || 1);
  return updateField(seg, i, { length: len });
}

export function updateField(seg: FfdSegment, i: number, patch: Partial<FfdValue>): FfdSegment {
  const values = [...seg.values];
  const next: FfdValue = { ...values[i], ...patch };
  for (const k of Object.keys(patch) as (keyof FfdValue)[]) if (patch[k] === undefined) delete next[k];
  values[i] = next;
  return withValues(seg, values);
}

/** Add a field at the end of the record. */
export function addField(seg: FfdSegment, length: number): FfdSegment {
  return withValues(seg, [...seg.values, { name: uniqueFieldName(seg, `Field${seg.values.length + 1}`), type: 'String', length: Math.max(1, length) }]);
}

/** Make the record exactly `total` characters by growing or shrinking fields at the end. */
export function fitLength(seg: FfdSegment, total: number): FfdSegment {
  const cur = segmentLength(seg);
  if (total <= 0 || cur === total) return seg;
  const values = [...seg.values];
  if (total > cur) {
    values[values.length - 1] = { ...values[values.length - 1], length: values[values.length - 1].length + total - cur };
  } else {
    let excess = cur - total;
    while (excess > 0 && values.length) {
      const last = values[values.length - 1];
      if (last.length > excess) {
        values[values.length - 1] = { ...last, length: last.length - excess };
        excess = 0;
      } else if (values.length > 1) {
        values.pop();
        excess -= last.length;
      } else break;
    }
  }
  return withValues(seg, values);
}

// ---------------------------------------------------------------- schema level

export function mapSegment(schema: FfdSchema, id: string, fn: (s: FfdSegment) => FfdSegment): FfdSchema {
  return { ...schema, segments: schema.segments.map((s) => (s.id === id ? fn(s) : s)) };
}

function mapItems(items: FfdItem[], fn: (it: FfdItem) => FfdItem | null): FfdItem[] {
  const out: FfdItem[] = [];
  for (const it of items) {
    const m = fn(it);
    if (!m) continue;
    if (m.kind === 'group') {
      const inner = mapItems(m.items, fn);
      if (inner.length) out.push({ ...m, items: inner });
    } else out.push(m);
  }
  return out;
}

const withForm = (schema: FfdSchema): FfdSchema => (schema.segments.length > 1 && schema.form === 'FIXEDWIDTH' ? { ...schema, form: 'FLATFILE' } : schema);

/** Rename a segment and every structure reference to it. */
export function renameSegment(schema: FfdSchema, oldId: string, newId: string): FfdSchema {
  const id = newId.trim();
  if (!id || id === oldId || schema.segments.some((s) => s.id === id)) return schema;
  return {
    ...schema,
    segments: schema.segments.map((s) => (s.id === oldId ? { ...s, id } : s)),
    structures: schema.structures.map((st) => ({ ...st, data: mapItems(st.data, (it) => (it.kind === 'segment' && it.idRef === oldId ? { ...it, idRef: id } : it)) })),
  };
}

export function uniqueSegmentId(schema: FfdSchema, base: string): string {
  const taken = new Set(schema.segments.map((s) => s.id));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}_${n}`)) return `${base}_${n}`;
}

/** Copy a segment's layout under a new id, right after it. Structures get an optional reference to it. */
export function duplicateSegment(schema: FfdSchema, id: string): { schema: FfdSchema; newId: string } {
  const i = schema.segments.findIndex((s) => s.id === id);
  if (i < 0) return { schema, newId: id };
  const newId = uniqueSegmentId(schema, `${id}_copy`);
  const copy: FfdSegment = { ...schema.segments[i], id: newId, name: `${schema.segments[i].name ?? id} (copy)`, values: schema.segments[i].values.map((v) => ({ ...v })) };
  const segments = [...schema.segments];
  segments.splice(i + 1, 0, copy);
  const structures = schema.structures.map((st) => ({ ...st, data: [...st.data, { kind: 'segment' as const, idRef: newId, usage: 'O' as const, max: Infinity }] }));
  return { schema: withForm({ ...schema, segments, structures }), newId };
}

/** Delete a segment and its structure references (empty groups are dropped). */
export function deleteSegment(schema: FfdSchema, id: string): FfdSchema {
  if (schema.segments.length <= 1) return schema;
  return {
    ...schema,
    segments: schema.segments.filter((s) => s.id !== id),
    structures: schema.structures.map((st) => ({ ...st, data: mapItems(st.data, (it) => (it.kind === 'segment' && it.idRef === id ? null : it)) })),
  };
}

/**
 * Copy fields 0..`through` of one segment (a shared header) to every other
 * segment. Target fields inside the header span are replaced; a field that
 * crosses its end is cut to start after it. A copied tag field keeps the target
 * segment's own tag value when the target has a tag at the same position.
 */
export function shareHeader(schema: FfdSchema, fromId: string, through: number): FfdSchema {
  const src = schema.segments.find((s) => s.id === fromId);
  if (!src || through < 0 || through >= src.values.length) return schema;
  const header = src.values.slice(0, through + 1);
  const end = header.reduce((n, v) => n + v.length, 0);
  const headerOffs = fieldOffsets(src);

  return {
    ...schema,
    segments: schema.segments.map((seg) => {
      if (seg.id === fromId || segmentLength(seg) < end) return seg;
      const offs = fieldOffsets(seg);
      const ownTags = new Map(seg.values.map((v, i) => [`${offs[i]}:${v.length}`, v.tagValue] as const).filter(([, t]) => t !== undefined));
      const copied = header.map((v, i) => {
        const c: FfdValue = { ...v };
        if (c.tagValue !== undefined) {
          const own = ownTags.get(`${headerOffs[i]}:${v.length}`);
          if (own !== undefined) c.tagValue = own;
        }
        return c;
      });
      const rest: FfdValue[] = [];
      seg.values.forEach((v, i) => {
        const s = offs[i];
        const e = s + v.length;
        if (e <= end) return;
        if (s >= end) rest.push(v);
        else rest.push({ ...v, length: e - end, tagValue: undefined });
      });
      for (const r of rest) if (r.tagValue === undefined) delete r.tagValue;
      const merged = { ...seg, values: [...copied, ...rest] };
      // keep names unique within the segment
      merged.values = merged.values.map((v, i) => ({ ...v, name: uniqueFieldName({ ...merged, values: merged.values.slice(0, i) }, v.name) }));
      return merged;
    }),
  };
}

// ---------------------------------------------------------------- checks

export interface LayoutProblem {
  segment: string;
  field?: number;
  severity: 'error' | 'warning';
  message: string;
}

export function layoutProblems(schema: FfdSchema): LayoutProblem[] {
  const out: LayoutProblem[] = [];
  const ids = new Set<string>();
  const tags = new Map<string, string>();
  for (const seg of schema.segments) {
    if (ids.has(seg.id)) out.push({ segment: seg.id, severity: 'error', message: `Segment id "${seg.id}" is used twice.` });
    ids.add(seg.id);
    const names = new Map<string, number>();
    const offs = fieldOffsets(seg);
    seg.values.forEach((v, i) => {
      const k = v.name.trim().toLowerCase();
      if (!k) out.push({ segment: seg.id, field: i, severity: 'error', message: `Field ${i + 1} has no name.` });
      else if (names.has(k)) out.push({ segment: seg.id, field: i, severity: 'error', message: `Field name "${v.name}" is used twice in segment ${seg.id}.` });
      names.set(k, i);
      if (v.tagValue !== undefined && v.tagValue.length !== v.length) {
        out.push({ segment: seg.id, field: i, severity: 'warning', message: `Tag value of "${v.name}" is ${v.tagValue.length} characters but the field is ${v.length}.` });
      }
    });
    const tagKey = seg.values
      .map((v, i) => (v.tagValue !== undefined ? `${offs[i]}=${v.tagValue}` : ''))
      .filter(Boolean)
      .join('|');
    if (schema.segments.length > 1) {
      if (!tagKey && seg.tag === undefined) out.push({ segment: seg.id, severity: 'warning', message: `Segment ${seg.id} has no tag field, so its records cannot be told apart from other types.` });
      else if (tagKey && tags.has(tagKey))
        out.push({ segment: seg.id, severity: 'error', message: `Segments ${tags.get(tagKey)} and ${seg.id} have the same tag, so records always match the first.` });
      if (tagKey) tags.set(tagKey, seg.id);
    }
  }
  return out;
}
