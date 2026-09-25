import { cellAt, type Dataset, type NormalizedRecord } from '../models/dataset';
import { AppError, IssueCollector } from '../models/issues';
import type { ColumnPair, ComparisonOptions, ComparisonSummary } from '../models/comparison';
import { createNormalizer, createValueComparer, type Normalizer } from '../normalization/normalize';
import { IntArrayBuilder } from '../utils/IntArrayBuilder';
import { buildColumnPlan } from './columnPlan';
import { compareSchemas } from './schemaCompare';

/**
 * Compact comparison result. Records are referenced by index into the source
 * and target datasets - nothing is copied - so a million-row result costs a few
 * typed arrays rather than a million objects.
 */
export interface ComparisonResult {
  summary: ComparisonSummary;
  keyPairs: ColumnPair[];
  comparedPairs: ColumnPair[];
  /** Target record indexes with no matching source key. */
  added: Int32Array;
  /** Source record indexes with no matching target key. */
  removed: Int32Array;
  unchangedSource: Int32Array;
  unchangedTarget: Int32Array;
  modifiedSource: Int32Array;
  modifiedTarget: Int32Array;
  /** Diffs of modified record i are `modifiedDiffColumns[modifiedDiffOffsets[i] .. modifiedDiffOffsets[i+1])`, as indexes into `comparedPairs`. */
  modifiedDiffOffsets: Int32Array;
  modifiedDiffColumns: Int32Array;
  /** Duplicate key groups, flattened: group g covers entries `duplicateGroupOffsets[g] .. [g+1]`. */
  duplicateGroupOffsets: Int32Array;
  /** 0 = source, 1 = target. */
  duplicateSide: Uint8Array;
  duplicateRecord: Int32Array;
  missingKeySource: Int32Array;
  missingKeyTarget: Int32Array;
}

export type ComparisonPhase = 'indexing' | 'comparing' | 'finishing';

export interface ComparisonProgress {
  phase: ComparisonPhase;
  processed: number;
  total: number;
}

export type ProgressCallback = (p: ComparisonProgress) => void;

const PROGRESS_EVERY = 25000;
const KEY_SEP = '\u001f';
const NULL_PART = '\u0000';

const now = () => performance.now();

/**
 * Compare two datasets. Pure function of its inputs - independent of React,
 * workers and file formats - so it is unit-tested directly.
 */
