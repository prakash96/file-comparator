import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ComparatorPage } from './pages/ComparatorPage';
import './styles/app.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ComparatorPage />
  </StrictMode>,
);
