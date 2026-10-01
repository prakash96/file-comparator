import { useCallback, useRef, useState } from 'react';

interface History<T> {
  past: T[];
  present: T;
  future: T[];
}

const LIMIT = 200;

/**
 * Undo / redo state. `set` records a step; `preview` changes the present
 * without recording (e.g. while dragging) and `commit` then records the step
 * from the value before the preview began.
 */
export function useHistory<T>(initial: T) {
  const [h, setH] = useState<History<T>>({ past: [], present: initial, future: [] });
  const hRef = useRef(h);
  hRef.current = h;
  /** Value before the current preview began (null when not previewing). */
  const base = useRef<{ value: T } | null>(null);

  const set = useCallback((next: T | ((cur: T) => T)) => {
    setH((cur) => {
      const value = typeof next === 'function' ? (next as (c: T) => T)(cur.present) : next;
      if (Object.is(value, cur.present)) return cur;
      return { past: [...cur.past, cur.present].slice(-LIMIT), present: value, future: [] };
    });
  }, []);

  const preview = useCallback((next: T) => {
    if (base.current === null) base.current = { value: hRef.current.present };
    setH((cur) => ({ ...cur, present: next }));
  }, []);

  const commit = useCallback(() => {
    const b = base.current;
    base.current = null;
    if (b === null) return;
    setH((cur) => (Object.is(b.value, cur.present) ? cur : { past: [...cur.past, b.value].slice(-LIMIT), present: cur.present, future: [] }));
  }, []);

  /** Replace everything (new document): history is cleared. */
  const reset = useCallback((value: T) => {
    base.current = null;
    setH({ past: [], present: value, future: [] });
  }, []);

  const undo = useCallback(() => setH((cur) => (cur.past.length ? { past: cur.past.slice(0, -1), present: cur.past[cur.past.length - 1], future: [cur.present, ...cur.future] } : cur)), []);
  const redo = useCallback(() => setH((cur) => (cur.future.length ? { past: [...cur.past, cur.present], present: cur.future[0], future: cur.future.slice(1) } : cur)), []);

  return { value: h.present, set, preview, commit, reset, undo, redo, canUndo: h.past.length > 0, canRedo: h.future.length > 0 };
}