export function compareDatasets(
  source: Dataset,
  target: Dataset,
  options: ComparisonOptions,
  onProgress: ProgressCallback = () => {},
): ComparisonResult {
  const t0 = now();
  const issues = new IssueCollector(10);
  const schema = compareSchemas(source.fields, target.fields, options);
  const plan = buildColumnPlan(schema, options);

  if (source.records.length === 0 && target.records.length === 0) {
    issues.warn('BOTH_EMPTY', 'Both files contain no data records.');
  }
  if (plan.skipped.length) {
    issues.info(
      'COLUMNS_SKIPPED',
      `${plan.skipped.length} column(s) exist in only one file and were not compared: ${plan.skipped.slice(0, 12).join(', ')}${plan.skipped.length > 12 ? ', …' : ''}.`,
    );
  }
  if (schema.typeMismatches.length) {
    issues.info('TYPE_MISMATCH', `Data types differ for: ${schema.typeMismatches.slice(0, 12).join(', ')}. Values are still compared as text after normalization.`);
  }

  const eq = createValueComparer(options);
  const keyNorm = createNormalizer(options);

  const core = plan.keyPairs.length > 0
    ? compareByKey(source.records, target.records, plan.keyPairs, plan.comparedPairs, keyNorm, eq, onProgress)
    : compareFullRecord(source.records, target.records, plan.comparedPairs, keyNorm, onProgress, issues, options);

  onProgress({ phase: 'finishing', processed: 1, total: 1 });

  const counts = {
    sourceTotal: source.records.length,
    targetTotal: target.records.length,
    added: core.added.length,
    removed: core.removed.length,
    modified: core.modifiedSource.length,
    unchanged: core.unchangedSource.length,
    duplicateKeys: core.duplicateGroupOffsets.length - 1,
    duplicateSourceRecords: countSide(core.duplicateSide, 0),
    duplicateTargetRecords: countSide(core.duplicateSide, 1),
    missingKeySource: core.missingKeySource.length,
    missingKeyTarget: core.missingKeyTarget.length,
  };
  const sourceAccounted = counts.removed + counts.modified + counts.unchanged + counts.duplicateSourceRecords + counts.missingKeySource;
  const targetAccounted = counts.added + counts.modified + counts.unchanged + counts.duplicateTargetRecords + counts.missingKeyTarget;

  if (counts.duplicateKeys > 0) {
    issues.warn(
      'DUPLICATE_KEYS',
      `${counts.duplicateKeys.toLocaleString('en-US')} key value(s) occur more than once. Records with these keys are listed under "Duplicate Keys" and are not classified as added, removed or modified.`,
    );
  }
  if (counts.missingKeySource + counts.missingKeyTarget > 0) {
    issues.warn(
      'MISSING_KEY_VALUE',
      `${counts.missingKeySource.toLocaleString('en-US')} source and ${counts.missingKeyTarget.toLocaleString('en-US')} target record(s) have empty key column(s) and could not be matched.`,
    );
  }

  const columnStats = plan.comparedPairs.map((p, i) => ({ column: p.name, differences: core.perColumnDiffs[i] }));
  columnStats.sort((a, b) => b.differences - a.differences);

  const summary: ComparisonSummary = {
    mode: plan.keyPairs.length ? 'key' : 'fullRecord',
    counts,
    reconciliation: {
      sourceAccounted,
      targetAccounted,
      sourceBalanced: sourceAccounted === counts.sourceTotal,
      targetBalanced: targetAccounted === counts.targetTotal,
    },
    keyColumns: plan.keyPairs.map((p) => p.name),
    comparedColumns: plan.comparedPairs.map((p) => p.name),
    skippedColumns: plan.skipped,
    columnStats,
    schema,
    options,
    timing: { indexMs: core.indexMs, compareMs: core.compareMs, totalMs: now() - t0 },
    issues: issues.toArray(),
  };

  return {
    summary,
    keyPairs: plan.keyPairs,
    comparedPairs: plan.comparedPairs,
    added: core.added,
    removed: core.removed,
    unchangedSource: core.unchangedSource,
    unchangedTarget: core.unchangedTarget,
    modifiedSource: core.modifiedSource,
    modifiedTarget: core.modifiedTarget,
    modifiedDiffOffsets: core.modifiedDiffOffsets,
    modifiedDiffColumns: core.modifiedDiffColumns,
    duplicateGroupOffsets: core.duplicateGroupOffsets,
    duplicateSide: core.duplicateSide,
    duplicateRecord: core.duplicateRecord,
    missingKeySource: core.missingKeySource,
    missingKeyTarget: core.missingKeyTarget,
  };
}

function countSide(sides: Uint8Array, side: number): number {
  let n = 0;
  for (let i = 0; i < sides.length; i++) if (sides[i] === side) n++;
  return n;
}

interface CoreResult {
  added: Int32Array;
  removed: Int32Array;
  unchangedSource: Int32Array;
  unchangedTarget: Int32Array;
  modifiedSource: Int32Array;
  modifiedTarget: Int32Array;
  modifiedDiffOffsets: Int32Array;
  modifiedDiffColumns: Int32Array;
  duplicateGroupOffsets: Int32Array;
  duplicateSide: Uint8Array;
  duplicateRecord: Int32Array;
  missingKeySource: Int32Array;
  missingKeyTarget: Int32Array;
  perColumnDiffs: number[];
  indexMs: number;
  compareMs: number;
}

/** Build the lookup key for a record. Returns null when every key part is NULL/empty. */
function makeKeyFn(pairs: ColumnPair[], side: 'source' | 'target', norm: Normalizer): (r: NormalizedRecord) => string | null {
  const idx = pairs.map((p) => (side === 'source' ? p.sourceIndex : p.targetIndex));
  if (idx.length === 1) {
    const i0 = idx[0];
    return (r) => {
      const v = norm(cellAt(r, i0));
      return v === null ? null : v;
    };
  }
  return (r) => {
    let allNull = true;
    let key = '';
    for (let i = 0; i < idx.length; i++) {
      const v = norm(cellAt(r, idx[i]));
      if (v !== null) allNull = false;
      key += (i ? KEY_SEP : '') + (v === null ? NULL_PART : v);
    }
    return allNull ? null : key;
  };
}

interface KeyIndex {
  keys: (string | null)[];
  first: Map<string, number>;
  /** Additional occurrences for keys seen more than once. */
  extra: Map<string, number[]>;
  missing: IntArrayBuilder;
}

