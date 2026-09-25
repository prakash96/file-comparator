import { useState } from 'react';
import { toFriendly } from '../hooks/useComparator';
import type { FriendlyError } from '../models/issues';
import type { ExportedFile, ProgressInfo, ReportKind } from '../models/session';
import { downloadBlob } from '../utils/format';
import { ErrorMessage } from './Messages';

const CSV_KINDS: [ReportKind, string][] = [
  ['csv-added', 'added.csv'],
  ['csv-removed', 'removed.csv'],
  ['csv-modified', 'modified.csv'],
  ['csv-unchanged', 'unchanged.csv'],
  ['csv-duplicates', 'duplicate-keys.csv'],
  ['csv-column-differences', 'column-differences.csv'],
];

interface Props {
  exportReport: (kind: ReportKind, onProgress?: (p: ProgressInfo) => void) => Promise<ExportedFile>;
}

/** Reports are generated in the worker and downloaded directly; nothing is uploaded. */
export function ExportBar({ exportReport }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [error, setError] = useState<FriendlyError | null>(null);
  const [menu, setMenu] = useState(false);

  const run = async (kinds: ReportKind[], label: string) => {
    setBusy(label);
    setError(null);
    setNotes([]);
    setMenu(false);
    try {
      const collected: string[] = [];
      for (const k of kinds) {
        const out = await exportReport(k);
        downloadBlob(out.blob, out.fileName);
        collected.push(...out.notes);
      }
      setNotes(collected);
    } catch (e) {
      setError(toFriendly(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="export-bar">
      <span className="export-title">Export</span>
      <button type="button" onClick={() => run(['excel'], 'Excel')} disabled={!!busy}>
        Export Excel
      </button>
      <div className="menu-wrap">
        <button type="button" onClick={() => setMenu((m) => !m)} disabled={!!busy} aria-haspopup="menu" aria-expanded={menu}>
          Export CSV ▾
        </button>
        {menu && (
          <div className="menu" role="menu">
            <button type="button" role="menuitem" onClick={() => run(CSV_KINDS.map((k) => k[0]), 'CSV')}>
              All CSV files
            </button>
            {CSV_KINDS.map(([k, name]) => (
              <button type="button" role="menuitem" key={k} onClick={() => run([k], name)}>
                {name}
              </button>
            ))}
          </div>
        )}
      </div>
      <button type="button" onClick={() => run(['html'], 'HTML')} disabled={!!busy}>
        Export HTML
      </button>
      <button type="button" onClick={() => run(['json-summary'], 'JSON')} disabled={!!busy}>
        Export JSON Summary
      </button>
      {busy && <span className="muted">Generating {busy}…</span>}
      {notes.map((n) => (
        <div key={n} className="issue issue-info">
          {n}
        </div>
      ))}
      {error && <ErrorMessage error={error} title="Export failed" />}
    </div>
  );
}
