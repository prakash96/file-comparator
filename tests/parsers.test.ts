import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { parquetWriteBuffer } from 'hyparquet-writer';
import { delimitedParser } from '../src/parsers/csv/delimitedParser';
import { DelimitedTokenizer } from '../src/parsers/csv/tokenizer';
import { sniffDelimited } from '../src/parsers/csv/sniff';
import { fixedWidthParser, suggestLayout, validateLayout } from '../src/parsers/fixedwidth/fixedWidthParser';
import { jsonParser } from '../src/parsers/json/jsonParser';
import { mntParser } from '../src/parsers/mnt/mntParser';
import { xmlParser } from '../src/parsers/xml/xmlParser';
import { excelParser } from '../src/parsers/excel/excelParser';
import { avroParser } from '../src/parsers/avro/avroParser';
import { decimalFromBytes } from '../src/parsers/avro/avroDecoder';
import { parquetParser } from '../src/parsers/parquet/parquetParser';
import { detectFormat } from '../src/parsers/detect';
import { AppError } from '../src/models/issues';
import { writeAvro } from '../scripts/lib/avroWriter';
import { parse } from './helpers/parse';

function tokenize(text: string, opts = { delimiter: ',', quoteChar: '"', escapeChar: '"' }, chunk = 0) {
  const out: string[][] = [];
  const t = new DelimitedTokenizer(opts, { record: (f) => out.push(f), textAfterQuote: () => {}, unterminatedQuote: () => {} });
  if (chunk > 0) for (let i = 0; i < text.length; i += chunk) t.feed(text.slice(i, i + chunk));
  else t.feed(text);
  t.end();
  return out;
}

describe('16. CSV / delimited', () => {
  it('tokenizes quotes, escaped quotes, embedded delimiters and newlines', () => {
    const text = 'a,"b,c","say ""hi""","multi\nline"\r\nx,,z,\n';
    const expected = [['a', 'b,c', 'say "hi"', 'multi\nline'], ['x', '', 'z', '']];
    expect(tokenize(text)).toEqual(expected);
    // identical result regardless of how the text is chunked
    for (const size of [1, 2, 3, 5, 7]) expect(tokenize(text, undefined, size)).toEqual(expected);
  });

  it('supports multi-character delimiters and backslash escapes', () => {
    expect(tokenize('a||b||"c\\"d"\n', { delimiter: '||', quoteChar: '"', escapeChar: '\\' })).toEqual([['a', 'b', 'c"d']]);
    expect(tokenize('a||b\n', { delimiter: '||', quoteChar: '"', escapeChar: '"' }, 1)).toEqual([['a', 'b']]);
  });

  it('parses with header, detects the delimiter, and warns about field-count mismatches', async () => {
    const r = await parse(delimitedParser, 'ID|NAME|AMT\n1|Alice|10.5\n2|Bob\n3|Carol|7|extra\n');
    expect(r.names).toEqual(['ID', 'NAME', 'AMT', 'COL_4']);
    expect(r.rows).toHaveLength(3);
    expect(r.meta.resolved?.delimited?.delimiter).toBe('|');
    expect(r.issues.filter((i) => i.code === 'FIELD_COUNT')).toHaveLength(2);
    expect(r.dataset.fields[0].type).toBe('integer');
    expect(r.dataset.fields[2].type).toBe('decimal');
  });

  it('headerless files get COL_n names', async () => {
    const r = await parse(delimitedParser, '1,a\n2,b\n', { delimited: { delimiter: ',', hasHeader: false } });
    expect(r.names).toEqual(['COL_1', 'COL_2']);
    expect(r.rows).toEqual([['1', 'a'], ['2', 'b']]);
  });

  it('reports an unterminated quote with its line number', async () => {
    const r = await parse(delimitedParser, 'A,B\n1,"open\n2,x\n', { delimited: { delimiter: ',' } });
    const issue = r.issues.find((i) => i.code === 'UNTERMINATED_QUOTE');
    expect(issue?.line).toBe(2);
  });

  it('decodes windows-1252', async () => {
    const bytes = Uint8Array.from([0x4e, 0x0a, 0x43, 0x61, 0x66, 0xe9, 0x0a]); // N \n Café \n
    const r = await parse(delimitedParser, bytes, { encoding: 'windows-1252', delimited: { delimiter: ',' } });
    expect(r.rows[0][0]).toBe('Café');
  });

  it('sniffs delimiter and header', () => {
    expect(sniffDelimited('A\tB\tC\n1\t2\t3\n4\t5\t6\n')).toMatchObject({ delimiter: '\t', hasHeader: true });
    expect(sniffDelimited('1;2;3\n4;5;6\n')).toMatchObject({ delimiter: ';', hasHeader: false });
  });

  it('empty file is a clear error', async () => {
    await expect(parse(delimitedParser, '')).rejects.toThrow(/empty/);
  });
});

