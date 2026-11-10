import { CODE_HOST_PROVIDERS, CODE_HOSTS, type Connection } from '#shared';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { useConnectionActions, useConnections } from '../api/hooks.js';
import { AddAccountForm } from '../components/connections/AddAccountForm.js';
import { AgentRuntimeCard } from '../components/connections/AgentRuntimeCard.js';
import { ConnectionStatusBadge, TokenExpiry } from '../components/connections/ConnectionStatus.js';
import { ErrorBanner, LastUpdated, Loading } from '../components/Status.js';

export function ConnectionsPage() {
  const connections = useConnections();
  const [adding, setAdding] = useState(false);

  return (
    <>
      <div className="page-header">
        <h1>Connections</h1>
        <LastUpdated at={connections.dataUpdatedAt} fetching={connections.isFetching} />
        {!adding && (
          <button type="button" onClick={() => setAdding(true)}>
            Add account
          </button>
        )}
      </div>
      <p className="muted">
        An account is one token for one{' '}
        {CODE_HOST_PROVIDERS.map((p) => CODE_HOSTS[p].label).join(' or ')} identity. One account can
        serve many projects; replacing its token here fixes every project using it.
      </p>

      {adding && (
        <section className="panel">
          <h2>Add account</h2>
          <AddAccountForm onCreated={() => setAdding(false)} onCancel={() => setAdding(false)} />
        </section>
      )}

      <ErrorBanner error={connections.error} />
      {connections.isPending ? (
        <Loading what="accounts" />
      ) : (
        CODE_HOST_PROVIDERS.map((provider) => {
          const items = (connections.data ?? []).filter((c) => c.provider === provider);
          return (
            <section
              key={provider}
              className="provider-group"
              aria-label={`${CODE_HOSTS[provider].label} accounts`}
            >
              <h2>{CODE_HOSTS[provider].label}</h2>
              {items.length === 0 ? (
                <p className="muted">No {CODE_HOSTS[provider].label} accounts yet.</p>
              ) : (
                items.map((connection) => (
                  <AccountRow key={connection.id} connection={connection} />
                ))
              )}
            </section>
          );
        })
      )}

      <AgentRuntimeCard />
    </>
  );
}

function AccountRow({ connection }: { connection: Connection }) {
  const actions = useConnectionActions(connection.id);
  const [rotating, setRotating] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [secret, setSecret] = useState('');
  const warnings = (connection.lastCheck?.details?.warnings as string[] | undefined) ?? [];
  const error = actions.test.error ?? actions.rotate.error ?? actions.disconnect.error;

  const rotate = (event: FormEvent) => {
    event.preventDefault();
    actions.rotate.mutate(secret.trim(), {
      onSuccess: () => setRotating(false),
      onSettled: () => setSecret(''),
    });
  };

  return (
    <article className="panel account" aria-label={connection.name}>
      <div className="section-header">
        <h3>
          {connection.name} <ConnectionStatusBadge status={connection.status} />
        </h3>
        <button
          type="button"
          className="secondary"
          disabled={actions.test.isPending || !connection.hasSecret}
          onClick={() => actions.test.mutate()}
        >
          {actions.test.isPending ? 'Testing…' : 'Test'}
        </button>
        <button type="button" className="secondary" onClick={() => setRotating(true)}>
          Replace token
        </button>
        {connection.hasSecret && (
          <button type="button" className="secondary" onClick={() => setConfirmDisconnect(true)}>
            Disconnect
          </button>
        )}
      </div>
      <ErrorBanner error={error} />
      <dl className="details">
        <dt>Account</dt>
        <dd>{connection.account ?? '—'}</dd>
        <dt>Instance</dt>
        <dd className="mono">{connection.baseUrl}</dd>
        <dt>Token</dt>
        <dd>
          {connection.hasSecret ? (
            <>
              <span className="mono">{connection.fingerprint}</span> ·{' '}
              {connection.authType?.replaceAll('_', ' ')} ·{' '}
              <TokenExpiry expiresAt={connection.tokenExpiresAt} />
            </>
          ) : (
            <span className="muted">none (disconnected)</span>
          )}
        </dd>
        <dt>Last check</dt>
        <dd>
          {connection.lastCheck?.message ?? '—'}
          {connection.lastCheckedAt && (
            <span className="muted small">
              {' '}
              · {new Date(connection.lastCheckedAt).toLocaleString()}
            </span>
          )}
        </dd>
        <dt>Used by</dt>
        <dd>
          {connection.projects.length === 0 ? (
            <span className="muted">no projects</span>
          ) : (
            connection.projects.map((p, i) => (
              <span key={p.id}>
                {i > 0 && ', '}
                <Link to={`/projects/${p.slug}`}>{p.name}</Link>
              </span>
            ))
          )}
        </dd>
      </dl>
      {warnings.length > 0 && (
        <ul className="warnings">
          {warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}

      {confirmDisconnect && (
        <div className="confirm">
          Delete this token from Workbox?{' '}
          {connection.projects.length > 0 &&
            `${connection.projects.length} project(s) will lose verified access until you add a new token.`}
          <button
            type="button"
            onClick={() =>
              actions.disconnect.mutate(undefined, { onSettled: () => setConfirmDisconnect(false) })
            }
          >
            Disconnect
          </button>
          <button type="button" className="secondary" onClick={() => setConfirmDisconnect(false)}>
            Keep
          </button>
        </div>
      )}

      {rotating && (
        <form className="form" onSubmit={rotate} aria-label="Replace token">
          <label>
            New token
            <input
              required
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder={
                connection.provider === 'claude_code'
                  ? ''
                  : CODE_HOSTS[connection.provider].tokenPlaceholder
              }
            />
          </label>
          <div className="form-actions">
            <button type="submit" disabled={actions.rotate.isPending || !secret.trim()}>
              {actions.rotate.isPending ? 'Verifying…' : 'Verify and replace'}
            </button>
            <button type="button" className="secondary" onClick={() => setRotating(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </article>
  );
}
