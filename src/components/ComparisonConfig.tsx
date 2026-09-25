import { useMemo, useState } from 'react';
import type { ComparisonOptions, MissingColumnMode, SchemaComparison } from '../models/comparison';
import { validateDateFormat } from '../normalization/dateFormat';
import { ColumnPicker } from './ColumnPicker';

interface Props {
  schema: SchemaComparison;
  options: ComparisonOptions;
  onChange: (o: ComparisonOptions) => void;
  onRun: () => void;
  running: boolean;
}

const KEY_HINT = /(^|_)(id|key|code|no|nbr|num|number|sku|orin)$/i;

function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="toggle">
      <input type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle-ui" aria-hidden />
      <span>
        {label}
        {hint && <span className="hint">{hint}</span>}
      </span>
    </label>
  );
}

export function ComparisonConfig({ schema, options, onChange, onRun, running }: Props) {
  const set = (patch: Partial<ComparisonOptions>) => onChange({ ...options, ...patch });
  const common = schema.common;
  const all = schema.fields.map((f) => f.name);
  const [datesText, setDatesText] = useState(options.dateFormats.join('\n'));
  const dateErrors = useMemo(
    () =>
      datesText
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((f) => [f, validateDateFormat(f)] as const)
        .filter(([, e]) => e),
    [datesText],
  );
  const suggestions = common.filter((c) => KEY_HINT.test(c) && !options.keyColumns.includes(c)).slice(0, 4);
  const missingKey = options.keyColumns.filter((k) => !common.some((c) => c.toLowerCase() === k.toLowerCase()));

  return (
    <section className="panel" aria-labelledby="config-title">
      <header className="panel-head">
        <h2 id="config-title">Comparison settings</h2>
      </header>

      <div className="config-grid">
        <div>
          <ColumnPicker
            label="Key columns"
            hint="Records are matched on these columns. Pick several for a composite key (in order). With no key, whole records are compared."
            columns={common}
            selected={options.keyColumns}
            onChange={(keyColumns) => set({ keyColumns })}
            ordered
            emptyText="No key - whole-record comparison"
          />
          {suggestions.length > 0 && (
            <div className="suggest">
              Suggested:{' '}
              {suggestions.map((s) => (
                <button type="button" key={s} className="chip chip-btn" onClick={() => set({ keyColumns: [...options.keyColumns, s] })}>
                  + {s}
                </button>
              ))}
            </div>
          )}
          {missingKey.length > 0 && <div className="issue issue-error">Key column(s) not in both files: {missingKey.join(', ')}</div>}
        </div>

        <div className="toggles">
          <Toggle label="Case-sensitive" checked={options.caseSensitive} onChange={(caseSensitive) => set({ caseSensitive })} />
          <Toggle label="Trim whitespace" checked={options.trimWhitespace} onChange={(trimWhitespace) => set({ trimWhitespace })} />
          <Toggle label="NULL equals empty string" checked={options.nullEqualsEmpty} onChange={(nullEqualsEmpty) => set({ nullEqualsEmpty })} />
          <Toggle label="Numeric normalization" hint="007 = 7 = 7.00; 12- = -12" checked={options.numericNormalization} onChange={(numericNormalization) => set({ numericNormalization })} />
          <Toggle label="Date normalization" hint="Same date in different formats is equal" checked={options.dateNormalization} onChange={(dateNormalization) => set({ dateNormalization })} />
          <Toggle label="Ignore column order (match by name)" hint="Off = match columns by position" checked={options.ignoreColumnOrder} onChange={(ignoreColumnOrder) => set({ ignoreColumnOrder })} />
          <Toggle label="Column names case-insensitive" checked={options.columnNamesCaseInsensitive} onChange={(columnNamesCaseInsensitive) => set({ columnNamesCaseInsensitive })} />

          <label className="field">
            Floating-point tolerance
            <input type="number" min={0} step="any" value={options.numericTolerance} onChange={(e) => set({ numericTolerance: Math.max(0, Number(e.target.value) || 0) })} />
            <span className="hint">Absolute difference allowed between numbers. 0 = exact.</span>
          </label>

          <fieldset className="field">
            <legend>Columns missing from one file</legend>
            {(
              [
                ['skip', 'Skip them (compare common columns)'],
                ['null', 'Treat as NULL (every record differs)'],
                ['error', 'Stop with an error'],
              ] as [MissingColumnMode, string][]
            ).map(([v, l]) => (
              <label key={v} className="check">
                <input type="radio" name="missingColumns" checked={options.missingColumns === v} onChange={() => set({ missingColumns: v })} /> {l}
              </label>
            ))}
          </fieldset>
        </div>

        <div>
          <ColumnPicker label="Ignore columns" hint="Not compared (e.g. load timestamps, batch ids)." columns={all} selected={options.ignoreColumns} onChange={(ignoreColumns) => set({ ignoreColumns })} disabled={options.keyColumns} />
          <ColumnPicker
            label="Compare only these columns"
            hint="Leave empty to compare every column."
            columns={all}
            selected={options.compareOnlyColumns}
            onChange={(compareOnlyColumns) => set({ compareOnlyColumns })}
            disabled={options.keyColumns}
            emptyText="All columns"
          />
          {options.dateNormalization && (
            <label className="field">
              Date formats (one per line)
              <textarea
                rows={4}
                value={datesText}
                onChange={(e) => {
                  setDatesText(e.target.value);
                  set({ dateFormats: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean) });
                }}
                spellCheck={false}
              />
              <span className="hint">Tokens: yyyy yy MM M MMM dd d HH hh mm ss SSS a · ISO-8601 is always recognised.</span>
              {dateErrors.map(([f, e]) => (
                <span key={f} className="issue issue-error">
                  {f}: {e}
                </span>
              ))}
            </label>
          )}
        </div>
      </div>

      <div className="run-bar">
        <button type="button" className="primary big" onClick={onRun} disabled={running || missingKey.length > 0 || dateErrors.length > 0}>
          {running ? 'Comparing…' : 'Compare files'}
        </button>
        <span className="muted">
          {options.keyColumns.length ? `Key: ${options.keyColumns.join(' + ')}` : 'No key selected: records are matched as whole rows.'}
        </span>
      </div>
    </section>
  );
}
