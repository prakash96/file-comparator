import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { ComparatorSession } from '../src/workers/session';
import { defaultParseOptions } from '../src/models/parseOptions';
import { buildExplanationInput, maskValue } from '../src/ai/explanation';
import { REPORTS } from '../src/reports/registry';
import { opts } from './helpers/dataset';

const SOURCE = 'CUSTOMER_ID,NAME,STATUS,LIMIT\n1,Alice,ACTIVE,5000\n2,Bob,ACTIVE,7000\n3,Carol,CLOSED,0\n4,Dan,ACTIVE,100\n4,Dan dup,ACTIVE,100\n';
const TARGET = 'CUSTOMER_ID|STATUS|NAME|LIMIT\n1|ACTIVE|Alice|5000\n2|CLOSED|Bob|7500\n5|ACTIVE|"Eve, Jr"|10\n4|ACTIVE|Dan|100\n';

async function loaded() {
  const s = new ComparatorSession();
  const src = await s.load('source', new Blob([SOURCE]), 'source.csv', defaultParseOptions());
  const tgt = await s.load('target', new Blob([TARGET]), 'target.csv', defaultParseOptions());
  return { s, src, tgt };
}

describe('ComparatorSession (worker host)', () => {
  it('auto-detects formats/delimiters and summarizes each file', async () => {
    const { src, tgt } = await loaded();
    expect(src.format).toBe('delimited');
    expect(src.options.delimited.delimiter).toBe(',');
    expect(tgt.options.delimited.delimiter).toBe('|');
    expect(src.recordCount).toBe(5);
    expect(tgt.fields.map((f) => f.name)).toEqual(['CUSTOMER_ID', 'STATUS', 'NAME', 'LIMIT']);
    expect(src.preview).toHaveLength(5);
  });

  it('compares, reconciles and serves filtered/sorted pages', async () => {
    const { s } = await loaded();
    const sum = s.compare(opts({ keyColumns: ['CUSTOMER_ID'] }));
    expect(sum.counts).toMatchObject({ added: 1, removed: 1, modified: 1, unchanged: 1, duplicateKeys: 1, duplicateSourceRecords: 2, duplicateTargetRecords: 1 });
    expect(sum.reconciliation.sourceBalanced && sum.reconciliation.targetBalanced).toBe(true);
    expect(sum.schema.orderDiffers).toBe(true);

    const mod = s.query({ view: 'modified', offset: 0, limit: 10 });
    expect(mod.rows[0].key).toEqual(['2']);
    expect(mod.rows[0].diffs).toEqual([
      { column: 'STATUS', source: 'ACTIVE', target: 'CLOSED' },
      { column: 'LIMIT', source: '7000', target: '7500' },
    ]);
    expect(s.query({ view: 'modified', offset: 0, limit: 10, changedColumn: 'NAME' }).total).toBe(0);
    expect(s.query({ view: 'modified', offset: 0, limit: 10, changedColumn: 'LIMIT' }).total).toBe(1);

    const added = s.query({ view: 'added', offset: 0, limit: 10 });
    expect(added.rows[0].values).toEqual(['5', 'ACTIVE', 'Eve, Jr', '10']);
    expect(added.rows[0].targetRecord).toBe(3);

    expect(s.query({ view: 'duplicates', offset: 0, limit: 10 }).rows.map((r) => r.side)).toEqual(['source', 'source', 'target']);
    expect(s.query({ view: 'removed', offset: 0, limit: 10, search: '3' }).total).toBe(1);
    expect(s.query({ view: 'removed', offset: 0, limit: 10, search: 'carol' }).total).toBe(0);
    expect(s.query({ view: 'removed', offset: 0, limit: 10, search: 'carol', searchAllColumns: true }).total).toBe(1);

    const sorted = s.query({ view: 'duplicates', offset: 0, limit: 10, sortColumn: 'NAME', sortDir: 'desc' });
    expect(sorted.rows.map((r) => r.values?.[1])).toEqual(['Dan dup', 'Dan', 'Dan']);
  });

  it('generates every report', async () => {
    const { s } = await loaded();
    s.compare(opts({ keyColumns: ['CUSTOMER_ID'] }));
    for (const r of REPORTS) {
      const out = await s.exportReport(r.kind);
      expect(out.blob.size, r.kind).toBeGreaterThan(0);
    }
    const modified = await (await s.exportReport('csv-modified')).blob.text();
    expect(modified.split('\r\n')[0]).toBe('KEY_CUSTOMER_ID,SOURCE_RECORD,TARGET_RECORD,FIELD,SOURCE_VALUE,TARGET_VALUE');
    expect(modified).toContain('2,2,2,STATUS,ACTIVE,CLOSED');
    const added = await (await s.exportReport('csv-added')).blob.text();
    expect(added).toContain('"Eve, Jr"');

    const html = await (await s.exportReport('html')).blob.text();
    expect(html).toContain('<!doctype html>');
    expect(html).not.toMatch(/<script|https?:\/\//i); // offline, no scripts or remote resources

    const json = JSON.parse(await (await s.exportReport('json-summary')).blob.text());
    expect(json.counts.modified).toBe(1);
    expect(JSON.stringify(json)).not.toContain('Alice'); // no record values

    const wb = XLSX.read(new Uint8Array(await (await s.exportReport('excel')).blob.arrayBuffer()), { type: 'array' });
    expect(wb.SheetNames).toEqual(['Summary', 'Added', 'Removed', 'Modified', 'Unchanged', 'Duplicate Keys', 'Column Differences', 'Schema']);
  });

  it('replacing a file invalidates the result; reset clears everything', async () => {
    const { s } = await loaded();
    s.compare(opts({ keyColumns: ['CUSTOMER_ID'] }));
    await s.load('target', new Blob([SOURCE]), 'same.csv', defaultParseOptions());
    expect(() => s.query({ view: 'added', offset: 0, limit: 1 })).toThrow(/Run a comparison/);
    s.reset();
    expect(() => s.compare(opts())).toThrow(/Load both/);
  });

  it('a replaced file cancels the earlier load', async () => {
    const s = new ComparatorSession();
    const big = 'A,B\n' + '1,2\n'.repeat(300000);
    const first = s.load('source', new Blob([big]), 'big.csv', defaultParseOptions());
    const second = s.load('source', new Blob([SOURCE]), 'small.csv', defaultParseOptions());
    await expect(first).rejects.toThrow(/cancelled/);
    expect((await second).recordCount).toBe(5);
  });

  it('AI explanation input contains masked samples only', async () => {
    const { s } = await loaded();
    s.compare(opts({ keyColumns: ['CUSTOMER_ID'] }));
    const cur = s.currentResult()!;
    const input = buildExplanationInput(cur.result, cur.views);
    expect(input.samples[0]).toEqual({ column: 'STATUS', source: 'xxxxxx', target: 'xxxxxx' });
    expect(maskValue('AB-12')).toBe('xx-99');
  });
});
