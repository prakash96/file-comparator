import { parse as parseYaml, YAMLParseError } from 'yaml';
import { FFD_TYPES, type FfdForm, type FfdFormat, type FfdItem, type FfdSchema, type FfdSegment, type FfdUsage, type FfdValue } from './model';

/** A schema that cannot be used. `problems` lists every issue found, not just the first. */
export class FfdError extends Error {
  constructor(
    message: string,
    readonly problems: string[] = [],
  ) {
    super(message);
    this.name = 'FfdError';
  }
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown) => (v === undefined || v === null ? undefined : String(v));

const USAGES: FfdUsage[] = ['M', 'O', 'C', 'U'];

function parseCount(v: unknown, where: string, problems: string[]): number {
  if (v === undefined || v === null) return 1;
  const s = String(v).trim();
  if (s === '>1') return Infinity;
  const n = Number(s);
  if (Number.isInteger(n) && n >= 1) return n;
  problems.push(`${where}: count "${s}" must be a whole number or '>1'.`);
  return 1;
}

function parseUsage(v: unknown, where: string, problems: string[]): FfdUsage {
  if (v === undefined || v === null) return 'M';
  const u = String(v).toUpperCase() as FfdUsage;
  if (USAGES.includes(u)) return u;
  problems.push(`${where}: usage "${String(v)}" must be M, O, C or U.`);
  return 'O';
}

function parseValue(raw: unknown, where: string, problems: string[]): FfdValue | null {
  if (!isObj(raw)) {
    problems.push(`${where}: expected { name, type, length }.`);
    return null;
  }
  const name = str(raw.name);
  const length = Number(raw.length);
  if (!name) problems.push(`${where}: missing name.`);
  if (!Number.isInteger(length) || length <= 0) problems.push(`${where}${name ? ` (${name})` : ''}: length must be a positive whole number.`);
  const typeRaw = str(raw.type) ?? 'String';
  const type = FFD_TYPES.find((t) => t.toLowerCase() === typeRaw.toLowerCase());
  if (!type) problems.push(`${where}${name ? ` (${name})` : ''}: unknown type "${typeRaw}" (use ${FFD_TYPES.join(', ')}).`);
  if (!name || !Number.isInteger(length) || length <= 0) return null;

  const value: FfdValue = { name, type: type ?? 'String', length };
  if (raw.tagValue !== undefined && raw.tagValue !== null) value.tagValue = String(raw.tagValue);
  if (raw.usage !== undefined) value.usage = parseUsage(raw.usage, where, problems);
  if (isObj(raw.format)) {
    const f: FfdFormat = {};
    const justify = str(raw.format.justify)?.toUpperCase();
    if (justify === 'LEFT' || justify === 'RIGHT') f.justify = justify;
    if (raw.format.pad !== undefined) f.pad = String(raw.format.pad);
    if (raw.format.implicit !== undefined) f.implicit = Number(raw.format.implicit) || 0;
    if (raw.format.pattern !== undefined) f.pattern = String(raw.format.pattern);
    value.format = f;
  }
  return value;
}

function parseValues(raw: unknown, where: string, problems: string[]): FfdValue[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    problems.push(`${where}: "values" must be a non-empty list of fields.`);
    return [];
  }
  return raw.map((v, i) => parseValue(v, `${where}, value ${i + 1}`, problems)).filter((v): v is FfdValue => v !== null);
}

function parseItems(raw: unknown, where: string, problems: string[]): FfdItem[] {
  if (!Array.isArray(raw)) {
    problems.push(`${where}: expected a list of { idRef } or { groupId, items }.`);
    return [];
  }
  const out: FfdItem[] = [];
  raw.forEach((it, i) => {
    const w = `${where}, item ${i + 1}`;
    if (!isObj(it)) return problems.push(`${w}: expected { idRef } or { groupId, items }.`);
    if (it.idRef !== undefined) {
      out.push({ kind: 'segment', idRef: String(it.idRef), usage: parseUsage(it.usage, w, problems), max: parseCount(it.count, w, problems) });
    } else if (it.groupId !== undefined) {
      const items = parseItems(it.items, `${w} (group ${String(it.groupId)})`, problems);
      out.push({ kind: 'group', groupId: String(it.groupId), usage: parseUsage(it.usage, w, problems), max: parseCount(it.count, w, problems), items });
    } else {
      problems.push(`${w}: needs an idRef (segment) or a groupId (group).`);
    }
  });
  return out;
}

