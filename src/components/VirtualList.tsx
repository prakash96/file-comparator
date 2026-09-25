import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';

interface Props {
  count: number;
  rowHeight: number;
  /** Extra height for expanded rows (index -> px). Rows not in the map use `rowHeight`. */
  extraHeights?: Map<number, number>;
  height: number | string;
  overscan?: number;
  renderRow: (index: number, style: React.CSSProperties) => ReactNode;
  header?: ReactNode;
  /** Minimum inner width (px) for wide tables; enables horizontal scrolling. */
  minWidth?: number;
  className?: string;
  ariaLabel?: string;
}

/**
 * Windowed list: only the rows in view (plus overscan) are in the DOM, so a
 * million-row result renders as ~40 elements. Supports a sticky header and
 * variable-height (expanded) rows via `extraHeights`.
 */
export function VirtualList({ count, rowHeight, extraHeights, height, overscan = 8, renderRow, header, minWidth, className, ariaLabel }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(600);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewport(el.clientHeight));
    ro.observe(el);
    setViewport(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  // Expanded rows sorted by index with prefix sums of extra height.
  const expanded = useMemo(() => {
    const entries = extraHeights ? [...extraHeights.entries()].filter(([i]) => i < count).sort((a, b) => a[0] - b[0]) : [];
    const prefix: number[] = [];
    let sum = 0;
    for (const [, h] of entries) {
      prefix.push(sum);
      sum += h;
    }
    return { idx: entries.map((e) => e[0]), h: entries.map((e) => e[1]), prefix, total: sum };
  }, [extraHeights, count]);

  /** Extra px before row i. */
  const extraBefore = useCallback(
    (i: number) => {
      let lo = 0;
      let hi = expanded.idx.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (expanded.idx[mid] < i) lo = mid + 1;
        else hi = mid;
      }
      return lo === 0 ? 0 : expanded.prefix[lo - 1] + expanded.h[lo - 1];
    },
    [expanded],
  );
  const top = useCallback((i: number) => i * rowHeight + extraBefore(i), [rowHeight, extraBefore]);

  const totalHeight = count * rowHeight + expanded.total;
  const contentHeight = totalHeight + (header ? rowHeight : 0) + 2;

  // First visible row: binary search on top().
  let lo = 0;
  let hi = count;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (top(mid + 1) <= scrollTop) lo = mid + 1;
    else hi = mid;
  }
  const first = Math.max(0, lo - overscan);
  const items: ReactNode[] = [];
  for (let i = first; i < count; i++) {
    const y = top(i);
    if (y > scrollTop + viewport + overscan * rowHeight) break;
    const h = rowHeight + (extraHeights?.get(i) ?? 0);
    items.push(renderRow(i, { position: 'absolute', top: y, left: 0, right: 0, height: h }));
  }

  return (
    <div
      ref={ref}
      className={`vlist ${className ?? ''}`}
      style={{
        // Shrink to the content for short results; `height` is the cap.
        height: typeof height === 'number' ? Math.min(height, contentHeight) : `min(${height}, ${contentHeight}px)`,
      }}
      onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop - (header ? rowHeight : 0))}
      role="table"
      aria-label={ariaLabel}
      aria-rowcount={count}
    >
      <div style={{ minWidth }}>
        {header && (
          <div className="vlist-header" style={{ height: rowHeight }}>
            {header}
          </div>
        )}
        <div style={{ position: 'relative', height: totalHeight }}>{items}</div>
      </div>
    </div>
  );
}
