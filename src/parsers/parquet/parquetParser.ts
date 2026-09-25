import { parquetMetadataAsync, parquetReadObjects, parquetSchema, type AsyncBuffer, type FileMetaData, type SchemaTree } from 'hyparquet';
import { compressors } from 'hyparquet-compressors';
import type { FieldType } from '../../models/dataset';
import { AppError } from '../../models/issues';
import type { ParseOptions } from '../../models/parseOptions';
import { ObjectRecordBuilder } from '../common/objectRecordBuilder';
import { formatEpoch, formatEpochDays } from '../common/values';
import type { FileParser, ParseContext, ParsedFile } from '../types';

/** Random-access view of a Blob for hyparquet: only the byte ranges it asks for are read. */
export function blobAsyncBuffer(blob: Blob): AsyncBuffer {
  return {
    byteLength: blob.size,
    slice: (start: number, end?: number) => blob.slice(start, end ?? blob.size).arrayBuffer(),
  };
}

/** Render timestamps/dates as canonical text, keeping micro/nanosecond precision. */
const PARSERS = {
  timestampFromMilliseconds: (v: bigint) => formatEpoch(v, 1e3),
  timestampFromMicroseconds: (v: bigint) => formatEpoch(v, 1e6),
  timestampFromNanoseconds: (v: bigint) => formatEpoch(v, 1e9),
  dateFromDays: (d: number) => formatEpochDays(d),
};

interface LeafInfo {
  path: string;
  label: string;
  fieldType: FieldType;
  decimalScale?: number;
}

function describeElement(t: SchemaTree): { label: string; fieldType: FieldType; scale?: number } {
  const e = t.element;
  const lt = e.logical_type;
  const ct = e.converted_type;
  const opt = e.repetition_type === 'OPTIONAL' ? '?' : '';
  if (lt?.type === 'DECIMAL' || ct === 'DECIMAL') {
    const p = lt?.type === 'DECIMAL' ? lt.precision : e.precision;
    const s = lt?.type === 'DECIMAL' ? lt.scale : (e.scale ?? 0);
    return { label: `decimal(${p},${s})${opt}`, fieldType: 'decimal', scale: s };
  }
  if (lt?.type === 'DATE' || ct === 'DATE') return { label: `date${opt}`, fieldType: 'date' };
  if (lt?.type === 'TIMESTAMP' || ct === 'TIMESTAMP_MILLIS' || ct === 'TIMESTAMP_MICROS' || e.type === 'INT96') {
    return { label: `timestamp${lt?.type === 'TIMESTAMP' ? `(${Object.keys(lt.unit)[0]?.toLowerCase() ?? ''})` : ''}${opt}`, fieldType: 'datetime' };
  }
  if (lt?.type === 'STRING' || ct === 'UTF8' || lt?.type === 'ENUM' || lt?.type === 'UUID' || lt?.type === 'JSON') return { label: `string${opt}`, fieldType: 'string' };
  if (lt?.type === 'LIST' || ct === 'LIST') return { label: `list${opt}`, fieldType: 'nested' };
  if (lt?.type === 'MAP' || ct === 'MAP' || ct === 'MAP_KEY_VALUE') return { label: `map${opt}`, fieldType: 'nested' };
  switch (e.type) {
    case 'BOOLEAN': return { label: `boolean${opt}`, fieldType: 'boolean' };
    case 'INT32': return { label: `int32${opt}`, fieldType: 'integer' };
    case 'INT64': return { label: `int64${opt}`, fieldType: 'integer' };
    case 'FLOAT': return { label: `float${opt}`, fieldType: 'decimal' };
    case 'DOUBLE': return { label: `double${opt}`, fieldType: 'decimal' };
    case 'BYTE_ARRAY': return { label: `binary${opt}`, fieldType: 'string' };
    case 'FIXED_LEN_BYTE_ARRAY': return { label: `fixed(${e.type_length})${opt}`, fieldType: 'string' };
    default: return { label: `struct${opt}`, fieldType: 'nested' };
  }
}

