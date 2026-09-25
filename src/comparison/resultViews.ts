import { cellAt, type CellValue, type Dataset } from '../models/dataset';
import type { ColumnPair } from '../models/comparison';
import { SORT_CHANGES, SORT_RECORD, type ResultView, type ViewPage, type ViewQuery, type ViewRow } from '../models/views';
import { modifiedDiffColumnsAt, type ComparisonResult } from './engine';

type Side = 'source' | 'target';

interface ViewSpec {
  size: number;
  columns: string[];
  /** Materialize entry i of the view. */
  row(i: number): ViewRow;
  /** Text used for key search. */
  keyText(i: number): string;
  /** Text used for all-column search. */
  allText(i: number): string;
  /** Value used to sort by a column. */
  sortValue(i: number, column: string): CellValue | number;
}

const MAX_CACHED_FILTERS = 12;

/**
 * Serves paged, filtered and sorted slices of a comparison result. Lives next to
 * the datasets (in the worker) so the UI only ever receives the rows on screen.
 * Filter/sort results are cached as compact Int32Arrays.
 */
export class ResultViews {
  private readonly specs = new Map<ResultView, ViewSpec>();
  private readonly cache = new Map<string, Int32Array>();
  readonly keyColumns: string[];

  constructor(
    readonly result: ComparisonResult,
    readonly source: Dataset,
    readonly target: Dataset,
  ) {
    this.keyColumns = result.keyPairs.map((p) => p.name);
  }

  private keyOf(side: Side, recordIndex: number): CellValue[] {
    const rec = (side === 'source' ? this.source : this.target).records[recordIndex];
    return this.result.keyPairs.map((p) => cellAt(rec, side === 'source' ? p.sourceIndex : p.targetIndex));
  }

  private recordValues(side: Side, recordIndex: number): CellValue[] {
    const ds = side === 'source' ? this.source : this.target;
    const rec = ds.records[recordIndex];
    return ds.fields.map((_, i) => cellAt(rec, i));
  }

  /** Union of both files' columns (schema order) with their positions on each side. */
  private unionColumns(): ColumnPair[] {
    return this.result.summary.schema.fields.map((f) => ({ name: f.name, sourceIndex: f.sourceIndex, targetIndex: f.targetIndex }));
  }

  spec(view: ResultView): ViewSpec {
    let s = this.specs.get(view);
    if (!s) {
      s = this.buildSpec(view);
      this.specs.set(view, s);
    }
    return s;
  }

  private simpleSpec(side: Side, indexes: Int32Array, extra?: (i: number) => Partial<ViewRow>): ViewSpec {
    const ds = side === 'source' ? this.source : this.target;
    const keyIdx = this.result.keyPairs.map((p) => (side === 'source' ? p.sourceIndex : p.targetIndex));
    const colIndex = new Map(ds.fields.map((f, i) => [f.name, i]));
    return {
      size: indexes.length,
      columns: ds.fields.map((f) => f.name),
      row: (i) => {
        const r = indexes[i];
        return {
          id: i,
          key: this.keyOf(side, r),
          [side === 'source' ? 'sourceRecord' : 'targetRecord']: r + 1,
          side,
          values: this.recordValues(side, r),
          ...extra?.(i),
        };
      },
      keyText: (i) => keyIdx.map((k) => cellAt(ds.records[indexes[i]], k) ?? '').join('\u0001'),
      allText: (i) => ds.records[indexes[i]].map((v) => v ?? '').join('\u0001'),
      sortValue: (i, column) => (column === SORT_RECORD ? indexes[i] : cellAt(ds.records[indexes[i]], colIndex.get(column) ?? -1)),
    };
  }

