import type { RunArtifact, RunEvent, Task, TaskRun } from '#shared';
import { useEffect, useRef, useState } from 'react';
import {
  useRunActions,
  useRunArtifacts,
  useRunDiff,
  useRunEvents,
  useRunReadiness,
  useRuns,
  useTaskGit,
} from '../../api/hooks.js';
import { gitLinks, type GitLinks } from '../../git-links.js';
import { ErrorBanner, Loading } from '../Status.js';

const ACTIVE = new Set<TaskRun['state']>(['queued', 'preparing', 'running', 'verifying']);
const STATE_LABEL: Record<TaskRun['state'], string> = {
  queued: 'Queued',
  preparing: 'Preparing',
  running: 'Agent working',
  verifying: 'Verifying',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  timed_out: 'Timed out',
};
const STATE_BADGE: Record<TaskRun['state'], string> = {
  queued: 'conn-degraded',
  preparing: 'conn-degraded',
  running: 'state-in_progress',
  verifying: 'state-verification',
  completed: 'conn-connected',
  failed: 'conn-expired',
  cancelled: 'state-cancelled',
  timed_out: 'conn-expired',
};

/** Start a run, follow it live, cancel it, and review what it changed. */
export function RunPanel({ task }: { task: Task }) {
  const runs = useRuns(task.id);
  const readiness = useRunReadiness(task.id);
  const actions = useRunActions(task.id);
  const links = gitLinks(useTaskGit(task.id).data);
  const [note, setNote] = useState('');
  const latest = runs.data?.[0];
  const active = latest && ACTIVE.has(latest.state);
  const isFollowUp = task.state === 'changes_requested' || task.state === 'blocked';

  return (
    <section className="panel" aria-label="Runs">
      <div className="section-header">
        <h2>Runs</h2>
      </div>
      <ErrorBanner error={actions.start.error ?? actions.cancel.error ?? runs.error} />

      {!active && readiness.data && (
        <div className="run-start">
          {readiness.data.ready ? (
            <>
              {isFollowUp && (
                <label className="note">
                  Notes for the agent <span className="muted">(optional, e.g. what to change)</span>
                  <textarea
                    rows={2}
                    maxLength={5000}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                  />
                </label>
              )}
              <button
                type="button"
                disabled={actions.start.isPending}
                onClick={() =>
                  actions.start.mutate(note.trim() || undefined, { onSuccess: () => setNote('') })
                }
              >
                {actions.start.isPending
                  ? 'Starting…'
                  : latest
                    ? 'Run again'
                    : 'Run with Claude Code'}
              </button>
              <p className="muted small">
                The agent works on a <span className="mono">workbox/…</span> branch in the project's
                working copy. After the checks pass, Workbox pushes it and opens a draft pull
                request for your review.
              </p>
            </>
          ) : (
            <ul className="readiness" aria-label="Why this task can't run yet">
              {readiness.data.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {runs.isPending ? (
        <Loading what="runs" />
      ) : runs.data && runs.data.length > 0 ? (
        runs.data.map((run, index) => (
          <RunView
            key={run.id}
            run={run}
            expanded={index === 0}
            links={links}
            onCancel={() => actions.cancel.mutate(run.id)}
            cancelling={actions.cancel.isPending}
          />
        ))
      ) : (
        <p className="muted">No runs yet.</p>
      )}
    </section>
  );
}

function RunView({
  run,
  expanded: initiallyExpanded,
  onCancel,
  cancelling,
  links,
}: {
  run: TaskRun;
  expanded: boolean;
  links: GitLinks;
  onCancel: () => void;
  cancelling: boolean;
}) {
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const [showDiff, setShowDiff] = useState(false);
  const active = ACTIVE.has(run.state);
  const events = useRunEvents(expanded ? run.id : '', active);
  const diff = useRunDiff(run.id, showDiff);

  return (
    <article className="run" aria-label={`Run #${run.attempt}`}>
      <button
        type="button"
        className="run-header"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="mono">#{run.attempt}</span>{' '}
        <span className={`badge ${STATE_BADGE[run.state]}`}>{STATE_LABEL[run.state]}</span>
        {run.branch && <span className="mono small">{run.branch}</span>}
        <span className="muted small">
          {run.durationMs !== null && ` · ${Math.round(run.durationMs / 1000)} s`}
          {run.costUsd !== null && ` · $${run.costUsd.toFixed(2)}`}
          {' · '}
          {new Date(run.startedAt ?? run.queuedAt).toLocaleString()}
        </span>
      </button>

      {expanded && (
        <div className="run-body">
          {active && (
            <button
              type="button"
              className="secondary"
              disabled={cancelling || run.cancelRequested}
              onClick={onCancel}
            >
              {run.cancelRequested ? 'Cancelling…' : 'Cancel run'}
            </button>
          )}
          {run.exitReason && run.state !== 'completed' && (
            <p className="warning-text">{run.exitReason}</p>
          )}
          {run.state !== 'queued' && (
            <p className="small">
              Verification:{' '}
              <span className={`badge verification-${run.verification}`}>{run.verification}</span>
              {run.commitSha && (
                <span className="muted">
                  {' '}
                  · committed{' '}
                  <CommitLink
                    sha={run.commitSha}
                    url={links.commit(run.commitSha, run.finishedAt)}
                  />
                </span>
              )}
            </p>
          )}
          {run.checkResults.length > 0 && (
            <ul className="check-results" aria-label="Check results">
              {run.checkResults.map((check) => (
                <li key={check.name}>
                  <details>
                    <summary>
                      <span className={check.status === 'passed' ? 'ok' : 'bad'}>
                        {check.status === 'passed' ? '✓' : '✗'}
                      </span>{' '}
                      {check.name} <span className="mono small">{check.command}</span>{' '}
                      {check.summary && <strong className="check-summary">{check.summary}</strong>}{' '}
                      <span className="muted small">({Math.round(check.durationMs / 1000)} s)</span>
                    </summary>
                    <pre className="check-output">{check.output || '(no output)'}</pre>
                  </details>
                </li>
              ))}
            </ul>
          )}
          {run.summary && (
            <>
              <h3>Summary (from the agent)</h3>
              <p className="prewrap">{run.summary}</p>
            </>
          )}
          {run.qaSteps.length > 0 && (
            <>
              <h3>Manual QA steps</h3>
              <ol>
                {run.qaSteps.map((step, i) => (
                  <li key={i}>{step}</li>
                ))}
              </ol>
            </>
          )}
          {run.changedFiles.length > 0 && (
            <>
              <h3>Changed files ({run.changedFiles.length})</h3>
              <ul className="changed-files">
                {run.changedFiles.map((file) => (
                  <li key={file.path}>
                    <span className={`file-status file-${file.status}`}>
                      {file.status[0]!.toUpperCase()}
                    </span>{' '}
                    <span className="mono">{file.path}</span>
                  </li>
                ))}
              </ul>
              <button type="button" className="secondary" onClick={() => setShowDiff((v) => !v)}>
                {showDiff ? 'Hide diff' : 'View diff'}
              </button>
              {showDiff &&
                (diff.isPending ? (
                  <Loading what="diff" />
                ) : (
                  diff.data && <DiffView diff={diff.data.diff} truncated={diff.data.truncated} />
                ))}
              {run.worktreePath && (
                <p className="muted small">
                  Local checkout: <span className="mono">{run.worktreePath}</span>
                </p>
              )}
            </>
          )}
          <RunFiles runId={run.id} active={active} />
          <h3>Timeline</h3>
          {events.isPending ? (
            <Loading what="timeline" />
          ) : (
            <EventLog events={events.data ?? []} follow={active} />
          )}
        </div>
      )}
    </article>
  );
}

function EventLog({ events, follow }: { events: RunEvent[]; follow: boolean }) {
  const ref = useRef<HTMLOListElement>(null);
  useEffect(() => {
    if (follow && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [events.length, follow]);
  if (events.length === 0) return <p className="muted small">Waiting for the worker…</p>;
  return (
    <ol className="event-log" ref={ref}>
      {events.map((event) => (
        <li
          key={event.seq}
          className={`event event-${event.type} ${event.data.level === 'warn' ? 'event-warn' : ''}`}
        >
          <span className="muted mono">{new Date(event.createdAt).toLocaleTimeString()}</span>{' '}
          <span className="event-type">{event.type.replace('_', ' ')}</span>{' '}
          <span className="event-message">{event.message}</span>
        </li>
      ))}
    </ol>
  );
}

export function DiffView({ diff, truncated }: { diff: string; truncated: boolean }) {
  return (
    <div className="diff">
      {truncated && <p className="warning-text small">The diff is large and was truncated.</p>}
      <pre>
        {diff.split('\n').map((line, i) => (
          <span
            key={i}
            className={
              line.startsWith('+') && !line.startsWith('+++')
                ? 'diff-add'
                : line.startsWith('-') && !line.startsWith('---')
                  ? 'diff-del'
                  : line.startsWith('@@')
                    ? 'diff-hunk'
                    : line.startsWith('diff --git')
                      ? 'diff-file'
                      : ''
            }
          >
            {line}
            {'\n'}
          </span>
        ))}
      </pre>
    </div>
  );
}

const KIND_LABEL: Record<RunArtifact['kind'], string> = {
  transcript: 'Agent transcript',
  check_output: 'Check output',
  patch: 'Patch',
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Full files saved for the run (M5): view in the browser or download, until they expire. */
function RunFiles({ runId, active }: { runId: string; active: boolean }) {
  const files = useRunArtifacts(runId, active);
  if (!files.data || files.data.length === 0) return null;
  const expires = new Date(
    Math.min(...files.data.map((f) => new Date(f.expiresAt).getTime())),
  ).toLocaleDateString();
  return (
    <>
      <h3>Saved files</h3>
      <ul className="run-files" aria-label="Saved files">
        {files.data.map((file) => {
          const url = `/api/v1/runs/${runId}/artifacts/${file.id}`;
          return (
            <li key={file.id}>
              <span className="muted small">{KIND_LABEL[file.kind]}</span>{' '}
              <a href={url} target="_blank" rel="noreferrer" className="mono">
                {file.name}
              </a>{' '}
              <span className="muted small">({formatSize(file.sizeBytes)})</span>{' '}
              <a href={`${url}?download=1`} className="small" aria-label={`Download ${file.name}`}>
                Download
              </a>
            </li>
          );
        })}
      </ul>
      <p className="muted small">Kept until {expires}, then deleted automatically.</p>
    </>
  );
}

function CommitLink({ sha, url }: { sha: string; url: string | null }) {
  const short = <span className="mono">{sha.slice(0, 7)}</span>;
  if (!url) return short;
  return (
    <a href={url} target="_blank" rel="noreferrer" title="Open the commit">
      {short} ↗
    </a>
  );
}
