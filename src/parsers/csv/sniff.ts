import { headLines } from '../common/textStream';

export const CANDIDATE_DELIMITERS = [',', '|', '\t', ';', '~', '^', ':'];

export interface DelimitedSniff {
  delimiter: string;
  hasHeader: boolean;
  /** 0..1 - how consistently the delimiter splits the sampled lines. */
  confidence: number;
}

/** Count delimiter occurrences outside double quotes. */
function countOutsideQuotes(line: string, d: string, quote: string): number {
  let n = 0;
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote && c === quote) inQ = !inQ;
    else if (!inQ && line.startsWith(d, i)) {
      n++;
      i += d.length - 1;
    }
  }
  return n;
}

/**
 * Guess the delimiter by picking the candidate that splits the first lines into
 * the same, non-zero number of fields most consistently.
 */
export function sniffDelimited(head: string, quoteChar = '"'): DelimitedSniff {
  const lines = headLines(head, 40).filter((l) => l.trim() !== '');
  let best: DelimitedSniff = { delimiter: ',', hasHeader: true, confidence: 0 };
  if (lines.length === 0) return best;
  let bestScore = -Infinity;

  for (const d of CANDIDATE_DELIMITERS) {
    const counts = lines.map((l) => countOutsideQuotes(l, d, quoteChar));
    const nonZero = counts.filter((c) => c > 0);
    if (nonZero.length === 0) continue;
    const freq = new Map<number, number>();
    for (const c of counts) freq.set(c, (freq.get(c) ?? 0) + 1);
    let mode = 0;
    let modeCount = 0;
    for (const [c, f] of freq) {
      if (c > 0 && (f > modeCount || (f === modeCount && c > mode))) {
        mode = c;
        modeCount = f;
      }
    }
    // consistency first, then more fields; ':' only wins if clearly better (it appears in times)
    const consistency = modeCount / lines.length;
    const score = consistency * 10 + Math.min(mode, 50) / 50 - (d === ':' ? 2 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = { delimiter: d, hasHeader: true, confidence: consistency };
    }
  }
  best.hasHeader = guessHeader(lines, best.delimiter, quoteChar);
  return best;
}

const NUMERIC_OR_DATE = /^[+-]?(\d+\.?\d*|\.\d+)$|^\d{4}-\d{2}-\d{2}|^\d{1,2}\/\d{1,2}\/\d{2,4}$/;

function splitSimple(line: string, d: string, quote: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote && c === quote) {
      inQ = !inQ;
      continue;
    }
    if (!inQ && line.startsWith(d, i)) {
      out.push(cur);
      cur = '';
      i += d.length - 1;
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/**
 * A first line is a header when none of its values look like data (numbers /
 * dates) while at least one column below it does, or when all its values look
 * like identifiers (CUSTOMER_ID, Name...) and are unique.
 */
export function guessHeader(lines: string[], d: string, quote: string): boolean {
  if (lines.length < 2) return true;
  const first = splitSimple(lines[0], d, quote);
  if (first.some((v) => NUMERIC_OR_DATE.test(v) || v === '')) return false;
  const rest = lines.slice(1, 20).map((l) => splitSimple(l, d, quote));
  const dataHasNumbers = first.some((_, i) => rest.some((r) => NUMERIC_OR_DATE.test(r[i] ?? '')));
  if (dataHasNumbers) return true;
  const identifiers = first.every((v) => /^[A-Za-z_][\w .#$-]*$/.test(v));
  return identifiers && new Set(first.map((v) => v.toLowerCase())).size === first.length;
}
