import type { FieldInfo, FieldType } from '../models/dataset';
import type { SchemaComparison, SchemaFieldComparison } from '../models/comparison';

export interface SchemaMatchOptions {
  ignoreColumnOrder: boolean;
  columnNamesCaseInsensitive: boolean;
}

export function columnNameKey(name: string, caseInsensitive: boolean): string {
  return caseInsensitive ? name.trim().toLowerCase() : name;
}

const NUMERIC: FieldType[] = ['integer', 'decimal'];
const TEMPORAL: FieldType[] = ['date', 'datetime'];

/** Types that should be reported as different. `empty` (all-null column) is compatible with anything. */
export function typesDiffer(a?: FieldType, b?: FieldType): boolean {
  if (!a || !b || a === b || a === 'empty' || b === 'empty') return false;
  if (NUMERIC.includes(a) && NUMERIC.includes(b)) return false;
  if (TEMPORAL.includes(a) && TEMPORAL.includes(b)) return false;
  return true;
}

/**
 * Compare the two field lists. Matching is by name (optionally case-insensitive)
 * or, when column order matters, by position - the usual situation for
 * headerless DataStage extracts whose columns are named COL_1..COL_n.
 */
export function compareSchemas(source: FieldInfo[], target: FieldInfo[], opts: SchemaMatchOptions): SchemaComparison {
  const fields: SchemaFieldComparison[] = [];

  if (!opts.ignoreColumnOrder) {
    const n = Math.max(source.length, target.length);
    for (let i = 0; i < n; i++) {
      const s = source[i];
      const t = target[i];
      const name = s && t && s.name !== t.name ? `${s.name} / ${t.name}` : (s ?? t).name;
      fields.push(makeField(name, s, t, s ? i : -1, t ? i : -1));
    }
  } else {
    const targetByKey = new Map<string, number>();
    target.forEach((f, i) => {
      const k = columnNameKey(f.name, opts.columnNamesCaseInsensitive);
      if (!targetByKey.has(k)) targetByKey.set(k, i);
    });
    const usedTarget = new Set<number>();
    source.forEach((s, i) => {
      const ti = targetByKey.get(columnNameKey(s.name, opts.columnNamesCaseInsensitive));
      if (ti !== undefined && !usedTarget.has(ti)) {
        usedTarget.add(ti);
        fields.push(makeField(s.name, s, target[ti], i, ti));
      } else {
        fields.push(makeField(s.name, s, undefined, i, -1));
      }
    });
    target.forEach((t, i) => {
      if (!usedTarget.has(i)) fields.push(makeField(t.name, undefined, t, -1, i));
    });
  }

  markNestedMismatches(fields);

  const common = fields.filter((f) => f.status === 'common');
  let orderDiffers = false;
  if (opts.ignoreColumnOrder) {
    for (let i = 1; i < common.length; i++) {
      if (common[i].targetIndex < common[i - 1].targetIndex) {
        orderDiffers = true;
        break;
      }
    }
  }

  return {
    fields,
    common: common.map((f) => f.name),
    sourceOnly: fields.filter((f) => f.status === 'sourceOnly').map((f) => f.name),
    targetOnly: fields.filter((f) => f.status === 'targetOnly').map((f) => f.name),
    typeMismatches: fields.filter((f) => f.typeMismatch).map((f) => f.name),
    nestedMismatches: fields.filter((f) => f.nestedMismatch).map((f) => f.name),
    orderDiffers,
    matchedBy: opts.ignoreColumnOrder ? 'name' : 'position',
  };
}

function makeField(name: string, s: FieldInfo | undefined, t: FieldInfo | undefined, si: number, ti: number): SchemaFieldComparison {
  return {
    name,
    sourceName: s?.name,
    targetName: t?.name,
    sourceIndex: si,
    targetIndex: ti,
    sourceType: s?.type,
    targetType: t?.type,
    sourceDeclaredType: s?.declaredType,
    targetDeclaredType: t?.declaredType,
    status: s && t ? 'common' : s ? 'sourceOnly' : 'targetOnly',
    typeMismatch: !!(s && t) && typesDiffer(s.type, t.type),
    nestedMismatch: false,
  };
}

/**
 * A one-sided field that is the parent or child path of a field on the other
 * side (`address` vs `address.city`) means one file holds the data nested and
 * the other flattened.
 */
function markNestedMismatches(fields: SchemaFieldComparison[]): void {
  const sourceOnly = fields.filter((f) => f.status === 'sourceOnly');
  const targetOnly = fields.filter((f) => f.status === 'targetOnly');
  if (!sourceOnly.length || !targetOnly.length) return;
  const related = (a: string, b: string) => {
    const x = a.toLowerCase();
    const y = b.toLowerCase();
    return x.startsWith(`${y}.`) || y.startsWith(`${x}.`) || x.startsWith(`${y}[`) || y.startsWith(`${x}[`);
  };
  for (const s of sourceOnly) {
    for (const t of targetOnly) {
      if (related(s.name, t.name)) {
        s.nestedMismatch = true;
        t.nestedMismatch = true;
      }
    }
  }
}
