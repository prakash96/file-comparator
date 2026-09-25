import type { CellValue, Dataset } from '../../src/models/dataset';
import { defaultComparisonOptions, type ComparisonOptions } from '../../src/models/comparison';

export function ds(fields: string[], records: CellValue[][]): Dataset {
  return { fields: fields.map((name) => ({ name, type: 'string' })), records };
}

export function opts(overrides: Partial<ComparisonOptions> = {}): ComparisonOptions {
  return { ...defaultComparisonOptions(), ...overrides };
}
