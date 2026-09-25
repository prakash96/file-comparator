import { useMemo, useState } from 'react';

interface Props {
  label: string;
  hint?: string;
  columns: string[];
  selected: string[];
  onChange: (next: string[]) => void;
  /** Keep selection order (for composite keys). */
  ordered?: boolean;
  disabled?: string[];
  emptyText?: string;
}

/** Searchable multi-select for column names (handles hundreds of columns). */
export function ColumnPicker({ label, hint, columns, selected, onChange, ordered, disabled = [], emptyText }: Props) {
  const [filter, setFilter] = useState('');
  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return f ? columns.filter((c) => c.toLowerCase().includes(f)) : columns;
  }, [columns, filter]);
  const sel = new Set(selected);
  const toggle = (c: string) => onChange(sel.has(c) ? selected.filter((x) => x !== c) : ordered ? [...selected, c] : columns.filter((x) => sel.has(x) || x === c));

  return (
    <fieldset className="picker">
      <legend>{label}</legend>
      {hint && <div className="hint">{hint}</div>}
      <div className="chips" aria-live="polite">
        {selected.length === 0 && <span className="muted">{emptyText ?? 'None selected'}</span>}
        {selected.map((c, i) => (
          <span key={c} className="chip">
            {ordered && selected.length > 1 && <span className="chip-n">{i + 1}</span>}
            {c}
            <button type="button" aria-label={`Remove ${c}`} onClick={() => toggle(c)}>
              ×
            </button>
          </span>
        ))}
      </div>
      {columns.length > 8 && (
        <input type="search" className="picker-filter" placeholder={`Filter ${columns.length} columns…`} value={filter} onChange={(e) => setFilter(e.target.value)} aria-label={`Filter columns for ${label}`} />
      )}
      <div className="picker-list">
        {shown.map((c) => (
          <label key={c} className={disabled.includes(c) ? 'is-disabled' : ''}>
            <input type="checkbox" checked={sel.has(c)} disabled={disabled.includes(c)} onChange={() => toggle(c)} />
            <span>{c}</span>
          </label>
        ))}
        {shown.length === 0 && <div className="muted">No matching columns</div>}
      </div>
    </fieldset>
  );
}
