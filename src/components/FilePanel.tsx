import { useRef, useState } from 'react';
import { FILE_FORMAT_LABELS } from '../models/dataset';
import { SLOT_LABEL, STAGE_LABELS, type Slot } from '../models/session';
import type { SlotState } from '../hooks/useComparator';
import type { ParseOptions } from '../models/parseOptions';
import { fmt, formatBytes, formatMs, formatRate } from '../utils/format';
import { ErrorMessage, IssueList } from './Messages';
import { FormatOptions } from './FormatOptions';
import { PreviewTable } from './PreviewTable';

interface Props {
  slot: Slot;
  state: SlotState;
  onFile: (file: File) => void;
  onRemove: () => void;
  onApply: (options: ParseOptions) => void;
}

export function FilePanel({ slot, state, onFile, onRemove, onApply }: Props) {
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const { file, status, summary, progress, error } = state;
  const label = SLOT_LABEL[slot];

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) onFile(f);
  };

  const dropzone = (
    <div
      className={`dropzone ${over ? 'is-over' : ''} ${file ? 'is-compact' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
      onClick={() => input.current?.click()}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && input.current?.click()}
      role="button"
      tabIndex={0}
      aria-label={`Choose ${label} file`}
    >
      <input
        ref={input}
        type="file"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = '';
        }}
      />
      {file ? (
        <span>Drop another file here or click to replace</span>
      ) : (
        <>
          <div className="dz-icon" aria-hidden>
            ⇪
          </div>
          <div className="dz-main">Drag &amp; drop the {label.toLowerCase()} file</div>
          <div className="muted">or click to browse · CSV, TXT, fixed-width, JSON, XML, XLSX/XLS, Avro, Parquet</div>
        </>
      )}
    </div>
  );

  return (
    <section className={`panel file-panel slot-${slot}`} aria-labelledby={`${slot}-title`}>
      <header className="panel-head">
        <h2 id={`${slot}-title`}>
          <span className={`slot-badge slot-badge-${slot}`}>{label}</span> {label === 'SOURCE' ? 'Source file' : 'Target file'}
        </h2>
        {file && (
          <button type="button" className="ghost" onClick={onRemove}>
            Remove
          </button>
        )}
      </header>

      {!file && dropzone}

      {file && (
        <>
          <dl className="file-facts">
            <div>
              <dt>File</dt>
              <dd title={file.name}>{file.name}</dd>
            </div>
            <div>
              <dt>Size</dt>
              <dd>{formatBytes(file.size)}</dd>
            </div>
            <div>
              <dt>Format</dt>
              <dd>
                {summary ? FILE_FORMAT_LABELS[summary.format] : '…'}
                {summary?.detection && (
                  <span className="muted" title={`Detected automatically: ${summary.detection.reason} (${summary.detection.confidence} confidence)`}>
                    {' '}
                    · auto
                  </span>
                )}
              </dd>
            </div>
            <div>
              <dt>Records</dt>
              <dd className="num">{summary ? fmt(summary.recordCount) : status === 'loading' && progress ? fmt(progress.records) : '—'}</dd>
            </div>
            <div>
              <dt>Columns</dt>
              <dd className="num">{summary ? fmt(summary.fields.length) : '—'}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>
                {status === 'loading' && <span className="status status-busy">Reading…</span>}
                {status === 'ready' && <span className="status status-ok">Parsed in {formatMs(summary!.parseMs)}</span>}
                {status === 'error' && <span className="status status-bad">Failed</span>}
              </dd>
            </div>
            {summary?.meta.details.map((d) => (
              <div key={d.label}>
                <dt>{d.label}</dt>
                <dd>{d.value}</dd>
              </div>
            ))}
          </dl>

          {status === 'loading' && (
            <div className="load-progress" aria-live="polite">
              <div className="progress-label">
                {progress ? STAGE_LABELS[progress.stage] : `Reading ${slot}…`}
                {progress?.percent !== undefined && ` ${Math.floor(progress.percent)}%`}
                {progress && ` · ${fmt(progress.records)} records · ${formatRate(progress.records, progress.elapsedMs)} · ${formatMs(progress.elapsedMs)}`}
              </div>
              <div className="progress" role="progressbar" aria-valuenow={Math.floor(progress?.percent ?? 0)} aria-valuemin={0} aria-valuemax={100}>
                <div className={progress?.percent === undefined ? 'indeterminate' : ''} style={{ width: `${progress?.percent ?? 30}%` }} />
              </div>
            </div>
          )}

          {error && <ErrorMessage error={error} title={`The ${label.toLowerCase()} file could not be read`} />}
          {summary && <IssueList issues={summary.issues} />}

          <details className="subsection" open={status === 'error' || summary?.issues.some((i) => i.code === 'FW_NO_LAYOUT') || undefined}>
            <summary>Format &amp; parsing options</summary>
            <FormatOptions options={state.options} summary={summary} busy={status === 'loading'} onApply={onApply} />
          </details>

          {summary && summary.fields.length > 0 && (
            <details className="subsection">
              <summary>
                Preview &amp; columns ({fmt(summary.fields.length)} columns, first {Math.min(summary.preview.length, 100)} records)
              </summary>
              <PreviewTable fields={summary.fields} rows={summary.preview} />
            </details>
          )}

          {summary?.meta.schemaText && (
            <details className="subsection">
              <summary>Declared schema</summary>
              <pre className="schema-text">{summary.meta.schemaText}</pre>
            </details>
          )}

          {dropzone}
        </>
      )}
    </section>
  );
}
