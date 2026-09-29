import { useEffect, useState } from 'react';
import { pageFromHash, type Page } from './components/AppHeader';
import { ComparatorPage } from './pages/ComparatorPage';
import { FfdPage } from './pages/FfdPage';
import { useTheme } from './hooks/useTheme';

/** Hash routing keeps the static build working from any path (GitHub Pages, file share). */
export function App() {
  const theme = useTheme();
  const [page, setPage] = useState<Page>(() => pageFromHash(location.hash));
  useEffect(() => {
    const onHash = () => setPage(pageFromHash(location.hash));
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, []);
  // Both pages stay mounted so loaded files and pasted text survive switching between them.
  return (
    <>
      <div hidden={page !== 'compare'}>
        <ComparatorPage theme={theme} />
      </div>
      <div hidden={page !== 'ffd'}>
        <FfdPage theme={theme} />
      </div>
    </>
  );
}