describe('20. fixed-width', () => {
  const text = [
    'CUSTOMER_IDNAME                          STATUS    ',
    '0000000001Alice                         ACTIVE    ',
    '0000000002Bob                           CLOSED    ',
    '0000000003Carol',
  ].join('\r\n');
  const columns = [
    { name: 'CUSTOMER_ID', start: 1, length: 10, type: 'integer' as const },
    { name: 'NAME', start: 11, length: 30, type: 'string' as const },
    { name: 'STATUS', start: 41, length: 10, type: 'string' as const },
  ];

  it('slices columns by position, trims, and skips header lines', async () => {
    const r = await parse(fixedWidthParser, text, { fixedWidth: { columns, skipLines: 1, trim: true } });
    expect(r.names).toEqual(['CUSTOMER_ID', 'NAME', 'STATUS']);
    expect(r.rows[0]).toEqual(['0000000001', 'Alice', 'ACTIVE']);
    expect(r.rows[2]).toEqual(['0000000003', 'Carol', null]);
    expect(r.issues.some((i) => i.code === 'FW_SHORT_LINE')).toBe(true);
  });

  it('supports fixed record length without line breaks', async () => {
    const r = await parse(fixedWidthParser, 'AAA111BBB222', { fixedWidth: { columns: [{ name: 'K', start: 1, length: 3, type: 'string' }, { name: 'V', start: 4, length: 3, type: 'integer' }], recordLength: 6 } });
    expect(r.rows).toEqual([['AAA', '111'], ['BBB', '222']]);
  });

  it('without a layout returns sample lines and a suggested layout', async () => {
    const r = await parse(fixedWidthParser, text);
    expect(r.issues[0].code).toBe('FW_NO_LAYOUT');
    expect(r.meta.sampleLines?.length).toBeGreaterThan(0);
    expect(r.meta.suggestedLayout?.length).toBeGreaterThan(0);
  });

  it('validates overlapping and suggests layouts', () => {
    expect(validateLayout([{ name: 'A', start: 1, length: 5, type: 'string' }, { name: 'B', start: 3, length: 2, type: 'string' }])[0]).toMatch(/overlaps/);
    expect(suggestLayout(['AB   CD  ', 'XY   ZW  ']).map((c) => [c.start, c.length])).toEqual([[1, 5], [6, 4]]);
  });
});

