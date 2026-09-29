import { useComparator } from '../hooks/useComparator';
import { AppHeader, type ThemeControl } from '../components/AppHeader';
import { ComparisonConfig } from '../components/ComparisonConfig';
import { FilePanel } from '../components/FilePanel';
import { ErrorMessage } from '../components/Messages';
import { ProgressPanel } from '../components/ProgressPanel';
import { ResultsView } from '../components/ResultsView';
import { SchemaPanel } from '../components/SchemaPanel';

export function ComparatorPage({ theme }: { theme: ThemeControl }) {
  const c = useComparator();
  const { slots, schema, compare } = c;
  const anyFile = !!(slots.source.file || slots.target.file);
  const bothReady = slots.source.status === 'ready' && slots.target.status === 'ready';

  return (
    <div className="app">
      <AppHeader
        page="compare"
        theme={theme}
        actions={
          anyFile && (
            <button type="button" className="ghost" onClick={c.reset} title="Clear both files and all in-memory data">
              Reset
            </button>
          )
        }
      />

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
