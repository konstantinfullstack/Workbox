import { useEffect, useState } from 'react';
import { ApiError } from '../api/client.js';

export function ErrorBanner({ error, onReload }: { error: unknown; onReload?: () => void }) {
  if (!error) return null;
  const apiError = error instanceof ApiError ? error : undefined;
  const conflict = apiError?.code === 'VERSION_CONFLICT';
  return (
    <div className="error-banner" role="alert">
      <strong>{conflict ? 'Someone else changed this task.' : 'Something went wrong.'}</strong>{' '}
      {conflict
        ? 'Reload to see the latest version, then reapply your change.'
        : (apiError?.message ?? (error instanceof Error ? error.message : 'Unexpected error'))}
      {apiError && !conflict && <code className="error-code">{apiError.code}</code>}
      {conflict && onReload && (
        <button type="button" className="link-button" onClick={onReload}>
          Reload
        </button>
      )}
    </div>
  );
}

export function Loading({ what }: { what: string }) {
  return <p className="muted">Loading {what}…</p>;
}

export function LastUpdated({ at, fetching }: { at: number; fetching: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  if (!at) return null;
  const seconds = Math.max(0, Math.round((now - at) / 1_000));
  return (
    <span className="muted last-updated" title={new Date(at).toLocaleString()}>
      {fetching ? 'Refreshing…' : `Updated ${seconds < 2 ? 'just now' : `${seconds}s ago`}`}
    </span>
  );
}
