import { useState } from 'react';
import type { FriendlyError, Issue } from '../models/issues';

/** User-facing error: plain message, technical details only on request. */
export function ErrorMessage({ error, title }: { error: FriendlyError; title?: string }) {
  return (
    <div className="msg msg-error" role="alert">
      <div className="msg-title">{title ?? 'Problem'}</div>
      <div>{error.message}</div>
      {error.details && (
        <details className="tech">
          <summary>Technical details</summary>
          <pre>
            {error.code}
            {'\n'}
            {error.details}
          </pre>
        </details>
      )}
    </div>
  );
}

const ICON: Record<Issue['severity'], string> = { error: '✖', warning: '▲', info: 'ℹ' };

export function IssueList({ issues, initial = 6 }: { issues: Issue[]; initial?: number }) {
  const [all, setAll] = useState(false);
  if (!issues.length) return null;
  const shown = all ? issues : issues.slice(0, initial);
  return (
    <ul className="issues">
      {shown.map((i, n) => (
        <li key={n} className={`issue issue-${i.severity}`}>
          <span className="issue-icon" aria-label={i.severity}>
            {ICON[i.severity]}
          </span>
          <span>
            {i.message}
            {i.details && (
              <details className="tech">
                <summary>Technical details</summary>
                <pre>{i.details}</pre>
              </details>
            )}
          </span>
        </li>
      ))}
      {issues.length > initial && (
        <li>
          <button type="button" className="link" onClick={() => setAll((a) => !a)}>
            {all ? 'Show fewer' : `Show all ${issues.length} messages`}
          </button>
        </li>
      )}
    </ul>
  );
}
