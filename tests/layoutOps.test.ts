import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseFfd, stringifyFfd } from '../src/ffd/ffdYaml';
import {
  addField,
  deleteSegment,
  duplicateSegment,
  fieldAt,
  fieldOffsets,
  fitLength,
  layoutProblems,
  mergeWithNext,
  moveBoundary,
  removeField,
  renameSegment,
  setFieldLength,
  shareHeader,
  splitAt,
  updateField,
} from '../src/ffd/layoutOps';
import { segmentLength, type FfdSegment } from '../src/ffd/model';

const seg = (lens: number[], tagAt = -1, tag = ''): FfdSegment => ({
  id: 'S',
  values: lens.map((length, i) => ({ name: `F${i + 1}`, type: 'String', length, ...(i === tagAt ? { tagValue: tag } : {}) })),
});
const lens = (s: FfdSegment) => s.values.map((v) => v.length);

describe('field operations', () => {
  it('finds fields by column', () => {
    const s = seg([5, 3, 2]);
    expect(fieldOffsets(s)).toEqual([0, 5, 8]);
    expect([0, 4, 5, 9, 10].map((c) => fieldAt(s, c))).toEqual([0, 0, 1, 2, -1]);
  });

  it('splits a field at a column and keeps the total length', () => {
    const s = splitAt(seg([10, 5]), 4);
    expect(lens(s)).toEqual([4, 6, 5]);
    expect(s.values[1].name).toBe('F1_2');
    expect(splitAt(s, 4)).toBe(s); // already a boundary
    expect(splitAt(s, 0)).toBe(s);
  });

  it('cuts a tag value when its field is split', () => {
    expect(splitAt(seg([5], 0, ' 0630'), 3).values[0].tagValue).toBe(' 06');
  });

  it('moves boundaries within the neighbours only', () => {
    const s = seg([5, 5, 5]);
    expect(lens(moveBoundary(s, 1, 7))).toEqual([7, 3, 5]);
    expect(lens(moveBoundary(s, 1, 100))).toEqual([9, 1, 5]); // clamped
    expect(lens(moveBoundary(s, 1, -3))).toEqual([1, 9, 5]);
    expect(moveBoundary(s, 0, 3)).toBe(s);
  });

  it('merges, removes, resizes and adds fields', () => {
    const s = seg([2, 3, 4]);
    expect(lens(mergeWithNext(s, 0))).toEqual([5, 4]);
    expect(mergeWithNext(s, 2)).toBe(s);
    expect(lens(removeField(s, 1))).toEqual([2, 4]);
    expect(lens(setFieldLength(s, 1, 10))).toEqual([2, 10, 4]);
    expect(lens(setFieldLength(s, 1, 0))).toEqual([2, 1, 4]);
    expect(addField(s, 3).values[3]).toMatchObject({ name: 'Field4', length: 3 });
    expect(updateField(s, 0, { tagValue: 'AB' }).values[0].tagValue).toBe('AB');
    expect('tagValue' in updateField(updateField(s, 0, { tagValue: 'AB' }), 0, { tagValue: undefined }).values[0]).toBe(false);
  });

  it('fits a record to a length by growing or trimming the end', () => {
    expect(lens(fitLength(seg([5, 5]), 14))).toEqual([5, 9]);
    expect(lens(fitLength(seg([5, 5, 5]), 7))).toEqual([5, 2]);
  });
});

describe('segment operations', () => {
  const schema = parseFfd(readFileSync(new URL('../samples/ffdschema.ffd', import.meta.url), 'utf8'));

  it('renames a segment and its structure references', () => {
    const r = renameSegment(schema, '0630', 'TXN');
    expect(r.segments[0].id).toBe('TXN');
    expect(stringifyFfd(r)).toContain("idRef: 'TXN'");
    expect(renameSegment(schema, '0630', '0461')).toBe(schema); // taken
  });

  it('duplicates and deletes segments, keeping structures valid', () => {
    const { schema: d, newId } = duplicateSegment(schema, '0941');
    expect(newId).toBe('0941_copy');
    expect(d.segments.map((s) => s.id)).toContain('0941_copy');
    const del = deleteSegment(schema, '0630');
    expect(del.segments).toHaveLength(6);
    // The Batch group only held 0630, so it disappears.
    expect(del.structures[0].data.some((i) => i.kind === 'group')).toBe(false);
    expect(() => parseFfd(stringifyFfd(del))).not.toThrow();
  });

  it('shares a header across segments, keeping each segment its own tag and total length', () => {
    // 0630's first 9 fields (135 characters) are the common header in the sample FFD.
    const base = schema.segments.map((s) => (s.id === '0630' ? s : { ...s, values: [s.values[0], { name: 'Rest', type: 'String' as const, length: segmentLength(s) - 5 }] }));
    const shared = shareHeader({ ...schema, segments: base }, '0630', 8);
    for (const s of shared.segments) {
      const original = schema.segments.find((o) => o.id === s.id)!;
      expect(segmentLength(s)).toBe(segmentLength(original));
      expect(s.values[0].tagValue).toBe(original.values[0].tagValue);
      expect(s.values.slice(0, 9).map((v) => v.name)).toEqual(['MSGLength', 'RespData1', 'BranchCode', 'RespData2', 'TellerID', 'TranCode', 'RespData3', 'FEJNO', 'RespCode']);
    }
    expect(shared.segments[1].values[9]).toMatchObject({ name: 'Rest', length: 466 - 135 });
  });

  it('flags duplicate names, duplicate tags and tag length mismatches', () => {
    const bad = { ...schema, segments: [schema.segments[0], { ...schema.segments[1], values: [{ ...schema.segments[1].values[0], tagValue: ' 0630' }, ...schema.segments[1].values.slice(1)] }] };
    expect(layoutProblems(bad).map((p) => p.message).join('\n')).toMatch(/same tag/);
    const dupName = { ...schema, segments: [{ ...schema.segments[0], values: [...schema.segments[0].values, { ...schema.segments[0].values[1] }] }] };
    expect(layoutProblems(dupName).some((p) => /used twice/.test(p.message))).toBe(true);
    const tagLen = { ...schema, segments: [updateField(schema.segments[0], 0, { tagValue: '0630' })] };
    expect(layoutProblems(tagLen).some((p) => /Tag value/.test(p.message))).toBe(true);
    expect(layoutProblems(schema)).toEqual([]);
  });
});
