import { useComparator } from '../hooks/useComparator';
import { useTheme } from '../hooks/useTheme';
import { ComparisonConfig } from '../components/ComparisonConfig';
import { FilePanel } from '../components/FilePanel';
import { ErrorMessage } from '../components/Messages';
import { ProgressPanel } from '../components/ProgressPanel';
import { ResultsView } from '../components/ResultsView';
import { SchemaPanel } from '../components/SchemaPanel';

export function ComparatorPage() {
  const c = useComparator();
  const { theme, toggle } = useTheme();
  const { slots, schema, compare } = c;
  const anyFile = !!(slots.source.file || slots.target.file);
  const bothReady = slots.source.status === 'ready' && slots.target.status === 'ready';

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <svg width="28" height="28" viewBox="0 0 32 32" aria-hidden>
            <rect width="32" height="32" rx="6" fill="var(--accent)" />
            <path d="M8 9h7v14H8zM17 9h7v14h-7z" fill="#fff" opacity=".92" />
          </svg>
          <div>
            <h1>File Comparator</h1>
            <div className="privacy" role="note">
              <span aria-hidden>🔒</span> Files are processed locally in your browser and are not uploaded.
            </div>
          </div>
        </div>
        <div className="header-actions">
          {anyFile && (
            <button type="button" className="ghost" onClick={c.reset} title="Clear both files and all in-memory data">
              Reset
            </button>
          )}
          <button type="button" className="ghost" onClick={toggle} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}>
            {theme === 'dark' ? '☀ Light' : '☾ Dark'}
          </button>
        </div>
      </header>

      <main>
        <div className="files">
          <FilePanel slot="source" state={slots.source} onFile={(f) => c.setFile('source', f)} onRemove={() => c.removeFile('source')} onApply={(o) => c.applyOptions('source', o)} />
          <FilePanel slot="target" state={slots.target} onFile={(f) => c.setFile('target', f)} onRemove={() => c.removeFile('target')} onApply={(o) => c.applyOptions('target', o)} />
        </div>

        {bothReady && schema && compare.status !== 'done' && (
          <>
            <SchemaPanel schema={schema} />
            <ComparisonConfig schema={schema} options={c.options} onChange={c.setOptions} onRun={c.runCompare} running={compare.status === 'running'} />
          </>
        )}

        {compare.status === 'running' && <ProgressPanel progress={compare.progress} source={slots.source.summary} target={slots.target.summary} onCancel={c.cancel} />}
        {compare.status === 'error' && compare.error && <ErrorMessage error={compare.error} title="The comparison could not be completed" />}

        {compare.status === 'done' && compare.summary && (
          <>
            <details className="panel collapsed-config">
              <summary>Comparison settings (change and re-run)</summary>
              {schema && <ComparisonConfig schema={schema} options={c.options} onChange={c.setOptions} onRun={c.runCompare} running={false} />}
            </details>
            <ResultsView c={c} />
          </>
        )}

        {!anyFile && (
          <section className="panel intro">
            <h2>How it works</h2>
            <ol>
              <li>Drop a SOURCE and a TARGET file. The format is detected automatically; adjust delimiter, layout, sheet or record path if needed.</li>
              <li>Review the schema comparison, choose key column(s) and comparison rules.</li>
              <li>Compare, then explore added / removed / modified records and export CSV, Excel, HTML or JSON reports.</li>
            </ol>
            <p className="muted">
              Everything runs in a background worker inside this tab. No data leaves your machine: the production build blocks all network connections with a Content-Security-Policy.
            </p>
          </section>
        )}
      </main>
      <footer className="app-footer muted">File Comparator 1.0 · runs offline · no data is stored or sent anywhere</footer>
    </div>
  );
}