describe('MNT', () => {
  const header = '<Header line_count="4" download_id="Price_Update_2_839.mnt" target_org_node="STORE:839" apply_immediately="true"/>';
  const rows = [
    'INSERT|PRICE_UPDATE_2|347014989|REGULAR_PRICE|STORE|839|109.01|2026-06-27 00:00:00||1',
    'INSERT|PRICE_UPDATE_2|423157245|PROMO_PRICE|STORE|839|99.50|2026-06-27 00:00:00||1',
    'INSERT|PRICE_UPDATE_2|"quoted"|PROMO_PRICE|STORE|839|1.00|2026-06-27 00:00:00||1',
  ];
  const mnt = [header, ...rows].join('\r\n') + '\r\n';

  it('reads the header attributes and the headerless pipe records', async () => {
    const { names, rows: recs, issues, meta } = await parse(mntParser, mnt);
    expect(names).toEqual(Array.from({ length: 10 }, (_, i) => `COL_${i + 1}`));
    expect(recs).toHaveLength(3);
    expect(recs[0].slice(0, 4)).toEqual(['INSERT', 'PRICE_UPDATE_2', '347014989', 'REGULAR_PRICE']);
    expect(recs[2][2]).toBe('"quoted"'); // no quote processing
    expect(recs[0][8]).toBe('');
    expect(meta.details).toContainEqual({ label: 'target_org_node', value: 'STORE:839' });
    expect(issues).toEqual([]);
  });

  it('applies column names and warns about a line_count mismatch with the right line numbers', async () => {
    const text = [header.replace('"4"', '"10"'), rows[0], 'INSERT|X'].join('\n');
    const { names, issues } = await parse(mntParser, text, { mnt: { columnNames: ['ACTION', 'MSG', 'ITEM'] } });
    expect(names.slice(0, 4)).toEqual(['ACTION', 'MSG', 'ITEM', 'COL_4']);
    expect(issues.find((i) => i.code === 'MNT_LINE_COUNT')).toBeTruthy();
    expect(issues.find((i) => i.code === 'FIELD_COUNT')?.line).toBe(3);
  });

  it('handles UTF-16 and files without a header line', async () => {
    const utf16 = new Uint8Array([...mnt].flatMap((c) => [c.charCodeAt(0), 0]));
    expect((await parse(mntParser, utf16, { encoding: 'utf-16le' })).rows).toHaveLength(3);
    const noHeader = await parse(mntParser, rows.join('\n'));
    expect(noHeader.rows).toHaveLength(3);
    expect(noHeader.issues.map((i) => i.code)).toContain('MNT_NO_HEADER');
  });

  it('is detected ahead of XML', async () => {
    expect((await detectFormat(new Blob([mnt]), 'x.txt')).format).toBe('mnt');
    expect((await detectFormat(new Blob(['<a><b/></a>']), 'x.mnt')).format).toBe('mnt');
    expect((await detectFormat(new Blob(['<a x="1"/>\n<b/>\n']), 'x.xml')).format).toBe('xml');
  });
});

describe('17. JSON', () => {
  const doc = JSON.stringify({ customers: [{ id: 1001, name: 'ABC', address: { city: 'Mumbai' }, tags: ['a', 'b'] }, { id: 1002, name: 'XYZ', address: { city: 'Pune', zip: '411001' } }] });

  it('auto-detects the record array and flattens nested fields', async () => {
    const r = await parse(jsonParser, doc);
    expect(r.meta.resolved?.json?.rootPath).toBe('customers');
    expect(r.names).toEqual(['id', 'name', 'address.city', 'tags', 'address.zip']);
    expect(r.rows[0]).toEqual(['1001', 'ABC', 'Mumbai', '["a","b"]']);
  });

  it('nested mode keeps objects as canonical JSON', async () => {
    const r = await parse(jsonParser, doc, { nestedMode: 'nested' });
    expect(r.names).toEqual(['id', 'name', 'address', 'tags']);
    expect(r.rows[1][2]).toBe('{"city":"Pune","zip":"411001"}');
    expect(r.dataset.fields[2].type).toBe('nested');
  });

  it('honours an explicit root path and rejects a wrong one', async () => {
    const wrapped = JSON.stringify({ data: { items: [{ a: 1 }] } });
    expect((await parse(jsonParser, wrapped, { json: { rootPath: 'data.items' } })).rows).toEqual([['1']]);
    await expect(parse(jsonParser, wrapped, { json: { rootPath: 'nope' } })).rejects.toThrow(/does not exist/);
  });

  it('reads JSON Lines', async () => {
    const r = await parse(jsonParser, '{"a":1}\n{"a":2,"b":"x"}\nnot json\n');
    expect(r.rows).toHaveLength(2);
    expect(r.issues.find((i) => i.code === 'JSONL_BAD_LINE')?.line).toBe(3);
  });

  it('malformed JSON reports line and column', async () => {
    const err = await parse(jsonParser, '[\n {"a": 1},\n {"a": 2,,}\n]').catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.message).toMatch(/line 3/);
  });
});

