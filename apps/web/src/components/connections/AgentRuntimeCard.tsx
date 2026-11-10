import { useAgentRuntime, useCheckAgentRuntime } from '../../api/hooks.js';
import { ErrorBanner, Loading } from '../Status.js';

export function AgentRuntimeCard() {
  const status = useAgentRuntime();
  const check = useCheckAgentRuntime();
  const s = status.data;
  return (
    <section className="panel" aria-label="Agent runtime">
      <div className="section-header">
        <h2>Agent runtime</h2>
        <button
          type="button"
          className="secondary"
          disabled={check.isPending}
          onClick={() => check.mutate()}
        >
          {check.isPending ? 'Checking…' : 'Check now'}
        </button>
      </div>
      <ErrorBanner error={check.error ?? status.error} />
      {status.isPending ? (
        <Loading what="agent runtime" />
      ) : s ? (
        <>
          <p>
            <strong>Claude Code</strong>{' '}
            <span
              className={`badge ${s.ok ? 'conn-connected' : s.checkedAt ? 'conn-degraded' : ''}`}
            >
              {s.ok ? 'Ready' : s.checkedAt ? 'Not ready' : 'Not checked'}
            </span>
            {s.version && <span className="muted"> · v{s.version}</span>}
            {s.loggedIn !== null && (
              <span className="muted">
                {' '}
                · {s.loggedIn ? `signed in (${s.authMethod ?? 'unknown'})` : 'not signed in'}
              </span>
            )}
          </p>
          <p className={s.ok ? 'muted small' : 'warning-text'}>{s.message}</p>
          {s.checkedAt && (
            <p className="muted small">
              Checked {new Date(s.checkedAt).toLocaleString()} by worker {s.workerId}. The check
              runs on the worker, because that is where agents run. Workbox uses your existing
              Claude Code login and never copies it.
            </p>
          )}
        </>
      ) : null}
    </section>
  );
}
