import { useEffect, useState } from 'react';
import { STAGE_LABELS, type DatasetSummary, type ProgressInfo, type StageId } from '../models/session';
import { fmt, formatMs, formatRate } from '../utils/format';

const COMPARE_STAGES: StageId[] = ['indexing', 'comparing', 'generating'];

interface Props {
  progress: ProgressInfo | null;
  source: DatasetSummary | null;
  target: DatasetSummary | null;
  onCancel: () => void;
}

/** Full pipeline view while a comparison runs. Parsing already happened when the files were loaded. */
export function ProgressPanel({ progress, source, target, onCancel }: Props) {
  const [startedAt] = useState(() => performance.now());
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 250);
    return () => clearInterval(t);
  }, []);
  const elapsed = performance.now() - startedAt;
  const current = progress?.stage ?? 'indexing';
  const currentIdx = COMPARE_STAGES.indexOf(current);

  const done = (label: string, detail: string) => (
    <li className="stage stage-done">
      <span className="stage-icon">✓</span> {label} <span className="muted">{detail}</span>
    </li>
  );

  return (
    <section className="panel progress-panel" aria-live="polite" aria-labelledby="progress-title">
      <header className="panel-head">
        <h2 id="progress-title">Comparing…</h2>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </header>
      <ol className="stages">
        {source && done('Reading & parsing source', `${fmt(source.recordCount)} records · ${formatMs(source.parseMs)}`)}
        {target && done('Reading & parsing target', `${fmt(target.recordCount)} records · ${formatMs(target.parseMs)}`)}
        {COMPARE_STAGES.map((s, i) => (
          <li key={s} className={`stage ${i < currentIdx ? 'stage-done' : i === currentIdx ? 'stage-active' : ''}`}>
            <span className="stage-icon">{i < currentIdx ? '✓' : i === currentIdx ? '●' : '○'}</span> {STAGE_LABELS[s]}
            {i === currentIdx && progress?.percent !== undefined && <strong> {Math.floor(progress.percent)}%</strong>}
          </li>
        ))}
      </ol>
      <div className="progress" role="progressbar" aria-valuenow={Math.floor(progress?.percent ?? 0)} aria-valuemin={0} aria-valuemax={100}>
        <div style={{ width: `${((Math.max(0, currentIdx) + (progress?.percent ?? 0) / 100) / COMPARE_STAGES.length) * 100}%` }} />
      </div>
      <div className="progress-facts">
        <span>Records processed: {fmt(progress?.records ?? 0)}</span>
        <span>Speed: {formatRate(progress?.records ?? 0, progress?.elapsedMs ?? 0)}</span>
        <span>Elapsed: {formatMs(elapsed)}</span>
      </div>
      <p className="muted">The page stays responsive: all processing runs in a background worker.</p>
    </section>
  );
}