describe('18. XML', () => {
  const xml = `<?xml version="1.0"?>
<!-- export -->
<customers>
  <customer id="1001"><name>ABC &amp; Co</name><address><city>Mumbai</city></address></customer>
  <customer id="1002"><name><![CDATA[X<Y]]></name><address><city>Pune</city></address><phone>1</phone><phone>2</phone></customer>
</customers>`;

  it('detects the repeating element and converts attributes and children', async () => {
    const r = await parse(xmlParser, xml);
    expect(r.meta.resolved?.xml?.recordNode).toBe('customer');
    expect(r.names).toEqual(['@id', 'name', 'address.city', 'phone']);
    expect(r.rows[0]).toEqual(['1001', 'ABC & Co', 'Mumbai']);
    expect(r.rows[1]).toEqual(['1002', 'X<Y', 'Pune', '["1","2"]']);
  });

  it('can ignore attributes', async () => {
    const r = await parse(xmlParser, xml, { xml: { recordNode: 'customer', includeAttributes: false } });
    expect(r.names[0]).toBe('name');
  });

  it('malformed XML reports the line', async () => {
    await expect(parse(xmlParser, '<a>\n<b>\n</c>\n</a>')).rejects.toThrow(/line 3: expected <\/b> but found <\/c>/);
    await expect(parse(xmlParser, '<a><b>x</b>')).rejects.toThrow(/truncated/);
  });
});

describe('19. Excel', () => {
  function workbook(): Uint8Array {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Notes'], ['nothing here']]), 'Readme');
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([
        ['ID', 'AMOUNT', 'ACTIVE', 'OPENED'],
        [1, 0.1 + 0.2, true, new Date(2024, 0, 31)],
        [2, 1234.5, false, null],
      ], { cellDates: true }),
      'Data',
    );
    return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as Uint8Array;
  }

  it('lists sheets and reads the selected one', async () => {
    const r = await parse(excelParser, workbook(), { excel: { sheet: 'Data' } });
    expect(r.meta.sheets?.map((s) => s.name)).toEqual(['Readme', 'Data']);
    expect(r.names).toEqual(['ID', 'AMOUNT', 'ACTIVE', 'OPENED']);
    expect(r.rows[0]).toEqual(['1', '0.3', 'true', '2024-01-31']);
    expect(r.rows[1][3]).toBeNull();
  });

  it('defaults to the first non-empty sheet', async () => {
    const r = await parse(excelParser, workbook());
    expect(r.meta.resolved?.excel?.sheet).toBe('Readme');
  });

  it('rejects non-Excel content with a friendly message', async () => {
    await expect(parse(excelParser, 'PK\u0003\u0004garbage')).rejects.toThrow(/could not be read as an Excel workbook/);
  });
});

