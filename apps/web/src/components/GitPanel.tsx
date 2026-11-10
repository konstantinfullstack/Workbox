import { CODE_HOSTS, type Task } from '#shared';
import { usePublishTask, useTaskGit } from '../api/hooks.js';
import { ErrorBanner, Loading } from './Status.js';

const REVIEW_BADGE = {
  draft: 'state-planning',
  open: 'state-in_progress',
  merged: 'conn-connected',
  closed: 'state-cancelled',
} as const;

/** Branch, commits and the draft pull/merge request, separate from the task state (spec §9). */
export function GitPanel({ task }: { task: Task }) {
  const git = useTaskGit(task.id);
  const publish = usePublishTask(task.id);
  if (git.isPending) return <Loading what="git status" />;
  const info = git.data;
  if (!info?.branch) {
    return (
      <section className="panel" aria-label="Git">
        <h2>Git</h2>
        <p className="muted">No branch yet: the first run creates one.</p>
      </section>
    );
  }
  const ref = info.reference;
  const label = ref ? CODE_HOSTS[ref.provider].reviewRequestLabel : 'pull request';
  const unpublished = info.localCommitSha !== null && info.localCommitSha !== ref?.pushedSha;
  const canPublish =
    info.localCommitSha !== null && (unpublished || !ref?.reviewNumber || Boolean(ref.lastError));

  return (
    <section className="panel" aria-label="Git">
      <div className="section-header">
        <h2>Git</h2>
        {canPublish && (
          <button
            type="button"
            disabled={publish.isPending || publish.isSuccess}
            onClick={() => publish.mutate()}
          >
            {publish.isPending || publish.isSuccess
              ? 'Publishing…'
              : ref?.lastError
                ? 'Retry publishing'
                : `Publish and open draft ${label}`}
          </button>
        )}
      </div>
      <ErrorBanner error={publish.error ?? git.error} />
      <dl className="details">
        <dt>Branch</dt>
        <dd className="mono">{info.branch}</dd>
        <dt>Latest commit</dt>
        <dd className="mono">
          {info.localCommitSha?.slice(0, 7) ?? '—'}
          {unpublished && <span className="warning-text small"> · not published yet</span>}
        </dd>
        <dt>{label[0]!.toUpperCase() + label.slice(1)}</dt>
        <dd>
          {ref?.reviewUrl ? (
            <>
              <a href={ref.reviewUrl} target="_blank" rel="noreferrer">
                #{ref.reviewNumber} ↗
              </a>{' '}
              {ref.reviewState && (
                <span className={`badge ${REVIEW_BADGE[ref.reviewState]}`}>{ref.reviewState}</span>
              )}
              {ref.lastSyncedAt && (
                <span className="muted small">
                  {' '}
                  · checked {new Date(ref.lastSyncedAt).toLocaleTimeString()}
                </span>
              )}
            </>
          ) : (
            <span className="muted">not opened yet</span>
          )}
        </dd>
      </dl>
      {ref?.lastError && <p className="warning-text">{ref.lastError}</p>}
      {ref?.reviewState === 'merged' && task.state !== 'done' && (
        <p className="small">
          The {label} is merged: mark the task as done when you've finished testing.
        </p>
      )}
    </section>
  );
}
