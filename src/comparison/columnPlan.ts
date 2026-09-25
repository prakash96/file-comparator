import { AppError } from '../models/issues';
import type { ColumnPair, ComparisonOptions, SchemaComparison } from '../models/comparison';
import { columnNameKey } from './schemaCompare';

export interface ColumnPlan {
  keyPairs: ColumnPair[];
  comparedPairs: ColumnPair[];
  /** One-sided columns left out because `missingColumns` is `skip`. */
  skipped: string[];
}

/**
 * Decide which columns are keys and which are compared, applying the
 * ignore / compare-only lists and the missing-column policy.
 */
export function buildColumnPlan(schema: SchemaComparison, options: ComparisonOptions): ColumnPlan {
  const ci = options.columnNamesCaseInsensitive;
  const byKey = new Map(schema.fields.map((f) => [columnNameKey(f.name, ci), f]));
  const toKey = (n: string) => columnNameKey(n, ci);

  const keyPairs: ColumnPair[] = [];
  for (const k of options.keyColumns) {
    const f = byKey.get(toKey(k));
    if (!f) {
      throw new AppError('MISSING_KEY_COLUMN', `Key column "${k}" does not exist in either file.`);
    }
    if (f.status !== 'common') {
      const missingIn = f.status === 'sourceOnly' ? 'TARGET' : 'SOURCE';
      throw new AppError(
        'MISSING_KEY_COLUMN',
        `Key column "${k}" is missing from the ${missingIn} file. A key column must exist in both files. ` +
          'Choose a different key, or check the header row / column layout of that file.',
      );
    }
    keyPairs.push({ name: f.name, sourceIndex: f.sourceIndex, targetIndex: f.targetIndex });
  }

  const keySet = new Set(options.keyColumns.map(toKey));
  const ignore = new Set(options.ignoreColumns.map(toKey));
  const only = new Set(options.compareOnlyColumns.map(toKey));

  const comparedPairs: ColumnPair[] = [];
  const skipped: string[] = [];
  const oneSided: string[] = [];

  for (const f of schema.fields) {
    const k = toKey(f.name);
    if (keySet.has(k) || ignore.has(k)) continue;
    if (only.size > 0 && !only.has(k)) continue;
    if (f.status === 'common') {
      comparedPairs.push({ name: f.name, sourceIndex: f.sourceIndex, targetIndex: f.targetIndex });
      continue;
    }
    if (options.missingColumns === 'skip') {
      skipped.push(f.name);
    } else if (options.missingColumns === 'null') {
      comparedPairs.push({ name: f.name, sourceIndex: f.sourceIndex, targetIndex: f.targetIndex });
    } else {
      oneSided.push(`${f.name} (only in ${f.status === 'sourceOnly' ? 'SOURCE' : 'TARGET'})`);
    }
  }

  if (oneSided.length) {
    throw new AppError(
      'SCHEMA_MISMATCH',
      `The files have different columns: ${oneSided.slice(0, 10).join(', ')}${oneSided.length > 10 ? `, and ${oneSided.length - 10} more` : ''}. ` +
        'Add these to "Ignore columns", or set "Columns missing from one file" to "Treat as NULL" or "Skip".',
    );
  }

  for (const c of options.compareOnlyColumns) {
    if (!byKey.has(toKey(c))) {
      throw new AppError('UNKNOWN_COLUMN', `"Compare only" column "${c}" does not exist in either file.`);
    }
  }

  if (comparedPairs.length === 0 && keyPairs.length === 0) {
    throw new AppError('NO_COLUMNS', 'There are no columns to compare. Check the ignore / compare-only settings and that both files were parsed with the right layout.');
  }

  return { keyPairs, comparedPairs, skipped };
}
