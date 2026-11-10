import { useState } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import {
  useCreateTask,
  useProject,
  useSetProjectArchived,
  useTasks,
  useUpdateProject,
} from '../api/hooks.js';
import { ChecksCard } from '../components/ChecksCard.js';
import { RepositoryCard } from '../components/connections/RepositoryCard.js';
import { ProjectForm } from '../components/ProjectForm.js';
import { ErrorBanner, LastUpdated, Loading } from '../components/Status.js';
import { TaskBoard } from '../components/TaskBoard.js';
import { TaskForm } from '../components/TaskForm.js';

export function ProjectPage() {
  const { slug = '' } = useParams();
  const project = useProject(slug);
  const tasks = useTasks(slug);
  const update = useUpdateProject(slug);
  const archive = useSetProjectArchived(slug);
  const createTask = useCreateTask(slug);
  const [editing, setEditing] = useState(false);
  const [creatingTask, setCreatingTask] = useState(false);
  const [showCancelled, setShowCancelled] = useState(false);
  const location = useLocation();
  const linkError = (location.state as { linkError?: string } | null)?.linkError;

  if (project.isPending) return <Loading what="project" />;
  if (project.error || !project.data) {
    return (
      <>
        <ErrorBanner error={project.error} />
        <Link to="/projects">← All projects</Link>
      </>
    );
  }
  const p = project.data;
  const archived = p.status === 'archived';

  return (
    <>
      <nav className="breadcrumbs">
        <Link to="/projects">Projects</Link> / {p.name}
      </nav>
      <div className="page-header">
        <h1>
          {p.name} {archived && <span className="badge">Archived</span>}
        </h1>
        <LastUpdated at={tasks.dataUpdatedAt} fetching={tasks.isFetching} />
        {!editing && (
          <button type="button" className="secondary" onClick={() => setEditing(true)}>
            Edit project
          </button>
        )}
        <button
          type="button"
          className="secondary"
          disabled={archive.isPending}
          onClick={() => archive.mutate(!archived)}
        >
          {archived ? 'Unarchive' : 'Archive'}
        </button>
      </div>
      <ErrorBanner error={archive.error} />

      {editing ? (
        <section className="panel">
          <h2>Edit project</h2>
          <ProjectForm
            initial={p}
            submitLabel="Save"
            pending={update.isPending}
            error={update.error}
            onCancel={() => {
              setEditing(false);
              update.reset();
            }}
            onSubmit={({ name, description, defaultBranch }) =>
              update.mutate(
                {
                  ...(name !== undefined ? { name } : {}),
                  ...(description !== undefined ? { description } : {}),
                  ...(defaultBranch !== undefined ? { defaultBranch } : {}),
                },
                { onSuccess: () => setEditing(false) },
              )
            }
          />
        </section>
      ) : (
        <dl className="details">
          <dt>Slug</dt>
          <dd className="mono">{p.slug}</dd>
          <dt>Default branch</dt>
          <dd className="mono">{p.defaultBranch}</dd>
          {p.description && (
            <>
              <dt>Description</dt>
              <dd className="prewrap">{p.description}</dd>
            </>
          )}
        </dl>
      )}

      {linkError && (
        <div className="error-banner" role="alert">
          <strong>Project created, but the repository was not linked.</strong> {linkError}
        </div>
      )}
      <RepositoryCard project={p} />
      <ChecksCard project={p} />

      <div className="section-header">
        <h2>Tasks</h2>
        <label className="checkbox inline">
          <input
            type="checkbox"
            checked={showCancelled}
            onChange={(e) => setShowCancelled(e.target.checked)}
          />
          Show cancelled
        </label>
        {!creatingTask && !archived && (
          <button type="button" onClick={() => setCreatingTask(true)}>
            New task
          </button>
        )}
      </div>

      {creatingTask && (
        <section className="panel">
          <h2>New task</h2>
          <TaskForm
            candidates={tasks.data?.items ?? []}
            submitLabel="Create task"
            pending={createTask.isPending}
            error={createTask.error}
            onCancel={() => {
              setCreatingTask(false);
              createTask.reset();
            }}
            onSubmit={(input) =>
              createTask.mutate(input, { onSuccess: () => setCreatingTask(false) })
            }
          />
        </section>
      )}

      <ErrorBanner error={tasks.error} />
      {tasks.isPending ? (
        <Loading what="tasks" />
      ) : (
        <TaskBoard tasks={tasks.data?.items ?? []} showCancelled={showCancelled} />
      )}
    </>
  );
}
