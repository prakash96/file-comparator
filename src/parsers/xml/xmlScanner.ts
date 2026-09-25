import { AppError } from '../../models/issues';

/**
 * Minimal, fast XML scanner for record-oriented documents.
 *
 * Why not DOMParser? DOMParser is not available inside Web Workers, and building
 * a full DOM for a multi-hundred-MB extract would double memory. This scanner
 * emits open/close/text events in one pass and checks well-formedness (matching
 * tags, closed comments/CDATA, single root), reporting the line of the problem.
 */

export interface XmlHandlers {
  open(name: string, attrs: Record<string, string>, selfClosing: boolean, depth: number): void;
  close(name: string, depth: number): void;
  text(text: string): void;
}

const NAMED_ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

export function decodeEntities(s: string): string {
  if (s.indexOf('&') === -1) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[A-Za-z][\w.-]*);/g, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try {
        return String.fromCodePoint(code);
      } catch {
        return m;
      }
    }
    return NAMED_ENTITIES[e] ?? m;
  });
}

function lineAt(text: string, pos: number): number {
  let n = 1;
  let i = -1;
  while ((i = text.indexOf('\n', i + 1)) !== -1 && i < pos) n++;
  return n;
}

const ATTR_RE = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g;

function parseAttributes(s: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  if (!s) return attrs;
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(s))) {
    if (m[1].startsWith('xmlns')) continue;
    attrs[m[1]] = decodeEntities(m[3] ?? m[4] ?? '');
  }
  return attrs;
}

export interface ScanOptions {
  /** Stop quietly at the end of input instead of reporting unclosed elements (used for sampling a file head). */
  partial?: boolean;
  /** Called every ~1 MB with the current offset. */
  onProgress?: (pos: number) => void;
}

export function scanXml(text: string, h: XmlHandlers, opts: ScanOptions = {}): void {
  const stack: string[] = [];
  const len = text.length;
  let pos = 0;
  let rootClosed = false;
  let nextReport = 1 << 20;
  const fail = (msg: string, at: number): never => {
    throw new AppError('XML_MALFORMED', `The XML is not well-formed at line ${lineAt(text, at).toLocaleString('en-US')}: ${msg}`, { line: lineAt(text, at) });
  };

  while (pos < len) {
    if (pos >= nextReport) {
      opts.onProgress?.(pos);
      nextReport = pos + (1 << 20);
    }
    const lt = text.indexOf('<', pos);
    if (lt === -1) {
      const tail = text.slice(pos);
      if (stack.length) h.text(decodeEntities(tail));
      else if (tail.trim() && !opts.partial) fail('text found outside the root element', pos);
      break;
    }
    if (lt > pos) {
      const t = text.slice(pos, lt);
      if (stack.length) h.text(decodeEntities(t));
      else if (t.trim()) fail(rootClosed ? 'content found after the root element was closed' : 'text found before the root element', pos);
    }
    const c = text.charCodeAt(lt + 1);
    if (c === 33 /* ! */) {
      if (text.startsWith('<!--', lt)) {
        const end = text.indexOf('-->', lt + 4);
        if (end === -1) {
          if (opts.partial) return;
          fail('a comment (<!--) is never closed', lt);
        }
        pos = end + 3;
      } else if (text.startsWith('<![CDATA[', lt)) {
        const end = text.indexOf(']]>', lt + 9);
        if (end === -1) {
          if (opts.partial) return;
          fail('a CDATA section is never closed', lt);
        }
        if (stack.length) h.text(text.slice(lt + 9, end));
        pos = end + 3;
      } else {
        // DOCTYPE (possibly with an internal subset in [...])
        let depth = 0;
        let i = lt + 2;
        for (; i < len; i++) {
          const ch = text[i];
          if (ch === '[') depth++;
          else if (ch === ']') depth--;
          else if (ch === '>' && depth <= 0) break;
        }
        pos = i + 1;
      }
      continue;
    }
    if (c === 63 /* ? */) {
      const end = text.indexOf('?>', lt + 2);
      if (end === -1) {
        if (opts.partial) return;
        fail('a processing instruction (<?) is never closed', lt);
      }
      pos = end + 2;
      continue;
    }
    const gt = findTagEnd(text, lt + 1);
    if (gt === -1) {
      if (opts.partial) return;
      fail('a tag is never closed with ">"', lt);
    }
    if (c === 47 /* / */) {
      const name = text.slice(lt + 2, gt).trim();
      const open = stack.pop();
      if (open === undefined) fail(`closing tag </${name}> has no matching opening tag`, lt);
      if (open !== name) fail(`expected </${open}> but found </${name}>`, lt);
      h.close(name, stack.length);
      if (stack.length === 0) rootClosed = true;
      pos = gt + 1;
      continue;
    }
    let body = text.slice(lt + 1, gt);
    const selfClosing = body.endsWith('/');
    if (selfClosing) body = body.slice(0, -1);
    const sp = body.search(/\s/);
    const name = sp === -1 ? body : body.slice(0, sp);
    if (!name || /^[\d.-]/.test(name)) fail(`"<${name}" is not a valid element name`, lt);
    if (stack.length === 0 && rootClosed) fail('a second root element was found; an XML document must have exactly one root element', lt);
    const attrs = parseAttributes(sp === -1 ? '' : body.slice(sp));
    h.open(name, attrs, selfClosing, stack.length);
    if (selfClosing) {
      h.close(name, stack.length);
      if (stack.length === 0) rootClosed = true;
    } else {
      stack.push(name);
    }
    pos = gt + 1;
  }
  if (stack.length && !opts.partial) {
    throw new AppError('XML_MALFORMED', `The XML ends before element <${stack[stack.length - 1]}> is closed. The file may be truncated.`);
  }
  if (!rootClosed && !opts.partial && stack.length === 0) {
    throw new AppError('XML_NO_ROOT', 'No XML elements were found in the file.');
  }
}

/** Index of the `>` ending a tag, skipping `>` inside quoted attribute values. */
function findTagEnd(text: string, from: number): number {
  let q = 0;
  for (let i = from; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (q) {
      if (c === q) q = 0;
    } else if (c === 34 || c === 39) {
      q = c;
    } else if (c === 62) {
      return i;
    } else if (c === 60) {
      return -1;
    }
  }
  return -1;
}
