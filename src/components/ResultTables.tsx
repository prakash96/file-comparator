import { useEffect, useMemo, useState } from 'react';
import { useRemoteRows } from '../hooks/useRemoteRows';
import type { ColumnDifferenceStat } from '../models/comparison';
import { SORT_CHANGES, SORT_RECORD, type ResultView, type SortDirection, type ViewPage, type ViewQuery, type ViewRow } from '../models/views';
import { fmt } from '../utils/format';
import { Cell } from './PreviewTable';
import { VirtualList } from './VirtualList';

const ROW_H = 30;
const COL_W = 170;

type Fetch = (q: ViewQuery) => Promise<ViewPage>;

function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

interface ToolbarProps {
  search: string;
  onSearch: (s: string) => void;
  allColumns: boolean;
  onAllColumns: (b: boolean) => void;
  hasKey: boolean;
  total?: number;
  unfiltered?: number;
  children?: React.ReactNode;
}

function Toolbar({ search, onSearch, allColumns, onAllColumns, hasKey, total, unfiltered, children }: ToolbarProps) {
  return (
    <div className="toolbar">
      <input type="search" value={search} onChange={(e) => onSearch(e.target.value)} placeholder={hasKey && !allColumns ? 'Search key values…' : 'Search all values…'} aria-label="Search results" />
      {hasKey && (
        <label className="check">
          <input type="checkbox" checked={allColumns} onChange={(e) => onAllColumns(e.target.checked)} /> All columns
        </label>
      )}
      {children}
      <span className="muted toolbar-count">
        {total === undefined ? 'Loading…' : total === unfiltered ? `${fmt(total)} records` : `${fmt(total)} of ${fmt(unfiltered ?? 0)} records`}
      </span>
    </div>
  );
}

