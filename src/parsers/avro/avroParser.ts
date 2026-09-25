import { snappyUncompress } from 'hyparquet';
import { decompressZstd } from 'hyparquet-compressors';
import { AppError } from '../../models/issues';
import type { ParseOptions } from '../../models/parseOptions';
import { ObjectRecordBuilder } from '../common/objectRecordBuilder';
import type { FileParser, ParseContext, ParsedFile } from '../types';
import { AvroEOFError, ByteReader, compileSchema, declaredColumns, type AvroSchema } from './avroDecoder';

const MAGIC = [0x4f, 0x62, 0x6a, 0x01]; // "Obj" 1
const WINDOW = 8 * 1024 * 1024;

/** Sliding window over a Blob so large Avro files are read block by block. */
class BlobWindow {
  private buf = new Uint8Array(0);
  private start = 0;

  constructor(private readonly blob: Blob) {}

  async ensure(offset: number, n: number): Promise<void> {
    const end = Math.min(this.blob.size, offset + n);
    if (offset >= this.start && end <= this.start + this.buf.length) return;
    const readEnd = Math.min(this.blob.size, Math.max(end, offset + WINDOW));
    this.buf = new Uint8Array(await this.blob.slice(offset, readEnd).arrayBuffer());
    this.start = offset;
  }

  bytes(offset: number, n: number): Uint8Array {
    const s = offset - this.start;
    return this.buf.subarray(s, Math.min(this.buf.length, s + n));
  }
}

function readVarintFrom(bytes: Uint8Array): { value: number; length: number } {
  let value = 0;
  let shift = 0;
  let i = 0;
  let b: number;
  do {
    b = bytes[i++];
    value += (b & 0x7f) * 2 ** shift;
    shift += 7;
  } while (b & 0x80 && i < bytes.length);
  return { value, length: i };
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function decompress(codec: string, data: Uint8Array): Promise<Uint8Array> {
  switch (codec) {
    case 'null':
      return data;
    case 'deflate':
      return inflateRaw(data);
    case 'snappy': {
      const body = data.subarray(0, data.length - 4); // trailing CRC32
      const out = new Uint8Array(readVarintFrom(body).value);
      snappyUncompress(body, out);
      return out;
    }
    case 'zstandard':
      return decompressZstd(data);
    default:
      throw new AppError('AVRO_CODEC', `This Avro file uses the "${codec}" compression codec, which is not supported in the browser. Supported codecs: null, deflate, snappy, zstandard.`);
  }
}

export const avroParser: FileParser = {
  format: 'avro',

  async parse(file: Blob, options: ParseOptions, ctx: ParseContext): Promise<ParsedFile> {
    if (file.size === 0) throw new AppError('EMPTY_FILE', 'The file is empty.');
    const win = new BlobWindow(file);

    // ---- header (grow the window until the metadata map fits)
    let headerLen = 0;
    let meta: Record<string, Uint8Array> = {};
    let sync = new Uint8Array(16);
    for (let size = 64 * 1024; ; size *= 4) {
      await win.ensure(0, size);
      const r = new ByteReader(win.bytes(0, size));
      try {
        const magic = r.readFixed(4);
        if (!MAGIC.every((b, i) => magic[i] === b)) {
          throw new AppError('AVRO_INVALID', 'This is not an Avro object container file (the "Obj" header is missing).');
        }
        meta = {};
        for (;;) {
          let n = r.readInt();
          if (n === 0) break;
          if (n < 0) {
            n = -n;
            r.readLong();
          }
          for (let i = 0; i < n; i++) meta[r.readString()] = r.readBytes().slice();
        }
        sync = r.readFixed(16).slice();
        headerLen = r.pos;
        break;
      } catch (e) {
        if (e instanceof AvroEOFError && size < file.size) continue;
        if (e instanceof AppError) throw e;
        throw new AppError('AVRO_INVALID', 'The Avro file header could not be read. The file may be truncated or damaged.', { cause: e });
      }
    }

    const dec = new TextDecoder();
    const schemaJson = meta['avro.schema'] ? dec.decode(meta['avro.schema']) : '';
    const codec = meta['avro.codec'] ? dec.decode(meta['avro.codec']) : 'null';
    let schema: AvroSchema;
    try {
      schema = JSON.parse(schemaJson) as AvroSchema;
    } catch (e) {
      throw new AppError('AVRO_INVALID', 'The Avro file has no readable schema (avro.schema).', { cause: e });
    }
    let decode;
    try {
      decode = compileSchema(schema);
    } catch (e) {
      throw new AppError('AVRO_SCHEMA', 'The Avro schema uses a construct this reader does not understand.', { cause: e });
    }

    const builder = new ObjectRecordBuilder(options.nestedMode);
    for (const c of declaredColumns(schema, options.nestedMode === 'flatten')) builder.declareColumn(c.path, c.label, c.fieldType);

    // ---- data blocks
    let offset = headerLen;
    let blocks = 0;
    while (offset < file.size) {
      ctx.checkCancelled();
      await win.ensure(offset, 32);
      const hr = new ByteReader(win.bytes(offset, 32));
      let count: number;
      let size: number;
      try {
        count = hr.readInt();
        size = hr.readInt();
      } catch (e) {
        throw new AppError('AVRO_TRUNCATED', `The Avro file ends in the middle of data block ${blocks + 1}. It may be truncated.`, { cause: e });
      }
      const dataStart = offset + hr.pos;
      if (size < 0 || dataStart + size + 16 > file.size) {
        throw new AppError('AVRO_TRUNCATED', `Data block ${blocks + 1} claims ${size} bytes but the file ends earlier. The file may be truncated.`);
      }
      await win.ensure(dataStart, size + 16);
      const raw = win.bytes(dataStart, size);
      const marker = win.bytes(dataStart + size, 16);
      if (!marker.every((b, i) => b === sync[i])) {
        throw new AppError('AVRO_BAD_SYNC', `Data block ${blocks + 1} is not followed by the file's sync marker. The file is damaged.`);
      }
      const data = await decompress(codec, raw);
      const r = new ByteReader(data);
      try {
        for (let i = 0; i < count; i++) builder.add(decode(r));
      } catch (e) {
        throw new AppError('AVRO_DECODE', `Record data in block ${blocks + 1} does not match the file's schema.`, { cause: e });
      }
      offset = dataStart + size + 16;
      blocks++;
      ctx.progress({ stage: 'parsing', bytesProcessed: offset, totalBytes: file.size, records: builder.recordCount });
    }

    return {
      dataset: builder.toDataset(),
      meta: {
        details: [
          { label: 'Schema', value: typeof schema === 'object' && !Array.isArray(schema) ? String(schema.name ?? 'record') : String(schema) },
          { label: 'Codec', value: codec },
          { label: 'Blocks', value: blocks.toLocaleString('en-US') },
          { label: 'Nested fields', value: options.nestedMode === 'flatten' ? 'flattened (a.b.c)' : 'kept nested (compared as JSON)' },
        ],
        schemaText: JSON.stringify(schema, null, 2),
      },
    };
  },
};
