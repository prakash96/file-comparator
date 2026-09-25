import type { CellValue } from '../models/dataset';
import type { ResultView } from '../models/views';
import { APP_NAME, APP_VERSION, countRows, fileRows, fmt, formatMs, optionRows, reconciliationText } from './summaryData';
import type { ReportContext, ReportGenerator } from './types';

/** Detail rows embedded per category; the full lists are in the CSV / Excel exports. */
export const HTML_DETAIL_LIMIT = 1000;

const esc = (v: CellValue | number | undefined) =>
  v === null || v === undefined
    ? '<span class="null">NULL</span>'
    : String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const kv = (rows: [string, string | number][]) =>
  `<table class="kv">${rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(typeof v === 'number' ? fmt(v) : v)}</td></tr>`).join('')}</table>`;

const STYLE = `
:root{--bg:#f6f7f9;--panel:#fff;--text:#1b2430;--muted:#5b6675;--line:#dde2e8;--accent:#1f5fae;
--added:#1a7f37;--removed:#c62828;--modified:#b26a00;--unchanged:#56627a;--dup:#7b3fb5;--code:#eef1f5}
@media (prefers-color-scheme:dark){:root{--bg:#12161c;--panel:#1a2029;--text:#e6ebf1;--muted:#98a3b3;--line:#2c3542;
--accent:#6aa5ff;--added:#4cc26b;--removed:#ff6b6b;--modified:#f0a830;--unchanged:#9aa7bb;--dup:#b78bea;--code:#232b36}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:1200px;margin:0 auto;padding:24px 16px 64px}h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:32px 0 12px;border-bottom:1px solid var(--line);padding-bottom:6px}
.muted{color:var(--muted)}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:12px 14px}.card .n{font-size:22px;font-weight:600;font-variant-numeric:tabular-nums}
.card .l{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.04em}
.added .n{color:var(--added)}.removed .n{color:var(--removed)}.modified .n{color:var(--modified)}.unchanged .n{color:var(--unchanged)}.dup .n{color:var(--dup)}
.two{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px}
table{border-collapse:collapse;width:100%;background:var(--panel);font-size:13px}th,td{border:1px solid var(--line);padding:4px 8px;text-align:left;vertical-align:top}
th{background:var(--code);font-weight:600}table.kv th{width:40%;background:transparent;font-weight:500;color:var(--muted)}
.scroll{overflow-x:auto;max-width:100%}td{font-variant-numeric:tabular-nums;white-space:pre-wrap;word-break:break-word}
.null{color:var(--muted);font-style:italic;font-size:11px}.ok{color:var(--added)}.bad{color:var(--removed);font-weight:600}
details{margin:10px 0;background:var(--panel);border:1px solid var(--line);border-radius:8px}summary{cursor:pointer;padding:10px 14px;font-weight:600}
details>div{padding:0 14px 14px}.bar{display:flex;height:14px;border-radius:4px;overflow:hidden;background:var(--code);margin:8px 0}
.bar span{display:block;height:100%}.legend{display:flex;gap:16px;flex-wrap:wrap;font-size:12px;color:var(--muted)}
.dot{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px;vertical-align:-1px}
.diff td.s{color:var(--removed)}.diff td.t{color:var(--added)}code,pre{background:var(--code);border-radius:4px;padding:1px 4px}
.note{border-left:3px solid var(--accent);padding:6px 10px;background:var(--panel);margin:8px 0}
.issue.error{border-left-color:var(--removed)}.issue.warning{border-left-color:var(--modified)}
`;

function distributionBar(ctx: ReportContext): string {
  const c = ctx.result.summary.counts;
  const parts: [string, number, string][] = [
    ['Unchanged', c.unchanged, 'var(--unchanged)'],
    ['Modified', c.modified, 'var(--modified)'],
    ['Added', c.added, 'var(--added)'],
    ['Removed', c.removed, 'var(--removed)'],
    ['Duplicate-key records', c.duplicateSourceRecords + c.duplicateTargetRecords, 'var(--dup)'],
  ];
  const total = parts.reduce((n, p) => n + p[1], 0) || 1;
  return `<div class="bar" role="img" aria-label="Distribution of results">${parts
    .filter((p) => p[1] > 0)
    .map(([l, n, col]) => `<span style="width:${((n / total) * 100).toFixed(3)}%;background:${col}" title="${l}: ${fmt(n)}"></span>`)
    .join('')}</div><div class="legend">${parts
    .map(([l, n, col]) => `<span><span class="dot" style="background:${col}"></span>${l}: ${fmt(n)}</span>`)
    .join('')}</div>`;
}

function detailTable(ctx: ReportContext, view: ResultView, title: string): string {
  const total = ctx.views.size(view);
  if (total === 0) return `<details><summary>${title} (0)</summary><div class="muted">None.</div></details>`;
  const keys = ctx.views.keyColumns;
  let body = '';
  if (view === 'modified') {
    body += `<table class="diff"><tr>${keys.map((k) => `<th>${esc(k)}</th>`).join('')}<th>Records (S/T)</th><th>Field</th><th>Source</th><th>Target</th></tr>`;
    for (const r of ctx.views.rows(view, HTML_DETAIL_LIMIT)) {
      const diffs = r.diffs ?? [];
      diffs.forEach((d, i) => {
        body += '<tr>';
        if (i === 0) {
          body += r.key.map((k) => `<td rowspan="${diffs.length}">${esc(k)}</td>`).join('');
          body += `<td rowspan="${diffs.length}">${r.sourceRecord} / ${r.targetRecord}</td>`;
        }
        body += `<td>${esc(d.column)}</td><td class="s">${esc(d.source)}</td><td class="t">${esc(d.target)}</td></tr>`;
      });
    }
    body += '</table>';
  } else {
    const cols = ctx.views.columns(view);
    const lead = view === 'duplicates' ? ['Group', 'Side', 'Record'] : view === 'unchanged' ? ['Records (S/T)'] : ['Record'];
    body += `<table><tr>${[...lead, ...cols].map((c) => `<th>${esc(c)}</th>`).join('')}</tr>`;
    for (const r of ctx.views.rows(view, HTML_DETAIL_LIMIT)) {
      const leadCells =
        view === 'duplicates'
          ? [r.group, r.side?.toUpperCase(), r.side === 'source' ? r.sourceRecord : r.targetRecord]
          : view === 'unchanged'
            ? [`${r.sourceRecord} / ${r.targetRecord}`]
            : [r.sourceRecord ?? r.targetRecord];
      body += `<tr>${[...leadCells, ...(r.values ?? [])].map((v) => `<td>${esc(v as CellValue)}</td>`).join('')}</tr>`;
    }
    body += '</table>';
  }
  const more = total > HTML_DETAIL_LIMIT ? `<p class="muted">Showing the first ${fmt(HTML_DETAIL_LIMIT)} of ${fmt(total)}. Export CSV or Excel for the complete list.</p>` : '';
  return `<details${view === 'modified' ? ' open' : ''}><summary>${title} (${fmt(total)})</summary><div>${more}<div class="scroll">${body}</div></div></details>`;
}

export function renderHtmlReport(ctx: ReportContext): string {
  const s = ctx.result.summary;
  const c = s.counts;
  const card = (cls: string, label: string, n: number) => `<div class="card ${cls}"><div class="l">${label}</div><div class="n">${fmt(n)}</div></div>`;
  const rec = reconciliationText(ctx);
  const matched = c.modified + c.unchanged;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>Comparison report - ${esc(ctx.source.fileName)} vs ${esc(ctx.target.fileName)}</title><style>${STYLE}</style></head>
<body><main>
<h1>File comparison report</h1>
<div class="muted">${esc(ctx.source.fileName)} → ${esc(ctx.target.fileName)} · generated ${esc(ctx.generatedAt.toISOString())} by ${APP_NAME} ${APP_VERSION} · processed locally in the browser</div>

<h2>Summary</h2>
<div class="grid">
${card('', 'Source records', c.sourceTotal)}${card('', 'Target records', c.targetTotal)}${card('added', 'Added', c.added)}${card('removed', 'Removed', c.removed)}
${card('modified', 'Modified', c.modified)}${card('unchanged', 'Unchanged', c.unchanged)}${card('dup', 'Duplicate keys', c.duplicateKeys)}
<div class="card"><div class="l">Comparison time</div><div class="n">${esc(formatMs(s.timing.totalMs))}</div></div>
</div>
${distributionBar(ctx)}
<div class="note">${rec.map((t) => `<div class="${t.includes('MISMATCH') ? 'bad' : ''}">${esc(t)}</div>`).join('')}</div>

<h2>Execution</h2>
${kv([
  ['Generated', ctx.generatedAt.toISOString()],
  ['Mode', s.mode === 'key' ? `Key comparison on ${s.keyColumns.join(' + ')}` : 'Whole-record comparison (no key)'],
  ['Columns compared', s.comparedColumns.length],
  ['Index build time', formatMs(s.timing.indexMs)],
  ['Compare time', formatMs(s.timing.compareMs)],
  ['Total comparison time', formatMs(s.timing.totalMs)],
])}

<div class="two">
<div><h2>Source file</h2>${kv(fileRows(ctx.source))}</div>
<div><h2>Target file</h2>${kv(fileRows(ctx.target))}</div>
</div>

<h2>Configuration</h2>
${kv(optionRows(s.options))}

<h2>Statistics</h2>
${kv(countRows(ctx))}

<h2>Schema comparison</h2>
<p class="muted">${fmt(s.schema.common.length)} common · ${fmt(s.schema.sourceOnly.length)} source only · ${fmt(s.schema.targetOnly.length)} target only · ${fmt(s.schema.typeMismatches.length)} type difference(s)${s.schema.orderDiffers ? ' · column order differs' : ''}</p>
<div class="scroll"><table><tr><th>Column</th><th>Status</th><th>Source type</th><th>Target type</th><th>Notes</th></tr>
${s.schema.fields
  .map(
    (f) =>
      `<tr><td>${esc(f.name)}</td><td>${{ common: 'In both', sourceOnly: '<span class="bad">Source only</span>', targetOnly: '<span class="bad">Target only</span>' }[f.status]}</td><td>${esc(f.sourceDeclaredType ?? f.sourceType ?? '')}</td><td>${esc(f.targetDeclaredType ?? f.targetType ?? '')}</td><td>${[f.typeMismatch ? 'type differs' : '', f.nestedMismatch ? 'nested vs flattened' : ''].filter(Boolean).join(', ')}</td></tr>`,
  )
  .join('')}
</table></div>

<h2>Column differences</h2>
${s.columnStats.length ? `<div class="scroll"><table><tr><th>Column</th><th>Modified records where it differs</th><th>% of matched records</th></tr>
${s.columnStats.map((x) => `<tr><td>${esc(x.column)}</td><td>${fmt(x.differences)}</td><td>${matched ? ((x.differences / matched) * 100).toFixed(2) : '0.00'}%</td></tr>`).join('')}</table></div>` : '<p class="muted">No columns compared.</p>'}

${s.issues.length ? `<h2>Warnings</h2>${s.issues.map((i) => `<div class="note issue ${i.severity}">${esc(i.message)}</div>`).join('')}` : ''}

<h2>Differences</h2>
${detailTable(ctx, 'modified', 'Modified')}
${detailTable(ctx, 'added', 'Added')}
${detailTable(ctx, 'removed', 'Removed')}
${detailTable(ctx, 'duplicates', 'Duplicate keys')}
</main></body></html>`;
}

export const htmlReport: ReportGenerator = {
  kind: 'html',
  label: 'HTML report',
  async generate(ctx) {
    const html = renderHtmlReport(ctx);
    const notes = (['modified', 'added', 'removed', 'duplicates'] as ResultView[])
      .filter((v) => ctx.views.size(v) > HTML_DETAIL_LIMIT)
      .map((v) => `The HTML report lists the first ${fmt(HTML_DETAIL_LIMIT)} ${v} records; use CSV/Excel for all ${fmt(ctx.views.size(v))}.`);
    return { fileName: 'comparison-report.html', mimeType: 'text/html', blob: new Blob([html], { type: 'text/html;charset=utf-8' }), notes };
  },
};
