export { formatBytes, formatMs, fmt } from '../reports/summaryData';

export function formatRate(records: number, ms: number): string {
  if (ms < 200 || records === 0) return '—';
  const perSec = (records / ms) * 1000;
  if (perSec >= 1e6) return `${(perSec / 1e6).toFixed(1)}M rec/s`;
  if (perSec >= 1e3) return `${(perSec / 1e3).toFixed(0)}K rec/s`;
  return `${Math.round(perSec)} rec/s`;
}

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
