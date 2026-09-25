import type { FieldType } from '../../models/dataset';
import { formatEpoch, formatEpochDays } from '../common/values';

/**
 * Avro binary decoding (spec 1.11): primitives, records, enums, arrays, maps,
 * unions, fixed, and the logical types date, time-*, timestamp-*,
 * local-timestamp-*, decimal and uuid. Decoded values are plain JS values;
 * logical types are rendered to the same canonical text the rest of the app uses.
 */

export class AvroEOFError extends Error {
  constructor() {
    super('Unexpected end of Avro data');
  }
}

const utf8 = new TextDecoder('utf-8');

export class ByteReader {
  pos = 0;
  private readonly view: DataView;

  constructor(readonly buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  get remaining(): number {
    return this.buf.length - this.pos;
  }

  private need(n: number): void {
    if (this.pos + n > this.buf.length) throw new AvroEOFError();
  }

  /** Zig-zag varint. Returns a number when it fits in 2^53, otherwise a bigint. */
  readLong(): number | bigint {
    let result = 0;
    let shift = 0;
    let b: number;
    const start = this.pos;
    do {
      if (this.pos >= this.buf.length) throw new AvroEOFError();
      b = this.buf[this.pos++];
      result += (b & 0x7f) * 2 ** shift;
      shift += 7;
    } while (b & 0x80);
    if (shift <= 49) {
      return result % 2 === 0 ? result / 2 : -(result + 1) / 2;
    }
    // Large magnitude: redo exactly with BigInt.
    let big = 0n;
    let s = 0n;
    for (let i = start; i < this.pos; i++) {
      big |= BigInt(this.buf[i] & 0x7f) << s;
      s += 7n;
    }
    const v = (big >> 1n) ^ -(big & 1n);
    return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
  }

  readInt(): number {
    return Number(this.readLong());
  }

  readBoolean(): boolean {
    this.need(1);
    return this.buf[this.pos++] !== 0;
  }

  readFloat(): number {
    this.need(4);
    const v = this.view.getFloat32(this.pos, true);
    this.pos += 4;
    return v;
  }

  readDouble(): number {
    this.need(8);
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }

  readFixed(n: number): Uint8Array {
    this.need(n);
    const v = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return v;
  }

  readBytes(): Uint8Array {
    const n = this.readInt();
    if (n < 0) throw new Error('Negative byte length in Avro data');
    return this.readFixed(n);
  }

  readString(): string {
    return utf8.decode(this.readBytes());
  }
}

export type AvroSchema = string | AvroSchema[] | { [k: string]: unknown };
export type Decoder = (r: ByteReader) => unknown;

/** Two's-complement big-endian unscaled integer + scale -> decimal text. */
export function decimalFromBytes(bytes: Uint8Array, scale: number): string {
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  if (bytes.length && bytes[0] & 0x80) v -= 1n << BigInt(8 * bytes.length);
  const neg = v < 0n;
  let digits = (neg ? -v : v).toString();
  if (scale > 0) {
    digits = digits.padStart(scale + 1, '0');
    digits = `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  }
  return (neg ? '-' : '') + digits;
}

const timeOfDay = (value: number | bigint, unitsPerSecond: number) => {
  const full = formatEpoch(value, unitsPerSecond); // 1970-01-01 HH:mm:ss[.f]
  return full.length > 10 ? full.slice(11) : '00:00:00';
};

const PRIMITIVES = new Set(['null', 'boolean', 'int', 'long', 'float', 'double', 'bytes', 'string']);

interface Named {
  decode: Decoder | null;
}

function fullName(name: string, ns?: string): string {
  return name.includes('.') || !ns ? name : `${ns}.${name}`;
}

/** Compile a schema into a decoder function. Named types may be referenced recursively. */
export function compileSchema(schema: AvroSchema, ns = '', named = new Map<string, Named>()): Decoder {
  if (typeof schema === 'string') {
    switch (schema) {
      case 'null': return () => null;
      case 'boolean': return (r) => r.readBoolean();
      case 'int': return (r) => r.readInt();
      case 'long': return (r) => r.readLong();
      case 'float': return (r) => r.readFloat();
      case 'double': return (r) => r.readDouble();
      case 'bytes': return (r) => r.readBytes();
      case 'string': return (r) => r.readString();
      default: {
        const ref = named.get(fullName(schema, ns)) ?? named.get(schema);
        if (!ref) throw new Error(`Unknown Avro type "${schema}"`);
        return (r) => ref.decode!(r);
      }
    }
  }
  if (Array.isArray(schema)) {
    const branches = schema.map((s) => compileSchema(s, ns, named));
    return (r) => {
      const i = r.readInt();
      const b = branches[i];
      if (!b) throw new Error(`Avro union index ${i} out of range`);
      return b(r);
    };
  }

  const s = schema as Record<string, unknown>;
  const type = s.type as AvroSchema;
  const logical = s.logicalType as string | undefined;

  if (logical && typeof type === 'string' && PRIMITIVES.has(type)) {
    const base = compileSchema(type, ns, named);
    switch (logical) {
      case 'date': return (r) => formatEpochDays(r.readInt());
      case 'time-millis': return (r) => timeOfDay(r.readInt(), 1e3);
      case 'time-micros': return (r) => timeOfDay(r.readLong(), 1e6);
      case 'timestamp-millis':
      case 'local-timestamp-millis': return (r) => formatEpoch(r.readLong(), 1e3);
      case 'timestamp-micros':
      case 'local-timestamp-micros': return (r) => formatEpoch(r.readLong(), 1e6);
      case 'timestamp-nanos':
      case 'local-timestamp-nanos': return (r) => formatEpoch(r.readLong(), 1e9);
      case 'decimal': {
        const scale = Number(s.scale ?? 0);
        if (type === 'bytes') return (r) => decimalFromBytes(r.readBytes(), scale);
        break;
      }
      default:
        return base;
    }
  }

  switch (type) {
    case 'record':
    case 'error': {
      const name = fullName(String(s.name), (s.namespace as string) ?? ns);
      const recNs = name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : ns;
      const holder: Named = { decode: null };
      named.set(name, holder);
      const fields = (s.fields as { name: string; type: AvroSchema }[]).map((f) => ({ name: f.name, decode: compileSchema(f.type, recNs, named) }));
      const decode: Decoder = (r) => {
        const obj: Record<string, unknown> = {};
        for (let i = 0; i < fields.length; i++) obj[fields[i].name] = fields[i].decode(r);
        return obj;
      };
      holder.decode = decode;
      return decode;
    }
    case 'enum': {
      const name = fullName(String(s.name), (s.namespace as string) ?? ns);
      const symbols = s.symbols as string[];
      const decode: Decoder = (r) => symbols[r.readInt()] ?? null;
      named.set(name, { decode });
      return decode;
    }
    case 'fixed': {
      const name = fullName(String(s.name), (s.namespace as string) ?? ns);
      const size = Number(s.size);
      const decode: Decoder =
        logical === 'decimal' ? (r) => decimalFromBytes(r.readFixed(size), Number(s.scale ?? 0)) : (r) => r.readFixed(size);
      named.set(name, { decode });
      return decode;
    }
    case 'array': {
      const item = compileSchema(s.items as AvroSchema, ns, named);
      return (r) => {
        const out: unknown[] = [];
        for (;;) {
          let n = r.readInt();
          if (n === 0) break;
          if (n < 0) {
            n = -n;
            r.readLong(); // block size in bytes
          }
          for (let i = 0; i < n; i++) out.push(item(r));
        }
        return out;
      };
    }
    case 'map': {
      const value = compileSchema(s.values as AvroSchema, ns, named);
      return (r) => {
        const out: Record<string, unknown> = {};
        for (;;) {
          let n = r.readInt();
          if (n === 0) break;
          if (n < 0) {
            n = -n;
            r.readLong();
          }
          for (let i = 0; i < n; i++) {
            const k = r.readString();
            out[k] = value(r);
          }
        }
        return out;
      };
    }
    default:
      // {"type": "string"} style wrappers, or nested complex type
      return compileSchema(type, ns, named);
  }
}

/* --------------------------------------------------------- declared types */

export interface DeclaredColumn {
  path: string;
  label: string;
  fieldType: FieldType;
}

function typeLabel(schema: AvroSchema): { label: string; fieldType: FieldType; record?: Record<string, unknown> } {
  if (typeof schema === 'string') {
    const map: Record<string, FieldType> = { int: 'integer', long: 'integer', float: 'decimal', double: 'decimal', boolean: 'boolean', string: 'string', bytes: 'string', null: 'empty' };
    return { label: schema, fieldType: map[schema] ?? 'string' };
  }
  if (Array.isArray(schema)) {
    const nonNull = schema.filter((b) => b !== 'null');
    const nullable = nonNull.length < schema.length;
    if (nonNull.length === 1) {
      const t = typeLabel(nonNull[0]);
      return { ...t, label: `${t.label}${nullable ? '?' : ''}` };
    }
    return { label: `union<${schema.map((b) => typeLabel(b).label).join('|')}>`, fieldType: 'string' };
  }
  const s = schema as Record<string, unknown>;
  const logical = s.logicalType as string | undefined;
  if (logical === 'decimal') return { label: `decimal(${s.precision ?? '?'},${s.scale ?? 0})`, fieldType: 'decimal' };
  if (logical === 'date') return { label: 'date', fieldType: 'date' };
  if (logical && /timestamp/.test(logical)) return { label: logical, fieldType: 'datetime' };
  if (logical) return { label: logical, fieldType: 'string' };
  switch (s.type) {
    case 'record':
    case 'error':
      return { label: `record ${String(s.name)}`, fieldType: 'nested', record: s };
    case 'enum': return { label: `enum ${String(s.name)}`, fieldType: 'string' };
    case 'fixed': return { label: `fixed(${String(s.size)})`, fieldType: 'string' };
    case 'array': return { label: `array<${typeLabel(s.items as AvroSchema).label}>`, fieldType: 'nested' };
    case 'map': return { label: `map<${typeLabel(s.values as AvroSchema).label}>`, fieldType: 'nested' };
    default: return typeLabel(s.type as AvroSchema);
  }
}

/** Columns declared by a top-level record schema, flattened like ObjectRecordBuilder does. */
export function declaredColumns(schema: AvroSchema, flatten: boolean): DeclaredColumn[] {
  const out: DeclaredColumn[] = [];
  const top = typeLabel(schema);
  if (!top.record) return out;
  const walk = (rec: Record<string, unknown>, prefix: string) => {
    for (const f of rec.fields as { name: string; type: AvroSchema }[]) {
      const path = prefix ? `${prefix}.${f.name}` : f.name;
      const t = typeLabel(f.type);
      if (flatten && t.record) walk(t.record, path);
      else out.push({ path, label: t.label, fieldType: t.fieldType });
    }
  };
  walk(top.record, '');
  return out;
}
