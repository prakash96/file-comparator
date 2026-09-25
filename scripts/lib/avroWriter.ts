/**
 * Minimal Avro object-container writer, used only to produce test fixtures and
 * sample files (the app itself only reads Avro). Supports the schema subset the
 * samples use: primitives, records, arrays, maps, enums, unions, and
 * pre-encoded logical values (pass the underlying int/long/bytes).
 */

type Schema = string | Schema[] | { [k: string]: unknown };

class Out {
  private parts: number[] = [];
  byte(b: number) {
    this.parts.push(b & 0xff);
  }
  bytes(b: Uint8Array) {
    for (const x of b) this.parts.push(x);
  }
  long(v: number | bigint) {
    let n = BigInt(v);
    n = n >= 0n ? n << 1n : (-n << 1n) - 1n;
    do {
      let b = Number(n & 0x7fn);
      n >>= 7n;
      if (n > 0n) b |= 0x80;
      this.byte(b);
    } while (n > 0n);
  }
  str(s: string) {
    const b = new TextEncoder().encode(s);
    this.long(b.length);
    this.bytes(b);
  }
  double(v: number) {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, v, true);
    this.bytes(b);
  }
  float(v: number) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setFloat32(0, v, true);
    this.bytes(b);
  }
  result() {
    return Uint8Array.from(this.parts);
  }
}

function matches(schema: Schema, v: unknown): boolean {
  const t = typeof schema === 'string' ? schema : Array.isArray(schema) ? 'union' : (schema.type as string);
  switch (t) {
    case 'null': return v === null || v === undefined;
    case 'boolean': return typeof v === 'boolean';
    case 'int': case 'long': return typeof v === 'number' || typeof v === 'bigint';
    case 'float': case 'double': return typeof v === 'number';
    case 'string': return typeof v === 'string';
    case 'bytes': case 'fixed': return v instanceof Uint8Array;
    case 'enum': return typeof v === 'string';
    case 'array': return Array.isArray(v);
    case 'record': case 'map': return typeof v === 'object' && v !== null && !Array.isArray(v);
    default: return false;
  }
}

function write(o: Out, schema: Schema, v: unknown): void {
  if (Array.isArray(schema)) {
    const i = schema.findIndex((s) => matches(s, v));
    if (i < 0) throw new Error(`No union branch for ${String(v)}`);
    o.long(i);
    write(o, schema[i], v);
    return;
  }
  const t = typeof schema === 'string' ? schema : (schema.type as Schema);
  if (typeof t !== 'string') return write(o, t, v);
  const s = schema as Record<string, unknown>;
  switch (t) {
    case 'null': return;
    case 'boolean': o.byte(v ? 1 : 0); return;
    case 'int': case 'long': o.long(v as number); return;
    case 'float': o.float(v as number); return;
    case 'double': o.double(v as number); return;
    case 'string': o.str(v as string); return;
    case 'bytes': o.long((v as Uint8Array).length); o.bytes(v as Uint8Array); return;
    case 'fixed': o.bytes(v as Uint8Array); return;
    case 'enum': o.long((s.symbols as string[]).indexOf(v as string)); return;
    case 'array': {
      const arr = v as unknown[];
      if (arr.length) {
        o.long(arr.length);
        for (const x of arr) write(o, s.items as Schema, x);
      }
      o.long(0);
      return;
    }
    case 'map': {
      const entries = Object.entries(v as Record<string, unknown>);
      if (entries.length) {
        o.long(entries.length);
        for (const [k, x] of entries) {
          o.str(k);
          write(o, s.values as Schema, x);
        }
      }
      o.long(0);
      return;
    }
    case 'record':
      for (const f of s.fields as { name: string; type: Schema }[]) write(o, f.type, (v as Record<string, unknown>)[f.name]);
      return;
    default:
      throw new Error(`Unsupported type ${t}`);
  }
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function writeAvro(schema: Schema, records: unknown[], opts: { codec?: 'null' | 'deflate'; blockSize?: number } = {}): Promise<Uint8Array> {
  const codec = opts.codec ?? 'null';
  const blockSize = opts.blockSize ?? 1000;
  const o = new Out();
  o.bytes(Uint8Array.from([0x4f, 0x62, 0x6a, 0x01]));
  o.long(2);
  o.str('avro.schema');
  const schemaBytes = new TextEncoder().encode(JSON.stringify(schema));
  o.long(schemaBytes.length);
  o.bytes(schemaBytes);
  o.str('avro.codec');
  const codecBytes = new TextEncoder().encode(codec);
  o.long(codecBytes.length);
  o.bytes(codecBytes);
  o.long(0);
  const sync = Uint8Array.from({ length: 16 }, (_, i) => (i * 37 + 11) & 0xff);
  o.bytes(sync);
  for (let i = 0; i < records.length; i += blockSize) {
    const chunk = records.slice(i, i + blockSize);
    const b = new Out();
    for (const r of chunk) write(b, schema, r);
    let data: Uint8Array = b.result();
    if (codec === 'deflate') data = await deflateRaw(data);
    o.long(chunk.length);
    o.long(data.length);
    o.bytes(data);
    o.bytes(sync);
  }
  return o.result();
}
