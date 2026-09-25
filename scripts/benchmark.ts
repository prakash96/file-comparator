/**
 * Benchmark: npm run bench            (10k, 100k, 1M rows)
 *            npm run bench -- 250000  (custom sizes)
 *
 * Runs the same code the browser worker runs (parser -> engine -> reports) in
 * Node and reports parse / compare / report time and heap usage. Browser
 * timings are typically within ~1.5x of these on the same machine.
 */
import { defaultParseOptions } from '../src/models/parseOptions';
import { defaultComparisonOptions } from '../src/models/comparison';
import type { ReportKind } from '../src/models/session';
import { ComparatorSession } from '../src/workers/session';
import { generatePair } from './lib/syntheticData';

const sizes = process.argv.slice(2).map(Number).filter((n) => n > 0);
const SIZES = sizes.length ? sizes : [10_000, 100_000, 1_000_000];

const mb = (b: number) => `${(b / 1024 / 1024).toFixed(0)} MB`;
const s = (ms: number) => `${(ms / 1000).toFixed(2)} s`;
const t = () => performance.now();

async function bench(n: number) {
  global.gc?.();
  const g0 = t();
  let pair: ReturnType<typeof generatePair> | null = generatePair(n);
  const genMs = t() - g0;
  const srcBlob = new Blob([pair.source]);
  const tgtBlob = new Blob([pair.target]);
  const expected = pair.expected;
  pair = null; // drop the generated text so heap numbers show only what the comparator holds
  global.gc?.();
  const bytes = srcBlob.size + tgtBlob.size;

  const session = new ComparatorSession();
  const p0 = t();
  await session.load('source', srcBlob, 'source.dat', defaultParseOptions());
  await session.load('target', tgtBlob, 'target.dat', defaultParseOptions());
  const parseMs = t() - p0;
  const heapAfterParse = process.memoryUsage().heapUsed;

  const c0 = t();
  const sum = session.compare({ ...defaultComparisonOptions(), keyColumns: ['CUSTOMER_ID'], numericNormalization: true });
  const compareMs = t() - c0;
  const heapAfterCompare = process.memoryUsage().heapUsed;

  const reports: [string, number][] = [];
  const kinds: ReportKind[] = ['csv-modified', 'csv-added', 'html', 'json-summary', ...(n <= 200_000 ? (['excel'] as const) : [])];
  for (const kind of kinds) {
    const r0 = t();
    await session.exportReport(kind);
    reports.push([kind, t() - r0]);
  }

  const c = sum.counts;
  const ok = c.removed === expected.removed && c.added === expected.added && c.duplicateKeys === expected.duplicateKeys && sum.reconciliation.sourceBalanced && sum.reconciliation.targetBalanced;
  console.log(`\n=== ${n.toLocaleString('en-US')} rows (${mb(bytes)} of text, generated in ${s(genMs)}) ===`);
  console.log(`  parse both files : ${s(parseMs)}  (${Math.round(((c.sourceTotal + c.targetTotal) / parseMs) * 1000).toLocaleString('en-US')} rec/s)`);
  console.log(`  compare          : ${s(compareMs)}  (index ${s(sum.timing.indexMs)}, compare ${s(sum.timing.compareMs)})`);
  console.log(`  reports          : ${reports.map(([k, ms]) => `${k} ${s(ms)}`).join(', ')}`);
  console.log(`  heap             : after parse ${mb(heapAfterParse)}, after compare ${mb(heapAfterCompare)}`);
  console.log(`  result           : added ${c.added}, removed ${c.removed}, modified ${c.modified}, unchanged ${c.unchanged}, duplicate keys ${c.duplicateKeys}`);
  console.log(`  correctness      : ${ok ? 'OK - counts match the generator and reconcile' : 'MISMATCH'}`);
  if (!ok) process.exitCode = 1;
  session.reset();
}

(async () => {
  console.log('DataStage File Comparator benchmark (Node', process.version + ')');
  for (const n of SIZES) await bench(n);
})();
