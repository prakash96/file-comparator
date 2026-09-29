import { useDeferredValue, useId, useMemo, useRef, useState } from 'react';
import { AppHeader, type ThemeControl } from '../components/AppHeader';
import { IssueList } from '../components/Messages';
import { applyFfd, type ApplyOptions, type FfdRecordMode } from '../ffd/applyFfd';
import { FfdError, parseFfd, stringifyFfd } from '../ffd/ffdYaml';
import { defaultInferOptions, inferFfd, type InferOptions, type InferResult } from '../ffd/inferFfd';
import type { FfdSchema } from '../ffd/model';
import { downloadBlob, fmt } from '../utils/format';

type Tab = 'generate' | 'apply';

/** Show at most this much JSON on screen; the download always has all of it. */
const MAX_SHOWN_JSON = 1_000_000;

function lineCount(text: string): number {
  if (!text) return 0;
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return text.endsWith('\n') ? n - 1 : n;
}

const baseName = (name: string) => name.replace(/\.[^.]*$/, '') || 'output';

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      disabled={!text}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          /* clipboard blocked: the download button still works */
        }
      }}
    >
      {done ? 'Copied ✓' : label}
    </button>
  );
}

/** A monospace text box that can also be filled from a local file. */
function TextSource({ label, value, onChange, accept, placeholder, fileName, onFileName, rows = 12 }: {
  label: string;
  value: string;
  onChange: (text: string) => void;
  accept: string;
  placeholder: string;
  fileName: string;
  onFileName: (name: string) => void;
  rows?: number;
}) {
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  return (
    <div className="text-source">
      <div className="text-source-head">
        <label htmlFor={id}>{label}</label>
        <span className="muted">
          {fileName && `${fileName} · `}
          {fmt(lineCount(value))} lines · {fmt(value.length)} chars
        </span>
        <span className="text-source-actions">
          <button type="button" onClick={() => input.current?.click()}>
            Open file…
          </button>
          {value && (
            <button type="button" className="ghost" onClick={() => (onChange(''), onFileName(''))}>
              Clear
            </button>
          )}
        </span>
        <input
          ref={input}
          type="file"
          accept={accept}
          hidden
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (!f) return;
            onChange(await f.text());
            onFileName(f.name);
          }}
        />
      </div>
      <textarea id={id} className="code-input" rows={rows} spellCheck={false} wrap="off" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

const numOrNull = (s: string): number | null => (s.trim() === '' ? null : Math.max(0, parseInt(s, 10) || 0));

