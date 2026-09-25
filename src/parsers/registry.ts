import type { FileFormat } from '../models/dataset';
import { avroParser } from './avro/avroParser';
import { delimitedParser } from './csv/delimitedParser';
import { excelParser } from './excel/excelParser';
import { fixedWidthParser } from './fixedwidth/fixedWidthParser';
import { jsonParser } from './json/jsonParser';
import { parquetParser } from './parquet/parquetParser';
import type { FileParser } from './types';
import { xmlParser } from './xml/xmlParser';

/**
 * All file adapters. Adding a format = implement `FileParser`, add it here,
 * add the id to `FileFormat` / `FILE_FORMAT_LABELS`, and teach `detect.ts`.
 * Nothing in comparison/, reports/ or the result views has to change.
 */
export const PARSERS: Record<FileFormat, FileParser> = {
  delimited: delimitedParser,
  fixedwidth: fixedWidthParser,
  json: jsonParser,
  xml: xmlParser,
  excel: excelParser,
  avro: avroParser,
  parquet: parquetParser,
};

export function getParser(format: FileFormat): FileParser {
  return PARSERS[format];
}
