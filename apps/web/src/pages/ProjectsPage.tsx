import { CODE_HOSTS } from '#shared';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { api } from '../api/client.js';
import { useCreateProject, useProjects } from '../api/hooks.js';
import { AccessStatusBadge } from '../components/connections/ConnectionStatus.js';
import {
  AccessChecklist,
  RepositoryPicker,
  type RepositorySelection,
} from '../components/connections/RepositoryPicker.js';
import { ProjectForm } from '../components/ProjectForm.js';
import { ErrorBanner, LastUpdated, Loading } from '../components/Status.js';

export function ProjectsPage() {
  const [showArchived, setShowArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const projects = useProjects(showArchived ? undefined : 'active');
  const create = useCreateProject();
  const navigate = useNavigate();
  const [withRepository, setWithRepository] = useState(true);
  const [selection, setSelection] = useState<RepositorySelection | null>(null);

  const linkThenOpen = async (slug: string) => {
    let linkError: string | undefined;
    if (withRepository && selection) {
      try {
        await api.linkRepository(slug, {
          connectionId: selection.connection.id,
          externalId: selection.repository.externalId,
        });
      } catch (error) {
        // The project exists either way: open it and show why linking failed, so it can be retried
        // from the repository card (re-submitting this form would hit "slug taken").
        linkError = error instanceof Error ? error.message : 'Linking the repository failed.';
      }
    }
    await navigate(`/projects/${slug}`, linkError ? { state: { linkError } } : undefined);
  };

  const reset = () => {
    setCreating(false);
    setSelection(null);
    create.reset();
  };

  return (
    <>
      <div className="page-header">
        <h1>Projects</h1>
        <LastUpdated at={projects.dataUpdatedAt} fetching={projects.isFetching} />
        <label className="checkbox inline">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
          />
          Show archived
        </label>
        {!creating && (
          <button type="button" onClick={() => setCreating(true)}>
            New project
          </button>
        )}
      </div>

      {creating && (
        <section className="panel">
          <h2>New project</h2>
          <ProjectForm
            submitLabel={
              withRepository && selection ? 'Create project and link repository' : 'Create project'
            }
            pending={create.isPending}
            error={create.error}
            submitDisabled={withRepository && !selection}
            onCancel={reset}
            onSubmit={(input) =>
              create.mutate(input, {
                onSuccess: (project) => void linkThenOpen(project.slug),
              })
            }
          >
            <fieldset className="repository-step">
              <legend>Repository</legend>
              <label className="checkbox">
                <input
                  type="radio"
                  name="repo-mode"
                  checked={!withRepository}
                  onChange={() => setWithRepository(false)}
                />
                No repository yet (planning only)
              </label>
              <label className="checkbox">
                <input
                  type="radio"
                  name="repo-mode"
                  checked={withRepository}
                  onChange={() => setWithRepository(true)}
                />
                Connect a repository
              </label>
              {withRepository && (
                <>
                  <RepositoryPicker value={selection} onChange={setSelection} />
                  {selection && (
                    <p className="small">
                      Selected <span className="mono">{selection.repository.fullPath}</span> on{' '}
                      {CODE_HOSTS[selection.connection.provider as keyof typeof CODE_HOSTS].label}:{' '}
                      <AccessChecklist
                        access={{ ...selection.repository.access, reviewRequests: 'unverified' }}
                        provider={selection.connection.provider}
                      />
                    </p>
                  )}
                </>
              )}
            </fieldset>
          </ProjectForm>
        </section>
      )}

      <ErrorBanner error={projects.error} />
      {projects.isPending ? (
        <Loading what="projects" />
      ) : projects.data && projects.data.length === 0 ? (
        <p className="empty-state">No projects yet. Create one to start adding tasks.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Repository</th>
              <th>Tasks</th>
              <th>Ready for QA</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {projects.data?.map((project) => (
              <tr key={project.id}>
                <td>
                  <Link to={`/projects/${project.slug}`}>{project.name}</Link>
                  <div className="muted small">{project.slug}</div>
                </td>
                <td className="small">
                  {project.repository ? (
                    <>
                      <span className="muted">{CODE_HOSTS[project.repository.provider].label}</span>{' '}
                      <span className="mono">{project.repository.fullPath}</span>{' '}
                      {project.repository.accessStatus !== 'verified' && (
                        <AccessStatusBadge status={project.repository.accessStatus} />
                      )}
                    </>
                  ) : project.repoUrl ? (
                    <span className="muted">not verified</span>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td>{project.totalTasks}</td>
                <td>{project.taskCounts.ready_for_qa}</td>
                <td>{project.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
