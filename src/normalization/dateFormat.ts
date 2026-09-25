/**
 * Date pattern compiler.
 *
 * Patterns use the Java/DataStage-style tokens developers already know:
 *   yyyy yy  MMMM MMM MM M  dd d  HH H hh h  mm  ss  S..S (fraction)  a (AM/PM)
 * Text in single quotes is literal: `yyyy-MM-dd'T'HH:mm:ss`.
 *
 * A compiled pattern turns a matching string into a canonical form:
 *   `yyyy-MM-dd`                     when there is no time part or the time is midnight
 *   `yyyy-MM-dd HH:mm:ss[.fraction]` otherwise (fraction without trailing zeros)
 * so the same instant written in different formats compares equal.
 */

export type DateParser = (value: string) => string | null;

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTHS_LONG = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

interface Parts {
  year?: number;
  month?: number;
  day?: number;
  hour?: number;
  minute?: number;
  second?: number;
  fraction?: string;
  pm?: boolean;
  hasAmPm?: boolean;
  offsetMinutes?: number;
}

type Setter = (parts: Parts, text: string) => boolean;

interface Token {
  regex: string;
  set?: Setter;
}

const num = (key: 'year' | 'month' | 'day' | 'hour' | 'minute' | 'second'): Setter => (p, t) => {
  p[key] = parseInt(t, 10);
  return true;
};

function tokenFor(tok: string): Token | null {
  switch (tok) {
    case 'yyyy': return { regex: '(\\d{4})', set: num('year') };
    case 'yy': return { regex: '(\\d{2})', set: (p, t) => { const y = parseInt(t, 10); p.year = y < 50 ? 2000 + y : 1900 + y; return true; } };
    case 'MMMM': return { regex: '([A-Za-z]+)', set: (p, t) => { const i = MONTHS_LONG.indexOf(t.toLowerCase()); p.month = i + 1; return i >= 0; } };
    case 'MMM': return { regex: '([A-Za-z]{3})', set: (p, t) => { const i = MONTHS.indexOf(t.toLowerCase()); p.month = i + 1; return i >= 0; } };
    case 'MM': return { regex: '(\\d{2})', set: num('month') };
    case 'M': return { regex: '(\\d{1,2})', set: num('month') };
    case 'dd': return { regex: '(\\d{2})', set: num('day') };
    case 'd': return { regex: '(\\d{1,2})', set: num('day') };
    case 'HH': return { regex: '(\\d{2})', set: num('hour') };
    case 'H': return { regex: '(\\d{1,2})', set: num('hour') };
    case 'hh': return { regex: '(\\d{2})', set: num('hour') };
    case 'h': return { regex: '(\\d{1,2})', set: num('hour') };
    case 'mm': return { regex: '(\\d{2})', set: num('minute') };
    case 'ss': return { regex: '(\\d{2})', set: num('second') };
    case 'a': return { regex: '([AaPp][Mm])', set: (p, t) => { p.hasAmPm = true; p.pm = t.toLowerCase() === 'pm'; return true; } };
    default:
      if (/^S+$/.test(tok)) return { regex: `(\\d{1,${tok.length}})`, set: (p, t) => { p.fraction = t; return true; } };
      return null;
  }
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** Build the canonical string from parsed parts, or null if the parts are not a valid date/time. */
function canonical(p: Parts): string | null {
  let { year, month, day, hour = 0 } = p;
  let minute = p.minute ?? 0;
  if (year === undefined || month === undefined || day === undefined) return null;
  if (p.hasAmPm) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (p.pm ? 12 : 0);
  }
  let second = p.second ?? 0;
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  if (hour > 23 || minute > 59 || second > 60) return null;
  if (p.offsetMinutes) {
    // Shift to UTC so the same instant in different zones compares equal.
    const ms = Date.UTC(year, month - 1, day, hour, minute, second) - p.offsetMinutes * 60000;
    const d = new Date(ms);
    year = d.getUTCFullYear(); month = d.getUTCMonth() + 1; day = d.getUTCDate();
    hour = d.getUTCHours(); minute = d.getUTCMinutes(); second = d.getUTCSeconds();
  }
  const fraction = (p.fraction ?? '').replace(/0+$/, '');
  const date = `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
  if (hour === 0 && minute === 0 && second === 0 && !fraction) return date;
  return `${date} ${pad(hour)}:${pad(minute)}:${pad(second)}${fraction ? `.${fraction}` : ''}`;
}

const TOKEN_RE = /'([^']*)'|(yyyy|yy|MMMM|MMM|MM|M|dd|d|HH|H|hh|h|mm|ss|S+|a)/g;

/** Compile a pattern such as `MM/dd/yyyy HH:mm:ss` into a parser. Throws on an empty pattern. */
export function compileDateFormat(pattern: string): DateParser {
  if (!pattern.trim()) throw new Error('Empty date format');
  let regex = '^';
  const setters: Setter[] = [];
  let last = 0;
  for (const m of pattern.matchAll(TOKEN_RE)) {
    regex += escapeRegex(pattern.slice(last, m.index));
    if (m[1] !== undefined) {
      regex += escapeRegex(m[1]);
    } else {
      const t = tokenFor(m[2]);
      if (t) {
        regex += t.regex;
        if (t.set) setters.push(t.set);
      }
    }
    last = (m.index ?? 0) + m[0].length;
  }
  regex += `${escapeRegex(pattern.slice(last))}$`;
  const re = new RegExp(regex, 'i');
  return (value: string) => {
    const m = re.exec(value);
    if (!m) return null;
    const parts: Parts = {};
    for (let i = 0; i < setters.length; i++) {
      if (!setters[i](parts, m[i + 1])) return null;
    }
    return canonical(parts);
  };
}

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?)?\s*(Z|z|[+-]\d{2}:?\d{2})?$/;

/** ISO-8601 dates and timestamps (with optional zone offset), always recognised. */
export const parseIsoDate: DateParser = (value: string) => {
  const m = ISO_RE.exec(value);
  if (!m) return null;
  const parts: Parts = {
    year: +m[1], month: +m[2], day: +m[3],
    hour: m[4] ? +m[4] : 0, minute: m[5] ? +m[5] : 0, second: m[6] ? +m[6] : 0,
    fraction: m[7],
  };
  const zone = m[8];
  if (zone && zone.toUpperCase() !== 'Z') {
    const sign = zone[0] === '-' ? -1 : 1;
    const digits = zone.slice(1).replace(':', '');
    parts.offsetMinutes = sign * (parseInt(digits.slice(0, 2), 10) * 60 + parseInt(digits.slice(2), 10));
  }
  return canonical(parts);
};

/** Validate a pattern for the UI. Returns an error message or null. */
export function validateDateFormat(pattern: string): string | null {
  try {
    const parser = compileDateFormat(pattern);
    void parser;
    if (!/yyyy|yy/.test(pattern) || !/M/.test(pattern) || !/d/.test(pattern)) {
      return 'A date format needs at least a year (yyyy or yy), a month (M, MM, MMM) and a day (d or dd).';
    }
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
