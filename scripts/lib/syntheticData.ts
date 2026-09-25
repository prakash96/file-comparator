/**
 * Deterministic synthetic DataStage-style extracts for benchmarks.
 * Target differs from source by: 0.5% removed, 0.25% added, 1% modified,
 * plus a few duplicate keys - so every comparison path is exercised.
 */
export interface SyntheticPair {
  source: string;
  target: string;
  expected: { removed: number; added: number; modified: number; duplicateKeys: number };
}

const STATUSES = ['ACTIVE', 'CLOSED', 'SUSPENDED', 'PENDING'];
const CITIES = ['Mumbai', 'Pune', 'Delhi', 'Chennai', 'Bengaluru', 'Kolkata', 'Hyderabad', 'Ahmedabad'];
const HEADER = 'CUSTOMER_ID|ACCOUNT_ID|NAME|STATUS|CREDIT_LIMIT|BALANCE|CITY|OPEN_DATE|LAST_TXN_TS|SEGMENT\n';

function row(i: number, variant = 0): string {
  const status = STATUSES[(i + variant) % STATUSES.length];
  const limit = ((i % 97) * 1000 + 5000 + variant * 250).toFixed(2);
  const bal = ((i * 37) % 100000 / 7).toFixed(2);
  const d = `20${String(10 + (i % 14)).padStart(2, '0')}-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`;
  return `${i}|ACC${String(i % 100000).padStart(7, '0')}|Customer ${i}|${status}|${limit}|${bal}|${CITIES[i % CITIES.length]}|${d}|${d} ${String(i % 24).padStart(2, '0')}:15:00|${i % 5 === 0 ? 'RETAIL' : 'CORP'}\n`;
}

/** Build the pair as arrays of lines joined in large chunks (fast, bounded memory churn). */
export function generatePair(n: number): SyntheticPair {
  const src: string[] = [HEADER];
  const tgt: string[] = [HEADER];
  let removed = 0;
  let modified = 0;
  for (let i = 1; i <= n; i++) {
    src.push(row(i));
    if (i % 200 === 0) {
      removed++;
      continue;
    }
    if (i % 100 === 1) {
      modified++;
      tgt.push(row(i, 1));
    } else {
      tgt.push(row(i));
    }
  }
  const added = Math.floor(n / 400);
  for (let i = n + 1; i <= n + added; i++) tgt.push(row(i));
  // duplicate keys: re-emit a few target rows whose ids are not modified/removed
  const dups = Math.min(12, Math.floor(n / 1000));
  for (let d = 0; d < dups; d++) tgt.push(row(d * 10 + 3));
  return { source: src.join(''), target: tgt.join(''), expected: { removed, added, modified: modified - dups * 0, duplicateKeys: dups } };
}
