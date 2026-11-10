import { CODE_HOSTS, type Connection, type RemoteRepository } from '#shared';
import { useEffect, useState } from 'react';
import { useConnections, useRemoteRepositories } from '../../api/hooks.js';
import { ErrorBanner, Loading } from '../Status.js';
import { AddAccountForm } from './AddAccountForm.js';
import { accountLabel, ConnectionStatusBadge } from './ConnectionStatus.js';

export interface RepositorySelection {
  connection: Connection;
  repository: RemoteRepository;
}

interface Props {
  value: RepositorySelection | null;
  onChange: (selection: RepositorySelection | null) => void;
  /** Pre-fill the search box (e.g. from a legacy typed repo URL). */
  initialSearch?: string;
}

/** Account dropdown (+ inline "add account") and a searchable list of that account's repositories. */
export function RepositoryPicker({ value, onChange, initialSearch = '' }: Props) {
  const connections = useConnections();
  const usable = (connections.data ?? []).filter((c) => c.hasSecret);
  const [chosenId, setConnectionId] = useState(value?.connection.id ?? '');
  // Default to the only account when there is exactly one.
  const connectionId = chosenId || (usable.length === 1 ? usable[0]!.id : '');
  const [adding, setAdding] = useState(false);
  const [search, setSearch] = useState(initialSearch);
  const debounced = useDebounced(search, 300);
  const connection = usable.find((c) => c.id === connectionId);
  const repos = useRemoteRepositories(connection ? connectionId : '', debounced);

  if (connections.isPending) return <Loading what="accounts" />;

  if (adding || usable.length === 0) {
    return (
      <div className="panel nested">
        <h3>{usable.length === 0 ? 'Add an account to pick a repository' : 'Add account'}</h3>
        <AddAccountForm
          onCreated={(created) => {
            setAdding(false);
            setConnectionId(created.id);
            onChange(null);
          }}
          {...(usable.length > 0 ? { onCancel: () => setAdding(false) } : {})}
        />
      </div>
    );
  }

  return (
    <div className="repo-picker">
      <div className="row">
        <label>
          Account
          <select
            value={connectionId}
            onChange={(e) => {
              setConnectionId(e.target.value);
              onChange(null);
            }}
          >
            <option value="">Choose an account…</option>
            {usable.map((c) => (
              <option key={c.id} value={c.id}>
                {CODE_HOSTS[c.provider as keyof typeof CODE_HOSTS].label} · {accountLabel(c)}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="secondary" onClick={() => setAdding(true)}>
          + Add account
        </button>
      </div>
      {connection && connection.status !== 'connected' && (
        <p className="warning-text">
          <ConnectionStatusBadge status={connection.status} /> {connection.lastCheck?.message}
        </p>
      )}
      {connection && (
        <>
          <label>
            Repository
            <input
              type="search"
              placeholder="Search repositories…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              // Searching must not submit an enclosing project form.
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.preventDefault();
              }}
            />
          </label>
          <ErrorBanner error={repos.error} />
          {repos.isFetching && !repos.data ? (
            <Loading what="repositories" />
          ) : repos.data && repos.data.length === 0 ? (
            <p className="muted">
              No repositories found for this account{debounced ? ` matching “${debounced}”` : ''}.
            </p>
          ) : (
            <ul className="repo-list" role="listbox" aria-label="Repositories">
              {repos.data?.map((repo) => {
                const selected =
                  value?.repository.externalId === repo.externalId &&
                  value.connection.id === connection.id;
                return (
                  <li key={repo.externalId}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={selected}
                      className={`repo-option ${selected ? 'selected' : ''}`}
                      disabled={!repo.access.pull}
                      onClick={() => onChange({ connection, repository: repo })}
                    >
                      <span className="mono">{repo.fullPath}</span>
                      <span className="muted small">
                        {repo.visibility} · {repo.defaultBranch}
                      </span>
                      <AccessChecklist
                        access={repo.access}
                        provider={connection.provider}
                        compact
                      />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

export function AccessChecklist({
  access,
  provider,
  compact = false,
}: {
  access: { pull: boolean; push: boolean; reviewRequests?: 'unverified' | 'verified' | 'denied' };
  provider: Connection['provider'];
  compact?: boolean;
}) {
  const review = provider === 'gitlab' ? 'merge requests' : 'pull requests';
  return (
    <span className={`access ${compact ? 'compact' : ''}`}>
      <span className={access.pull ? 'ok' : 'bad'}>{access.pull ? '✓' : '✗'} pull</span>
      <span className={access.push ? 'ok' : 'bad'}>{access.push ? '✓' : '✗'} push</span>
      {!compact && (
        <span className={access.reviewRequests === 'denied' ? 'bad' : 'pending'}>
          {access.reviewRequests === 'verified'
            ? '✓'
            : access.reviewRequests === 'denied'
              ? '✗'
              : '⏳'}{' '}
          {review}
          {access.reviewRequests === 'unverified' ? ' (confirmed on first use)' : ''}
        </span>
      )}
    </span>
  );
}

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}
