import type { CellValue, FieldInfo } from '../models/dataset';

export function Cell({ v }: { v: CellValue | undefined }) {
  if (v === null || v === undefined) return <span className="null">NULL</span>;
  if (v === '') return <span className="null">(empty)</span>;
  return <>{v}</>;
}

/** Small preview of the first records (already capped at 100 rows by the worker). */
export function PreviewTable({ fields, rows }: { fields: FieldInfo[]; rows: CellValue[][] }) {
  return (
    <div className="table-scroll preview">
      <table className="data">
        <thead>
          <tr>
            <th className="num">#</th>
            {fields.map((f) => (
              <th key={f.name} title={f.declaredType ?? f.type}>
                {f.name}
                <span className="type-tag">{f.declaredType ?? f.type}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td className="num muted">{i + 1}</td>
              {fields.map((f, c) => (
                <td key={f.name}>
                  <Cell v={r[c]} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
