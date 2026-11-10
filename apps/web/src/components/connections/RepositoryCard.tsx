import { CODE_HOSTS, type ProjectSummary } from '#shared';
import { useState } from 'react';
import { Link } from 'react-router';
import { useProjectRepository, useRepositoryActions } from '../../api/hooks.js';
import { ErrorBanner, Loading } from '../Status.js';
import { AccessStatusBadge, ConnectionStatusBadge } from './ConnectionStatus.js';
import { AccessChecklist, RepositoryPicker, type RepositorySelection } from './RepositoryPicker.js';
import { WorkspaceStatus } from './WorkspaceStatus.js';

/** The project's repository: status, access, actions, or a prompt to connect one. */
export function RepositoryCard({ project }: { project: ProjectSummary }) {
  const repository = useProjectRepository(project.slug);
  const actions = useRepositoryActions(project.slug);
  const [choosing, setChoosing] = useState(false);
  const [selection, setSelection] = useState<RepositorySelection | null>(null);
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  const repo = repository.data;
  const error =
    actions.link.error ??
    actions.verify.error ??
    actions.sync.error ??
    actions.unlink.error ??
    repository.error;

  const link = () => {
    if (!selection) return;
    actions.link.mutate(
      { connectionId: selection.connection.id, externalId: selection.repository.externalId },
      {
        onSuccess: () => {
          setChoosing(false);
          setSelection(null);
        },
      },
    );
  };

  if (repository.isPending) return <Loading what="repository" />;

  return (
    <section className="panel" aria-label="Repository">
      <div className="section-header">
        <h2>Repository</h2>
        {repo && !choosing && (
          <>
            <button
              type="button"
              className="secondary"
              disabled={actions.verify.isPending}
              onClick={() => actions.verify.mutate()}
            >
              {actions.verify.isPending ? 'Verifying…' : 'Verify again'}
            </button>
            <button type="button" className="secondary" onClick={() => setChoosing(true)}>
              Change
            </button>
            <button type="button" className="secondary" onClick={() => setConfirmUnlink(true)}>
              Unlink
            </button>
          </>
        )}
      </div>
      <ErrorBanner error={error} />

      {confirmUnlink && (
        <div className="confirm">
          Unlink this repository from the project? The account and its token are kept.
          <button
            type="button"
            onClick={() =>
              actions.unlink.mutate(undefined, { onSuccess: () => setConfirmUnlink(false) })
            }
          >
            Unlink
          </button>
          <button type="button" className="secondary" onClick={() => setConfirmUnlink(false)}>
            Keep
          </button>
        </div>
      )}

      {repo && !choosing ? (
        <>
          <dl className="details">
            <dt>{CODE_HOSTS[repo.provider].label}</dt>
            <dd>
              <a href={repo.webUrl} target="_blank" rel="noreferrer" className="mono">
                {repo.fullPath} ↗
              </a>{' '}
              <AccessStatusBadge status={repo.accessStatus} />
            </dd>
            <dt>Account</dt>
            <dd>
              <Link to="/connections">{repo.connectionName}</Link>{' '}
              <ConnectionStatusBadge status={repo.connectionStatus} />
            </dd>
            <dt>Access</dt>
            <dd>
              <AccessChecklist access={repo.access} provider={repo.provider} />
            </dd>
            <dt>Default branch</dt>
            <dd className="mono">{repo.defaultBranch}</dd>
            <dt>Local clone</dt>
            <dd>
              <WorkspaceStatus
                workspace={repo.workspace}
                defaultBranch={repo.defaultBranch}
                syncing={actions.sync.isPending}
                onSync={() => actions.sync.mutate()}
              />
            </dd>
            <dt>Last verified</dt>
            <dd>{repo.verifiedAt ? new Date(repo.verifiedAt).toLocaleString() : 'never'}</dd>
          </dl>
          {repo.lastError && (
            <p className="warning-text">
              {repo.lastError}{' '}
              {(repo.accessStatus === 'expired' || repo.connectionStatus === 'disconnected') && (
                <Link to="/connections">Replace token →</Link>
              )}
            </p>
          )}
        </>
      ) : choosing || !repo ? (
        <>
          {!repo && !choosing && (
            <p className="muted">
              {project.repoUrl ? (
                <>
                  A repository URL was typed in earlier but is not verified:{' '}
                  <span className="mono">{project.repoUrl}</span>. Connect it through an account so
                  Workbox can check access.
                </>
              ) : (
                'No repository yet. Connect one so agents can work on this project.'
              )}
            </p>
          )}
          {choosing || !repo ? (
            <>
              <RepositoryPicker
                value={selection}
                onChange={setSelection}
                initialSearch={suggestSearch(project.repoUrl)}
              />
              <div className="form-actions">
                <button
                  type="button"
                  disabled={!selection || actions.link.isPending}
                  onClick={link}
                >
                  {actions.link.isPending
                    ? 'Linking…'
                    : selection
                      ? `Link ${selection.repository.fullPath}`
                      : 'Link repository'}
                </button>
                {repo && (
                  <button type="button" className="secondary" onClick={() => setChoosing(false)}>
                    Cancel
                  </button>
                )}
              </div>
            </>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

/** From a legacy typed URL like git@github.com:org/repo.git, suggest searching for "repo". */
export function suggestSearch(repoUrl: string | null): string {
  if (!repoUrl) return '';
  const match = /([^/:]+?)(\.git)?$/.exec(repoUrl.trim());
  return match?.[1] ?? '';
}
