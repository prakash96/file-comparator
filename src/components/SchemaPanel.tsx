import { useState } from 'react';
import type { SchemaComparison } from '../models/comparison';

const STATUS_LABEL = { common: 'In both', sourceOnly: 'Source only', targetOnly: 'Target only' } as const;

export function SchemaPanel({ schema }: { schema: SchemaComparison }) {
  const [onlyDiffs, setOnlyDiffs] = useState(false);
  const rows = onlyDiffs ? schema.fields.filter((f) => f.status !== 'common' || f.typeMismatch || f.nestedMismatch) : schema.fields;
  const problems = schema.sourceOnly.length + schema.targetOnly.length + schema.typeMismatches.length;

  return (
    <section className="panel" aria-labelledby="schema-title">
      <header className="panel-head">
        <h2 id="schema-title">Schema comparison</h2>
        <label className="check">
          <input type="checkbox" checked={onlyDiffs} onChange={(e) => setOnlyDiffs(e.target.checked)} /> Show differences only
        </label>
      </header>
      <div className="schema-stats">
        <span className="pill pill-ok">{schema.common.length} common</span>
        <span className={`pill ${schema.sourceOnly.length ? 'pill-bad' : ''}`}>{schema.sourceOnly.length} only in source</span>
        <span className={`pill ${schema.targetOnly.length ? 'pill-bad' : ''}`}>{schema.targetOnly.length} only in target</span>
        <span className={`pill ${schema.typeMismatches.length ? 'pill-warn' : ''}`}>{schema.typeMismatches.length} type differences</span>
        {schema.nestedMismatches.length > 0 && <span className="pill pill-warn">{schema.nestedMismatches.length} nested vs flattened</span>}
        {schema.orderDiffers && <span className="pill pill-warn">column order differs</span>}
        <span className="muted">Matched by {schema.matchedBy}</span>
      </div>
      {problems === 0 && !schema.orderDiffers && <p className="muted">Both files have the same columns.</p>}
      <div className="table-scroll schema-table">
        <table className="data">
          <thead>
            <tr>
              <th>Source column</th>
              <th>Source type</th>
              <th>Target column</th>
              <th>Target type</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((f) => (
              <tr key={`${f.sourceIndex}:${f.targetIndex}`} className={f.status !== 'common' ? 'row-bad' : f.typeMismatch || f.nestedMismatch ? 'row-warn' : ''}>
                <td>{f.sourceName ?? <span className="muted">—</span>}</td>
                <td className="muted">{f.sourceDeclaredType ?? f.sourceType ?? ''}</td>
                <td>{f.targetName ?? <span className="muted">—</span>}</td>
                <td className="muted">{f.targetDeclaredType ?? f.targetType ?? ''}</td>
                <td>
                  {STATUS_LABEL[f.status]}
                  {f.typeMismatch && ' · type differs'}
                  {f.nestedMismatch && ' · nested vs flattened'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