  private buildSpec(view: ResultView): ViewSpec {
    const r = this.result;
    switch (view) {
      case 'added':
        return this.simpleSpec('target', r.added);
      case 'removed':
        return this.simpleSpec('source', r.removed);
      case 'unchanged':
        return this.simpleSpec('source', r.unchangedSource, (i) => ({ targetRecord: r.unchangedTarget[i] + 1, side: undefined }));
      case 'missingKey': {
        const ns = r.missingKeySource.length;
        const union = this.unionColumns();
        const entry = (i: number): [Side, number] => (i < ns ? ['source', r.missingKeySource[i]] : ['target', r.missingKeyTarget[i - ns]]);
        return this.unionSpec(ns + r.missingKeyTarget.length, union, entry, () => ({}));
      }
      case 'duplicates': {
        const union = this.unionColumns();
        const groupOf = new Int32Array(r.duplicateRecord.length);
        for (let g = 0; g + 1 < r.duplicateGroupOffsets.length; g++) {
          for (let e = r.duplicateGroupOffsets[g]; e < r.duplicateGroupOffsets[g + 1]; e++) groupOf[e] = g;
        }
        const entry = (i: number): [Side, number] => [r.duplicateSide[i] === 0 ? 'source' : 'target', r.duplicateRecord[i]];
        return this.unionSpec(r.duplicateRecord.length, union, entry, (i) => ({ group: groupOf[i] + 1 }));
      }
      case 'modified': {
        const pairs = r.comparedPairs;
        const sKey = r.keyPairs.map((p) => p.sourceIndex);
        return {
          size: r.modifiedSource.length,
          columns: [],
          row: (i) => {
            const s = r.modifiedSource[i];
            const t = r.modifiedTarget[i];
            const sr = this.source.records[s];
            const tr = this.target.records[t];
            return {
              id: i,
              key: this.keyOf('source', s),
              sourceRecord: s + 1,
              targetRecord: t + 1,
              diffs: Array.from(modifiedDiffColumnsAt(r, i), (c) => ({
                column: pairs[c].name,
                source: cellAt(sr, pairs[c].sourceIndex),
                target: cellAt(tr, pairs[c].targetIndex),
              })),
            };
          },
          keyText: (i) => sKey.map((k) => cellAt(this.source.records[r.modifiedSource[i]], k) ?? '').join('\u0001'),
          allText: (i) => {
            const sr = this.source.records[r.modifiedSource[i]];
            const tr = this.target.records[r.modifiedTarget[i]];
            return `${sr.map((v) => v ?? '').join('\u0001')}\u0001${tr.map((v) => v ?? '').join('\u0001')}`;
          },
          sortValue: (i, column) => {
            if (column === SORT_RECORD) return r.modifiedTarget[i];
            if (column === SORT_CHANGES) return r.modifiedDiffOffsets[i + 1] - r.modifiedDiffOffsets[i];
            const k = r.keyPairs.find((p) => p.name === column);
            return k ? cellAt(this.source.records[r.modifiedSource[i]], k.sourceIndex) : null;
          },
        };
      }
    }
  }

  private unionSpec(size: number, union: ColumnPair[], entry: (i: number) => [Side, number], extra: (i: number) => Partial<ViewRow>): ViewSpec {
    const value = (side: Side, rec: number, col: ColumnPair) =>
      cellAt((side === 'source' ? this.source : this.target).records[rec], side === 'source' ? col.sourceIndex : col.targetIndex);
    const byName = new Map(union.map((c) => [c.name, c]));
    return {
      size,
      columns: union.map((c) => c.name),
      row: (i) => {
        const [side, rec] = entry(i);
        return {
          id: i,
          key: this.keyOf(side, rec),
          side,
          [side === 'source' ? 'sourceRecord' : 'targetRecord']: rec + 1,
          values: union.map((c) => value(side, rec, c)),
          ...extra(i),
        };
      },
      keyText: (i) => {
        const [side, rec] = entry(i);
        return this.keyOf(side, rec).map((v) => v ?? '').join('\u0001');
      },
      allText: (i) => {
        const [side, rec] = entry(i);
        return (side === 'source' ? this.source : this.target).records[rec].map((v) => v ?? '').join('\u0001');
      },
      sortValue: (i, column) => {
        const [side, rec] = entry(i);
        if (column === SORT_RECORD) return i;
        const c = byName.get(column);
        return c ? value(side, rec, c) : null;
      },
    };
  }

