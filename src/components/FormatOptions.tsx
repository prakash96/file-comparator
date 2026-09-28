import { useEffect, useState } from 'react';
import { FILE_FORMAT_LABELS, type FileFormat } from '../models/dataset';
import { ENCODINGS, type ParseOptions } from '../models/parseOptions';
import type { DatasetSummary } from '../models/session';
import { FixedWidthEditor } from './FixedWidthEditor';

const DELIMS: { value: string; label: string }[] = [
  { value: ',', label: 'Comma ,' },
  { value: '|', label: 'Pipe |' },
  { value: '\t', label: 'Tab' },
  { value: ';', label: 'Semicolon ;' },
];

const TEXT_FORMATS: FileFormat[] = ['delimited', 'fixedwidth', 'mnt', 'json', 'xml'];
const NESTED_FORMATS: FileFormat[] = ['json', 'xml', 'avro', 'parquet'];

interface Props {
  options: ParseOptions;
  summary: DatasetSummary | null;
  busy: boolean;
  onApply: (next: ParseOptions) => void;
}

/** Visible escape for special delimiters in the custom field. */
const showDelim = (d: string) => (d === '\t' ? '\\t' : d);
const readDelim = (d: string) => d.replace(/\\t/g, '\t');

/**
 * Parsing options for one file. Edits are kept as a draft and applied with
 * "Apply & re-read", so large files are not re-parsed on every keystroke.
 */