describe('Avro', () => {
  const schema = {
    type: 'record',
    name: 'Customer',
    namespace: 'com.example',
    fields: [
      { name: 'id', type: 'long' },
      { name: 'name', type: ['null', 'string'] },
      { name: 'address', type: { type: 'record', name: 'Address', fields: [{ name: 'city', type: 'string' }] } },
      { name: 'status', type: { type: 'enum', name: 'Status', symbols: ['ACTIVE', 'CLOSED'] } },
      { name: 'opened', type: { type: 'int', logicalType: 'date' } },
      { name: 'updated', type: { type: 'long', logicalType: 'timestamp-micros' } },
      { name: 'tags', type: { type: 'array', items: 'string' } },
    ],
  };
  const records = [
    { id: 1, name: 'Alice', address: { city: 'Mumbai' }, status: 'ACTIVE', opened: 19753, updated: 1706695200123456n, tags: ['a'] },
    { id: 9007199254740993n, name: null, address: { city: 'Pune' }, status: 'CLOSED', opened: 0, updated: 0, tags: [] },
  ];

  for (const codec of ['null', 'deflate'] as const) {
    it(`reads ${codec} container files with nested fields and logical types`, async () => {
      const bytes = await writeAvro(schema, records, { codec, blockSize: 1 });
      const r = await parse(avroParser, bytes);
      expect(r.names).toEqual(['id', 'name', 'address.city', 'status', 'opened', 'updated', 'tags']);
      expect(r.rows[0]).toEqual(['1', 'Alice', 'Mumbai', 'ACTIVE', '2024-01-31', '2024-01-31 10:00:00.123456', '["a"]']);
      expect(r.rows[1]).toEqual(['9007199254740993', null, 'Pune', 'CLOSED', '1970-01-01', '1970-01-01', '[]']);
      expect(r.dataset.fields.find((f) => f.name === 'name')?.declaredType).toBe('string?');
      expect(r.meta.details.find((d) => d.label === 'Codec')?.value).toBe(codec);
    });
  }

  it('decodes decimals exactly', () => {
    expect(decimalFromBytes(Uint8Array.from([0x30, 0x39]), 2)).toBe('123.45');
    expect(decimalFromBytes(Uint8Array.from([0xff, 0x85]), 2)).toBe('-1.23');
  });

  it('rejects non-Avro and truncated files', async () => {
    await expect(parse(avroParser, 'hello')).rejects.toThrow(/not an Avro/);
    const bytes = await writeAvro(schema, records);
    await expect(parse(avroParser, bytes.slice(0, bytes.length - 10))).rejects.toThrow(/truncated/);
  });
});

describe('Parquet', () => {
  it('reads columns, schema and row count', async () => {
    const buf = parquetWriteBuffer({
      columnData: [
        { name: 'id', data: [1, 2, 3], type: 'INT32' },
        { name: 'name', data: ['a', null, 'c'], type: 'STRING' },
        { name: 'amount', data: [1.5, 2.25, 3], type: 'DOUBLE' },
      ],
    });
    const r = await parse(parquetParser, new Uint8Array(buf));
    expect(r.names).toEqual(['id', 'name', 'amount']);
    expect(r.rows).toEqual([['1', 'a', '1.5'], ['2', null, '2.25'], ['3', 'c', '3']]);
    expect(r.meta.declaredRecordCount).toBe(3);
    expect(r.meta.schemaText).toContain('amount');
  });

  it('rejects non-Parquet data', async () => {
    await expect(parse(parquetParser, 'PAR1 not really')).rejects.toThrow(/could not be read as Parquet/);
  });
});

describe('format detection', () => {
  const blob = (s: string | Uint8Array) => new Blob([s as BlobPart]);
  it('recognises formats from content', async () => {
    expect((await detectFormat(blob('a,b\n1,2\n'), 'x.txt')).format).toBe('delimited');
    expect((await detectFormat(blob('[{"a":1}]'), 'x.dat')).format).toBe('json');
    expect((await detectFormat(blob('<a/>'), 'x')).format).toBe('xml');
    expect((await detectFormat(blob('AAAA  11\nBBBB  22\nCCCC  33\n'), 'x.dat')).format).toBe('fixedwidth');
    expect((await detectFormat(blob(await writeAvro('string', ['x'])), 'x')).format).toBe('avro');
    expect((await detectFormat(blob(new Uint8Array(parquetWriteBuffer({ columnData: [{ name: 'a', data: [1], type: 'INT32' }] }))), 'x')).format).toBe('parquet');
  });
});
