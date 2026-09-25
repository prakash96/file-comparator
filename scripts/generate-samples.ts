/**
 * Writes the sample files in samples/. Run: npm run samples
 *
 * The same 20 customers are rendered in every format. SOURCE vs TARGET contain
 * intentional differences so every result category is exercised:
 *   removed    : 3, 15
 *   added      : 21, 22
 *   modified   : 2 (STATUS), 5 (CREDIT_LIMIT), 9 (CITY), 12 (NAME + STATUS)
 *   duplicates : 7 twice in SOURCE, 11 twice in TARGET
 *   nulls      : 4 has EMAIL NULL in source and '' in target (equal when "NULL equals empty" is on)
 *                17 has CITY NULL in target
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as XLSX from 'xlsx';
import { parquetWriteBuffer } from 'hyparquet-writer';
import { writeAvro } from './lib/avroWriter';

type Rec = { CUSTOMER_ID: number; NAME: string; STATUS: string; CREDIT_LIMIT: string; CITY: string | null; OPEN_DATE: string; EMAIL: string | null };

const CITIES = ['Mumbai', 'Pune', 'Delhi', 'Chennai', 'Bengaluru', 'Kolkata', 'Hyderabad'];
const NAMES = ['Asha Rao', 'Bharat Iyer', 'Chitra Nair', 'Dev Malhotra', 'Esha Kapoor', 'Farhan Ali', 'Gita Menon', 'Hari Singh', 'Indu Das', 'Jai Verma',
  'Kavya Shah', 'Lakshmi Pillai', 'Manoj Gupta', 'Neha Joshi', 'Om Prakash', 'Priya Reddy', 'Qasim Khan', 'Ravi Kumar', 'Sara Thomas', 'Tara Bose', 'Uday Jain', 'Veena Patil'];

function base(): Rec[] {
  return Array.from({ length: 20 }, (_, i) => {
    const id = i + 1;
    return {
      CUSTOMER_ID: id,
      NAME: NAMES[i],
      STATUS: id % 6 === 0 ? 'CLOSED' : 'ACTIVE',
      CREDIT_LIMIT: (5000 + id * 1250).toFixed(2),
      CITY: CITIES[i % CITIES.length],
      OPEN_DATE: `20${String(10 + (id % 12)).padStart(2, '0')}-${String((id % 12) + 1).padStart(2, '0')}-${String((id % 27) + 1).padStart(2, '0')}`,
      EMAIL: `${NAMES[i].split(' ')[0].toLowerCase()}@example.com`,
    };
  });
}

function source(): Rec[] {
  const r = base();
  r[3].EMAIL = null;
  r.splice(7, 0, { ...r[6], NAME: 'Gita Menon (dup)' }); // duplicate key 7
  return r;
}

function target(): Rec[] {
  const r = base().filter((x) => x.CUSTOMER_ID !== 3 && x.CUSTOMER_ID !== 15);
  const by = (id: number) => r.find((x) => x.CUSTOMER_ID === id)!;
  by(2).STATUS = 'CLOSED';
  by(5).CREDIT_LIMIT = '12500.00';
  by(9).CITY = 'Hyderabad';
  by(12).NAME = 'LAKSHMI PILLAI';
  by(12).STATUS = 'SUSPENDED';
  by(4).EMAIL = '';
  by(17).CITY = null;
  const i11 = r.indexOf(by(11));
  r.splice(i11 + 1, 0, { ...by(11), CREDIT_LIMIT: '99999.00' }); // duplicate key 11
  for (const id of [21, 22]) {
    r.push({ CUSTOMER_ID: id, NAME: NAMES[id - 1], STATUS: 'ACTIVE', CREDIT_LIMIT: '1000.00', CITY: 'Mumbai', OPEN_DATE: '2024-06-01', EMAIL: `${NAMES[id - 1].split(' ')[0].toLowerCase()}@example.com` });
  }
  return r;
}

const COLS: (keyof Rec)[] = ['CUSTOMER_ID', 'NAME', 'STATUS', 'CREDIT_LIMIT', 'CITY', 'OPEN_DATE', 'EMAIL'];

const csvCell = (v: unknown) => {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (rows: Rec[]) => [COLS.join(','), ...rows.map((r) => COLS.map((c) => csvCell(r[c])).join(','))].join('\r\n') + '\r\n';

const nested = (r: Rec) => ({ CUSTOMER_ID: r.CUSTOMER_ID, NAME: r.NAME, STATUS: r.STATUS, CREDIT_LIMIT: Number(r.CREDIT_LIMIT), ADDRESS: { CITY: r.CITY }, OPEN_DATE: r.OPEN_DATE, EMAIL: r.EMAIL });
const toJson = (rows: Rec[]) => JSON.stringify({ extract: 'CUSTOMER_MASTER', customers: rows.map(nested) }, null, 2) + '\n';

const xmlEsc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const toXml = (rows: Rec[]) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<customers>\n${rows
    .map(
      (r) =>
        `  <customer id="${r.CUSTOMER_ID}">\n    <NAME>${xmlEsc(r.NAME)}</NAME>\n    <STATUS>${r.STATUS}</STATUS>\n    <CREDIT_LIMIT>${r.CREDIT_LIMIT}</CREDIT_LIMIT>\n    <ADDRESS>${r.CITY === null ? '' : `<CITY>${xmlEsc(r.CITY)}</CITY>`}</ADDRESS>\n    <OPEN_DATE>${r.OPEN_DATE}</OPEN_DATE>\n    ${r.EMAIL === null ? '<EMAIL/>' : `<EMAIL>${xmlEsc(r.EMAIL)}</EMAIL>`}\n  </customer>`,
    )
    .join('\n')}\n</customers>\n`;

export const FIXED_LAYOUT = {
  columns: [
    { name: 'CUSTOMER_ID', start: 1, length: 10, type: 'integer' },
    { name: 'NAME', start: 11, length: 30, type: 'string' },
    { name: 'STATUS', start: 41, length: 10, type: 'string' },
    { name: 'CREDIT_LIMIT', start: 51, length: 12, type: 'decimal' },
    { name: 'CITY', start: 63, length: 20, type: 'string' },
    { name: 'OPEN_DATE', start: 83, length: 10, type: 'date' },
  ],
  trim: true,
  skipLines: 0,
  recordLength: 0,
};
const toFixed = (rows: Rec[]) =>
  rows
    .map((r) =>
      [
        String(r.CUSTOMER_ID).padStart(10, '0'),
        r.NAME.padEnd(30).slice(0, 30),
        r.STATUS.padEnd(10),
        r.CREDIT_LIMIT.padStart(12),
        (r.CITY ?? '').padEnd(20),
        r.OPEN_DATE,
      ].join(''),
    )
    .join('\r\n') + '\r\n';

function toXlsx(rows: Rec[]): Uint8Array {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Customer master extract'], ['Generated sample - see the Customers sheet']]), 'About');
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([COLS, ...rows.map((r) => [r.CUSTOMER_ID, r.NAME, r.STATUS, Number(r.CREDIT_LIMIT), r.CITY, r.OPEN_DATE, r.EMAIL])]),
    'Customers',
  );
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer);
}

const AVRO_SCHEMA = {
  type: 'record',
  name: 'Customer',
  namespace: 'com.example.dw',
  fields: [
    { name: 'CUSTOMER_ID', type: 'long' },
    { name: 'NAME', type: 'string' },
    { name: 'STATUS', type: 'string' },
    { name: 'CREDIT_LIMIT', type: 'double' },
    { name: 'ADDRESS', type: { type: 'record', name: 'Address', fields: [{ name: 'CITY', type: ['null', 'string'] }] } },
    { name: 'OPEN_DATE', type: { type: 'int', logicalType: 'date' } },
    { name: 'EMAIL', type: ['null', 'string'] },
  ],
};
const days = (d: string) => Math.round(Date.parse(`${d}T00:00:00Z`) / 86400000);
const toAvro = (rows: Rec[]) =>
  writeAvro(
    AVRO_SCHEMA,
    rows.map((r) => ({ ...r, CREDIT_LIMIT: Number(r.CREDIT_LIMIT), ADDRESS: { CITY: r.CITY }, OPEN_DATE: days(r.OPEN_DATE) })),
    { codec: 'deflate', blockSize: 8 },
  );

function toParquet(rows: Rec[]): Uint8Array {
  return new Uint8Array(
    parquetWriteBuffer({
      columnData: [
        { name: 'CUSTOMER_ID', data: rows.map((r) => r.CUSTOMER_ID), type: 'INT32' },
        { name: 'NAME', data: rows.map((r) => r.NAME), type: 'STRING' },
        { name: 'STATUS', data: rows.map((r) => r.STATUS), type: 'STRING' },
        { name: 'CREDIT_LIMIT', data: rows.map((r) => Number(r.CREDIT_LIMIT)), type: 'DOUBLE' },
        { name: 'CITY', data: rows.map((r) => r.CITY), type: 'STRING' },
        { name: 'OPEN_DATE', data: rows.map((r) => r.OPEN_DATE), type: 'STRING' },
        { name: 'EMAIL', data: rows.map((r) => r.EMAIL), type: 'STRING' },
      ],
    }),
  );
}

async function main() {
  const dir = join(process.cwd(), 'samples');
  mkdirSync(dir, { recursive: true });
  const s = source();
  const t = target();
  const w = (name: string, data: string | Uint8Array) => {
    writeFileSync(join(dir, name), data);
    console.log(`  samples/${name}`);
  };
  console.log('Writing sample files:');
  w('source.csv', toCsv(s));
  w('target.csv', toCsv(t));
  w('source.json', toJson(s));
  w('target.json', toJson(t));
  w('source.xml', toXml(s));
  w('target.xml', toXml(t));
  w('source-fixed.txt', toFixed(s));
  w('target-fixed.txt', toFixed(t));
  w('fixed-width-layout.json', JSON.stringify(FIXED_LAYOUT, null, 2) + '\n');
  w('source.xlsx', toXlsx(s));
  w('target.xlsx', toXlsx(t));
  w('source.avro', await toAvro(s));
  w('target.avro', await toAvro(t));
  w('source.parquet', toParquet(s));
  w('target.parquet', toParquet(t));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
