import type { FileFormat } from './dataset';

/** How nested structures (JSON objects, XML child elements, Avro/Parquet records) become columns. */
export type NestedMode = 'flatten' | 'nested';

export interface DelimitedOptions {
  /** Field delimiter. May be more than one character (e.g. `||`). `\t` for tab. Empty = detect. */
  delimiter: string;
  hasHeader: boolean;
  /** Quote character, or '' for no quoting. */
  quoteChar: string;
  /**
   * Escape character inside quoted fields. When equal to `quoteChar` the RFC 4180
   * doubled-quote convention applies (`""`). Otherwise it escapes the next character (e.g. `\"`).
   */
  escapeChar: string;
  skipEmptyLines: boolean;
}

export type FixedWidthType = 'string' | 'integer' | 'decimal' | 'date';

export interface FixedWidthColumn {
  name: string;
  /** 1-based start position (DataStage / COBOL convention). */
  start: number;
  length: number;
  type: FixedWidthType;
}

export interface FixedWidthOptions {
  columns: FixedWidthColumn[];
  trim: boolean;
  /** Number of leading lines to skip (header/banner lines). */
  skipLines: number;
  /** Fixed record length for files without line breaks; 0 = records are separated by line breaks. */
  recordLength: number;
}

/**
 * MNT download files: one `<Header attr="..."/>` line, then headerless delimited
 * records (e.g. `INSERT|PRICE_UPDATE_2|347014989|REGULAR_PRICE|...`).
 */
export interface MntOptions {
  /** Field delimiter of the record lines. Empty = detect. */
  delimiter: string;
  /** Names for the record fields, in order. Missing names default to COL_n. */
  columnNames: string[];
}

export interface JsonOptions {
  /** Dotted path to the array of records, e.g. `customers` or `data.items`. Empty = auto-detect. */
  rootPath: string;
}

export interface XmlOptions {
  /** Name of the repeating record element, e.g. `customer`. Empty = auto-detect. */
  recordNode: string;
  includeAttributes: boolean;
}

export interface ExcelOptions {
  /** Worksheet name. Empty = first non-empty sheet. */
  sheet: string;
  hasHeader: boolean;
  /** 1-based row number holding the header (or the first data row when there is no header). */
  headerRow: number;
}

export interface ParseOptions {
  /** `auto` = detect from content. */
  format: FileFormat | 'auto';
  /** Text encoding label understood by the browser's TextDecoder (utf-8, windows-1252, utf-16le, ...). */
  encoding: string;
  nestedMode: NestedMode;
  delimited: DelimitedOptions;
  fixedWidth: FixedWidthOptions;
  mnt: MntOptions;
  json: JsonOptions;
  xml: XmlOptions;
  excel: ExcelOptions;
}

export function defaultParseOptions(): ParseOptions {
  return {
    format: 'auto',
    encoding: 'utf-8',
    nestedMode: 'flatten',
    delimited: { delimiter: '', hasHeader: true, quoteChar: '"', escapeChar: '"', skipEmptyLines: true },
    fixedWidth: { columns: [], trim: true, skipLines: 0, recordLength: 0 },
    mnt: { delimiter: '|', columnNames: [] },
    json: { rootPath: '' },
    xml: { recordNode: '', includeAttributes: true },
    excel: { sheet: '', hasHeader: true, headerRow: 1 },
  };
}

export const ENCODINGS: { value: string; label: string }[] = [
  { value: 'utf-8', label: 'UTF-8' },
  { value: 'windows-1252', label: 'Windows-1252 (Western European)' },
  { value: 'iso-8859-1', label: 'ISO-8859-1 (Latin-1)' },
  { value: 'iso-8859-15', label: 'ISO-8859-15 (Latin-9)' },
  { value: 'utf-16le', label: 'UTF-16 LE' },
  { value: 'utf-16be', label: 'UTF-16 BE' },
  { value: 'shift_jis', label: 'Shift_JIS' },
  { value: 'gb18030', label: 'GB18030' },
  { value: 'big5', label: 'Big5' },
  { value: 'euc-kr', label: 'EUC-KR' },
];
