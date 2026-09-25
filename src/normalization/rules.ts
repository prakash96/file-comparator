import { compileDateFormat, parseIsoDate, type DateParser } from './dateFormat';

/** Options that affect how a single value is normalized before comparison. */
export interface NormalizationOptions {
  caseSensitive: boolean;
  trimWhitespace: boolean;
  nullEqualsEmpty: boolean;
  numericNormalization: boolean;
  dateNormalization: boolean;
  dateFormats: string[];
}

/** Precomputed state shared by all rules of one normalizer (compiled date patterns etc.). */
export interface RuleContext {
  dateParsers: DateParser[];
}

/**
 * A normalization rule transforms a non-null string value. Rules run in the
 * order of `NORMALIZATION_RULES`; a rule returning `null` turns the value into
 * NULL and stops the pipeline.
 *
 * To add a rule: implement this interface, append it to `NORMALIZATION_RULES`
 * at the right position, and add an option to `NormalizationOptions` /
 * `ComparisonOptions` if it should be switchable.
 */
export interface NormalizationRule {
  id: string;
  description: string;
  isEnabled(options: NormalizationOptions): boolean;
  apply(value: string, options: NormalizationOptions, ctx: RuleContext): string | null;
}

/* ----------------------------------------------------------- numbers */

const PLAIN_NUMBER = /^([+-])?(\d*)(?:\.(\d*))?$/;
const TRAILING_SIGN = /^(\d*(?:\.\d*)?)([+-])$/; // COBOL / DataStage display numerics: 123.45-
const EXPONENT_NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)[eE][+-]?\d+$/;

/**
 * Canonical decimal string for a numeric value, or null if `s` is not a number.
 * Works on the text, so long DECIMAL(38,x) values keep every digit
 * (`00123.4500` -> `123.45`, `-0.0` -> `0`, `12-` -> `-12`).
 */
export function canonicalNumber(s: string): string | null {
  let text = s;
  const trailing = TRAILING_SIGN.exec(text);
  if (trailing && trailing[1] !== '') text = trailing[2] + trailing[1];
  const m = PLAIN_NUMBER.exec(text);
  if (m) {
    const intPart = m[2] ?? '';
    const fracPart = m[3] ?? '';
    if (intPart === '' && fracPart === '') return null;
    const int = intPart.replace(/^0+/, '');
    const frac = fracPart.replace(/0+$/, '');
    if (int === '' && frac === '') return '0';
    return `${m[1] === '-' ? '-' : ''}${int || '0'}${frac ? `.${frac}` : ''}`;
  }
  if (EXPONENT_NUMBER.test(text)) {
    const n = Number(text);
    if (!Number.isFinite(n)) return null;
    if (n === 0) return '0';
    const plain = Math.abs(n) >= 1e-6 && Math.abs(n) < 1e21 ? String(n) : null;
    return plain !== null && !/e/i.test(plain) ? canonicalNumber(plain) : String(n);
  }
  return null;
}

/* ----------------------------------------------------------- rules */

export const trimRule: NormalizationRule = {
  id: 'trim',
  description: 'Remove leading and trailing whitespace',
  isEnabled: (o) => o.trimWhitespace,
  apply: (v) => v.trim(),
};

export const nullEmptyRule: NormalizationRule = {
  id: 'null-empty',
  description: "Treat empty string as NULL",
  isEnabled: (o) => o.nullEqualsEmpty,
  apply: (v) => (v === '' ? null : v),
};

export const dateRule: NormalizationRule = {
  id: 'date',
  description: 'Rewrite recognised dates/timestamps to yyyy-MM-dd[ HH:mm:ss[.f]]',
  isEnabled: (o) => o.dateNormalization,
  apply: (v, _o, ctx) => {
    // Cheap pre-check: every supported date has at least one digit.
    if (v.length < 6 || !/\d/.test(v)) return v;
    for (const parse of ctx.dateParsers) {
      const d = parse(v);
      if (d !== null) return d;
    }
    return v;
  },
};

export const numberRule: NormalizationRule = {
  id: 'number',
  description: 'Rewrite numbers to a canonical decimal form (007 = 7 = 7.00)',
  isEnabled: (o) => o.numericNormalization,
  apply: (v) => canonicalNumber(v) ?? v,
};

export const caseRule: NormalizationRule = {
  id: 'case',
  description: 'Lower-case text for case-insensitive comparison',
  isEnabled: (o) => !o.caseSensitive,
  apply: (v) => v.toLowerCase(),
};

/** Rules in execution order. Date runs before number so `20240131` is read as a date when a matching pattern is configured. */
export const NORMALIZATION_RULES: NormalizationRule[] = [trimRule, nullEmptyRule, dateRule, numberRule, caseRule];

export function buildRuleContext(options: NormalizationOptions): RuleContext {
  const dateParsers: DateParser[] = [parseIsoDate];
  if (options.dateNormalization) {
    for (const f of options.dateFormats) {
      if (!f.trim()) continue;
      try {
        dateParsers.push(compileDateFormat(f.trim()));
      } catch {
        // Invalid patterns are reported by the UI validator; ignore here.
      }
    }
  }
  return { dateParsers };
}
