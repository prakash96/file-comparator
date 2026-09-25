import { useMemo, useRef, useState } from 'react';
import type { FixedWidthColumn, FixedWidthOptions, FixedWidthType } from '../models/parseOptions';
import { suggestLayout, validateLayout } from '../parsers/fixedwidth/fixedWidthParser';
import { downloadBlob } from '../utils/format';
import { safeStorage } from '../utils/safeStorage';

const STORE_KEY = 'dfc.fixedWidthLayouts';
const TYPES: FixedWidthType[] = ['string', 'integer', 'decimal', 'date'];
const COLORS = ['#1f5fae', '#1a7f37', '#b26a00', '#7b3fb5', '#c62828', '#00838f'];

type SavedLayouts = Record<string, FixedWidthOptions>;

function readSaved(): SavedLayouts {
  try {
    return JSON.parse(safeStorage.get(STORE_KEY) ?? '{}') as SavedLayouts;
  } catch {
    return {};
  }
}

function isLayout(x: unknown): x is FixedWidthOptions {
  const o = x as FixedWidthOptions;
  return !!o && Array.isArray(o.columns) && o.columns.every((c) => typeof c.name === 'string' && Number.isFinite(c.start) && Number.isFinite(c.length));
}

/** A sample line with each layout column highlighted; gaps and trailing text stay plain. */
function renderLine(line: string, columns: FixedWidthColumn[]) {
  if (columns.length === 0) return line;
  const sorted = columns.map((c, i) => ({ ...c, color: COLORS[i % COLORS.length] })).sort((a, b) => a.start - b.start);
  const out: React.ReactNode[] = [];
  let pos = 0;
  sorted.forEach((c, i) => {
    const s = Math.max(pos, c.start - 1);
    if (s > pos) out.push(line.slice(pos, s).padEnd(s - pos, ' '));
    const e = c.start - 1 + c.length;
    out.push(
      <span key={i} title={c.name} style={{ background: `${c.color}22`, boxShadow: `inset 0 -2px ${c.color}` }}>
        {line.slice(s, e).padEnd(Math.max(0, e - s), ' ')}
      </span>,
    );
    pos = Math.max(pos, e);
  });
  if (pos < line.length) out.push(<span key="rest" className="fw-rest">{line.slice(pos)}</span>);
  return out;
}

interface Props {
  value: FixedWidthOptions;
  onChange: (v: FixedWidthOptions) => void;
  sampleLines: string[];
  suggested?: FixedWidthColumn[];
}

/**
 * Layout editor for fixed-width files: one row per column (name, 1-based
 * start, length, type), a ruler preview over the file's first lines, and
 * layouts saved locally (browser storage) or exported/imported as JSON.
 */