function indexRecords(
  records: NormalizedRecord[],
  keyFn: (r: NormalizedRecord) => string | null,
  onProgress: ProgressCallback,
  offset: number,
  total: number,
): KeyIndex {
  const keys: (string | null)[] = new Array(records.length);
  const first = new Map<string, number>();
  const extra = new Map<string, number[]>();
  const missing = new IntArrayBuilder();
  for (let i = 0; i < records.length; i++) {
    const k = keyFn(records[i]);
    keys[i] = k;
    if (k === null) {
      missing.push(i);
    } else if (!first.has(k)) {
      first.set(k, i);
    } else {
      const list = extra.get(k);
      if (list) list.push(i);
      else extra.set(k, [i]);
    }
    if (i % PROGRESS_EVERY === 0) onProgress({ phase: 'indexing', processed: offset + i, total });
  }
  return { keys, first, extra, missing };
}

function compareByKey(
  src: NormalizedRecord[],
  tgt: NormalizedRecord[],
  keyPairs: ColumnPair[],
  compared: ColumnPair[],
  norm: Normalizer,
  eq: (a: string | null, b: string | null) => boolean,
  onProgress: ProgressCallback,
): CoreResult {
  const t0 = now();
  const indexTotal = src.length + tgt.length;
  const s = indexRecords(src, makeKeyFn(keyPairs, 'source', norm), onProgress, 0, indexTotal);
  const t = indexRecords(tgt, makeKeyFn(keyPairs, 'target', norm), onProgress, src.length, indexTotal);
  const indexMs = now() - t0;

  // Duplicate groups: every record of a key that repeats in either file.
  const dupKeys = new Set<string>([...s.extra.keys(), ...t.extra.keys()]);
  const groupOffsets = new IntArrayBuilder();
  const dupSide: number[] = [];
  const dupRecord = new IntArrayBuilder();
  const addGroupSide = (ix: KeyIndex, k: string, side: number) => {
    const f = ix.first.get(k);
    if (f === undefined) return;
    dupSide.push(side);
    dupRecord.push(f);
    for (const r of ix.extra.get(k) ?? []) {
      dupSide.push(side);
      dupRecord.push(r);
    }
  };
  for (const k of dupKeys) {
    groupOffsets.push(dupRecord.length);
    addGroupSide(s, k, 0);
    addGroupSide(t, k, 1);
  }
  groupOffsets.push(dupRecord.length);

  const tc = now();
  const added = new IntArrayBuilder();
  const removed = new IntArrayBuilder();
  const unchangedS = new IntArrayBuilder(Math.min(src.length, tgt.length) + 16);
  const unchangedT = new IntArrayBuilder(Math.min(src.length, tgt.length) + 16);
  const modS = new IntArrayBuilder();
  const modT = new IntArrayBuilder();
  const diffOffsets = new IntArrayBuilder();
  const diffCols = new IntArrayBuilder();
  const perColumn = new Array<number>(compared.length).fill(0);
  const total = tgt.length + src.length;

  diffOffsets.push(0);
  for (let ti = 0; ti < tgt.length; ti++) {
    const k = t.keys[ti];
    if (ti % PROGRESS_EVERY === 0) onProgress({ phase: 'comparing', processed: ti, total });
    if (k === null || dupKeys.has(k)) continue;
    const si = s.first.get(k);
    if (si === undefined) {
      added.push(ti);
      continue;
    }
    const sr = src[si];
    const tr = tgt[ti];
    const before = diffCols.length;
    for (let c = 0; c < compared.length; c++) {
      const p = compared[c];
      if (!eq(cellAt(sr, p.sourceIndex), cellAt(tr, p.targetIndex))) {
        diffCols.push(c);
        perColumn[c]++;
      }
    }
    if (diffCols.length === before) {
      unchangedS.push(si);
      unchangedT.push(ti);
    } else {
      modS.push(si);
      modT.push(ti);
      diffOffsets.push(diffCols.length);
    }
  }
  for (let si = 0; si < src.length; si++) {
    const k = s.keys[si];
    if (si % PROGRESS_EVERY === 0) onProgress({ phase: 'comparing', processed: tgt.length + si, total });
    if (k === null || dupKeys.has(k)) continue;
    if (!t.first.has(k)) removed.push(si);
  }
  return {
    added: added.finish(),
    removed: removed.finish(),
    unchangedSource: unchangedS.finish(),
    unchangedTarget: unchangedT.finish(),
    modifiedSource: modS.finish(),
    modifiedTarget: modT.finish(),
    modifiedDiffOffsets: diffOffsets.finish(),
    modifiedDiffColumns: diffCols.finish(),
    duplicateGroupOffsets: groupOffsets.finish(),
    duplicateSide: Uint8Array.from(dupSide),
    duplicateRecord: dupRecord.finish(),
    missingKeySource: s.missing.finish(),
    missingKeyTarget: t.missing.finish(),
    perColumnDiffs: perColumn,
    indexMs,
    compareMs: now() - tc,
  };
}

