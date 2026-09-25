/**
 * Errors and warnings shown to the user.
 *
 * `message` is written for DataStage developers ("Record 1,204 has 10 fields,
 * expected 5"). Anything technical (exception text, stack) goes in `details`,
 * which the UI only shows behind a "Technical details" toggle. Record values are
 * never put in `details` so that nothing sensitive ends up in logs or reports.
 */

export type IssueSeverity = 'error' | 'warning' | 'info';

export interface Issue {
  severity: IssueSeverity;
  /** Stable machine-readable code, e.g. `CSV_FIELD_COUNT`. */
  code: string;
  /** Plain-language explanation. */
  message: string;
  /** Optional technical detail (exception message, parser state). */
  details?: string;
  /** 1-based record number, when the issue concerns one record. */
  record?: number;
  /** 1-based physical line number, when known. */
  line?: number;
  /** How many times this issue occurred (for aggregated issues). */
  count?: number;
}

/** An error that carries a user-facing message plus optional technical details. */
export class AppError extends Error {
  readonly code: string;
  readonly details?: string;
  readonly line?: number;
  readonly record?: number;

  constructor(code: string, message: string, opts: { details?: string; line?: number; record?: number; cause?: unknown } = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = opts.details ?? (opts.cause instanceof Error ? opts.cause.message : undefined);
    this.line = opts.line;
    this.record = opts.record;
  }

  toIssue(): Issue {
    return { severity: 'error', code: this.code, message: this.message, details: this.details, line: this.line, record: this.record };
  }
}

/** Serializable error sent from the worker to the UI. */
export interface FriendlyError {
  code: string;
  message: string;
  details?: string;
}

export function toFriendlyError(err: unknown, fallbackMessage = 'An unexpected problem occurred while processing the file.'): FriendlyError {
  if (err instanceof AppError) {
    return { code: err.code, message: err.message, details: err.details };
  }
  if (err instanceof RangeError && /string length|allocation|memory/i.test(err.message)) {
    return {
      code: 'OUT_OF_MEMORY',
      message:
        'The browser ran out of memory while processing this file. Try a smaller extract, close other tabs, or use a 64-bit desktop browser.',
      details: `${err.name}: ${err.message}`,
    };
  }
  if (err instanceof Error) {
    return { code: 'UNEXPECTED', message: fallbackMessage, details: `${err.name}: ${err.message}${err.stack ? `\n${err.stack}` : ''}` };
  }
  return { code: 'UNEXPECTED', message: fallbackMessage, details: String(err) };
}

/**
 * Collects issues while parsing. Repeated issues with the same code are
 * aggregated after `maxPerCode` individual entries so a file with a million bad
 * rows does not produce a million warnings.
 */
export class IssueCollector {
  private readonly issues: Issue[] = [];
  private readonly counts = new Map<string, number>();
  private readonly overflow = new Map<string, Issue>();

  constructor(private readonly maxPerCode = 20) {}

  add(issue: Issue): void {
    const n = (this.counts.get(issue.code) ?? 0) + 1;
    this.counts.set(issue.code, n);
    if (n <= this.maxPerCode) {
      this.issues.push(issue);
      return;
    }
    const agg = this.overflow.get(issue.code);
    if (agg) {
      agg.count = (agg.count ?? 0) + 1;
    } else {
      this.overflow.set(issue.code, {
        severity: issue.severity,
        code: issue.code,
        message: `…and more occurrences of the same problem (${issue.code}).`,
        count: 1,
      });
    }
  }

  warn(code: string, message: string, extra: Partial<Issue> = {}): void {
    this.add({ severity: 'warning', code, message, ...extra });
  }

  error(code: string, message: string, extra: Partial<Issue> = {}): void {
    this.add({ severity: 'error', code, message, ...extra });
  }

  info(code: string, message: string, extra: Partial<Issue> = {}): void {
    this.add({ severity: 'info', code, message, ...extra });
  }

  countOf(code: string): number {
    return this.counts.get(code) ?? 0;
  }

  toArray(): Issue[] {
    const out = [...this.issues];
    for (const agg of this.overflow.values()) {
      out.push({ ...agg, message: `…and ${(agg.count ?? 0).toLocaleString('en-US')} more occurrence(s) of ${agg.code}.` });
    }
    return out;
  }
}