function GenerateTab({ sample, onApply }: { sample: string; onApply: (ffd: string) => void }) {
  const [opts, setOpts] = useState<InferOptions>(defaultInferOptions);
  const [tagStart, setTagStart] = useState('');
  const [tagLength, setTagLength] = useState('');
  const [result, setResult] = useState<InferResult | null>(null);
  const [yaml, setYaml] = useState('');

  const generate = () => {
    const r = inferFfd(sample, { ...opts, tagStart: numOrNull(tagStart), tagLength: numOrNull(tagLength) });
    setResult(r);
    setYaml(stringifyFfd(r.schema));
  };

  return (
    <div className="tab-body ffd-tab">
      <div className="form-grid">
        <label>
          Tag start position
          <input type="number" min={1} value={tagStart === '' ? '' : Number(tagStart) + 1} placeholder="auto" onChange={(e) => setTagStart(e.target.value === '' ? '' : String(Math.max(1, parseInt(e.target.value, 10) || 1) - 1))} />
          <span className="hint">1-based column where the record-type code starts</span>
        </label>
        <label>
          Tag length
          <input type="number" min={0} value={tagLength} placeholder="auto" onChange={(e) => setTagLength(e.target.value)} />
          <span className="hint">0 = one record type (no tag)</span>
        </label>
        <label>
          Structure id
          <input value={opts.structureId} onChange={(e) => setOpts({ ...opts, structureId: e.target.value })} />
        </label>
        <label className="check">
          <input type="checkbox" checked={opts.inferTypes} onChange={(e) => setOpts({ ...opts, inferTypes: e.target.checked })} /> Detect Integer / Decimal fields (otherwise all String)
        </label>
      </div>
      <div className="row-actions">
        <button type="button" className="primary" disabled={!sample.trim()} onClick={generate}>
          Generate FFD
        </button>
        {!sample.trim() && <span className="muted">Paste or open sample text above first.</span>}
      </div>

      {result && (
        <>
          <div className="ffd-report">
            <p>
              <strong>{fmt(result.report.recordCount)}</strong> records ({result.report.mode}).{' '}
              {result.report.tag ? (
                <>
                  Record type tag: columns {result.report.tag.start + 1}–{result.report.tag.start + result.report.tag.length}, because {result.report.tag.reason}.
                </>
              ) : (
                'One record type (no tag).'
              )}
            </p>
            <div className="table-scroll">
              <table className="data">
                <thead>
                  <tr>
                    <th>Segment</th>
                    <th className="num">Records</th>
                    <th className="num">Length</th>
                    <th className="num">Fields</th>
                  </tr>
                </thead>
                <tbody>
                  {result.report.segments.map((s) => (
                    <tr key={s.id}>
                      <td>
                        <code>{s.id}</code>
                      </td>
                      <td className="num">{fmt(s.records)}</td>
                      <td className="num">{fmt(s.length)}</td>
                      <td className="num">{fmt(s.fields)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <IssueList issues={result.issues} />
            <p className="muted">
              Field boundaries come from blank columns in the sample, and fields are named Field1, Field2… Rename them and check the lengths below. A varied sample (several records per type) gives better boundaries.
            </p>
          </div>
          <label className="field">
            Generated FFD (editable)
            <textarea className="code-input" rows={18} spellCheck={false} wrap="off" value={yaml} onChange={(e) => setYaml(e.target.value)} />
          </label>
          <div className="row-actions">
            <button type="button" className="primary" onClick={() => onApply(yaml)}>
              Apply this FFD to the sample →
            </button>
            <CopyButton text={yaml} />
            <button type="button" onClick={() => downloadBlob(new Blob([yaml], { type: 'text/yaml' }), `${opts.structureId || 'schema'}.ffd`)}>
              Download .ffd
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function ApplyTab({ sample, sampleName, ffd, setFfd, ffdName, setFfdName }: {
  sample: string;
  sampleName: string;
  ffd: string;
  setFfd: (s: string) => void;
  ffdName: string;
  setFfdName: (s: string) => void;
}) {
  const [mode, setMode] = useState<FfdRecordMode>('auto');
  const [trim, setTrim] = useState(true);
  const [structure, setStructure] = useState<string | null>(null);

  const deferredFfd = useDeferredValue(ffd);
  const deferredSample = useDeferredValue(sample);

  const parsed = useMemo((): { schema: FfdSchema } | { error: FfdError | Error } | null => {
    if (!deferredFfd.trim()) return null;
    try {
      return { schema: parseFfd(deferredFfd) };
    } catch (e) {
      return { error: e as Error };
    }
  }, [deferredFfd]);
  const schema = parsed && 'schema' in parsed ? parsed.schema : null;

  // Default to the first structure; keep the user's choice while it still exists.
  const structureId = schema ? (structure !== null && (structure === '' || schema.structures.some((s) => s.id === structure)) ? structure : (schema.structures[0]?.id ?? '')) : '';

  const result = useMemo(() => {
    if (!schema || !deferredSample.trim()) return null;
    const options: ApplyOptions = { recordMode: mode, trim, structureId };
    return applyFfd(deferredSample, schema, options);
  }, [schema, deferredSample, mode, trim, structureId]);

  const json = useMemo(() => (result ? JSON.stringify(result.output, null, 2) : ''), [result]);
  const stale = deferredFfd !== ffd || deferredSample !== sample;

  return (
    <div className="tab-body ffd-tab">
      <TextSource label="FFD schema" value={ffd} onChange={setFfd} fileName={ffdName} onFileName={setFfdName} accept=".ffd,.yaml,.yml,.txt" rows={14} placeholder={"form: FLATFILE\nstructures:\n- id: 'BatchReq'\n  data:\n  - { idRef: '0630', usage: O, count: '>1' }\nsegments:\n- id: '0630'\n  values:\n  - { name: 'MSGLength', type: String, length: 5, tagValue: ' 0630' }\n  - …"} />
      {parsed && 'error' in parsed && (
        <div className="msg msg-error" role="alert">
          <div className="msg-title">The FFD cannot be used</div>
          <div>{parsed.error.message}</div>
          {parsed.error instanceof FfdError && parsed.error.problems.length > 0 && (
            <ul>
              {parsed.error.problems.slice(0, 30).map((p, i) => (
                <li key={i}>{p}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {schema && (
        <p className="muted">
          {schema.form} schema · {schema.segments.length} segment(s): {schema.segments.map((s) => s.id).join(', ')}
        </p>
      )}

      <div className="form-grid">
        <label>
          Records are
          <select value={mode} onChange={(e) => setMode(e.target.value as FfdRecordMode)}>
            <option value="auto">Auto-detect</option>
            <option value="lines">One per line</option>
            <option value="stream">Back to back (no line breaks)</option>
          </select>
        </label>
        <label>
          Group by structure
          <select value={structureId} disabled={!schema} onChange={(e) => setStructure(e.target.value)}>
            {schema?.structures.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name ? `${s.id} – ${s.name}` : s.id}
              </option>
            ))}
            <option value="">None – list of records</option>
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={trim} onChange={(e) => setTrim(e.target.checked)} /> Trim padding from values
        </label>
      </div>

      {!sample.trim() && <p className="muted">Paste or open sample text above to see the JSON output.</p>}
      {result && (
        <section className={`ffd-output${stale ? ' is-stale' : ''}`}>
          <div className="chips">
            <span className="muted">
              {fmt(result.records.length)} records ({result.mode === 'lines' ? 'one per line' : 'back to back'}):
            </span>
            {Object.entries(result.segmentCounts).map(([id, n]) => (
              <span key={id} className="chip chip-btn">
                {id} × {fmt(n)}
              </span>
            ))}
          </div>
          <IssueList issues={result.issues} />
          <div className="row-actions">
            <CopyButton text={json} label="Copy JSON" />
            <button type="button" onClick={() => downloadBlob(new Blob([json], { type: 'application/json' }), `${baseName(sampleName || 'output')}.json`)}>
              Download .json
            </button>
            <span className="muted">{fmt(json.length)} chars</span>
          </div>
          <pre className="json-output">{json.length > MAX_SHOWN_JSON ? `${json.slice(0, MAX_SHOWN_JSON)}\n\n… truncated on screen; download for the full output` : json}</pre>
        </section>
      )}
    </div>
  );
}

/**
 * FFD tools: generate a MuleSoft-style flat file definition from sample
 * fixed-width text, or apply an FFD to text and see the JSON it produces.
 */
export function FfdPage({ theme }: { theme: ThemeControl }) {
  const [tab, setTab] = useState<Tab>('generate');
  const [sample, setSample] = useState('');
  const [sampleName, setSampleName] = useState('');
  const [ffd, setFfd] = useState('');
  const [ffdName, setFfdName] = useState('');

  return (
    <div className="app">
      <AppHeader page="ffd" theme={theme} />
      <main>
        <section className="panel">
          <div className="panel-head">
            <h2>FFD tools</h2>
            <span className="muted">Flat File Definitions (MuleSoft / DataWeave flat file schema) for fixed-width files</span>
          </div>
          <TextSource
            label="Sample text"
            value={sample}
            onChange={setSample}
            fileName={sampleName}
            onFileName={setSampleName}
            accept=".txt,.dat,.fix,.fw,.mnt,text/plain,*"
            placeholder={' 0630RESPDATA…\n 0461RESPDATA…\n\nOne record per line, or records back to back.'}
          />
        </section>

        <section className="panel">
          <div className="tabs" role="tablist">
            <button type="button" role="tab" aria-selected={tab === 'generate'} className={`tab${tab === 'generate' ? ' is-active' : ''}`} onClick={() => setTab('generate')}>
              Generate FFD from text
            </button>
            <button type="button" role="tab" aria-selected={tab === 'apply'} className={`tab${tab === 'apply' ? ' is-active' : ''}`} onClick={() => setTab('apply')}>
              Apply FFD → JSON
            </button>
          </div>
          <div hidden={tab !== 'generate'}>
            <GenerateTab
              sample={sample}
              onApply={(yaml) => {
                setFfd(yaml);
                setFfdName('generated');
                setTab('apply');
              }}
            />
          </div>
          <div hidden={tab !== 'apply'}>
            <ApplyTab sample={sample} sampleName={sampleName} ffd={ffd} setFfd={setFfd} ffdName={ffdName} setFfdName={setFfdName} />
          </div>
        </section>
      </main>
      <footer className="app-footer muted">File Comparator 1.0 · runs offline · no data is stored or sent anywhere</footer>
    </div>
  );
}
