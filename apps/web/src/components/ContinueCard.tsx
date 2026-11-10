import type { ContinueStatus, ProjectSummary } from '#shared';
import { Link } from 'react-router';
import { useContinueDevelopment, useContinueStatus } from '../api/hooks.js';
import { ErrorBanner, Loading } from './Status.js';

const TONE: Record<ContinueStatus['reason'], string> = {
  ready: 'continue-ready',
  running: 'continue-running',
  waiting_for_qa: 'continue-waiting',
  blocked: 'continue-stopped',
  waiting_on_dependencies: 'continue-waiting',
  queue_empty: 'continue-idle',
  not_ready: 'continue-stopped',
  archived: 'continue-idle',
};

/**
 * "Continue development" (B3): one click runs the project's next task. Work stops at Ready for
 * QA, so the card always says what runs next or why it stopped.
 */
export function ContinueCard({ project }: { project: ProjectSummary }) {
  const status = useContinueStatus(project.slug);
  const start = useContinueDevelopment(project.slug);

  if (!project.repository) return null;
  if (status.isPending) return <Loading what="next task" />;
  const s = status.data;

  return (
    <section
      className={`panel continue ${s ? TONE[s.reason] : ''}`}
      aria-label="Continue development"
    >
      <div className="section-header">
        <h2>Continue development</h2>
        <button
          type="button"
          disabled={!s?.canStart || start.isPending}
          onClick={() => start.mutate()}
          title={s && !s.canStart ? s.message : undefined}
        >
          {start.isPending ? 'Starting…' : 'Continue development'}
        </button>
      </div>
      <ErrorBanner error={start.error ?? status.error} />
      {s && (
        <>
          <p className="continue-message" role="status">
            {s.task ? <TaskMessage status={s} /> : s.message}
          </p>
          {s.details.length > 0 && (
            <ul className="readiness">
              {s.details.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}
        </>
      )}
      <p className="muted small">
        Runs one task: requested changes first, then the backlog by priority. It stops when the task
        is Ready for QA and waits for your review before starting the next one.
      </p>
    </section>
  );
}

/** The status line with the task's "#n Title" turned into a link to the task. */
function TaskMessage({ status }: { status: ContinueStatus }) {
  const task = status.task!;
  const label = `#${task.number} ${task.title}`;
  const at = status.message.indexOf(label);
  if (at < 0) {
    return (
      <>
        {status.message} <Link to={`/tasks/${task.id}`}>Open #{task.number}</Link>
      </>
    );
  }
  return (
    <>
      {status.message.slice(0, at)}
      <Link to={`/tasks/${task.id}`}>{label}</Link>
      {status.message.slice(at + label.length)}
    </>
  );
}
