/**
 * Write large synthetic source/target files for manual testing in the browser:
 *   npm run gen-data -- 1000000
 * Output: samples/generated/source-<n>.dat and target-<n>.dat (pipe-delimited).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generatePair } from './lib/syntheticData';

const n = Number(process.argv[2] ?? 1_000_000);
const dir = join(process.cwd(), 'samples', 'generated');
mkdirSync(dir, { recursive: true });
const pair = generatePair(n);
writeFileSync(join(dir, `source-${n}.dat`), pair.source);
writeFileSync(join(dir, `target-${n}.dat`), pair.target);
console.log(`Wrote samples/generated/source-${n}.dat and target-${n}.dat`);
console.log(`Expected with key CUSTOMER_ID: removed ${pair.expected.removed}, added ${pair.expected.added}, duplicate keys ${pair.expected.duplicateKeys}`);
