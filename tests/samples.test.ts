import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultParseOptions, type ParseOptions } from '../src/models/parseOptions';
import { ComparatorSession } from '../src/workers/session';
import { opts } from './helpers/dataset';

const dir = join(__dirname, '..', 'samples');
const blob = (name: string) => new Blob([readFileSync(join(dir, name))]);
const layout = JSON.parse(readFileSync(join(dir, 'fixed-width-layout.json'), 'utf8'));

/** Expected result for every sample pair (see scripts/generate-samples.ts). */
const EXPECTED = { sourceTotal: 21, targetTotal: 21, added: 2, removed: 2, modified: 5, unchanged: 11, duplicateKeys: 2 };

async function run(src: string, tgt: string, key: string, parse: Partial<ParseOptions> = {}, extra = {}) {
  const s = new ComparatorSession();
  const o = { ...defaultParseOptions(), ...parse };
  await s.load('source', blob(src), src, o);
  await s.load('target', blob(tgt), tgt, o);
  return s.compare(opts({ keyColumns: [key], ...extra }));
}

describe('sample files (end-to-end through the worker session)', () => {
  const cases: [string, string, string, string, Partial<ParseOptions>?][] = [
    ['CSV', 'source.csv', 'target.csv', 'CUSTOMER_ID'],
    ['JSON', 'source.json', 'target.json', 'CUSTOMER_ID'],
    ['XML', 'source.xml', 'target.xml', '@id'],
    ['Fixed-width', 'source-fixed.txt', 'target-fixed.txt', 'CUSTOMER_ID', { format: 'fixedwidth', fixedWidth: layout }],
    ['Excel', 'source.xlsx', 'target.xlsx', 'CUSTOMER_ID', { excel: { sheet: 'Customers', hasHeader: true, headerRow: 1 } }],
    ['Avro', 'source.avro', 'target.avro', 'CUSTOMER_ID'],
    ['Parquet', 'source.parquet', 'target.parquet', 'CUSTOMER_ID'],
  ];
  for (const [name, src, tgt, key, parse] of cases) {
    it(`${name}: every category is found and counts reconcile`, async () => {
      const sum = await run(src, tgt, key, parse);
      expect(sum.counts).toMatchObject(EXPECTED);
      expect(sum.reconciliation.sourceBalanced && sum.reconciliation.targetBalanced).toBe(true);
    });
  }

  it('cross-format: CSV source vs Parquet target with numeric normalization', async () => {
    const s = new ComparatorSession();
    await s.load('source', blob('source.csv'), 'source.csv', defaultParseOptions());
    await s.load('target', blob('target.parquet'), 'target.parquet', defaultParseOptions());
    const plain = s.compare(opts({ keyColumns: ['CUSTOMER_ID'] }));
    expect(plain.counts.modified).toBeGreaterThan(EXPECTED.modified); // 6250.00 vs 6250
    const numeric = s.compare(opts({ keyColumns: ['CUSTOMER_ID'], numericNormalization: true }));
    expect(numeric.counts).toMatchObject(EXPECTED);
  });

  it('cross-format: CSV vs JSON reports nested vs flattened schema difference', async () => {
    const s = new ComparatorSession();
    await s.load('source', blob('source.csv'), 'source.csv', defaultParseOptions());
    await s.load('target', blob('target.json'), 'target.json', defaultParseOptions());
    const sum = s.compare(opts({ keyColumns: ['CUSTOMER_ID'], numericNormalization: true }));
    expect(sum.schema.sourceOnly).toEqual(['CITY']);
    expect(sum.schema.targetOnly).toEqual(['ADDRESS.CITY']);
  });
});
