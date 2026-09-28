import { IssueCollector } from '../../src/models/issues';
import { defaultParseOptions, type ParseOptions } from '../../src/models/parseOptions';
import type { FileParser, ParseContext } from '../../src/parsers/types';

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

export function parseOptions(patch: DeepPartial<ParseOptions> = {}): ParseOptions {
  const base = defaultParseOptions();
  const out = { ...base, ...patch } as ParseOptions;
  for (const k of ['delimited', 'fixedWidth', 'mnt', 'json', 'xml', 'excel'] as const) {
    (out as unknown as Record<string, unknown>)[k] = { ...base[k], ...(patch[k] as object | undefined) };
  }
  return out;
}

export function testContext(): ParseContext & { issues: IssueCollector } {
  return { issues: new IssueCollector(), progress: () => {}, checkCancelled: () => {} };
}

export async function parse(parser: FileParser, content: string | Uint8Array | Blob, patch: DeepPartial<ParseOptions> = {}) {
  const blob = content instanceof Blob ? content : new Blob([content as BlobPart]);
  const ctx = testContext();
  const res = await parser.parse(blob, parseOptions(patch), ctx);
  return { ...res, issues: ctx.issues.toArray(), names: res.dataset.fields.map((f) => f.name), rows: res.dataset.records };
}
