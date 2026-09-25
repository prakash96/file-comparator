/**
 * OPTIONAL AI EXPLANATION LAYER - interface only, not implemented in v1.
 *
 * The comparator works fully offline and never calls an AI service. This file
 * defines the contract a future "explain these differences" feature would use,
 * so it can be added without touching parsing or comparison:
 *
 *   ComparisonResult --buildExplanationInput()--> ExplanationInput --provider--> Explanation
 *
 * `buildExplanationInput` only passes the compact summary (counts, schema,
 * per-column statistics) and, if explicitly allowed, a handful of sample
 * differences with values MASKED by default. Raw files are never included.
 */
import type { ComparisonResult } from '../comparison/engine';
import type { ResultViews } from '../comparison/resultViews';
import type { ComparisonSummary } from '../models/comparison';

export interface ExplanationInput {
  counts: ComparisonSummary['counts'];
  mode: ComparisonSummary['mode'];
  keyColumns: string[];
  columnDifferences: ComparisonSummary['columnStats'];
  schema: Pick<ComparisonSummary['schema'], 'sourceOnly' | 'targetOnly' | 'typeMismatches' | 'orderDiffers'>;
  /** Sample field-level changes. Values are masked unless `includeValues` was requested. */
  samples: { column: string; source: string | null; target: string | null }[];
}

export interface Explanation {
  text: string;
}

/** Implement this to plug in an explanation service (local model, approved enterprise endpoint...). */
export interface ExplanationProvider {
  readonly name: string;
  explain(input: ExplanationInput, signal?: AbortSignal): Promise<Explanation>;
}

/** Keeps the shape of a value (length, digits vs letters) without revealing it. */
export function maskValue(v: string | null): string | null {
  if (v === null) return null;
  return v.replace(/[A-Za-z]/g, 'x').replace(/\d/g, '9');
}

export function buildExplanationInput(
  result: ComparisonResult,
  views: ResultViews,
  opts: { maxSamples?: number; includeValues?: boolean } = {},
): ExplanationInput {
  const s = result.summary;
  const max = opts.maxSamples ?? 20;
  const pick = opts.includeValues ? (v: string | null) => v : maskValue;
  const samples: ExplanationInput['samples'] = [];
  for (const row of views.rows('modified', max)) {
    for (const d of row.diffs ?? []) {
      if (samples.length >= max) break;
      samples.push({ column: d.column, source: pick(d.source), target: pick(d.target) });
    }
  }
  return {
    counts: s.counts,
    mode: s.mode,
    keyColumns: s.keyColumns,
    columnDifferences: s.columnStats,
    schema: { sourceOnly: s.schema.sourceOnly, targetOnly: s.schema.targetOnly, typeMismatches: s.schema.typeMismatches, orderDiffers: s.schema.orderDiffers },
    samples,
  };
}
