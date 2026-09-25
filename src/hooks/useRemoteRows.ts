import { useCallback, useEffect, useRef, useState } from 'react';
import type { ViewPage, ViewQuery, ViewRow } from '../models/views';

const PAGE = 200;

/**
 * Fetches rows of a result view from the worker page by page, on demand, as
 * the virtual list scrolls. Only visible pages are requested; at most ~50
 * pages are kept, so memory in the UI thread stays small for any result size.
 */
export function useRemoteRows(fetchPage: (q: ViewQuery) => Promise<ViewPage>, base: Omit<ViewQuery, 'offset' | 'limit'>, version: number) {
  const [meta, setMeta] = useState<{ total: number; unfilteredTotal: number; columns: string[]; keyColumns: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const pages = useRef(new Map<number, ViewRow[]>());
  const inflight = useRef(new Set<number>());
  const gen = useRef(0);
  const baseKey = JSON.stringify(base);

  const loadPage = useCallback(
    (p: number, g: number) => {
      if (pages.current.has(p) || inflight.current.has(p)) return;
      inflight.current.add(p);
      const q = JSON.parse(baseKey) as Omit<ViewQuery, 'offset' | 'limit'>;
      fetchPage({ ...q, offset: p * PAGE, limit: PAGE })
        .then((res) => {
          if (g !== gen.current) return;
          inflight.current.delete(p);
          if (pages.current.size > 50) pages.current.delete(pages.current.keys().next().value!);
          pages.current.set(p, res.rows);
          setMeta({ total: res.total, unfilteredTotal: res.unfilteredTotal, columns: res.columns, keyColumns: res.keyColumns });
          setTick((t) => t + 1);
        })
        .catch((e) => {
          if (g !== gen.current) return;
          inflight.current.delete(p);
          setError(e instanceof Error ? e.message : String(e));
        });
    },
    [baseKey, fetchPage],
  );

  useEffect(() => {
    gen.current++;
    pages.current = new Map();
    inflight.current = new Set();
    setError(null);
    setMeta(null);
    loadPage(0, gen.current);
  }, [baseKey, version, loadPage]);

  const getRow = useCallback(
    (i: number): ViewRow | undefined => {
      const p = Math.floor(i / PAGE);
      const page = pages.current.get(p);
      if (!page) {
        loadPage(p, gen.current);
        return undefined;
      }
      return page[i - p * PAGE];
    },
    [loadPage],
  );

  return { meta, getRow, error, loading: meta === null && !error };
}
