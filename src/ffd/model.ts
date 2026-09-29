/**
 * Flat File Definition (FFD) - the MuleSoft / DataWeave flat-file schema
 * (YAML). Only the fixed-width parts are modelled: `form: FLATFILE` (several
 * record types identified by a tag, grouped by `structures`) and
 * `form: FIXEDWIDTH` (one record type, top-level `values`).
 */

export type FfdForm = 'FLATFILE' | 'FIXEDWIDTH';

export type FfdType = 'String' | 'Integer' | 'Decimal' | 'Boolean' | 'Date' | 'DateTime' | 'Time';

export const FFD_TYPES: FfdType[] = ['String', 'Integer', 'Decimal', 'Boolean', 'Date', 'DateTime', 'Time'];

/** M = mandatory, O = optional, C = conditional, U = unused. */
export type FfdUsage = 'M' | 'O' | 'C' | 'U';

export interface FfdFormat {
  justify?: 'LEFT' | 'RIGHT';
  pad?: string;
  /** Implied decimal places for Decimal values (`12345` with implicit 2 = 123.45). */
  implicit?: number;
  pattern?: string;
}

export interface FfdValue {
  name: string;
  type: FfdType;
  length: number;
  /** When set, the value at this position identifies the record type. */
  tagValue?: string;
  usage?: FfdUsage;
  format?: FfdFormat;
}

export interface FfdSegment {
  id: string;
  name?: string;
  /** Legacy tag form: the tag string found at the schema's `tagStart` / `tagLength`. */
  tag?: string;
  values: FfdValue[];
}

export interface FfdSegmentRef {
  kind: 'segment';
  idRef: string;
  usage: FfdUsage;
  /** Maximum occurrences; Infinity for `'>1'`. */
  max: number;
}

export interface FfdGroup {
  kind: 'group';
  groupId: string;
  usage: FfdUsage;
  max: number;
  items: FfdItem[];
}

export type FfdItem = FfdSegmentRef | FfdGroup;

export interface FfdStructure {
  id: string;
  name?: string;
  data: FfdItem[];
}

export interface FfdSchema {
  form: FfdForm;
  /** Legacy schema-level tag position (0-based) and length. */
  tagStart?: number;
  tagLength?: number;
  structures: FfdStructure[];
  segments: FfdSegment[];
}

export const segmentLength = (s: FfdSegment) => s.values.reduce((n, v) => n + v.length, 0);
