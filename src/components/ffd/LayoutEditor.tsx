import { useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { applyFfd, type FfdRecord } from '../../ffd/applyFfd';
import {
  deleteSegment,
  duplicateSegment,
  fieldAt,
  fieldOffsets,
  fitLength,
  layoutProblems,
  mapSegment,
  mergeWithNext,
  moveBoundary,
  removeField,
  renameSegment,
  setFieldLength,
  shareHeader,
  splitAt,
  updateField,
  addField,
} from '../../ffd/layoutOps';
import { FFD_TYPES, segmentLength, type FfdSchema, type FfdSegment, type FfdType } from '../../ffd/model';
import { fmt } from '../../utils/format';

export interface LayoutHistory {
  value: FfdSchema;
  set: (next: FfdSchema | ((cur: FfdSchema) => FfdSchema)) => void;
  preview: (next: FfdSchema) => void;
  commit: () => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
}

const MAX_RECORDS_PER_SEGMENT = 500;
const SHOW_OPTIONS = [3, 8, 20, 50];

/** Text input that commits on Enter / blur, so typing is one undo step, not one per key. */
function CommitInput({
  value,
  onCommit,
  className,
  type = 'text',
  min,
  ariaLabel,
  placeholder,
}: {
  value: string;
  onCommit: (v: string) => void;
  className?: string;
  type?: 'text' | 'number';
  min?: number;
  ariaLabel: string;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => draft !== value && onCommit(draft);
  return (
    <input
      className={className}
      type={type}
      min={min}
      value={draft}
      aria-label={ariaLabel}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') setDraft(value);
      }}
    />
  );
}

const visible = (s: string, dots: boolean) => (dots ? s.replace(/ /g, '·') : s);

/**
 * Visual fixed-width layout editor: a column ruler over sample records with
 * draggable field boundaries, a field table, and per-segment tools.
 */
