/**
 * Streaming delimited-text tokenizer.
 *
 * Feed it text chunks of any size; it emits one string[] per record.
 * - delimiter may be any non-empty string (`,`, `|`, `\t`, `||`, `~^~` ...)
 * - a field is quoted only if the quote character is its very first character
 * - inside quotes: doubled quote (`""`) when escape == quote, otherwise
 *   `<escape><char>` inserts <char> literally (e.g. `\"`)
 * - record separators: \n, \r\n or \r; newlines inside quotes are kept
 *
 * A record that is incomplete at the end of a chunk is re-scanned when the next
 * chunk arrives, which keeps the state machine simple and handles delimiters,
 * quotes and CRLF split across chunk boundaries.
 */

export interface TokenizerOptions {
  delimiter: string;
  quoteChar: string;
  escapeChar: string;
  /** Line number of the first line fed in (when the caller skipped leading lines). Default 1. */
  startLine?: number;
}

export interface TokenizerEvents {
  record(fields: string[], line: number, quotedEmptyLine: boolean): void;
  /** Characters after a closing quote before the delimiter (`"abc"x,`). */
  textAfterQuote(line: number): void;
  /** File ended inside a quoted field. */
  unterminatedQuote(line: number): void;
}

const INCOMPLETE = -1;

export class DelimitedTokenizer {
  private carry = '';
  private line = 1;
  private readonly delim: string;
  private readonly quote: string;
  private readonly escape: string;

  constructor(opts: TokenizerOptions, private readonly ev: TokenizerEvents) {
    if (!opts.delimiter) throw new Error('Delimiter must not be empty');
    this.delim = opts.delimiter;
    this.quote = opts.quoteChar;
    this.escape = opts.escapeChar || opts.quoteChar;
    this.line = opts.startLine ?? 1;
  }

  feed(chunk: string, isLast = false): void {
    const buf = this.carry ? this.carry + chunk : chunk;
    this.carry = '';
    const scan = new Scanner(buf, this.delim);
    let pos = 0;
    while (pos < buf.length) {
      const next = this.parseRecord(buf, pos, isLast, scan);
      if (next === INCOMPLETE) {
        this.carry = buf.slice(pos);
        return;
      }
      pos = next;
    }
  }

  end(): void {
    if (this.carry) {
      const rest = this.carry;
      this.carry = '';
      this.feed(rest, true);
    }
  }

  /** Parse one record starting at `start`. Returns the index after its terminator, or INCOMPLETE. */
  private parseRecord(buf: string, start: number, isLast: boolean, scan: Scanner): number {
    const { delim, quote, escape } = this;
    const dlen = delim.length;
    const qlen = quote.length;
    const len = buf.length;
    const fields: string[] = [];
    let embeddedNewlines = 0;
    let anyQuoted = false;
    let i = start;

    for (;;) {
      if (qlen && buf.startsWith(quote, i)) {
        // ---------- quoted field
        anyQuoted = true;
        let j = i + qlen;
        let value = '';
        let closed = false;
        for (;;) {
          const q = buf.indexOf(quote, j);
          const e = escape !== quote ? buf.indexOf(escape, j) : -1;
          if (e !== -1 && (q === -1 || e < q)) {
            if (e + escape.length >= len && !isLast) return INCOMPLETE;
            value += buf.slice(j, e) + buf.charAt(e + escape.length);
            j = e + escape.length + 1;
            continue;
          }
          if (q === -1) {
            if (!isLast) return INCOMPLETE;
            value += buf.slice(j);
            j = len;
            this.ev.unterminatedQuote(this.line);
            break;
          }
          if (escape === quote) {
            if (q + qlen >= len && !isLast) return INCOMPLETE; // cannot tell yet if it is a doubled quote
            if (buf.startsWith(quote, q + qlen)) {
              value += buf.slice(j, q) + quote;
              j = q + 2 * qlen;
              continue;
            }
          }
          value += buf.slice(j, q);
          j = q + qlen;
          closed = true;
          break;
        }
        if (value.indexOf('\n') !== -1 || value.indexOf('\r') !== -1) {
          embeddedNewlines += countLineBreaks(value);
        }
        i = j;
        if (closed && i < len && !buf.startsWith(delim, i) && buf[i] !== '\n' && buf[i] !== '\r') {
          // junk after the closing quote: keep it, like most readers do
          const end = scan.fieldEnd(i);
          if (end === Infinity && !isLast) return INCOMPLETE;
          const stop = end === Infinity ? len : end;
          value += buf.slice(i, stop);
          this.ev.textAfterQuote(this.line + embeddedNewlines);
          i = stop;
        }
        fields.push(value);
      } else {
        // ---------- unquoted field
        const end = scan.fieldEnd(i);
        if (end === Infinity) {
          if (!isLast) return INCOMPLETE;
          fields.push(buf.slice(i));
          i = len;
        } else {
          fields.push(buf.slice(i, end));
          i = end;
        }
      }

      // ---------- after a field: delimiter, newline or end
      if (i >= len) {
        if (!isLast) return INCOMPLETE;
        this.emit(fields, embeddedNewlines, anyQuoted);
        return len;
      }
      if (buf.startsWith(delim, i)) {
        i += dlen;
        if (i >= len && !isLast) return INCOMPLETE;
        if (i >= len) {
          fields.push('');
          this.emit(fields, embeddedNewlines, anyQuoted);
          return len;
        }
        continue;
      }
      // newline
      if (buf[i] === '\r') {
        if (i + 1 >= len && !isLast) return INCOMPLETE; // may be \r\n split across chunks
        i += buf[i + 1] === '\n' ? 2 : 1;
      } else {
        i += 1;
      }
      this.emit(fields, embeddedNewlines, anyQuoted);
      return i;
    }
  }

  private emit(fields: string[], embeddedNewlines: number, anyQuoted: boolean): void {
    const line = this.line;
    this.line += 1 + embeddedNewlines;
    this.ev.record(fields, line, anyQuoted);
  }
}

function countLineBreaks(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 10) n++;
    else if (c === 13) {
      n++;
      if (s.charCodeAt(i + 1) === 10) i++;
    }
  }
  return n;
}

/**
 * Finds the end of an unquoted field (next delimiter or line break) with cached
 * indexOf positions, so scanning stays linear even when a delimiter or `\r`
 * never occurs in the buffer.
 */
class Scanner {
  private nextDelim = -2;
  private nextLf = -2;
  private nextCr = -2;

  constructor(private readonly buf: string, private readonly delim: string) {}

  private find(cached: number, needle: string, from: number): number {
    if (cached === Infinity) return Infinity;
    if (cached >= from) return cached;
    const i = this.buf.indexOf(needle, from);
    return i === -1 ? Infinity : i;
  }

  fieldEnd(from: number): number {
    this.nextDelim = this.find(this.nextDelim, this.delim, from);
    this.nextLf = this.find(this.nextLf, '\n', from);
    this.nextCr = this.find(this.nextCr, '\r', from);
    return Math.min(this.nextDelim, this.nextLf, this.nextCr);
  }
}
