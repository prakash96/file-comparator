import { useCallback, useEffect, useState } from 'react';
import { safeStorage } from '../utils/safeStorage';

export type Theme = 'light' | 'dark';

const KEY = 'dfc.theme';

function initialTheme(): Theme {
  const saved = safeStorage.get(KEY);
  if (saved === 'light' || saved === 'dark') return saved;
  return typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  const toggle = useCallback(() => {
    setTheme((t) => {
      const next = t === 'dark' ? 'light' : 'dark';
      safeStorage.set(KEY, next);
      return next;
    });
  }, []);
  return { theme, toggle };
}