  /** Entry ids (positions in the unfiltered view) after filter + sort. `null` = identity. */
  private selection(q: ViewQuery): Int32Array | null {
    const search = (q.search ?? '').trim().toLowerCase();
    const changed = q.view === 'modified' ? q.changedColumn ?? '' : '';
    const sort = q.sortColumn ?? '';
    if (!search && !changed && !sort) return null;
    const cacheKey = JSON.stringify([q.view, search, !!q.searchAllColumns, changed, sort, q.sortDir ?? 'asc']);
    const hit = this.cache.get(cacheKey);
    if (hit) return hit;

    const spec = this.spec(q.view);
    let ids: number[] = [];
    const useAll = q.searchAllColumns || this.keyColumns.length === 0;
    const changedIdx = changed ? this.result.comparedPairs.findIndex((p) => p.name === changed) : -1;
    for (let i = 0; i < spec.size; i++) {
      if (changed) {
        if (changedIdx < 0) continue;
        const cols = modifiedDiffColumnsAt(this.result, i);
        if (cols.indexOf(changedIdx) === -1) continue;
      }
      if (search) {
        const text = (useAll ? spec.allText(i) : spec.keyText(i)).toLowerCase();
        if (!text.includes(search)) continue;
      }
      ids.push(i);
    }
    if (sort) ids = sortIds(ids, (i) => spec.sortValue(i, sort), q.sortDir === 'desc');
    const out = Int32Array.from(ids);
    if (this.cache.size >= MAX_CACHED_FILTERS) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(cacheKey, out);
    return out;
  }

  query(q: ViewQuery): ViewPage {
    const spec = this.spec(q.view);
    const sel = this.selection(q);
    const total = sel ? sel.length : spec.size;
    const offset = Math.max(0, Math.min(q.offset, total));
    const end = Math.min(total, offset + Math.max(0, q.limit));
    const rows: ViewRow[] = [];
    for (let p = offset; p < end; p++) rows.push(spec.row(sel ? sel[p] : p));
    return { view: q.view, total, unfilteredTotal: spec.size, offset, columns: spec.columns, keyColumns: this.keyColumns, rows };
  }

  /** Iterate every row of a view in file order (used by report generators). */
  *rows(view: ResultView, limit = Infinity): Generator<ViewRow> {
    const spec = this.spec(view);
    const n = Math.min(spec.size, limit);
    for (let i = 0; i < n; i++) yield spec.row(i);
  }

  size(view: ResultView): number {
    return this.spec(view).size;
  }

  columns(view: ResultView): string[] {
    return this.spec(view).columns;
  }
}

const NUMERIC = /^[+-]?(?:\d+\.?\d*|\.\d+)$/;

/** Sort ids by value: NULLs first, numbers numerically, then text; stable. */
function sortIds(ids: number[], valueOf: (i: number) => CellValue | number, desc: boolean): number[] {
  const keyed = ids.map((id) => {
    const v = valueOf(id);
    if (v === null || v === undefined) return { id, n: -Infinity, s: '', t: 0 };
    if (typeof v === 'number') return { id, n: v, s: '', t: 1 };
    const t = v.trim();
    if (NUMERIC.test(t)) return { id, n: Number(t), s: '', t: 1 };
    return { id, n: 0, s: v, t: 2 };
  });
  keyed.sort((a, b) => {
    let c = a.t - b.t;
    if (!c) c = a.t === 2 ? (a.s < b.s ? -1 : a.s > b.s ? 1 : 0) : a.n - b.n;
    if (!c) return a.id - b.id;
    return desc ? -c : c;
  });
  return keyed.map((k) => k.id);
}