/** Parse and validate FFD YAML text. Throws FfdError with every problem found. */
export function parseFfd(text: string): FfdSchema {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (e) {
    const where = e instanceof YAMLParseError && e.linePos ? ` (line ${e.linePos[0].line}, column ${e.linePos[0].col})` : '';
    throw new FfdError(`The FFD is not valid YAML${where}: ${(e as Error).message.split('\n')[0]}`);
  }
  if (!isObj(doc)) throw new FfdError('The FFD must be a YAML mapping starting with "form:".');

  const problems: string[] = [];
  const form = (str(doc.form)?.toUpperCase() ?? (doc.values ? 'FIXEDWIDTH' : 'FLATFILE')) as FfdForm;
  if (form !== 'FLATFILE' && form !== 'FIXEDWIDTH') {
    throw new FfdError(`Unsupported form "${String(doc.form)}". Only FLATFILE and FIXEDWIDTH schemas are supported.`);
  }

  const segments: FfdSegment[] = [];
  if (form === 'FIXEDWIDTH' || doc.values !== undefined) {
    const id = str(doc.id) ?? 'Record';
    segments.push({ id, name: str(doc.name), values: parseValues(doc.values, `Record "${id}"`, problems) });
  } else {
    if (!Array.isArray(doc.segments) || doc.segments.length === 0) problems.push('"segments" must be a non-empty list.');
    else {
      doc.segments.forEach((s, i) => {
        if (!isObj(s)) return problems.push(`Segment ${i + 1}: expected { id, name, values }.`);
        const id = str(s.id);
        if (!id) problems.push(`Segment ${i + 1}: missing id.`);
        const values = parseValues(s.values, `Segment "${id ?? i + 1}"`, problems);
        if (id) segments.push({ id, name: str(s.name), tag: str(s.tag), values });
      });
    }
  }

  const ids = new Set<string>();
  for (const s of segments) {
    if (ids.has(s.id)) problems.push(`Segment id "${s.id}" is defined more than once.`);
    ids.add(s.id);
  }

  const structures = Array.isArray(doc.structures)
    ? doc.structures.filter(isObj).map((s, i) => ({
        id: str(s.id) ?? `Structure${i + 1}`,
        name: str(s.name),
        data: parseItems(s.data, `Structure "${str(s.id) ?? i + 1}"`, problems),
      }))
    : [];
  const checkRefs = (items: FfdItem[], where: string) => {
    for (const it of items) {
      if (it.kind === 'segment' && !ids.has(it.idRef)) problems.push(`${where}: idRef "${it.idRef}" does not match any segment id.`);
      if (it.kind === 'group') checkRefs(it.items, where);
    }
  };
  for (const s of structures) checkRefs(s.data, `Structure "${s.id}"`);

  const schema: FfdSchema = { form, structures, segments };
  if (doc.tagStart !== undefined) schema.tagStart = Number(doc.tagStart);
  if (doc.tagLength !== undefined) schema.tagLength = Number(doc.tagLength);

  if (problems.length) throw new FfdError(`The FFD has ${problems.length} problem(s).`, problems);
  return schema;
}

// ---------------------------------------------------------------- writing

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
const count = (max: number) => (max === Infinity ? `'>1'` : max > 1 ? String(max) : '');

function valueLine(v: FfdValue): string {
  const parts = [`name: ${q(v.name)}`, `type: ${v.type}`, `length: ${v.length}`];
  if (v.tagValue !== undefined) parts.push(`tagValue: ${q(v.tagValue)}`);
  if (v.usage && v.usage !== 'M') parts.push(`usage: ${v.usage}`);
  if (v.format) {
    const f: string[] = [];
    if (v.format.justify) f.push(`justify: ${v.format.justify}`);
    if (v.format.pad !== undefined) f.push(`pad: ${q(v.format.pad)}`);
    if (v.format.implicit) f.push(`implicit: ${v.format.implicit}`);
    if (v.format.pattern) f.push(`pattern: ${q(v.format.pattern)}`);
    if (f.length) parts.push(`format: { ${f.join(', ')} }`);
  }
  return `- { ${parts.join(', ')} }`;
}

function itemLines(items: FfdItem[], indent: string): string[] {
  const out: string[] = [];
  for (const it of items) {
    const c = count(it.max);
    if (it.kind === 'segment') {
      out.push(`${indent}- { idRef: ${q(it.idRef)}, usage: ${it.usage}${c ? `, count: ${c}` : ''} }`);
    } else {
      out.push(`${indent}- groupId: ${q(it.groupId)}`, `${indent}  usage: ${it.usage}`);
      if (c) out.push(`${indent}  count: ${c}`);
      out.push(`${indent}  items:`, ...itemLines(it.items, `${indent}  `));
    }
  }
  return out;
}

/** Serialize a schema as FFD YAML, in the compact one-line-per-field style. */
export function stringifyFfd(schema: FfdSchema): string {
  const out: string[] = [`form: ${schema.form}`];
  if (schema.form === 'FIXEDWIDTH') {
    const s = schema.segments[0];
    out.push(`id: ${q(s.id)}`);
    if (s.name) out.push(`name: ${q(s.name)}`);
    out.push('values:', ...s.values.map(valueLine));
    return out.join('\n') + '\n';
  }
  if (schema.tagStart !== undefined) out.push(`tagStart: ${schema.tagStart}`);
  if (schema.tagLength !== undefined) out.push(`tagLength: ${schema.tagLength}`);
  if (schema.structures.length) {
    out.push('structures:');
    for (const st of schema.structures) {
      out.push(`- id: ${q(st.id)}`);
      if (st.name) out.push(`  name: ${q(st.name)}`);
      out.push('  data:', ...itemLines(st.data, '  '));
    }
  }
  out.push('segments:');
  for (const s of schema.segments) {
    out.push(`- id: ${q(s.id)}`);
    if (s.name) out.push(`  name: ${q(s.name)}`);
    if (s.tag !== undefined) out.push(`  tag: ${q(s.tag)}`);
    out.push('  values:', ...s.values.map((v) => `  ${valueLine(v)}`));
  }
  return out.join('\n') + '\n';
}
