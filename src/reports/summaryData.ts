import { FILE_FORMAT_LABELS } from '../models/dataset';
import type { ComparisonOptions } from '../models/comparison';
import type { ReportContext, ReportFileInfo } from './types';

export const APP_NAME = 'File Comparator';
export const APP_VERSION = '1.0.0';

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = -1;
  do {
    v /= 1024;
    i++;
  } while (v >= 1024 && i < units.length - 1);
  return `${v.toFixed(v < 10 ? 2 : 1)} ${units[i]}`;
}

export const fmt = (n: number) => n.toLocaleString('en-US');

export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(2)} s`;
  return `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s`;
}

export function fileRows(f: ReportFileInfo): [string, string][] {
  return [
    ['File name', f.fileName],
    ['Size', formatBytes(f.fileSize)],
    ['Format', FILE_FORMAT_LABELS[f.format]],
    ['Records', fmt(f.recordCount)],
    ['Columns', fmt(f.fields.length)],
    ['Parse time', formatMs(f.parseMs)],
  ];
}

export function optionRows(o: ComparisonOptions): [string, string][] {
  const yn = (b: boolean) => (b ? 'Yes' : 'No');
  return [
    ['Key columns', o.keyColumns.length ? o.keyColumns.join(' + ') : '(none - whole-record comparison)'],
    ['Case-sensitive', yn(o.caseSensitive)],
    ['Trim whitespace', yn(o.trimWhitespace)],
    ['NULL equals empty string', yn(o.nullEqualsEmpty)],
    ['Numeric normalization', yn(o.numericNormalization)],
    ['Numeric tolerance', String(o.numericTolerance)],
    ['Date normalization', o.dateNormalization ? `Yes (${o.dateFormats.join(', ')})` : 'No'],
    ['Match columns by', o.ignoreColumnOrder ? `name${o.columnNamesCaseInsensitive ? ' (case-insensitive)' : ''}` : 'position'],
    ['Ignored columns', o.ignoreColumns.join(', ') || '(none)'],
    ['Compare only', o.compareOnlyColumns.join(', ') || '(all columns)'],
    ['Columns missing from one file', { skip: 'Skipped', null: 'Treated as NULL', error: 'Error' }[o.missingColumns]],
  ];
}

export function countRows(ctx: ReportContext): [string, number][] {
  const c = ctx.result.summary.counts;
  return [
    ['Source records', c.sourceTotal],
    ['Target records', c.targetTotal],
    ['Added', c.added],
    ['Removed', c.removed],
    ['Modified', c.modified],
    ['Unchanged', c.unchanged],
    ['Duplicate keys', c.duplicateKeys],
    ['Duplicate-key records (source)', c.duplicateSourceRecords],
    ['Duplicate-key records (target)', c.duplicateTargetRecords],
    ['Records with empty key (source)', c.missingKeySource],
    ['Records with empty key (target)', c.missingKeyTarget],
  ];
}

export function reconciliationText(ctx: ReportContext): string[] {
  const c = ctx.result.summary.counts;
  const r = ctx.result.summary.reconciliation;
  return [
    `Source ${fmt(c.sourceTotal)} = removed ${fmt(c.removed)} + modified ${fmt(c.modified)} + unchanged ${fmt(c.unchanged)} + duplicate-key ${fmt(c.duplicateSourceRecords)} + empty-key ${fmt(c.missingKeySource)} = ${fmt(r.sourceAccounted)} ${r.sourceBalanced ? '✓' : '✗ MISMATCH'}`,
    `Target ${fmt(c.targetTotal)} = added ${fmt(c.added)} + modified ${fmt(c.modified)} + unchanged ${fmt(c.unchanged)} + duplicate-key ${fmt(c.duplicateTargetRecords)} + empty-key ${fmt(c.missingKeyTarget)} = ${fmt(r.targetAccounted)} ${r.targetBalanced ? '✓' : '✗ MISMATCH'}`,
  ];
}
