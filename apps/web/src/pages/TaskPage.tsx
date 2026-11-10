import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useProject, useTask, useTaskHistory, useTasks, useUpdateTask } from '../api/hooks.js';
import { PriorityBadge, StateBadge } from '../components/Badges.js';
import { HistoryTimeline } from '../components/HistoryTimeline.js';
import { ErrorBanner, LastUpdated, Loading } from '../components/Status.js';
import { TaskForm } from '../components/TaskForm.js';
import { RunPanel } from '../components/runs/RunPanel.js';
import { TransitionControls } from '../components/TransitionControls.js';

export function TaskPage() {
  const { taskId = '' } = useParams();
  const task = useTask(taskId);
  const history = useTaskHistory(taskId);
  const projectId = task.data?.projectId ?? '';
  const project = useProject(projectId);
  const siblings = useTasks(projectId);
  const update = useUpdateTask(taskId);
  const [editing, setEditing] = useState(false);

  if (task.isPending) return <Loading what="task" />;
  if (task.error || !task.data) {
    return (
      <>
        <ErrorBanner error={task.error} />
        <Link to="/projects">← All projects</Link>
      </>
    );
  }
  const t = task.data;
  const reload = () => {
    update.reset();
    void task.refetch();
    void history.refetch();
  };
  const taskTitle = (id: string) => {
    const match = siblings.data?.items.find((item) => item.id === id);
    return match ? `#${match.number} ${match.title}` : id;
  };

  return (
    <>
      <nav className="breadcrumbs">
        <Link to="/projects">Projects</Link> /{' '}
        {project.data ? (
          <Link to={`/projects/${project.data.slug}`}>{project.data.name}</Link>
        ) : (
          '…'
        )}{' '}
        / #{t.number}
      </nav>

      <div className="page-header">
        <h1>
          <span className="muted">#{t.number}</span> {t.title}
        </h1>
        <LastUpdated at={task.dataUpdatedAt} fetching={task.isFetching} />
      </div>
      <div className="badges">
        <StateBadge state={t.state} />
        <PriorityBadge priority={t.priority} />
        <span className="muted small">version {t.version}</span>
      </div>

      <div className="task-layout">
        <div>
          <section className="panel">
            <h2>Actions</h2>
            <TransitionControls task={t} onReload={reload} />
          </section>

          <section className="panel">
            <div className="section-header">
              <h2>Details</h2>
              {!editing && (
                <button type="button" className="secondary" onClick={() => setEditing(true)}>
                  Edit
                </button>
              )}
            </div>
            {editing ? (
              <TaskForm
                key={t.version}
                initial={t}
                candidates={siblings.data?.items ?? []}
                submitLabel="Save"
                pending={update.isPending}
                error={update.error}
                onReload={() => {
                  reload();
                  setEditing(false);
                }}
                onCancel={() => {
                  setEditing(false);
                  update.reset();
                }}
                onSubmit={(input) =>
                  update.mutate(
                    { ...input, expectedVersion: t.version },
                    { onSuccess: () => setEditing(false) },
                  )
                }
              />
            ) : (
              <>
                {t.description ? (
                  <p className="prewrap">{t.description}</p>
                ) : (
                  <p className="muted">No description.</p>
                )}
                <h3>Acceptance criteria</h3>
                {t.acceptanceCriteria.length > 0 ? (
                  <ul className="criteria">
                    {t.acceptanceCriteria.map((item, index) => (
                      <li key={index}>{item}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="muted">None defined.</p>
                )}
                <h3>Depends on</h3>
                {t.dependsOn.length > 0 ? (
                  <ul>
                    {t.dependsOn.map((id) => (
                      <li key={id}>
                        <Link to={`/tasks/${id}`}>{taskTitle(id)}</Link>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="muted">No dependencies.</p>
                )}
              </>
            )}
          </section>

          <RunPanel task={t} />
          <section className="panel placeholder">
            <h2>Git</h2>
            <p className="muted">
              Commit, push and pull request arrive in the next step (B2). Until then, review the
              changes in the run above; the branch exists only in Workbox's local checkout.
            </p>
          </section>
          <section className="panel placeholder">
            <h2>Artifacts &amp; QA instructions</h2>
            <p className="muted">Test results, artifacts and manual QA steps appear here in M5.</p>
          </section>
        </div>

        <aside className="panel">
          <h2>History</h2>
          <ErrorBanner error={history.error} />
          {history.isPending ? (
            <Loading what="history" />
          ) : (
            <HistoryTimeline items={history.data ?? []} />
          )}
        </aside>
      </div>
    </>
  );
}