function SortHeader({ label, column, sort, onSort }: { label: string; column: string; sort: { column: string; dir: SortDirection } | null; onSort: (c: string) => void }) {
  const active = sort?.column === column;
  return (
    <button type="button" className={`th-btn ${active ? 'is-sorted' : ''}`} onClick={() => onSort(column)} title={`Sort by ${label}`} aria-sort={active ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      {label}
      <span className="sort-ind">{active ? (sort!.dir === 'asc' ? '▲' : '▼') : ''}</span>
    </button>
  );
}

function useSort() {
  const [sort, setSort] = useState<{ column: string; dir: SortDirection } | null>(null);
  const onSort = (column: string) =>
    setSort((s) => (s?.column === column ? (s.dir === 'asc' ? { column, dir: 'desc' } : null) : { column, dir: 'asc' }));
  return { sort, onSort };
}

/* ------------------------------------------------------------- record table */

export function RecordsTable({ view, fetchPage, version, hasKey }: { view: Exclude<ResultView, 'modified'>; fetchPage: Fetch; version: number; hasKey: boolean }) {
  const [search, setSearch] = useState('');
  const [allColumns, setAllColumns] = useState(false);
  const { sort, onSort } = useSort();
  const q = useDebounced(search);
  const base = useMemo(() => ({ view, search: q, searchAllColumns: allColumns, sortColumn: sort?.column, sortDir: sort?.dir }), [view, q, allColumns, sort]);
  const { meta, getRow, error } = useRemoteRows(fetchPage, base, version);

  const lead: { label: string; get: (r: ViewRow) => React.ReactNode; sort?: string }[] =
    view === 'duplicates'
      ? [
          { label: 'Group', get: (r) => r.group },
          { label: 'Side', get: (r) => <span className={`side side-${r.side}`}>{r.side?.toUpperCase()}</span> },
          { label: 'Record #', get: (r) => (r.side === 'source' ? r.sourceRecord : r.targetRecord) },
        ]
      : view === 'missingKey'
        ? [
            { label: 'Side', get: (r) => <span className={`side side-${r.side}`}>{r.side?.toUpperCase()}</span> },
            { label: 'Record #', get: (r) => (r.side === 'source' ? r.sourceRecord : r.targetRecord) },
          ]
        : view === 'unchanged'
          ? [{ label: 'Record # (S / T)', get: (r) => `${r.sourceRecord} / ${r.targetRecord}`, sort: SORT_RECORD }]
          : [{ label: 'Record #', get: (r) => r.sourceRecord ?? r.targetRecord, sort: SORT_RECORD }];

  const columns = meta?.columns ?? [];
  const keySet = new Set((meta?.keyColumns ?? []).map((k) => k.toLowerCase()));
  const template = `${lead.map(() => '110px').join(' ')} ${columns.map(() => `${COL_W}px`).join(' ')}`;
  const minWidth = lead.length * 110 + columns.length * COL_W;

  return (
    <div className="result-table">
      <Toolbar search={search} onSearch={setSearch} allColumns={allColumns} onAllColumns={setAllColumns} hasKey={hasKey} total={meta?.total} unfiltered={meta?.unfilteredTotal} />
      {error && <div className="issue issue-error">{error}</div>}
      {meta && meta.total === 0 ? (
        <div className="empty">{meta.unfilteredTotal === 0 ? 'No records in this category.' : 'No records match the search.'}</div>
      ) : (
        <VirtualList
          count={meta?.total ?? 0}
          rowHeight={ROW_H}
          height="min(62vh, 640px)"
          minWidth={minWidth}
          ariaLabel={`${view} records`}
          header={
            <div className="vrow vrow-head" style={{ gridTemplateColumns: template }}>
              {lead.map((l) => (
                <div key={l.label} className="vcell">
                  {l.sort ? <SortHeader label={l.label} column={l.sort} sort={sort} onSort={onSort} /> : l.label}
                </div>
              ))}
              {columns.map((c) => (
                <div key={c} className={`vcell ${keySet.has(c.toLowerCase()) ? 'is-key' : ''}`}>
                  <SortHeader label={c} column={c} sort={sort} onSort={onSort} />
                </div>
              ))}
            </div>
          }
          renderRow={(i, style) => {
            const r = getRow(i);
            return (
              <div key={i} className={`vrow ${i % 2 ? 'odd' : ''}`} style={{ ...style, gridTemplateColumns: template }} role="row">
                {r ? (
                  <>
                    {lead.map((l) => (
                      <div key={l.label} className="vcell num muted">
                        {l.get(r)}
                      </div>
                    ))}
                    {(r.values ?? []).map((v, c) => (
                      <div key={c} className={`vcell ${keySet.has(columns[c]?.toLowerCase()) ? 'is-key' : ''}`} title={v ?? 'NULL'}>
                        <Cell v={v} />
                      </div>
                    ))}
                  </>
                ) : (
                  <div className="vcell muted">…</div>
                )}
              </div>
            );
          }}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------- modified */

export function ModifiedList({ fetchPage, version, changedColumns, initialColumn, hasKey }: { fetchPage: Fetch; version: number; changedColumns: ColumnDifferenceStat[]; initialColumn?: string; hasKey: boolean }) {
  const [search, setSearch] = useState('');
  const [allColumns, setAllColumns] = useState(false);
  const [column, setColumn] = useState(initialColumn ?? '');
  const [expanded, setExpanded] = useState<Map<number, number>>(new Map());
  const { sort, onSort } = useSort();
  const q = useDebounced(search);
  useEffect(() => setColumn(initialColumn ?? ''), [initialColumn]);
  const base = useMemo(() => ({ view: 'modified' as const, search: q, searchAllColumns: allColumns, changedColumn: column || undefined, sortColumn: sort?.column, sortDir: sort?.dir }), [q, allColumns, column, sort]);
  const { meta, getRow, error } = useRemoteRows(fetchPage, base, version);
  useEffect(() => setExpanded(new Map()), [base, version]);

  const keys = meta?.keyColumns ?? [];
  const template = `28px ${keys.map(() => '160px').join(' ')} 150px minmax(240px, 1fr) 90px`;
  const toggle = (i: number, diffCount: number) =>
    setExpanded((m) => {
      const n = new Map(m);
      if (n.has(i)) n.delete(i);
      else n.set(i, (diffCount + 1) * 28 + 20);
      return n;
    });
  const expandAll = () => {
    // Expand the rows that are loaded near the top (bounded to keep the DOM small).
    const n = new Map<number, number>();
    for (let i = 0; i < Math.min(meta?.total ?? 0, 200); i++) {
      const r = getRow(i);
      if (r) n.set(i, ((r.diffs?.length ?? 0) + 1) * 28 + 20);
    }
    setExpanded(n);
  };

  return (
    <div className="result-table">
      <Toolbar search={search} onSearch={setSearch} allColumns={allColumns} onAllColumns={setAllColumns} hasKey={hasKey} total={meta?.total} unfiltered={meta?.unfilteredTotal}>
        <label className="inline">
          Changed column
          <select value={column} onChange={(e) => setColumn(e.target.value)}>
            <option value="">Any</option>
            {changedColumns
              .filter((c) => c.differences > 0)
              .map((c) => (
                <option key={c.column} value={c.column}>
                  {c.column} ({fmt(c.differences)})
                </option>
              ))}
          </select>
        </label>
        <button type="button" className="ghost" onClick={expanded.size ? () => setExpanded(new Map()) : expandAll}>
          {expanded.size ? 'Collapse all' : 'Expand first 200'}
        </button>
      </Toolbar>
      {error && <div className="issue issue-error">{error}</div>}
      {meta && meta.total === 0 ? (
        <div className="empty">{meta.unfilteredTotal === 0 ? 'No modified records.' : 'No modified records match the filter.'}</div>
      ) : (
        <VirtualList
          count={meta?.total ?? 0}
          rowHeight={ROW_H}
          extraHeights={expanded}
          height="min(62vh, 640px)"
          minWidth={28 + keys.length * 160 + 150 + 240 + 90}
          ariaLabel="Modified records"
          header={
            <div className="vrow vrow-head" style={{ gridTemplateColumns: template }}>
              <div className="vcell" />
              {keys.map((k) => (
                <div key={k} className="vcell is-key">
                  <SortHeader label={k} column={k} sort={sort} onSort={onSort} />
                </div>
              ))}
              <div className="vcell">
                <SortHeader label="Record # (S / T)" column={SORT_RECORD} sort={sort} onSort={onSort} />
              </div>
              <div className="vcell">Changed columns</div>
              <div className="vcell">
                <SortHeader label="Changes" column={SORT_CHANGES} sort={sort} onSort={onSort} />
              </div>
            </div>
          }
          renderRow={(i, style) => {
            const r = getRow(i);
            const open = expanded.has(i);
            if (!r)
              return (
                <div key={i} className="vrow" style={style}>
                  <div className="vcell muted">…</div>
                </div>
              );
            const diffs = r.diffs ?? [];
            return (
              <div key={i} className={`mod-row ${open ? 'is-open' : ''} ${i % 2 ? 'odd' : ''}`} style={style}>
                <div
                  className="vrow vrow-click"
                  style={{ gridTemplateColumns: template, height: ROW_H }}
                  onClick={() => toggle(i, diffs.length)}
                  onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), toggle(i, diffs.length))}
                  role="button"
                  tabIndex={0}
                  aria-expanded={open}
                >
                  <div className="vcell caret">{open ? '▾' : '▸'}</div>
                  {r.key.map((k, n) => (
                    <div key={n} className="vcell is-key">
                      <Cell v={k} />
                    </div>
                  ))}
                  <div className="vcell num muted">
                    {r.sourceRecord} / {r.targetRecord}
                  </div>
                  <div className="vcell" title={diffs.map((d) => d.column).join(', ')}>
                    {diffs.map((d) => d.column).join(', ')}
                  </div>
                  <div className="vcell num">{diffs.length}</div>
                </div>
                {open && (
                  <table className="diff-table">
                    <thead>
                      <tr>
                        <th>Field</th>
                        <th>Source</th>
                        <th>Target</th>
                      </tr>
                    </thead>
                    <tbody>
                      {diffs.map((d) => (
                        <tr key={d.column}>
                          <td>{d.column}</td>
                          <td className="old">
                            <Cell v={d.source} />
                          </td>
                          <td className="new">
                            <Cell v={d.target} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            );
          }}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------- column differences */

export function ColumnDifferences({ stats, matched, onPick }: { stats: ColumnDifferenceStat[]; matched: number; onPick: (column: string) => void }) {
  const max = Math.max(1, ...stats.map((s) => s.differences));
  if (!stats.length) return <div className="empty">No columns were compared.</div>;
  return (
    <div className="table-scroll">
      <table className="data coldiff">
        <thead>
          <tr>
            <th>Column</th>
            <th className="num">Records where it differs</th>
            <th className="num">% of matched</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {stats.map((s) => (
            <tr key={s.column}>
              <td>{s.column}</td>
              <td className="num">{fmt(s.differences)}</td>
              <td className="num">{matched ? ((s.differences / matched) * 100).toFixed(2) : '0.00'}%</td>
              <td>
                <span className="bar-track small">
                  <span className="bar-fill" style={{ width: `${(s.differences / max) * 100}%`, background: 'var(--c-modified)' }} />
                </span>
                {s.differences > 0 && (
                  <button type="button" className="link" onClick={() => onPick(s.column)}>
                    Show records
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
