import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ProjectPage } from '../src/pages/ProjectPage.js';
import { makeProject, makeTask, mockApi, renderRoute } from './helpers.js';

describe('project board', () => {
  it('places tasks in the right columns and hides cancelled ones by default', async () => {
    const tasks = [
      makeTask({ title: 'Write spec', state: 'backlog' }),
      makeTask({ title: 'Build API', state: 'in_progress', priority: 'urgent' }),
      makeTask({ title: 'Waiting on token', state: 'blocked' }),
      makeTask({ title: 'Ship it', state: 'ready_for_qa' }),
      makeTask({ title: 'Old idea', state: 'cancelled' }),
    ];
    mockApi({
      'GET /api/v1/projects/demo': () => ({ json: makeProject({ totalTasks: 5 }) }),
      'GET /api/v1/projects/demo/repository': () => ({ json: { repository: null } }),
      'GET /api/v1/connections': () => ({ json: { items: [] } }),
      'GET /api/v1/projects/demo/tasks': () => ({
        json: { items: tasks, total: tasks.length, limit: 500, offset: 0 },
      }),
    });

    renderRoute(<ProjectPage />, '/projects/:slug', '/projects/demo');

    const column = async (name: string) => within(await screen.findByRole('listitem', { name }));
    expect((await column('Backlog')).getByText('Write spec')).toBeInTheDocument();
    expect((await column('In progress')).getByText('Build API')).toBeInTheDocument();
    const attention = await column('Needs attention');
    expect(attention.getByText('Waiting on token')).toBeInTheDocument();
    expect(attention.getByText('Blocked')).toBeInTheDocument(); // state badge in mixed column
    expect((await column('Ready for QA')).getByText('Ship it')).toBeInTheDocument();
    expect(screen.queryByText('Old idea')).not.toBeInTheDocument();

    await userEvent.click(screen.getByLabelText('Show cancelled'));
    expect((await column('Cancelled')).getByText('Old idea')).toBeInTheDocument();
  });

  it('links each card to its task detail page', async () => {
    const task = makeTask({ title: 'Linked' });
    mockApi({
      'GET /api/v1/projects/demo': () => ({ json: makeProject() }),
      'GET /api/v1/projects/demo/repository': () => ({ json: { repository: null } }),
      'GET /api/v1/connections': () => ({ json: { items: [] } }),
      'GET /api/v1/projects/demo/tasks': () => ({
        json: { items: [task], total: 1, limit: 500, offset: 0 },
      }),
    });
    renderRoute(<ProjectPage />, '/projects/:slug', '/projects/demo');
    const card = await screen.findByRole('link', { name: /Linked/ });
    expect(card).toHaveAttribute('href', `/tasks/${task.id}`);
  });
});