export function FormatOptions({ options, summary, busy, onApply }: Props) {
  const [draft, setDraft] = useState<ParseOptions>(options);
  useEffect(() => setDraft(options), [options]);

  const format: FileFormat = draft.format === 'auto' ? summary?.format ?? 'delimited' : draft.format;
  const dirty = JSON.stringify(draft) !== JSON.stringify(options);
  const set = (patch: Partial<ParseOptions>) => setDraft((d) => ({ ...d, ...patch }));
  const setDelim = (patch: Partial<ParseOptions['delimited']>) => setDraft((d) => ({ ...d, delimited: { ...d.delimited, ...patch } }));
  const isPreset = DELIMS.some((d) => d.value === draft.delimited.delimiter);
  const meta = summary?.meta;

  return (
    <div className="format-options">
      <div className="form-grid">
        <label>
          Format
          <select value={format} onChange={(e) => set({ format: e.target.value as FileFormat })}>
            {(Object.keys(FILE_FORMAT_LABELS) as FileFormat[]).map((f) => (
              <option key={f} value={f}>
                {FILE_FORMAT_LABELS[f]}
              </option>
            ))}
          </select>
        </label>
        {TEXT_FORMATS.includes(format) && (
          <label>
            Encoding
            <select value={draft.encoding} onChange={(e) => set({ encoding: e.target.value })}>
              {ENCODINGS.map((x) => (
                <option key={x.value} value={x.value}>
                  {x.label}
                </option>
              ))}
            </select>
          </label>
        )}
        {NESTED_FORMATS.includes(format) && (
          <label>
            Nested fields
            <select value={draft.nestedMode} onChange={(e) => set({ nestedMode: e.target.value as ParseOptions['nestedMode'] })}>
              <option value="flatten">Flatten (address.city)</option>
              <option value="nested">Keep nested (compare as JSON)</option>
            </select>
          </label>
        )}
      </div>

      {format === 'delimited' && (
        <div className="form-grid">
          <label>
            Delimiter
            <select value={isPreset ? draft.delimited.delimiter : 'custom'} onChange={(e) => setDelim({ delimiter: e.target.value === 'custom' ? '' : e.target.value })}>
              {DELIMS.map((d) => (
                <option key={d.label} value={d.value}>
                  {d.label}
                </option>
              ))}
              <option value="custom">Customâ€¦</option>
            </select>
          </label>
          {!isPreset && (
            <label>
              Custom delimiter
              <input value={showDelim(draft.delimited.delimiter)} placeholder="e.g. ~  ||  \t" onChange={(e) => setDelim({ delimiter: readDelim(e.target.value) })} />
              <span className="hint">Empty = detect</span>
            </label>
          )}
          <label>
            Quote character
            <select value={draft.delimited.quoteChar} onChange={(e) => setDelim({ quoteChar: e.target.value, escapeChar: draft.delimited.escapeChar === draft.delimited.quoteChar ? e.target.value : draft.delimited.escapeChar })}>
              <option value={'"'}>Double quote "</option>
              <option value="'">Single quote '</option>
              <option value="">None</option>
            </select>
          </label>
          <label>
            Escape character
            <select value={draft.delimited.escapeChar === draft.delimited.quoteChar ? 'double' : draft.delimited.escapeChar} onChange={(e) => setDelim({ escapeChar: e.target.value === 'double' ? draft.delimited.quoteChar : e.target.value })} disabled={!draft.delimited.quoteChar}>
              <option value="double">Doubled quote ("")</option>
              <option value="\">Backslash (\")</option>
            </select>
          </label>
          <label className="check">
            <input type="checkbox" checked={draft.delimited.hasHeader} onChange={(e) => setDelim({ hasHeader: e.target.checked })} /> First row is a header
          </label>
          <label className="check">
            <input type="checkbox" checked={draft.delimited.skipEmptyLines} onChange={(e) => setDelim({ skipEmptyLines: e.target.checked })} /> Skip empty lines
          </label>
        </div>
      )}

      {format === 'mnt' && (
        <div className="form-grid">
          <label>
            Record delimiter
            <input value={showDelim(draft.mnt.delimiter)} placeholder="| (empty = detect)" onChange={(e) => set({ mnt: { ...draft.mnt, delimiter: readDelim(e.target.value) } })} />
          </label>
          <label className="wide">
            Column names
            <input
              value={draft.mnt.columnNames.join(', ')}
              placeholder="optional, e.g. ACTION, MESSAGE_TYPE, ITEM, PRICE_TYPE…"
              onChange={(e) => set({ mnt: { ...draft.mnt, columnNames: e.target.value.split(',').map((n) => n.trimStart()) } })}
            />
            <span className="hint">Comma-separated, in field order. Unnamed fields are COL_1, COL_2…</span>
          </label>
        </div>
      )}

      {format === 'fixedwidth' && (
        <FixedWidthEditor value={draft.fixedWidth} onChange={(fixedWidth) => set({ fixedWidth })} sampleLines={meta?.sampleLines ?? []} suggested={meta?.suggestedLayout} />
      )}

      {format === 'json' && (
        <div className="form-grid">
          <label>
            Root path (records array)
            <input list={`json-roots-${summary?.slot}`} value={draft.json.rootPath} placeholder="auto-detect, e.g. customers or data.items" onChange={(e) => set({ json: { rootPath: e.target.value } })} />
            <datalist id={`json-roots-${summary?.slot}`}>
              {meta?.jsonRootCandidates?.map((c) => (
                <option key={c.path} value={c.path}>
                  {c.count.toLocaleString('en-US')} items
                </option>
              ))}
            </datalist>
          </label>
        </div>
      )}

      {format === 'xml' && (
        <div className="form-grid">
          <label>
            Record element
            <select value={draft.xml.recordNode} onChange={(e) => set({ xml: { ...draft.xml, recordNode: e.target.value } })}>
              <option value="">Auto-detect</option>
              {meta?.xmlRecordCandidates?.map((c) => (
                <option key={c.name} value={c.name}>
                  {`<${c.name}>  (${c.count.toLocaleString('en-US')})`}
                </option>
              ))}
              {draft.xml.recordNode && !meta?.xmlRecordCandidates?.some((c) => c.name === draft.xml.recordNode) && <option value={draft.xml.recordNode}>{draft.xml.recordNode}</option>}
            </select>
          </label>
          <label className="check">
            <input type="checkbox" checked={draft.xml.includeAttributes} onChange={(e) => set({ xml: { ...draft.xml, includeAttributes: e.target.checked } })} /> Include attributes as fields (@name)
          </label>
        </div>
      )}

      {format === 'excel' && (
        <div className="form-grid">
          <label>
            Worksheet
            <select value={draft.excel.sheet} onChange={(e) => set({ excel: { ...draft.excel, sheet: e.target.value } })}>
              {!meta?.sheets && <option value="">First non-empty sheet</option>}
              {meta?.sheets?.map((s) => (
                <option key={s.name} value={s.name}>
                  {`${s.name}  (${s.rows.toLocaleString('en-US')} rows)`}
                </option>
              ))}
            </select>
          </label>
          <label>
            {draft.excel.hasHeader ? 'Header row' : 'First data row'}
            <input type="number" min={1} value={draft.excel.headerRow} onChange={(e) => set({ excel: { ...draft.excel, headerRow: Math.max(1, parseInt(e.target.value, 10) || 1) } })} />
          </label>
          <label className="check">
            <input type="checkbox" checked={draft.excel.hasHeader} onChange={(e) => set({ excel: { ...draft.excel, hasHeader: e.target.checked } })} /> Sheet has a header row
          </label>
        </div>
      )}

      <div className="row-actions">
        <button type="button" className="primary" disabled={busy || (!dirty && format === summary?.format)} onClick={() => onApply({ ...draft, format })}>
          Apply &amp; re-read file
        </button>
        {dirty && (
          <button type="button" className="ghost" onClick={() => setDraft(options)}>
            Discard changes
          </button>
        )}
      </div>
    </div>
  );
}