/**
 * No key selected: records are compared as whole rows (multiset semantics).
 * Identical rows pair up as unchanged; everything else is added or removed.
 * "Modified" cannot be determined without a key, and numeric tolerance does
 * not apply because rows are matched by their normalized signature.
 */
function compareFullRecord(
  src: NormalizedRecord[],
  tgt: NormalizedRecord[],
  compared: ColumnPair[],
  norm: Normalizer,
  onProgress: ProgressCallback,
  issues: IssueCollector,
  options: ComparisonOptions,
): CoreResult {
  if (compared.length === 0) throw new AppError('NO_COLUMNS', 'There are no columns to compare.');
  if (options.numericTolerance > 0) {
    issues.info('TOLERANCE_IGNORED', 'Numeric tolerance is not applied when no key column is selected (records are matched as whole rows).');
  }
  issues.info('NO_KEY', 'No key column selected: records were matched as whole rows. Select key column(s) to detect modified records and duplicate keys.');

  const sig = (r: NormalizedRecord, side: 'source' | 'target') => {
    let out = '';
    for (let c = 0; c < compared.length; c++) {
      const v = norm(cellAt(r, side === 'source' ? compared[c].sourceIndex : compared[c].targetIndex));
      out += (c ? KEY_SEP : '') + (v === null ? NULL_PART : v);
    }
    return out;
  };

  const t0 = now();
  const total = src.length + tgt.length;
  // signature -> source record index, or a list when the same row occurs several times
  const pool = new Map<string, number | number[]>();
  for (let i = 0; i < src.length; i++) {
    const k = sig(src[i], 'source');
    const cur = pool.get(k);
    if (cur === undefined) pool.set(k, i);
    else if (typeof cur === 'number') pool.set(k, [cur, i]);
    else cur.push(i);
    if (i % PROGRESS_EVERY === 0) onProgress({ phase: 'indexing', processed: i, total });
  }
  const indexMs = now() - t0;

  const tc = now();
  const matched = new Uint8Array(src.length);
  const added = new IntArrayBuilder();
  const unchangedS = new IntArrayBuilder();
  const unchangedT = new IntArrayBuilder();
  const cursor = new Map<string, number>();
  for (let ti = 0; ti < tgt.length; ti++) {
    if (ti % PROGRESS_EVERY === 0) onProgress({ phase: 'comparing', processed: src.length + ti, total });
    const k = sig(tgt[ti], 'target');
    const cur = pool.get(k);
    let si = -1;
    if (typeof cur === 'number') {
      si = cur;
      pool.delete(k);
    } else if (cur) {
      const pos = cursor.get(k) ?? 0;
      if (pos < cur.length) {
        si = cur[pos];
        cursor.set(k, pos + 1);
      }
    }
    if (si < 0) {
      added.push(ti);
    } else {
      matched[si] = 1;
      unchangedS.push(si);
      unchangedT.push(ti);
    }
  }
  const removed = new IntArrayBuilder();
  for (let si = 0; si < src.length; si++) if (!matched[si]) removed.push(si);

  return {
    added: added.finish(),
    removed: removed.finish(),
    unchangedSource: unchangedS.finish(),
    unchangedTarget: unchangedT.finish(),
    modifiedSource: new Int32Array(0),
    modifiedTarget: new Int32Array(0),
    modifiedDiffOffsets: Int32Array.of(0),
    modifiedDiffColumns: new Int32Array(0),
    duplicateGroupOffsets: Int32Array.of(0),
    duplicateSide: new Uint8Array(0),
    duplicateRecord: new Int32Array(0),
    missingKeySource: new Int32Array(0),
    missingKeyTarget: new Int32Array(0),
    perColumnDiffs: new Array<number>(compared.length).fill(0),
    indexMs,
    compareMs: now() - tc,
  };
}

/** Differences of the i-th modified record as compared-column indexes. */
export function modifiedDiffColumnsAt(result: ComparisonResult, i: number): Int32Array {
  return result.modifiedDiffColumns.subarray(result.modifiedDiffOffsets[i], result.modifiedDiffOffsets[i + 1]);
}
