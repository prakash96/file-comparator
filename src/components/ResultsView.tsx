import { useState } from 'react';
import type { Comparator } from '../hooks/useComparator';
import type { ResultView } from '../models/views';
import { fmt } from '../utils/format';
import { Dashboard } from './Dashboard';
import { ExportBar } from './ExportBar';
import { IssueList } from './Messages';
import { ColumnDifferences, ModifiedList, RecordsTable } from './ResultTables';
import { SchemaPanel } from './SchemaPanel';

type Tab = 'summary' | 'added' | 'removed' | 'modified' | 'unchanged' | 'duplicates' | 'columns' | 'issues';

export function ResultsView({ c }: { c: Comparator }) {
  const [tab, setTab] = useState<Tab>('summary');
  const [changedColumn, setChangedColumn] = useState<string | undefined>();
  const summary = c.compare.summary!;
  const source = c.slots.source.summary!;
  const target = c.slots.target.summary!;
  const counts = summary.counts;
  const version = c.compare.version;
  const hasKey = summary.mode === 'key';
  const allIssues = [
    ...source.issues.map((i) => ({ ...i, message: `SOURCE: ${i.message}` })),
    ...target.issues.map((i) => ({ ...i, message: `TARGET: ${i.message}` })),
    ...summary.issues,
  ];
  const missingKeys = counts.missingKeySource + counts.missingKeyTarget;

  const tabs: [Tab, string, number | null][] = [
    ['summary', 'Summary', null],
    ['added', 'Added', counts.added],
    ['removed', 'Removed', counts.removed],
    ['modified', 'Modified', counts.modified],
    ['unchanged', 'Unchanged', counts.unchanged],
    ['duplicates', 'Duplicate Keys', counts.duplicateKeys],
    ['columns', 'Column Differences', summary.columnStats.filter((s) => s.differences > 0).length],
    ['issues', 'Errors / Warnings', allIssues.length],
  ];

  const open = (v: ResultView | 'columns') => {
    if (v === 'modified') setChangedColumn(undefined);
    setTab(v === 'missingKey' ? 'issues' : (v as Tab));
  };

  return (
    <section className="panel results" aria-labelledby="results-title">
      <header className="panel-head">
        <h2 id="results-title">Results</h2>
        <span className="muted">
          {hasKey ? `Matched on ${summary.keyColumns.join(' + ')}` : 'Whole-record comparison'} · {fmt(summary.comparedColumns.length)} columns compared
        </span>
      </header>
      <ExportBar exportReport={c.exportReport} />

      <div className="tabs" role="tablist">
        {tabs.map(([id, label, n]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className={`tab ${tab === id ? 'is-active' : ''}`} onClick={() => {
              if (id === 'modified') setChangedColumn(undefined);
              setTab(id);
            }}>
            {label}
            {n !== null && <span className={`tab-count ${id}`}>{fmt(n)}</span>}
          </button>
        ))}
      </div>

      <div className="tab-body" role="tabpanel">
        {tab === 'summary' && (
          <>
            <Dashboard summary={summary} source={source} target={target} onOpen={open} />
            <SchemaPanel schema={summary.schema} />
          </>
        )}
        {(tab === 'added' || tab === 'removed' || tab === 'unchanged' || tab === 'duplicates') && (
          <RecordsTable key={tab} view={tab} fetchPage={c.query} version={version} hasKey={hasKey} />
        )}
        {tab === 'modified' &&
          (hasKey ? (
            <ModifiedList fetchPage={c.query} version={version} changedColumns={summary.columnStats} initialColumn={changedColumn} hasKey={hasKey} />
          ) : (
            <div className="empty">Modified records can only be identified when key columns are selected.</div>
          ))}
        {tab === 'columns' && (
          <ColumnDifferences
            stats={summary.columnStats}
            matched={counts.modified + counts.unchanged}
            onPick={(col) => {
              setChangedColumn(col);
              setTab('modified');
            }}
          />
        )}
        {tab === 'issues' && (
          <>
            {allIssues.length === 0 ? <div className="empty">No errors or warnings.</div> : <IssueList issues={allIssues} initial={50} />}
            {missingKeys > 0 && (
              <>
                <h3>Records with empty key values ({fmt(missingKeys)})</h3>
                <RecordsTable view="missingKey" fetchPage={c.query} version={version} hasKey={false} />
              </>
            )}
          </>
        )}
      </div>
    </section>
  );
}
