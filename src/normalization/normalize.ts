import type { CellValue } from '../models/dataset';
import { buildRuleContext, NORMALIZATION_RULES, type NormalizationOptions, type NormalizationRule } from './rules';

export type { NormalizationOptions } from './rules';

export type Normalizer = (value: CellValue) => CellValue;

/** Compile the enabled rules for `options` into one fast function. Reuse it for every cell. */
export function createNormalizer(options: NormalizationOptions, rules: NormalizationRule[] = NORMALIZATION_RULES): Normalizer {
  const active = rules.filter((r) => r.isEnabled(options));
  const ctx = buildRuleContext(options);
  const nullEqualsEmpty = options.nullEqualsEmpty;
  if (active.length === 0) return (v) => v;
  return (value) => {
    if (value === null) return null;
    let v: string | null = value;
    for (let i = 0; i < active.length; i++) {
      v = active[i].apply(v, options, ctx);
      if (v === null) return null;
    }
    // A rule (e.g. trim) may produce '' after nullEmptyRule already ran.
    return nullEqualsEmpty && v === '' ? null : v;
  };
}

/** Convenience single-value API: `normalize(value, options)`. Prefer `createNormalizer` in loops. */
export function normalize(value: CellValue, options: NormalizationOptions): CellValue {
  return createNormalizer(options)(value);
}

export type ValueComparer = (a: CellValue, b: CellValue) => boolean;

/**
 * Equality used by the comparison engine: normalize both sides, compare the
 * canonical strings, and fall back to numeric tolerance when configured.
 * Identical raw values short-circuit without normalizing, which is the common case.
 */
export function createValueComparer(options: NormalizationOptions & { numericTolerance: number }): ValueComparer {
  const norm = createNormalizer(options);
  const tol = Math.max(0, options.numericTolerance || 0);
  return (a, b) => {
    if (a === b) return true;
    const na = norm(a);
    const nb = norm(b);
    if (na === nb) return true;
    if (tol > 0 && na !== null && nb !== null) {
      const x = Number(na);
      const y = Number(nb);
      if (na.trim() !== '' && nb.trim() !== '' && Number.isFinite(x) && Number.isFinite(y)) {
        // Small relative epsilon absorbs binary floating-point noise at the boundary.
        return Math.abs(x - y) <= tol + Math.max(Math.abs(x), Math.abs(y)) * 1e-12;
      }
    }
    return false;
  };
}
