import type { FileFormat } from '../models/dataset';
import { headLines, readTextHead } from './common/textStream';
import { sniffDelimited } from './csv/sniff';

export interface Detection {
  format: FileFormat;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
  delimiter?: string;
  hasHeader?: boolean;
}

const startsWith = (b: Uint8Array, sig: number[], at = 0) => sig.every((v, i) => b[at + i] === v);

const ext = (name: string) => {
  const i = name.lastIndexOf('.');
  return i === -1 ? '' : name.slice(i + 1).toLowerCase();
};

/**
 * Detect the format from magic bytes first (binary formats), then from the
 * text content, using the file extension only as a tie-breaker.
 */
export async function detectFormat(file: Blob, fileName: string, encoding = 'utf-8'): Promise<Detection> {
  const e = ext(fileName);
  const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());

  if (startsWith(head, [0x50, 0x41, 0x52, 0x31])) return { format: 'parquet', confidence: 'high', reason: 'Parquet signature (PAR1)' };
  if (startsWith(head, [0x4f, 0x62, 0x6a, 0x01])) return { format: 'avro', confidence: 'high', reason: 'Avro container signature (Obj)' };
  if (startsWith(head, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return { format: 'excel', confidence: 'high', reason: 'Legacy Excel (.xls) signature' };
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04])) {
    return { format: 'excel', confidence: ['xlsx', 'xlsm', 'xlsb'].includes(e) ? 'high' : 'medium', reason: 'ZIP container (Excel .xlsx)' };
  }

  const text = await readTextHead(file, encoding, 128 * 1024);
  const trimmed = text.replace(/^﻿/, '').trimStart();
  if (!trimmed) {
    return { format: e === 'json' ? 'json' : e === 'xml' ? 'xml' : 'delimited', confidence: 'low', reason: 'Empty file' };
  }
  if (trimmed[0] === '{' || trimmed[0] === '[') return { format: 'json', confidence: 'high', reason: 'Starts with { or [' };
  if (trimmed[0] === '<') return { format: 'xml', confidence: 'high', reason: 'Starts with <' };

  const lines = headLines(text, 60).filter((l) => l.length > 0);
  const sniff = sniffDelimited(text);
  const equalLength = equalLengthShare(lines);

  if (sniff.confidence >= 0.8) {
    // Fixed-width files often contain stray commas; prefer fixed-width if the delimiter is rare.
    if (equalLength >= 0.9 && lines.length >= 3 && avgFields(lines, sniff.delimiter) < 2.5 && /\s{2,}/.test(lines[0] ?? '')) {
      return { format: 'fixedwidth', confidence: 'medium', reason: 'All lines have the same length and are space-padded' };
    }
    return {
      format: 'delimited',
      confidence: sniff.confidence >= 0.95 ? 'high' : 'medium',
      reason: `Consistent "${sniff.delimiter === '\t' ? 'tab' : sniff.delimiter}" delimiter`,
      delimiter: sniff.delimiter,
      hasHeader: sniff.hasHeader,
    };
  }
  if (equalLength >= 0.8 && lines.length >= 2) {
    return { format: 'fixedwidth', confidence: 'medium', reason: 'Lines have equal length and no consistent delimiter' };
  }
  if (e === 'dat' || e === 'txt' || e === 'fix' || e === 'fw') {
    return { format: 'fixedwidth', confidence: 'low', reason: 'No consistent delimiter found' };
  }
  return { format: 'delimited', confidence: 'low', reason: 'No consistent delimiter found', delimiter: sniff.delimiter, hasHeader: sniff.hasHeader };
}

function equalLengthShare(lines: string[]): number {
  if (!lines.length) return 0;
  const freq = new Map<number, number>();
  for (const l of lines) freq.set(l.length, (freq.get(l.length) ?? 0) + 1);
  return Math.max(...freq.values()) / lines.length;
}

function avgFields(lines: string[], d: string): number {
  return lines.reduce((n, l) => n + l.split(d).length, 0) / Math.max(1, lines.length);
}
