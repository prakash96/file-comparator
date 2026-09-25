import { describe, expect, it } from 'vitest';
import { compareDatasets, modifiedDiffColumnsAt, type ComparisonResult } from '../src/comparison/engine';
import { AppError } from '../src/models/issues';
import { ds, opts } from './helpers/dataset';

const FIELDS = ['CUSTOMER_ID', 'NAME', 'STATUS', 'LIMIT'];
const base = () => [
  ['1', 'Alice', 'ACTIVE', '5000'],
  ['2', 'Bob', 'ACTIVE', '7000'],
  ['3', 'Carol', 'CLOSED', '0'],
];

function expectReconciled(r: ComparisonResult) {
  const { reconciliation } = r.summary;
  expect(reconciliation.sourceBalanced).toBe(true);
  expect(reconciliation.targetBalanced).toBe(true);
}

const diffNames = (r: ComparisonResult, i: number) => Array.from(modifiedDiffColumnsAt(r, i)).map((c) => r.comparedPairs[c].name);

describe('comparison engine', () => {
  it('1. identical files are all unchanged', () => {
    const r = compareDatasets(ds(FIELDS, base()), ds(FIELDS, base()), opts({ keyColumns: ['CUSTOMER_ID'] }));
    expect(r.summary.counts).toMatchObject({ added: 0, removed: 0, modified: 0, unchanged: 3, duplicateKeys: 0 });
    expectReconciled(r);
  });

  it('2. detects added records (in target only)', () => {
    const t = [...base(), ['4', 'Dan', 'ACTIVE', '100']];
    const r = compareDatasets(ds(FIELDS, base()), ds(FIELDS, t), opts({ keyColumns: ['CUSTOMER_ID'] }));
    expect(r.summary.counts.added).toBe(1);
    expect(Array.from(r.added)).toEqual([3]);
    expectReconciled(r);
  });

  it('3. detects removed records (in source only)', () => {
    const t = base().slice(1);
    const r = compareDatasets(ds(FIELDS, base()), ds(FIELDS, t), opts({ keyColumns: ['CUSTOMER_ID'] }));
    expect(r.summary.counts.removed).toBe(1);
    expect(Array.from(r.removed)).toEqual([0]);
    expectReconciled(r);
  });

  it('4. detects modified records with exact field differences', () => {
    const t = base();
    t[1] = ['2', 'Bob', 'CLOSED', '7500'];
    const r = compareDatasets(ds(FIELDS, base()), ds(FIELDS, t), opts({ keyColumns: ['CUSTOMER_ID'] }));
    expect(r.summary.counts.modified).toBe(1);
    expect(r.summary.counts.unchanged).toBe(2);
    expect(diffNames(r, 0)).toEqual(['STATUS', 'LIMIT']);
    expect(r.summary.columnStats.find((c) => c.column === 'STATUS')?.differences).toBe(1);
    expectReconciled(r);
  });

  it('5. reports duplicate keys separately and still reconciles', () => {
    const s = [...base(), ['2', 'Bob again', 'ACTIVE', '1']];
    const t = [...base(), ['3', 'Carol dup', 'CLOSED', '0'], ['3', 'Carol dup2', 'CLOSED', '0']];
    const r = compareDatasets(ds(FIELDS, s), ds(FIELDS, t), opts({ keyColumns: ['CUSTOMER_ID'] }));
    const c = r.summary.counts;
    expect(c.duplicateKeys).toBe(2);
    expect(c.duplicateSourceRecords).toBe(3); // two "2"s + one "3"
    expect(c.duplicateTargetRecords).toBe(4); // one "2" + three "3"s
    expect(c.unchanged).toBe(1);
    expectReconciled(r);
  });

  it('6. supports composite keys', () => {
    const F = ['CUSTOMER_ID', 'ACCOUNT_ID', 'BAL'];
    const s = [['1', 'A', '10'], ['1', 'B', '20'], ['2', 'A', '30']];
    const t = [['1', 'A', '10'], ['1', 'B', '25'], ['2', 'B', '30']];
    const r = compareDatasets(ds(F, s), ds(F, t), opts({ keyColumns: ['CUSTOMER_ID', 'ACCOUNT_ID'] }));
    expect(r.summary.counts).toMatchObject({ unchanged: 1, modified: 1, added: 1, removed: 1, duplicateKeys: 0 });
    expectReconciled(r);
  });

  it('7/8. null vs empty string honours the option', () => {
    const F = ['ID', 'V'];
    const s = [['1', null], ['2', '']];
    const t = [['1', ''], ['2', null]];
    const lenient = compareDatasets(ds(F, s), ds(F, t), opts({ keyColumns: ['ID'], nullEqualsEmpty: true }));
    expect(lenient.summary.counts.unchanged).toBe(2);
    const strict = compareDatasets(ds(F, s), ds(F, t), opts({ keyColumns: ['ID'], nullEqualsEmpty: false }));
    expect(strict.summary.counts.modified).toBe(2);
  });

  it('7. null on both sides is equal; empty key values are reported as missing keys', () => {
    const F = ['ID', 'V'];
    const r = compareDatasets(ds(F, [['1', null], [null, 'x']]), ds(F, [['1', null], ['', 'y']]), opts({ keyColumns: ['ID'] }));
    expect(r.summary.counts).toMatchObject({ unchanged: 1, missingKeySource: 1, missingKeyTarget: 1 });
    expectReconciled(r);
  });

  it('9. different column order matches by name', () => {
    const s = ds(['ID', 'A', 'B'], [['1', 'x', 'y']]);
    const t = ds(['B', 'ID', 'A'], [['y', '1', 'x']]);
    const r = compareDatasets(s, t, opts({ keyColumns: ['ID'] }));
    expect(r.summary.counts.unchanged).toBe(1);
    expect(r.summary.schema.orderDiffers).toBe(true);
  });

  it('9. positional matching when column order matters', () => {
    const s = ds(['COL_1', 'COL_2'], [['1', 'x']]);
    const t = ds(['COL_1', 'COL_2'], [['1', 'y']]);
    const r = compareDatasets(s, t, opts({ keyColumns: ['COL_1'], ignoreColumnOrder: false }));
    expect(r.summary.schema.matchedBy).toBe('position');
    expect(r.summary.counts.modified).toBe(1);
  });

  it('10. different column sets: skip, treat as null, or error', () => {
    const s = ds(['ID', 'A', 'ONLY_S'], [['1', 'x', 'q']]);
    const t = ds(['ID', 'A', 'ONLY_T'], [['1', 'x', 'z']]);
    const skip = compareDatasets(s, t, opts({ keyColumns: ['ID'], missingColumns: 'skip' }));
    expect(skip.summary.counts.unchanged).toBe(1);
    expect(skip.summary.skippedColumns).toEqual(['ONLY_S', 'ONLY_T']);
    expect(skip.summary.schema.sourceOnly).toEqual(['ONLY_S']);
    expect(skip.summary.schema.targetOnly).toEqual(['ONLY_T']);

    const asNull = compareDatasets(s, t, opts({ keyColumns: ['ID'], missingColumns: 'null' }));
    expect(asNull.summary.counts.modified).toBe(1);
    expect(diffNames(asNull, 0)).toEqual(['ONLY_S', 'ONLY_T']);

    expect(() => compareDatasets(s, t, opts({ keyColumns: ['ID'], missingColumns: 'error' }))).toThrow(AppError);
  });

  it('10. key column missing from one file gives a clear error', () => {
    const s = ds(['ID', 'A'], [['1', 'x']]);
    const t = ds(['CUST_ID', 'A'], [['1', 'x']]);
    expect(() => compareDatasets(s, t, opts({ keyColumns: ['ID'] }))).toThrow(/missing from the TARGET file/);
  });

  it('11. numeric normalization and tolerance', () => {
    const F = ['ID', 'AMT'];
    const s = [['1', '007.50'], ['2', '100'], ['3', '1.0001'], ['4', '12-']];
    const t = [['1', '7.5'], ['2', '100.00'], ['3', '1.0002'], ['4', '-12.0']];
    const plain = compareDatasets(ds(F, s), ds(F, t), opts({ keyColumns: ['ID'] }));
    expect(plain.summary.counts.modified).toBe(4);
    const numeric = compareDatasets(ds(F, s), ds(F, t), opts({ keyColumns: ['ID'], numericNormalization: true }));
    expect(numeric.summary.counts.modified).toBe(1);
    const tolerant = compareDatasets(ds(F, s), ds(F, t), opts({ keyColumns: ['ID'], numericNormalization: true, numericTolerance: 0.001 }));
    expect(tolerant.summary.counts.modified).toBe(0);
  });

  it('11. numeric normalization also applies to keys (00123 = 123)', () => {
    const F = ['ID', 'V'];
    const r = compareDatasets(ds(F, [['00123', 'a']]), ds(F, [['123', 'a']]), opts({ keyColumns: ['ID'], numericNormalization: true }));
    expect(r.summary.counts.unchanged).toBe(1);
  });

  it('12. date normalization across formats', () => {
    const F = ['ID', 'D'];
    const s = [['1', '2024-01-31'], ['2', '2024-02-01 00:00:00'], ['3', '2024-03-01 10:15:00']];
    const t = [['1', '01/31/2024'], ['2', '20240201'], ['3', '2024-03-01T10:15:00.000']];
    const off = compareDatasets(ds(F, s), ds(F, t), opts({ keyColumns: ['ID'] }));
    expect(off.summary.counts.modified).toBe(3);
    const on = compareDatasets(ds(F, s), ds(F, t), opts({ keyColumns: ['ID'], dateNormalization: true }));
    expect(on.summary.counts.modified).toBe(0);
  });

  it('13. case sensitivity', () => {
    const F = ['ID', 'S'];
    const s = [['a1', 'Active']];
    const t = [['A1', 'ACTIVE']];
    const sensitive = compareDatasets(ds(F, s), ds(F, t), opts({ keyColumns: ['ID'] }));
    expect(sensitive.summary.counts).toMatchObject({ added: 1, removed: 1 });
    const insensitive = compareDatasets(ds(F, s), ds(F, t), opts({ keyColumns: ['ID'], caseSensitive: false }));
    expect(insensitive.summary.counts.unchanged).toBe(1);
  });

  it('14. whitespace trimming', () => {
    const F = ['ID', 'S'];
    const s = [[' 1', 'A  ']];
    const t = [['1 ', '  A']];
    expect(compareDatasets(ds(F, s), ds(F, t), opts({ keyColumns: ['ID'], trimWhitespace: true })).summary.counts.unchanged).toBe(1);
    const noTrim = compareDatasets(ds(F, s), ds(F, t), opts({ keyColumns: ['ID'], trimWhitespace: false }));
    expect(noTrim.summary.counts).toMatchObject({ added: 1, removed: 1 });
  });

  it('ignore columns and compare-only columns', () => {
    const t = base().map((r) => [r[0], r[1].toUpperCase(), r[2], r[3]]);
    const ignored = compareDatasets(ds(FIELDS, base()), ds(FIELDS, t), opts({ keyColumns: ['CUSTOMER_ID'], ignoreColumns: ['NAME'] }));
    expect(ignored.summary.counts.unchanged).toBe(3);
    const only = compareDatasets(ds(FIELDS, base()), ds(FIELDS, t), opts({ keyColumns: ['CUSTOMER_ID'], compareOnlyColumns: ['NAME'] }));
    expect(only.summary.counts.modified).toBe(3);
    expect(only.summary.comparedColumns).toEqual(['NAME']);
  });

  it('column names match case-insensitively by default', () => {
    const s = ds(['id', 'name'], [['1', 'a']]);
    const t = ds(['ID', 'NAME'], [['1', 'a']]);
    expect(compareDatasets(s, t, opts({ keyColumns: ['ID'] })).summary.counts.unchanged).toBe(1);
  });

  it('whole-record comparison when no key is selected (multiset)', () => {
    const F = ['A', 'B'];
    const s = [['1', 'x'], ['1', 'x'], ['2', 'y']];
    const t = [['1', 'x'], ['2', 'y'], ['3', 'z']];
    const r = compareDatasets(ds(F, s), ds(F, t), opts());
    expect(r.summary.mode).toBe('fullRecord');
    expect(r.summary.counts).toMatchObject({ unchanged: 2, removed: 1, added: 1, modified: 0 });
    expectReconciled(r);
  });

  it('15. large dataset: 200k records reconcile and stay fast', () => {
    const n = 200_000;
    const F = ['ID', 'NAME', 'AMT', 'STATUS'];
    const s: string[][] = new Array(n);
    const t: string[][] = [];
    for (let i = 0; i < n; i++) {
      s[i] = [String(i), `name${i}`, String(i * 3), 'A'];
      if (i % 100 === 0) continue; // removed
      const row = [String(i), `name${i}`, String(i * 3), i % 50 === 1 ? 'B' : 'A'];
      t.push(row);
    }
    for (let i = n; i < n + 500; i++) t.push([String(i), `name${i}`, '0', 'A']); // added
    t.push([String(5), 'dup', '0', 'A']); // duplicate key 5
    const started = performance.now();
    const r = compareDatasets(ds(F, s), ds(F, t), opts({ keyColumns: ['ID'] }));
    const elapsed = performance.now() - started;
    const c = r.summary.counts;
    expect(c.removed).toBe(n / 100);
    expect(c.added).toBe(500);
    expect(c.duplicateKeys).toBe(1);
    expect(c.modified).toBe(n / 50); // i % 50 === 1 is never a multiple of 100, and 5 is not ≡ 1 (mod 50)
    expectReconciled(r);
    expect(elapsed).toBeLessThan(10000);
  });
});
