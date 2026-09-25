import { APP_NAME, APP_VERSION } from './summaryData';
import type { ReportContext, ReportFileInfo, ReportGenerator } from './types';

const fileSummary = (f: ReportFileInfo) => ({
  fileName: f.fileName,
  fileSize: f.fileSize,
  format: f.format,
  recordCount: f.recordCount,
  parseMs: Math.round(f.parseMs),
  fields: f.fields.map((x) => ({ name: x.name, type: x.type, declaredType: x.declaredType })),
});

/**
 * Machine-readable summary: counts, configuration, schema and per-column
 * statistics. It deliberately contains no record values, so it is safe to
 * attach to tickets or feed to downstream tooling (including a future AI layer).
 */
export function buildJsonSummary(ctx: ReportContext) {
  const s = ctx.result.summary;
  return {
    tool: { name: APP_NAME, version: APP_VERSION },
    generatedAt: ctx.generatedAt.toISOString(),
    files: { source: fileSummary(ctx.source), target: fileSummary(ctx.target) },
    mode: s.mode,
    keyColumns: s.keyColumns,
    comparedColumns: s.comparedColumns,
    skippedColumns: s.skippedColumns,
    counts: s.counts,
    reconciliation: s.reconciliation,
    columnDifferences: s.columnStats,
    schema: {
      matchedBy: s.schema.matchedBy,
      common: s.schema.common,
      sourceOnly: s.schema.sourceOnly,
      targetOnly: s.schema.targetOnly,
      typeMismatches: s.schema.typeMismatches,
      nestedMismatches: s.schema.nestedMismatches,
      orderDiffers: s.schema.orderDiffers,
    },
    options: s.options,
    timing: { indexMs: Math.round(s.timing.indexMs), compareMs: Math.round(s.timing.compareMs), totalMs: Math.round(s.timing.totalMs) },
    issues: s.issues.map(({ severity, code, message, count }) => ({ severity, code, message, count })),
  };
}

export const jsonSummaryReport: ReportGenerator = {
  kind: 'json-summary',
  label: 'JSON summary',
  async generate(ctx) {
    const text = JSON.stringify(buildJsonSummary(ctx), null, 2);
    return { fileName: 'comparison-summary.json', mimeType: 'application/json', blob: new Blob([text], { type: 'application/json' }), notes: [] };
  },
};
