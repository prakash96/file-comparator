import { describe, expect, it } from 'vitest';
import { createValueComparer, normalize } from '../src/normalization/normalize';
import { canonicalNumber } from '../src/normalization/rules';
import { compileDateFormat, parseIsoDate, validateDateFormat } from '../src/normalization/dateFormat';
import { defaultComparisonOptions } from '../src/models/comparison';

const o = (x: Partial<ReturnType<typeof defaultComparisonOptions>> = {}) => ({ ...defaultComparisonOptions(), ...x });

describe('normalize()', () => {
  it('trims and maps empty to null', () => {
    expect(normalize('  a ', o())).toBe('a');
    expect(normalize('   ', o())).toBeNull();
    expect(normalize('   ', o({ nullEqualsEmpty: false }))).toBe('');
    expect(normalize(' a ', o({ trimWhitespace: false }))).toBe(' a ');
  });

  it('lower-cases when case-insensitive', () => {
    expect(normalize('MiXeD', o({ caseSensitive: false }))).toBe('mixed');
    expect(normalize('MiXeD', o())).toBe('MiXeD');
  });

  it('canonicalises numbers without floating point loss', () => {
    expect(canonicalNumber('007.500')).toBe('7.5');
    expect(canonicalNumber('-0.00')).toBe('0');
    expect(canonicalNumber('+12')).toBe('12');
    expect(canonicalNumber('123.45-')).toBe('-123.45');
    expect(canonicalNumber('.5')).toBe('0.5');
    expect(canonicalNumber('1.5e3')).toBe('1500');
    expect(canonicalNumber('12345678901234567890.123456789')).toBe('12345678901234567890.123456789');
    expect(canonicalNumber('12a')).toBeNull();
    expect(canonicalNumber('.')).toBeNull();
    expect(canonicalNumber('')).toBeNull();
  });

  it('parses configured date formats', () => {
    expect(compileDateFormat('MM/dd/yyyy')('01/31/2024')).toBe('2024-01-31');
    expect(compileDateFormat('dd-MMM-yyyy')('05-feb-2023')).toBe('2023-02-05');
    expect(compileDateFormat('yyyyMMdd')('20240230')).toBeNull(); // invalid day
    expect(compileDateFormat('MM/dd/yyyy hh:mm a')('01/31/2024 01:05 PM')).toBe('2024-01-31 13:05:00');
    expect(compileDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS")('2024-01-31T10:00:00.120')).toBe('2024-01-31 10:00:00.12');
    expect(validateDateFormat('HH:mm')).toMatch(/year/);
    expect(validateDateFormat('yyyy-MM-dd')).toBeNull();
  });

  it('parses ISO timestamps and converts offsets to UTC', () => {
    expect(parseIsoDate('2024-01-31T23:30:00-02:00')).toBe('2024-02-01 01:30:00');
    expect(parseIsoDate('2024-01-31 00:00:00')).toBe('2024-01-31');
    expect(parseIsoDate('2024-13-01')).toBeNull();
  });

  it('value comparer applies tolerance only to numbers', () => {
    const eq = createValueComparer({ ...o({ numericNormalization: true }), numericTolerance: 0.01 });
    expect(eq('1.004', '1.0')).toBe(true);
    expect(eq('1.02', '1.0')).toBe(false);
    expect(eq('abc', 'abd')).toBe(false);
    expect(eq(null, '')).toBe(true);
  });
});