export function FixedWidthEditor({ value, onChange, sampleLines, suggested }: Props) {
  const [saved, setSaved] = useState<SavedLayouts>(readSaved);
  const [layoutName, setLayoutName] = useState('');
  const [importError, setImportError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const errors = useMemo(() => (value.columns.length ? validateLayout(value.columns) : []), [value.columns]);

  const setCols = (columns: FixedWidthColumn[]) => onChange({ ...value, columns });
  const update = (i: number, patch: Partial<FixedWidthColumn>) => setCols(value.columns.map((c, n) => (n === i ? { ...c, ...patch } : c)));
  const add = () => {
    const last = value.columns[value.columns.length - 1];
    const start = last ? last.start + last.length : 1;
    setCols([...value.columns, { name: `COL_${value.columns.length + 1}`, start, length: 10, type: 'string' }]);
  };

  const persist = (next: SavedLayouts) => {
    setSaved(next);
    safeStorage.set(STORE_KEY, JSON.stringify(next));
  };

  const importFile = async (f: File) => {
    setImportError(null);
    try {
      const parsed = JSON.parse(await f.text()) as unknown;
      if (!isLayout(parsed)) throw new Error('not a layout');
      onChange({ ...value, ...parsed });
    } catch {
      setImportError('That file is not a fixed-width layout exported from this tool.');
    }
  };

  const data = sampleLines.slice(value.skipLines, value.skipLines + 8);
  const width = Math.max(40, ...data.map((l) => l.length), ...value.columns.map((c) => c.start - 1 + c.length));
  const ruler = Array.from({ length: Math.ceil(width / 10) }, (_, i) => String((i + 1) * 10).padStart(10, '·')).join('');

  return (
    <div className="fw-editor">
      <div className="fw-preview" aria-label="Layout preview">
        <pre className="fw-ruler">{ruler.slice(0, width)}</pre>
        <div className="fw-lines">
          {data.map((line, li) => (
            <pre key={li}>
              {renderLine(line, value.columns)}
            </pre>
          ))}
          {data.length === 0 && <div className="muted">No sample lines available.</div>}
        </div>
      </div>

      <table className="fw-table">
        <thead>
          <tr>
            <th>Column name</th>
            <th>Start</th>
            <th>Length</th>
            <th>End</th>
            <th>Type</th>
            <th aria-label="Remove" />
          </tr>
        </thead>
        <tbody>
          {value.columns.map((c, i) => (
            <tr key={i}>
              <td>
                <input value={c.name} onChange={(e) => update(i, { name: e.target.value })} aria-label={`Column ${i + 1} name`} />
              </td>
              <td>
                <input type="number" min={1} value={c.start} onChange={(e) => update(i, { start: parseInt(e.target.value, 10) || 0 })} aria-label={`Column ${i + 1} start`} />
              </td>
              <td>
                <input type="number" min={1} value={c.length} onChange={(e) => update(i, { length: parseInt(e.target.value, 10) || 0 })} aria-label={`Column ${i + 1} length`} />
              </td>
              <td className="muted num">{c.start + c.length - 1}</td>
              <td>
                <select value={c.type} onChange={(e) => update(i, { type: e.target.value as FixedWidthType })} aria-label={`Column ${i + 1} type`}>
                  {TYPES.map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
              </td>
              <td>
                <button type="button" className="icon-btn" aria-label={`Remove column ${c.name}`} onClick={() => setCols(value.columns.filter((_, n) => n !== i))}>
                  ×
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="row-actions">
        <button type="button" onClick={add}>
          + Add column
        </button>
        <button type="button" onClick={() => setCols(suggested?.length ? suggested : suggestLayout(sampleLines.slice(value.skipLines)))} disabled={!sampleLines.length}>
          Suggest layout
        </button>
        {value.columns.length > 0 && (
          <button type="button" className="ghost" onClick={() => setCols([])}>
            Clear
          </button>
        )}
      </div>

      <div className="form-grid">
        <label>
          Header lines to skip
          <input type="number" min={0} value={value.skipLines} onChange={(e) => onChange({ ...value, skipLines: Math.max(0, parseInt(e.target.value, 10) || 0) })} />
        </label>
        <label>
          Fixed record length
          <input type="number" min={0} value={value.recordLength} onChange={(e) => onChange({ ...value, recordLength: Math.max(0, parseInt(e.target.value, 10) || 0) })} />
          <span className="hint">0 = one record per line</span>
        </label>
        <label className="check">
          <input type="checkbox" checked={value.trim} onChange={(e) => onChange({ ...value, trim: e.target.checked })} /> Trim whitespace
        </label>
      </div>

      {errors.length > 0 && (
        <ul className="issues">
          {errors.map((e) => (
            <li key={e} className="issue issue-error">
              <span className="issue-icon">✖</span>
              {e}
            </li>
          ))}
        </ul>
      )}

      <details className="fw-saved">
        <summary>Save / load layout</summary>
        <div className="row-actions">
          <input placeholder="Layout name" value={layoutName} onChange={(e) => setLayoutName(e.target.value)} aria-label="Layout name" />
          <button type="button" disabled={!layoutName.trim() || !value.columns.length} onClick={() => persist({ ...saved, [layoutName.trim()]: value })}>
            Save in this browser
          </button>
          <button type="button" disabled={!value.columns.length} onClick={() => downloadBlob(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }), `${layoutName.trim() || 'fixed-width-layout'}.json`)}>
            Export JSON
          </button>
          <button type="button" onClick={() => fileInput.current?.click()}>
            Import JSON
          </button>
          <input ref={fileInput} type="file" accept=".json,application/json" hidden onChange={(e) => e.target.files?.[0] && importFile(e.target.files[0])} />
        </div>
        {importError && <div className="issue issue-error">{importError}</div>}
        {Object.keys(saved).length > 0 && (
          <ul className="saved-list">
            {Object.entries(saved).map(([name, layout]) => (
              <li key={name}>
                <button type="button" className="link" onClick={() => onChange({ ...value, ...layout })}>
                  {name}
                </button>
                <span className="muted"> · {layout.columns.length} columns</span>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Delete layout ${name}`}
                  onClick={() => {
                    const next = { ...saved };
                    delete next[name];
                    persist(next);
                  }}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="hint">Only the layout (names and positions) is stored - never file contents.</div>
      </details>
    </div>
  );
}
