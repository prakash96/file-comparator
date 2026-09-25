import type { CellValue } from '../../models/dataset';

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** `yyyy-MM-dd` when the time is exactly midnight UTC, else `yyyy-MM-dd HH:mm:ss[.SSS]`. */
export function formatUtcDate(d: Date): string | null {
  const t = d.getTime();
  if (Number.isNaN(t)) return null;
  const date = `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const h = d.getUTCHours();
  const m = d.getUTCMinutes();
  const s = d.getUTCSeconds();
  const ms = d.getUTCMilliseconds();
  if (!h && !m && !s && !ms) return date;
  return `${date} ${pad(h)}:${pad(m)}:${pad(s)}${ms ? `.${pad(ms, 3).replace(/0+$/, '')}` : ''}`;
}

/** Epoch-based timestamp with sub-millisecond precision. `unitsPerSecond` = 1e3 (millis), 1e6 (micros) or 1e9 (nanos). */
export function formatEpoch(value: bigint | number, unitsPerSecond: number): string {
  const v = BigInt(value);
  const per = BigInt(unitsPerSecond);
  let seconds = v / per;
  let frac = v % per;
  if (frac < 0n) {
    frac += per;
    seconds -= 1n;
  }
  const base = formatUtcDate(new Date(Number(seconds) * 1000)) ?? '';
  const digits = String(unitsPerSecond).length - 1;
  const fracText = frac === 0n ? '' : frac.toString().padStart(digits, '0').replace(/0+$/, '');
  if (!fracText) return base;
  return base.length === 10 ? `${base} 00:00:00.${fracText}` : `${base}.${fracText}`;
}

/** Days since 1970-01-01 to `yyyy-MM-dd`. */
export function formatEpochDays(days: number): string {
  return formatUtcDate(new Date(days * 86400000)) ?? String(days);
}

export function bytesToHex(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
  return s;
}

/** Stable JSON with sorted object keys, so key order never causes a difference. */
export function canonicalJson(v: unknown): string {
  return JSON.stringify(sortForJson(v));
}

function sortForJson(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Date) return formatUtcDate(v);
  if (v instanceof Uint8Array) return bytesToHex(v);
  if (Array.isArray(v)) return v.map(sortForJson);
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) out[k] = sortForJson((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}

/** Convert any parsed value into the canonical cell representation. */
export function toCell(v: unknown): CellValue {
  if (v === null || v === undefined) return null;
  switch (typeof v) {
    case 'string':
      return v;
    case 'number':
      return Number.isFinite(v) ? String(v) : String(v);
    case 'bigint':
      return v.toString();
    case 'boolean':
      return v ? 'true' : 'false';
    case 'object':
      if (v instanceof Date) return formatUtcDate(v);
      if (v instanceof Uint8Array) return bytesToHex(v);
      return canonicalJson(v);
    default:
      return String(v);
  }
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date) && !(v instanceof Uint8Array);
}

/** Make header names usable: blank -> COL_n, duplicates -> NAME_2, NAME_3. */
export function uniqueHeaders(raw: (string | null | undefined)[], onDuplicate?: (name: string) => void): string[] {
  const seen = new Map<string, number>();
  return raw.map((h, i) => {
    let name = (h ?? '').toString().trim();
    if (!name) name = `COL_${i + 1}`;
    const key = name.toLowerCase();
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    if (n > 0) {
      onDuplicate?.(name);
      let candidate = `${name}_${n + 1}`;
      while (seen.has(candidate.toLowerCase())) candidate = `${candidate}_`;
      seen.set(candidate.toLowerCase(), 1);
      return candidate;
    }
    return name;
  });
}
