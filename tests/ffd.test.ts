import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyFfd, defaultApplyOptions } from '../src/ffd/applyFfd';
import { FfdError, parseFfd, stringifyFfd } from '../src/ffd/ffdYaml';
import { defaultInferOptions, inferFfd } from '../src/ffd/inferFfd';
import type { FfdSchema } from '../src/ffd/model';

const SAMPLE_FFD = readFileSync(new URL('../samples/ffdschema.ffd', import.meta.url), 'utf8');

/** Build records for a segment: tag value, then short values that leave padding blanks. */
function record(schema: FfdSchema, id: string, n: number): string {
  const seg = schema.segments.find((s) => s.id === id)!;
  return seg.values
    .map((v, i) => {
      if (v.tagValue !== undefined) return v.tagValue;
      const text = `${v.name.slice(0, 3).toUpperCase()}${n}${i}`.slice(0, Math.max(0, v.length - 1));
      return text.padEnd(v.length);
    })
    .join('');
}

describe('FFD schema', () => {
  it('parses the sample FFD (flow maps, quoted tags, groups, counts)', () => {
    const s = parseFfd(SAMPLE_FFD);
    expect(s.form).toBe('FLATFILE');
    expect(s.segments.map((x) => x.id)).toEqual(['0630', '0461', '0246', '0941', '0179', '0165', '0174']);
    expect(s.segments[0].values[0]).toEqual({ name: 'MSGLength', type: 'String', length: 5, tagValue: ' 0630' });
    expect(s.segments[0].values.reduce((n, v) => n + v.length, 0)).toBe(635);
    const [batch, ...rest] = s.structures[0].data;
    expect(batch).toMatchObject({ kind: 'group', groupId: 'Batch', usage: 'O', max: Infinity });
    expect(rest).toHaveLength(6);
  });

  it('round-trips through stringify', () => {
    const s = parseFfd(SAMPLE_FFD);
    expect(parseFfd(stringifyFfd(s))).toEqual(s);
  });

  it('reports every problem in a broken FFD', () => {
    const bad = "form: FLATFILE\nstructures:\n- id: 'S'\n  data:\n  - { idRef: 'X' }\nsegments:\n- id: 'A'\n  values:\n  - { name: 'a', type: Strin, length: 0 }\n";
    try {
      parseFfd(bad);
      expect.fail('should throw');
    } catch (e) {
      expect(e).toBeInstanceOf(FfdError);
      const p = (e as FfdError).problems.join('\n');
      expect(p).toMatch(/length must be/);
      expect(p).toMatch(/unknown type "Strin"/);
      expect(p).toMatch(/idRef "X"/);
    }
    expect(() => parseFfd('form: [')).toThrow(/not valid YAML \(line 1/);
  });
});

describe('apply FFD', () => {
  const schema = parseFfd(SAMPLE_FFD);
  const ids = ['0630', '0630', '0630', '0461', '0246', '0941', '0179', '0165', '0174'];
  const recs = ids.map((id, i) => record(schema, id, i));

  it('reads one record per line and groups them by the structure', () => {
    const r = applyFfd(recs.join('\n') + '\n', schema, defaultApplyOptions(schema));
    expect(r.mode).toBe('lines');
    expect(r.issues).toEqual([]);
    expect(r.segmentCounts['0630']).toBe(3);
    const out = r.output as Record<string, any>;
    expect(out.Batch).toHaveLength(3);
    expect(out.Batch[0]['0630'].MSGLength).toBe('0630');
    expect(out.Batch[0]['0630'].BranchCode).toBe('BRA0');
    expect(out['0461'].MoreData).toBe('');
    expect(Object.keys(out)).toEqual(['Batch', '0461', '0246', '0941', '0179', '0165', '0174']);
  });

  it('reads back-to-back records without line breaks', () => {
    const r = applyFfd(recs.join(''), schema, { ...defaultApplyOptions(schema), trim: false });
    expect(r.mode).toBe('stream');
    expect(r.records).toHaveLength(9);
    expect(r.records[3].values.MSGLength).toBe(' 0461');
  });

  it('lists records without a structure and flags records that do not fit', () => {
    const list = applyFfd(recs.join('\n'), schema, { ...defaultApplyOptions(schema), structureId: '' });
    expect(Array.isArray(list.output)).toBe(true);
    const odd = applyFfd([recs[3], recs[0], 'XXXXX bad line'].join('\n'), schema, defaultApplyOptions(schema));
    const codes = odd.issues.map((i) => i.code);
    expect(codes).toContain('FFD_UNKNOWN_RECORD');
    expect(codes).toContain('FFD_UNMATCHED');
    expect((odd.output as Record<string, any>)._unmatched[0].segment).toBe('0630');
  });

  it('converts Integer / Decimal (implicit decimals) values', () => {
    const s = parseFfd("form: FIXEDWIDTH\nid: 'R'\nvalues:\n- { name: 'n', type: Integer, length: 4 }\n- { name: 'd', type: Decimal, length: 6, format: { implicit: 2 } }\n- { name: 'big', type: Integer, length: 20 }\n");
    const r = applyFfd('0042 1234512345678901234567890\n', s, defaultApplyOptions(s));
    expect(r.records[0].values).toEqual({ n: 42, d: 123.45, big: '12345678901234567890' });
  });
});

describe('generate FFD from text', () => {
  const schema = parseFfd(SAMPLE_FFD);
  const ids = ['0630', '0630', '0630', '0630', '0461', '0246', '0630', '0941', '0179', '0165', '0174'];
  const recs = ids.map((id, i) => record(schema, id, i));

  it('detects the length-prefix tag and each record type, and the result reads the sample cleanly', () => {
    const { schema: gen, report, issues } = inferFfd(recs.join('\n'), defaultInferOptions());
    expect(report.tag).toMatchObject({ start: 0, length: 5, lengthPrefix: true });
    expect(gen.form).toBe('FLATFILE');
    expect(gen.segments.map((s) => s.id)).toEqual(['0630', '0461', '0246', '0941', '0179', '0165', '0174']);
    for (const s of gen.segments) {
      const original = schema.segments.find((o) => o.id === s.id)!;
      expect(s.values.reduce((n, v) => n + v.length, 0)).toBe(original.values.reduce((n, v) => n + v.length, 0));
      expect(s.values[0].tagValue).toBe(original.values[0].tagValue);
    }
    // 0630 recurs after 0461/0246, so the three form a repeating group.
    expect(gen.structures[0].data[0]).toMatchObject({ kind: 'group', max: Infinity });
    expect(issues.filter((i) => i.severity !== 'info')).toEqual([]);

    const yaml = stringifyFfd(gen);
    const applied = applyFfd(recs.join('\n'), parseFfd(yaml), defaultApplyOptions(gen));
    expect(applied.issues).toEqual([]);
    expect(applied.records).toHaveLength(ids.length);
  });

  it('splits a single-line length-prefixed stream', () => {
    const { report } = inferFfd(recs.join(''), defaultInferOptions());
    expect(report.mode).toBe('length-prefixed stream');
    expect(report.recordCount).toBe(ids.length);
  });

  it('finds a short record-type code and blank-separated fields', () => {
    const text = ['HDR 20260628 STORE839', 'DTL 00001 ITEM-A     10.50', 'DTL 00002 ITEM-B      9.00', 'TRL 2'].join('\n');
    const { schema: gen, report } = inferFfd(text, { ...defaultInferOptions(), inferTypes: true });
    expect(report.tag).toMatchObject({ start: 0, length: 3 });
    const dtl = gen.segments.find((s) => s.id === 'DTL')!;
    expect(dtl.values.map((v) => v.length)).toEqual([3, 7, 11, 5]);
    expect(dtl.values.find((v) => v.type === 'Decimal')).toBeTruthy();
    expect(gen.structures[0].data.map((i) => (i.kind === 'segment' ? `${i.idRef}${i.max > 1 ? '*' : ''}` : 'group'))).toEqual(['HDR', 'DTL*', 'TRL']);
  });

  it('treats equal-length records as one FIXEDWIDTH type unless a tag is given', () => {
    const text = 'AAAA  0001\nBBBB  0002\nCCCC  0003\n';
    expect(inferFfd(text, defaultInferOptions()).schema.form).toBe('FIXEDWIDTH');
    const tagged = inferFfd(text, { ...defaultInferOptions(), tagStart: 0, tagLength: 4 });
    expect(tagged.schema.segments).toHaveLength(3);
  });
});