export function LayoutEditor({ layout, sample }: { layout: LayoutHistory; sample: string }) {
  const schema = layout.value;
  const [segId, setSegId] = useState(schema.segments[0]?.id ?? '');
  const [fieldIdx, setFieldIdx] = useState(0);
  const [recIdx, setRecIdx] = useState(0);
  const [showCount, setShowCount] = useState(8);
  const [dots, setDots] = useState(true);
  const [hoverCol, setHoverCol] = useState<number | null>(null);

  const seg: FfdSegment | undefined = schema.segments.find((s) => s.id === segId) ?? schema.segments[0];
  useEffect(() => {
    if (seg && seg.id !== segId) setSegId(seg.id);
  }, [seg, segId]);
  const fIdx = seg ? Math.min(fieldIdx, seg.values.length - 1) : 0;

  // Which sample records belong to which segment, with the current (deferred) layout.
  const deferredSchema = useDeferredValue(schema);
  const deferredSample = useDeferredValue(sample);
  const applied = useMemo(() => {
    if (!deferredSample.trim()) return null;
    return applyFfd(deferredSample, deferredSchema, { recordMode: 'auto', trim: false, structureId: '' });
  }, [deferredSample, deferredSchema]);
  const bySegment = useMemo(() => {
    const m = new Map<string, FfdRecord[]>();
    for (const r of applied?.records ?? []) {
      const list = m.get(r.segment) ?? [];
      if (list.length < MAX_RECORDS_PER_SEGMENT) list.push(r);
      m.set(r.segment, list);
    }
    return m;
  }, [applied]);

  const records = (seg && bySegment.get(seg.id)) || [];
  const rIdx = Math.min(recIdx, Math.max(0, records.length - 1));
  // In line mode `raw` is the whole line, so text past the segment's end is visible too.
  const shown = useMemo(() => {
    if (!records.length) return [];
    const start = Math.max(0, Math.min(rIdx, records.length - showCount));
    return records.slice(start, start + showCount).map((r, k) => ({ r, idx: start + k, raw: r.raw }));
  }, [records, rIdx, showCount]);

  const problems = useMemo(() => layoutProblems(schema), [schema]);

  // ---- ruler geometry
  const inner = useRef<HTMLDivElement>(null);
  const probe = useRef<HTMLSpanElement>(null);
  const [ch, setCh] = useState(8);
  useLayoutEffect(() => {
    const measure = () => probe.current && setCh(probe.current.getBoundingClientRect().width / 100 || 8);
    measure();
    document.fonts?.ready.then(measure).catch(() => {});
    addEventListener('resize', measure);
    return () => removeEventListener('resize', measure);
  }, []);
  const px = (cols: number) => `${cols * ch}px`;
  const colFromEvent = (e: { clientX: number }, round = false) => {
    const rect = inner.current!.getBoundingClientRect();
    const x = (e.clientX - rect.left) / ch;
    return round ? Math.round(x) : Math.floor(x);
  };

  const drag = useRef<{ i: number; start: FfdSchema; id: string } | null>(null);

  if (!seg) return <p className="muted">The schema has no segments.</p>;

  const offs = fieldOffsets(seg);
  const segLen = segmentLength(seg);
  const width = Math.max(segLen, ...shown.map((s) => s.raw.length), 10);
  const sampleLens = [...new Set(records.map((r) => r.raw.length))].sort((a, b) => b - a);
  const lengthMismatch = records.length > 0 && !(sampleLens.length === 1 && sampleLens[0] === segLen);
  const field = seg.values[fIdx];
  const selectedRecord = shown.find((s) => s.idx === rIdx);

  const edit = (fn: (s: FfdSegment) => FfdSegment) => layout.set((cur) => mapSegment(cur, seg.id, fn));
  const hoverField = hoverCol !== null ? fieldAt(seg, hoverCol) : -1;

  const onRulerClick = (e: { clientX: number }) => {
    const col = colFromEvent(e, true);
    if (col > 0 && col < segLen && !offs.includes(col)) {
      edit((s) => splitAt(s, col));
      setFieldIdx(fieldAt(splitAt(seg, col), col));
    }
  };
  const onRecordClick = (e: { clientX: number; shiftKey: boolean }, idx: number) => {
    const col = colFromEvent(e);
    setRecIdx(idx);
    if (e.shiftKey && col > 0 && col < segLen && !offs.includes(col)) {
      edit((s) => splitAt(s, col));
      setFieldIdx(fieldAt(splitAt(seg, col), col));
      return;
    }
    const f = fieldAt(seg, col);
    if (f >= 0) setFieldIdx(f);
  };

  const onHandleDown = (e: PointerEvent<HTMLDivElement>, i: number) => {
    e.preventDefault();
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { i, start: schema, id: seg.id };
    setFieldIdx(i);
  };
  const onHandleMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const col = colFromEvent(e, true);
    layout.preview(mapSegment(d.start, d.id, (s) => moveBoundary(s, d.i, col)));
  };
  const onHandleUp = () => {
    if (drag.current) layout.commit();
    drag.current = null;
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const typing = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT';
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z' && !typing) {
      e.preventDefault();
      if (e.shiftKey) layout.redo();
      else layout.undo();
    } else if (mod && e.key.toLowerCase() === 'y' && !typing) {
      e.preventDefault();
      layout.redo();
    } else if (!typing && target.closest('.ruler-wrap')) {
      // Arrow keys move the selected field's start boundary; Alt+arrow selects fields.
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        const dir = e.key === 'ArrowLeft' ? -1 : 1;
        if (e.altKey) setFieldIdx((i) => Math.max(0, Math.min(seg.values.length - 1, i + dir)));
        else if (fIdx >= 1) edit((s) => moveBoundary(s, fIdx, offs[fIdx] + dir));
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && fIdx >= 1) {
        e.preventDefault();
        edit((s) => mergeWithNext(s, fIdx - 1));
        setFieldIdx(fIdx - 1);
      }
    }
  };

  // Scale: tick marks every column, labels every 10.
  const ticks = Array.from({ length: width }, (_, c) => ((c + 1) % 10 === 0 ? '|' : (c + 1) % 5 === 0 ? '+' : '·')).join('');
  const labels = Array.from({ length: Math.floor(width / 10) }, (_, k) => (k + 1) * 10);

  const segProblems = problems.filter((p) => p.segment === seg.id);

  return (
    <div className="layout-editor" onKeyDown={onKey}>
      <div className="le-toolbar">
        <button type="button" onClick={layout.undo} disabled={!layout.canUndo} title="Undo (Ctrl+Z)">
          ↶ Undo
        </button>
        <button type="button" onClick={layout.redo} disabled={!layout.canRedo} title="Redo (Ctrl+Y)">
          ↷ Redo
        </button>
        <label className="inline">
          Show
          <select value={showCount} onChange={(e) => setShowCount(Number(e.target.value))}>
            {SHOW_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n} records
              </option>
            ))}
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={dots} onChange={(e) => setDots(e.target.checked)} /> Show spaces as ·
        </label>
        {applied && applied.unknownRecords > 0 && (
          <span className="le-warn">
            {fmt(applied.unknownRecords)} record(s) match no segment{applied.mode === 'stream' ? ' (reading stopped there)' : ''}
          </span>
        )}
      </div>

      <div className="tabs le-segtabs" role="tablist" aria-label="Segments">
        {schema.segments.map((s) => {
          const n = applied?.segmentCounts[s.id] ?? 0;
          const bad = problems.some((p) => p.segment === s.id && p.severity === 'error');
          return (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={s.id === seg.id}
              className={`tab${s.id === seg.id ? ' is-active' : ''}`}
              onClick={() => (setSegId(s.id), setFieldIdx(0), setRecIdx(0))}
            >
              <code>{s.id}</code>
              <span className="tab-count">{fmt(n)}</span>
              {bad && <span className="le-dot" aria-label="has problems" />}
            </button>
          );
        })}
      </div>

      <div className="form-grid le-seg-form">
        <label>
          Segment id
          <CommitInput
            value={seg.id}
            ariaLabel="Segment id"
            onCommit={(v) => {
              const next = renameSegment(schema, seg.id, v);
              if (next !== schema) {
                layout.set(next);
                setSegId(v.trim());
              }
            }}
          />
        </label>
        <label>
          Segment name
          <CommitInput value={seg.name ?? ''} ariaLabel="Segment name" onCommit={(v) => edit((s) => ({ ...s, name: v || undefined }))} />
        </label>
        <div className="field">
          Record length
          <div className="le-len">
            <strong>{fmt(segLen)}</strong> defined
            {records.length > 0 && <span className={lengthMismatch ? 'le-warn' : 'muted'}> · sample {sampleLens.slice(0, 3).map(fmt).join(', ')}</span>}
          </div>
        </div>
        <div className="row-actions le-seg-actions">
          {lengthMismatch && (
            <button type="button" onClick={() => edit((s) => fitLength(s, sampleLens[0]))} title="Grow or shrink the last field(s)">
              Fit to {fmt(sampleLens[0])}
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              const r = duplicateSegment(schema, seg.id);
              layout.set(r.schema);
              setSegId(r.newId);
            }}
          >
            Duplicate
          </button>
          <button type="button" className="danger" disabled={schema.segments.length <= 1} onClick={() => layout.set(deleteSegment(schema, seg.id))}>
            Delete segment
          </button>
        </div>
      </div>

      <p className="hint le-help">
        Click the ruler (or Shift+click a record) to start a field there · drag a ▼ marker to move a boundary, double-click it to remove · click a record to select it and its field · with the ruler
        focused, ←/→ move the selected field's start, Alt+←/→ select fields, Delete merges into the previous field.
      </p>

      <div className="ruler-wrap" tabIndex={0} aria-label="Record layout ruler" onPointerLeave={() => setHoverCol(null)}>
        <div className="ruler" ref={inner} style={{ width: px(width + 1) }} onPointerMove={(e) => setHoverCol(colFromEvent(e))}>
          <span ref={probe} className="ruler-probe" aria-hidden>
            {'0'.repeat(100)}
          </span>
          {/* column highlight + boundary lines through every row */}
          {hoverCol !== null && hoverCol < width && <div className="ruler-hover" style={{ left: px(hoverCol), width: px(1) }} />}
          {offs.slice(1).map((o) => (
            <div key={`l${o}`} className="ruler-line" style={{ left: px(o) }} />
          ))}
          {segLen < width && <div className="ruler-end" style={{ left: px(segLen) }} />}

          <div className="ruler-labels" aria-hidden>
            {labels.map((c) => (
              <span key={c} style={{ left: px(c - 1) }}>
                {c}
              </span>
            ))}
          </div>
          <div className="ruler-ticks" aria-hidden onClick={onRulerClick} title="Click to start a new field at this column">
            {ticks}
          </div>
          <div className="ruler-handles" onClick={onRulerClick}>
            {offs.slice(1).map((o, k) => (
              <div
                key={`h${k}`}
                className={`ruler-handle${k + 1 === fIdx ? ' is-selected' : ''}`}
                style={{ left: px(o) }}
                title={`Boundary at column ${o + 1} (start of ${seg.values[k + 1].name}). Drag to move, double-click to remove.`}
                onPointerDown={(e) => onHandleDown(e, k + 1)}
                onPointerMove={onHandleMove}
                onPointerUp={onHandleUp}
                onPointerCancel={onHandleUp}
                onClick={(e) => e.stopPropagation()}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  edit((s) => mergeWithNext(s, k));
                  setFieldIdx(k);
                }}
              >
                ▼
              </div>
            ))}
          </div>
          <div className="ruler-fields">
            {seg.values.map((v, i) => (
              <button
                key={i}
                type="button"
                className={`rf${i % 2 ? ' odd' : ''}${i === fIdx ? ' is-selected' : ''}${v.tagValue !== undefined ? ' is-tag' : ''}`}
                style={{ width: px(v.length) }}
                title={`${v.name} · columns ${offs[i] + 1}–${offs[i] + v.length} · length ${v.length}${v.tagValue !== undefined ? ' · tag' : ''}`}
                onClick={() => setFieldIdx(i)}
              >
                {v.name}
              </button>
            ))}
          </div>
          <div className="ruler-records">
            {shown.length === 0 && <div className="muted ruler-empty">No sample records match this segment{sample.trim() ? '' : ' (no sample text)'}.</div>}
            {shown.map(({ r, idx, raw }) => (
              <div
                key={idx}
                className={`rr${idx === rIdx ? ' is-current' : ''}`}
                onClick={(e) => onRecordClick(e, idx)}
                title={`Record ${idx + 1} of ${records.length} (${applied?.mode === 'lines' ? 'line' : 'record'} ${r.line})`}
              >
                {seg.values.map((v, i) => (
                  <span key={i} className={`rc${i % 2 ? ' odd' : ''}${i === fIdx ? ' is-selected' : ''}`} style={{ width: px(v.length) }}>
                    {visible(raw.slice(offs[i], offs[i] + v.length), dots)}
                  </span>
                ))}
                {raw.length > segLen && <span className="rc extra">{visible(raw.slice(segLen), dots)}</span>}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="le-status">
        {hoverCol !== null ? (
          <>
            Column <strong>{hoverCol + 1}</strong>
            {hoverField >= 0 ? (
              <>
                {' '}
                · {seg.values[hoverField].name} ({offs[hoverField] + 1}–{offs[hoverField] + seg.values[hoverField].length}, length {seg.values[hoverField].length})
              </>
            ) : (
              ' · past the end of the segment'
            )}
          </>
        ) : (
          <span className="muted">Hover the ruler to see column positions.</span>
        )}
        {records.length > 1 && (
          <span className="le-recnav">
            <button type="button" className="icon-btn" disabled={rIdx === 0} onClick={() => setRecIdx(rIdx - 1)} aria-label="Previous record">
              ‹
            </button>
            Record {fmt(rIdx + 1)} of {fmt(records.length)}
            {(applied?.segmentCounts[seg.id] ?? 0) > records.length && ` (first ${fmt(records.length)} shown)`}
            <button type="button" className="icon-btn" disabled={rIdx >= records.length - 1} onClick={() => setRecIdx(rIdx + 1)} aria-label="Next record">
              ›
            </button>
          </span>
        )}
      </div>

      <div className="table-scroll le-fields">
        <table className="data">
          <thead>
            <tr>
              <th className="num">#</th>
              <th>Name</th>
              <th className="num">Start</th>
              <th className="num">Length</th>
              <th className="num">End</th>
              <th>Type</th>
              <th>Tag value</th>
              <th>Format</th>
              <th>Value in record {selectedRecord ? fmt(rIdx + 1) : ''}</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {seg.values.map((v, i) => {
              const raw = selectedRecord ? selectedRecord.raw.slice(offs[i], offs[i] + v.length) : '';
              const probs = segProblems.filter((p) => p.field === i);
              return (
                <tr key={i} className={`${i === fIdx ? 'is-selected' : ''}${probs.some((p) => p.severity === 'error') ? ' has-error' : ''}`} onClick={() => setFieldIdx(i)}>
                  <td className="num">{i + 1}</td>
                  <td>
                    <CommitInput className="le-name" value={v.name} ariaLabel={`Name of field ${i + 1}`} onCommit={(name) => edit((s) => updateField(s, i, { name: name.trim() }))} />
                  </td>
                  <td className="num">{offs[i] + 1}</td>
                  <td className="num">
                    <CommitInput
                      className="le-num"
                      type="number"
                      min={1}
                      value={String(v.length)}
                      ariaLabel={`Length of ${v.name}`}
                      onCommit={(len) => edit((s) => setFieldLength(s, i, Number(len)))}
                    />
                  </td>
                  <td className="num">{offs[i] + v.length}</td>
                  <td>
                    <select value={v.type} aria-label={`Type of ${v.name}`} onChange={(e) => edit((s) => updateField(s, i, { type: e.target.value as FfdType }))}>
                      {FFD_TYPES.map((t) => (
                        <option key={t}>{t}</option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <div className="le-tag">
                      <input
                        type="checkbox"
                        checked={v.tagValue !== undefined}
                        aria-label={`${v.name} identifies the record type`}
                        title="This field identifies the record type"
                        onChange={(e) => edit((s) => updateField(s, i, { tagValue: e.target.checked ? raw || ' '.repeat(v.length) : undefined }))}
                      />
                      {v.tagValue !== undefined && (
                        <CommitInput className="le-tagval" value={v.tagValue} ariaLabel={`Tag value of ${v.name} (spaces count)`} onCommit={(t) => edit((s) => updateField(s, i, { tagValue: t }))} />
                      )}
                    </div>
                  </td>
                  <td className="le-format">
                    <select
                      value={v.format?.justify ?? ''}
                      aria-label={`Justification of ${v.name}`}
                      onChange={(e) => edit((s) => updateField(s, i, { format: cleanFormat({ ...v.format, justify: (e.target.value || undefined) as 'LEFT' | 'RIGHT' | undefined }) }))}
                    >
                      <option value="">–</option>
                      <option value="LEFT">LEFT</option>
                      <option value="RIGHT">RIGHT</option>
                    </select>
                    {v.type === 'Decimal' && (
                      <CommitInput
                        className="le-num"
                        type="number"
                        min={0}
                        value={String(v.format?.implicit ?? '')}
                        placeholder="implicit"
                        ariaLabel={`Implied decimals of ${v.name}`}
                        onCommit={(n) => edit((s) => updateField(s, i, { format: cleanFormat({ ...v.format, implicit: Number(n) || undefined }) }))}
                      />
                    )}
                    {(v.type === 'Date' || v.type === 'DateTime' || v.type === 'Time') && (
                      <CommitInput
                        className="le-pattern"
                        value={v.format?.pattern ?? ''}
                        placeholder="yyyyMMdd"
                        ariaLabel={`Pattern of ${v.name}`}
                        onCommit={(p) => edit((s) => updateField(s, i, { format: cleanFormat({ ...v.format, pattern: p || undefined }) }))}
                      />
                    )}
                  </td>
                  <td className="le-value" title={probs.map((p) => p.message).join('\n') || undefined}>
                    <code>{visible(raw, dots)}</code>
                  </td>
                  <td className="le-actions">
                    <button
                      type="button"
                      className="icon-btn"
                      disabled={i + 1 >= seg.values.length}
                      title="Merge with the next field"
                      onClick={(e) => (e.stopPropagation(), edit((s) => mergeWithNext(s, i)))}
                    >
                      Merge ↓
                    </button>
                    <button
                      type="button"
                      className="icon-btn"
                      disabled={seg.values.length <= 1}
                      title="Remove this field (the record gets shorter)"
                      onClick={(e) => (e.stopPropagation(), edit((s) => removeField(s, i)))}
                    >
                      Delete
                    </button>
                    {schema.segments.length > 1 && (
                      <button
                        type="button"
                        className="icon-btn"
                        title={`Copy fields 1–${i + 1} (columns 1–${offs[i] + v.length}) to every other segment as a shared header`}
                        onClick={(e) => (e.stopPropagation(), layout.set(shareHeader(schema, seg.id, i)))}
                      >
                        Share 1–{i + 1}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="row-actions">
        <button type="button" onClick={() => edit((s) => addField(s, 1))}>
          + Add field at end
        </button>
        {field && (
          <span className="muted">
            Selected: {field.name} · columns {offs[fIdx] + 1}–{offs[fIdx] + field.length}
          </span>
        )}
      </div>

      {problems.length > 0 && (
        <ul className="issues">
          {problems.slice(0, 20).map((p, k) => (
            <li key={k} className={`issue issue-${p.severity}`}>
              <span className="issue-icon" aria-label={p.severity}>
                {p.severity === 'error' ? '✖' : '▲'}
              </span>
              <span>
                <button type="button" className="link" onClick={() => (setSegId(p.segment), p.field !== undefined && setFieldIdx(p.field))}>
                  {p.segment}
                </button>{' '}
                {p.message}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function cleanFormat(f: NonNullable<FfdSegment['values'][number]['format']>) {
  const out = Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined && v !== ''));
  return Object.keys(out).length ? out : undefined;
}
