import type { ComparisonSummary } from '../models/comparison';
import type { DatasetSummary } from '../models/session';
import type { ResultView } from '../models/views';
import { fmt, formatBytes, formatMs } from '../utils/format';

interface Props {
  summary: ComparisonSummary;
  source: DatasetSummary;
  target: DatasetSummary;
  onOpen: (view: ResultView | 'columns') => void;
}

function Card({ label, value, cls = '', sub, onClick }: { label: string; value: string; cls?: string; sub?: string; onClick?: () => void }) {
  const body = (
    <>
      <div className="card-label">{label}</div>
      <div className="card-value">{value}</div>
      {sub && <div className="card-sub">{sub}</div>}
    </>
  );
  return onClick ? (
    <button type="button" className={`card card-btn ${cls}`} onClick={onClick}>
      {body}
    </button>
  ) : (
    <div className={`card ${cls}`}>{body}</div>
  );
}

const pct = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(n && n / d < 0.001 ? 3 : 1)}%` : '0%');

export function Dashboard({ summary, source, target, onOpen }: Props) {
  const c = summary.counts;
  const r = summary.reconciliation;
  const bars: [string, number, string, ResultView][] = [
    ['Unchanged', c.unchanged, 'var(--c-unchanged)', 'unchanged'],
    ['Modified', c.modified, 'var(--c-modified)', 'modified'],
    ['Added', c.added, 'var(--c-added)', 'added'],
    ['Removed', c.removed, 'var(--c-removed)', 'removed'],
    ['Duplicate-key records', c.duplicateSourceRecords + c.duplicateTargetRecords, 'var(--c-dup)', 'duplicates'],
  ];
  const max = Math.max(1, ...bars.map((b) => b[1]));
  const matched = c.modified + c.unchanged;
  const topCols = summary.columnStats.filter((s) => s.differences > 0).slice(0, 8);
  const topMax = Math.max(1, ...topCols.map((t) => t.differences));

  return (
    <div className="dashboard">
      <div className="cards">
        <Card label="Source records" value={fmt(c.sourceTotal)} sub={formatBytes(source.fileSize)} />
        <Card label="Target records" value={fmt(c.targetTotal)} sub={formatBytes(target.fileSize)} />
        <Card label="Added" value={fmt(c.added)} cls="c-added" sub="in target only" onClick={() => onOpen('added')} />
        <Card label="Removed" value={fmt(c.removed)} cls="c-removed" sub="in source only" onClick={() => onOpen('removed')} />
        <Card label="Modified" value={fmt(c.modified)} cls="c-modified" sub={`${pct(c.modified, matched)} of matched`} onClick={() => onOpen('modified')} />
        <Card label="Unchanged" value={fmt(c.unchanged)} cls="c-unchanged" sub={`${pct(c.unchanged, matched)} of matched`} onClick={() => onOpen('unchanged')} />
        <Card label="Duplicate keys" value={fmt(c.duplicateKeys)} cls="c-dup" sub={`${fmt(c.duplicateSourceRecords + c.duplicateTargetRecords)} records`} onClick={() => onOpen('duplicates')} />
        <Card label="Compare time" value={formatMs(summary.timing.totalMs)} sub={`parse: source ${formatMs(source.parseMs)}, target ${formatMs(target.parseMs)}`} />
      </div>

      <div className="dash-grid">
        <div className="chart" role="img" aria-label="Result distribution">
          <h3>Result distribution</h3>
          {bars.map(([label, n, color, view]) => (
            <button type="button" key={label} className="bar-row" onClick={() => onOpen(view)} disabled={n === 0}>
              <span className="bar-label">{label}</span>
              <span className="bar-track">
                <span className="bar-fill" style={{ width: `${(n / max) * 100}%`, background: color }} />
              </span>
              <span className="bar-value num">{fmt(n)}</span>
            </button>
          ))}
        </div>

        <div className="chart">
          <h3>Most changed columns</h3>
          {topCols.length === 0 && <p className="muted">{summary.mode === 'key' ? 'No field differences.' : 'Not available without a key.'}</p>}
          {topCols.map((t) => (
            <button type="button" key={t.column} className="bar-row" onClick={() => onOpen('columns')}>
              <span className="bar-label" title={t.column}>
                {t.column}
              </span>
              <span className="bar-track">
                <span className="bar-fill" style={{ width: `${(t.differences / topMax) * 100}%`, background: 'var(--c-modified)' }} />
              </span>
              <span className="bar-value num">{fmt(t.differences)}</span>
            </button>
          ))}
        </div>
      </div>

      <div className={`reconcile ${r.sourceBalanced && r.targetBalanced ? 'ok' : 'bad'}`}>
        <strong>{r.sourceBalanced && r.targetBalanced ? '✓ Counts reconcile' : '✗ Counts do not reconcile'}</strong>
        <div className="num">
          Source {fmt(c.sourceTotal)} = removed {fmt(c.removed)} + modified {fmt(c.modified)} + unchanged {fmt(c.unchanged)} + duplicate-key {fmt(c.duplicateSourceRecords)}
          {c.missingKeySource ? ` + empty-key ${fmt(c.missingKeySource)}` : ''}
        </div>
        <div className="num">
          Target {fmt(c.targetTotal)} = added {fmt(c.added)} + modified {fmt(c.modified)} + unchanged {fmt(c.unchanged)} + duplicate-key {fmt(c.duplicateTargetRecords)}
          {c.missingKeyTarget ? ` + empty-key ${fmt(c.missingKeyTarget)}` : ''}
        </div>
      </div>
    </div>
  );
}
