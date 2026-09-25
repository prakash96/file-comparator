import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { defaultComparisonOptions, type ComparisonOptions, type ComparisonSummary, type SchemaComparison } from '../models/comparison';
import type { FriendlyError } from '../models/issues';
import { defaultParseOptions, type ParseOptions } from '../models/parseOptions';
import type { DatasetSummary, ExportedFile, ProgressInfo, ReportKind, Slot } from '../models/session';
import type { ViewPage, ViewQuery } from '../models/views';
import { ComparatorClient, WorkerRequestError } from '../workers/client';

export interface SlotState {
  file: File | null;
  options: ParseOptions;
  status: 'empty' | 'loading' | 'ready' | 'error';
  progress: ProgressInfo | null;
  summary: DatasetSummary | null;
  error: FriendlyError | null;
}

export interface CompareState {
  status: 'idle' | 'running' | 'done' | 'error';
  progress: ProgressInfo | null;
  summary: ComparisonSummary | null;
  error: FriendlyError | null;
  /** Incremented on every completed comparison so result views refetch. */
  version: number;
}

const emptySlot = (): SlotState => ({ file: null, options: defaultParseOptions(), status: 'empty', progress: null, summary: null, error: null });

export function toFriendly(e: unknown): FriendlyError {
  if (e instanceof WorkerRequestError) return e.friendly;
  return { code: 'UNEXPECTED', message: 'Something went wrong in the page.', details: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
}

/**
 * Application state + the only bridge to the comparator worker. Components
 * receive plain state and callbacks; none of them touch the worker directly.
 */
export function useComparator() {
  const client = useMemo(() => new ComparatorClient(), []);
  const [slots, setSlots] = useState<Record<Slot, SlotState>>({ source: emptySlot(), target: emptySlot() });
  const [options, setOptions] = useState<ComparisonOptions>(defaultComparisonOptions);
  const [schema, setSchema] = useState<SchemaComparison | null>(null);
  const [compare, setCompare] = useState<CompareState>({ status: 'idle', progress: null, summary: null, error: null, version: 0 });
  const slotsRef = useRef(slots);
  slotsRef.current = slots;
  const loadSeq = useRef<Record<Slot, number>>({ source: 0, target: 0 });

  useEffect(() => () => client.terminate(), [client]);

  const patchSlot = useCallback((slot: Slot, patch: Partial<SlotState>) => {
    setSlots((s) => ({ ...s, [slot]: { ...s[slot], ...patch } }));
  }, []);

  const resetCompare = useCallback(() => setCompare((c) => ({ status: 'idle', progress: null, summary: null, error: null, version: c.version + 1 })), []);

  const load = useCallback(
    async (slot: Slot, file: File, parseOptions: ParseOptions) => {
      const seq = ++loadSeq.current[slot];
      patchSlot(slot, { file, options: parseOptions, status: 'loading', progress: null, error: null, summary: null });
      setSchema(null);
      resetCompare();
      try {
        const summary = await client.request({ type: 'load', slot, file, options: parseOptions }, (p) => {
          if (loadSeq.current[slot] === seq) patchSlot(slot, { progress: p });
        });
        if (loadSeq.current[slot] !== seq) return;
        patchSlot(slot, { status: 'ready', summary, options: summary.options, progress: null });
      } catch (e) {
        if (loadSeq.current[slot] !== seq) return;
        const err = toFriendly(e);
        if (err.code === 'CANCELLED') return;
        patchSlot(slot, { status: 'error', error: err, progress: null });
      }
    },
    [client, patchSlot, resetCompare],
  );

  const setFile = useCallback((slot: Slot, file: File) => load(slot, file, defaultParseOptions()), [load]);

  /** Re-parse the current file with new options. */
  const applyOptions = useCallback(
    (slot: Slot, next: ParseOptions) => {
      const file = slotsRef.current[slot].file;
      if (file) void load(slot, file, next);
      else patchSlot(slot, { options: next });
    },
    [load, patchSlot],
  );

  const removeFile = useCallback(
    (slot: Slot) => {
      loadSeq.current[slot]++;
      if (client.alive) void client.request({ type: 'clear', slot }).catch(() => {});
      setSlots((s) => ({ ...s, [slot]: emptySlot() }));
      setSchema(null);
      resetCompare();
    },
    [client, resetCompare],
  );

  // Schema comparison whenever both files are ready or matching rules change.
  const bothReady = slots.source.status === 'ready' && slots.target.status === 'ready';
  useEffect(() => {
    if (!bothReady) return;
    let live = true;
    client
      .request({ type: 'schema', options: { ignoreColumnOrder: options.ignoreColumnOrder, columnNamesCaseInsensitive: options.columnNamesCaseInsensitive } })
      .then((s) => live && setSchema(s))
      .catch(() => live && setSchema(null));
    return () => {
      live = false;
    };
  }, [bothReady, client, options.ignoreColumnOrder, options.columnNamesCaseInsensitive, slots.source.summary, slots.target.summary]);

  const runCompare = useCallback(async () => {
    setCompare((c) => ({ ...c, status: 'running', progress: null, error: null, summary: null }));
    try {
      const summary = await client.request({ type: 'compare', options }, (p) => setCompare((c) => (c.status === 'running' ? { ...c, progress: p } : c)));
      setCompare((c) => ({ status: 'done', progress: null, summary, error: null, version: c.version + 1 }));
    } catch (e) {
      const err = toFriendly(e);
      setCompare((c) => (err.code === 'CANCELLED' ? { ...c, status: 'idle', progress: null } : { ...c, status: 'error', error: err, progress: null }));
    }
  }, [client, options]);

  /** Hard cancel: kill the worker, then transparently re-load both files. */
  const cancel = useCallback(() => {
    client.terminate();
    const cur = slotsRef.current;
    for (const slot of ['source', 'target'] as Slot[]) {
      const st = cur[slot];
      if (st.file) void load(slot, st.file, st.options);
    }
  }, [client, load]);

  /** Clear everything, including all data held by the worker. */
  const reset = useCallback(() => {
    client.terminate();
    loadSeq.current.source++;
    loadSeq.current.target++;
    setSlots({ source: emptySlot(), target: emptySlot() });
    setSchema(null);
    setOptions(defaultComparisonOptions());
    resetCompare();
  }, [client, resetCompare]);

  const query = useCallback((q: ViewQuery): Promise<ViewPage> => client.request({ type: 'query', query: q }), [client]);

  const exportReport = useCallback(
    (kind: ReportKind, onProgress?: (p: ProgressInfo) => void): Promise<ExportedFile> => client.request({ type: 'export', kind }, onProgress),
    [client],
  );

  return { slots, options, setOptions, schema, compare, setFile, applyOptions, removeFile, runCompare, cancel, reset, query, exportReport };
}

export type Comparator = ReturnType<typeof useComparator>;
