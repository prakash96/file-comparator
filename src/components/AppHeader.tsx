import type { ReactNode } from 'react';
import type { Theme } from '../hooks/useTheme';

export type Page = 'compare' | 'ffd';

export const PAGE_HASH: Record<Page, string> = { compare: '#/', ffd: '#/ffd' };

export const pageFromHash = (hash: string): Page => (hash.startsWith('#/ffd') ? 'ffd' : 'compare');

export interface ThemeControl {
  theme: Theme;
  toggle: () => void;
}

/** Brand, page navigation and theme toggle, shared by every page. `actions` go before the theme toggle. */
export function AppHeader({ page, theme: { theme, toggle }, actions }: { page: Page; theme: ThemeControl; actions?: ReactNode }) {
  return (
    <header className="app-header">
      <div className="brand">
        <svg width="28" height="28" viewBox="0 0 32 32" aria-hidden>
          <rect width="32" height="32" rx="6" fill="var(--accent)" />
          <path d="M8 9h7v14H8zM17 9h7v14h-7z" fill="#fff" opacity=".92" />
        </svg>
        <div>
          <h1>File Comparator</h1>
          <div className="privacy" role="note">
            <span aria-hidden>🔒</span> Files are processed locally in your browser and are not uploaded.
          </div>
        </div>
      </div>
      <nav className="page-nav" aria-label="Tools">
        <a href={PAGE_HASH.compare} className={page === 'compare' ? 'is-active' : ''} aria-current={page === 'compare' ? 'page' : undefined}>
          Compare files
        </a>
        <a href={PAGE_HASH.ffd} className={page === 'ffd' ? 'is-active' : ''} aria-current={page === 'ffd' ? 'page' : undefined}>
          FFD tools
        </a>
      </nav>
      <div className="header-actions">
        {actions}
        <button type="button" className="ghost" onClick={toggle} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}>
          {theme === 'dark' ? '☀ Light' : '☾ Dark'}
        </button>
      </div>
    </header>
  );
}