/** Columns as the ObjectRecordBuilder will name them (structs flattened in flatten mode). */
function leafColumns(root: SchemaTree, flatten: boolean): LeafInfo[] {
  const out: LeafInfo[] = [];
  const walk = (node: SchemaTree, prefix: string) => {
    for (const child of node.children) {
      const path = prefix ? `${prefix}.${child.element.name}` : child.element.name;
      const d = describeElement(child);
      const isStruct = child.children.length > 0 && d.label.startsWith('struct');
      if (flatten && isStruct) walk(child, path);
      else out.push({ path, label: d.label, fieldType: d.fieldType, decimalScale: d.scale });
    }
  };
  walk(root, '');
  return out;
}

function schemaText(root: SchemaTree): string {
  const lines: string[] = [];
  const walk = (node: SchemaTree, depth: number) => {
    for (const c of node.children) {
      lines.push(`${'  '.repeat(depth)}${c.element.name}: ${describeElement(c).label}`);
      walk(c, depth + 1);
    }
  };
  walk(root, 0);
  return lines.join('\n');
}

export const parquetParser: FileParser = {
  format: 'parquet',

  async parse(file: Blob, options: ParseOptions, ctx: ParseContext): Promise<ParsedFile> {
    if (file.size === 0) throw new AppError('EMPTY_FILE', 'The file is empty.');
    const buffer = blobAsyncBuffer(file);
    let metadata: FileMetaData;
    try {
      metadata = await parquetMetadataAsync(buffer);
    } catch (e) {
      throw new AppError('PARQUET_INVALID', 'This file could not be read as Parquet. The footer is missing or damaged (the file may be truncated, or not a Parquet file).', { cause: e });
    }
    const tree = parquetSchema(metadata);
    const leaves = leafColumns(tree, options.nestedMode === 'flatten');

    // hyparquet returns DECIMAL as a JS number; render at the declared scale to avoid 12.340000000000002.
    const transforms = new Map<string, (v: unknown) => unknown>();
    for (const l of leaves) {
      if (l.decimalScale !== undefined) {
        const scale = l.decimalScale;
        transforms.set(l.path, (v) => (typeof v === 'number' && Math.abs(v) < 1e21 ? v.toFixed(scale) : v));
      }
    }
    const builder = new ObjectRecordBuilder(options.nestedMode, transforms);
    for (const l of leaves) builder.declareColumn(l.path, l.label, l.fieldType);

    const total = Number(metadata.num_rows);
    let rowStart = 0;
    for (let g = 0; g < metadata.row_groups.length; g++) {
      ctx.checkCancelled();
      const rowEnd = rowStart + Number(metadata.row_groups[g].num_rows);
      let rows;
      try {
        rows = await parquetReadObjects({ file: buffer, metadata, rowStart, rowEnd, compressors, parsers: PARSERS });
      } catch (e) {
        throw new AppError('PARQUET_DECODE', `Row group ${g + 1} of ${metadata.row_groups.length} could not be decoded. The file may be damaged or use an unsupported encoding/compression.`, { cause: e });
      }
      for (const row of rows) builder.add(row);
      rowStart = rowEnd;
      ctx.progress({ stage: 'parsing', bytesProcessed: Math.round((rowStart / Math.max(1, total)) * file.size), totalBytes: file.size, records: builder.recordCount });
    }

    return {
      dataset: builder.toDataset(),
      meta: {
        details: [
          { label: 'Row groups', value: metadata.row_groups.length.toLocaleString('en-US') },
          { label: 'Rows (metadata)', value: total.toLocaleString('en-US') },
          { label: 'Columns', value: String(leaves.length) },
          { label: 'Created by', value: metadata.created_by ?? 'unknown' },
        ],
        schemaText: schemaText(tree),
        declaredRecordCount: total,
      },
    };
  },
};
