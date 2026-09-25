import { AppError } from '../../models/issues';
import type { ParseOptions } from '../../models/parseOptions';
import { ObjectRecordBuilder } from '../common/objectRecordBuilder';
import { readAllText } from '../common/textStream';
import type { FileParser, ParseContext, ParsedFile } from '../types';
import { scanXml } from './xmlScanner';

const localName = (n: string) => {
  const i = n.indexOf(':');
  return i === -1 ? n : n.slice(i + 1);
};

/**
 * Suggest the repeating record element: the element name that occurs most
 * often as a repeated child of the same parent, preferring shallower levels.
 */
export function detectRecordNodes(text: string): { name: string; count: number }[] {
  const counts = new Map<string, { count: number; depth: number; repeats: boolean }>();
  const childCounts: Map<string, number>[] = [];
  try {
    scanXml(
      text,
      {
        open(name, _a, _s, depth) {
          const siblings = childCounts[depth] ?? (childCounts[depth] = new Map());
          const n = (siblings.get(name) ?? 0) + 1;
          siblings.set(name, n);
          const e = counts.get(name);
          if (e) {
            e.count++;
            e.depth = Math.min(e.depth, depth);
            if (n > 1) e.repeats = true;
          } else {
            counts.set(name, { count: 1, depth, repeats: n > 1 });
          }
          childCounts[depth + 1] = new Map();
        },
        close() {},
        text() {},
      },
      { partial: true },
    );
  } catch {
    // Malformed sample: whatever was counted so far is still useful.
  }
  return [...counts.entries()]
    .filter(([, v]) => v.depth > 0)
    .sort((a, b) => Number(b[1].repeats) - Number(a[1].repeats) || a[1].depth - b[1].depth || b[1].count - a[1].count)
    .map(([name, v]) => ({ name, count: v.count }));
}

interface Frame {
  name: string;
  obj: Record<string, unknown>;
  text: string;
  hasChildren: boolean;
}

export const xmlParser: FileParser = {
  format: 'xml',

  async parse(file: Blob, options: ParseOptions, ctx: ParseContext): Promise<ParsedFile> {
    ctx.progress({ stage: 'reading', bytesProcessed: 0, totalBytes: file.size, records: 0 });
    const text = await readAllText(file, options.encoding, (b) => ctx.progress({ stage: 'reading', bytesProcessed: b, totalBytes: file.size, records: 0 }));
    if (!text.trim()) throw new AppError('EMPTY_FILE', 'The file is empty.');

    const candidates = detectRecordNodes(text.length > 4_000_000 ? text.slice(0, 4_000_000) : text);
    let recordNode = options.xml.recordNode.trim();
    if (!recordNode) {
      if (!candidates.length) throw new AppError('XML_NO_RECORDS', 'Could not find a repeating record element in this XML. Enter the record element name manually.');
      recordNode = candidates[0].name;
      ctx.issues.info('XML_RECORD_DETECTED', `Records were read from <${recordNode}> elements. Choose another record element if this is not right.`);
    }
    const target = recordNode;
    const matches = (n: string) => n === target || localName(n) === target;
    const withAttrs = options.xml.includeAttributes;

    const builder = new ObjectRecordBuilder(options.nestedMode);
    const stack: Frame[] = [];
    const bytesPerChar = file.size / Math.max(1, text.length);

    scanXml(
      text,
      {
        open(name, attrs) {
          if (stack.length === 0 && !matches(name)) return;
          const obj: Record<string, unknown> = {};
          if (withAttrs) for (const k of Object.keys(attrs)) obj[`@${k}`] = attrs[k];
          if (stack.length) stack[stack.length - 1].hasChildren = true;
          stack.push({ name, obj, text: '', hasChildren: false });
        },
        text(t) {
          if (stack.length) stack[stack.length - 1].text += t;
        },
        close() {
          if (!stack.length) return;
          const f = stack.pop()!;
          const txt = f.text.trim();
          let value: unknown;
          if (!f.hasChildren && Object.keys(f.obj).length === 0) {
            value = stack.length === 0 ? { '#text': txt === '' ? null : txt } : txt === '' ? null : txt;
          } else {
            if (txt) f.obj['#text'] = txt;
            value = f.obj;
          }
          if (stack.length === 0) {
            builder.add(value);
            if (builder.recordCount % 20000 === 0) {
              ctx.checkCancelled();
            }
            return;
          }
          const parent = stack[stack.length - 1].obj;
          const key = localName(f.name);
          if (key in parent) {
            const cur = parent[key];
            if (Array.isArray(cur)) cur.push(value);
            else parent[key] = [cur, value];
          } else {
            parent[key] = value;
          }
        },
      },
      { onProgress: (pos) => ctx.progress({ stage: 'parsing', bytesProcessed: Math.round(pos * bytesPerChar), totalBytes: file.size, records: builder.recordCount }) },
    );

    if (builder.recordCount === 0) {
      ctx.issues.warn('NO_RECORDS', `No <${recordNode}> elements were found.${candidates.length ? ` Elements that repeat: ${candidates.slice(0, 6).map((c) => c.name).join(', ')}.` : ''}`);
    }

    return {
      dataset: builder.toDataset(),
      meta: {
        details: [
          { label: 'Record element', value: `<${recordNode}>` },
          { label: 'Attributes', value: withAttrs ? 'included as @name fields' : 'ignored' },
          { label: 'Nested elements', value: options.nestedMode === 'flatten' ? 'flattened (a.b.c)' : 'kept nested (compared as JSON)' },
        ],
        xmlRecordCandidates: candidates.slice(0, 30),
        resolved: { xml: { ...options.xml, recordNode } },
      },
    };
  },
};
