import type { Task } from '#shared';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { TaskPage } from '../src/pages/TaskPage.js';
import {
  makeProject,
  makeTask,
  makeTransition,
  mockApi,
  renderRoute,
  requestUrl,
} from './helpers.js';

function setup(initial: Task, extra: Parameters<typeof mockApi>[0] = {}) {
  let current = initial;
  const fetchMock = mockApi({
    [`GET /api/v1/tasks/${initial.id}`]: () => ({ json: current }),
    [`GET /api/v1/tasks/${initial.id}/history`]: () => ({
      json: { items: [makeTransition(initial)] },
    }),
    [`GET /api/v1/projects/${initial.projectId}`]: () => ({ json: makeProject() }),
    [`GET /api/v1/projects/${initial.projectId}/tasks`]: () => ({
      json: { items: [current], total: 1, limit: 500, offset: 0 },
    }),
    [`GET /api/v1/tasks/${initial.id}/git`]: () => ({
      json: { branch: null, localCommitSha: null, reference: null, repositoryWebUrl: null },
    }),
    ...extra,
  });
  renderRoute(<TaskPage />, '/tasks/:taskId', `/tasks/${initial.id}`);
  return {
    fetchMock,
    setCurrent: (task: Task) => {
      current = task;
    },
  };
}

const posted = (fetchMock: ReturnType<typeof mockApi>, path: string) =>
  fetchMock.mock.calls
    .filter(([url, init]) => requestUrl(url).endsWith(path) && init?.method === 'POST')
    .map(([, init]) => JSON.parse(typeof init?.body === 'string' ? init.body : 'null') as unknown);

describe('task detail page', () => {
  it('shows only the transitions the backend allows', async () => {
    setup(
      makeTask({
        title: 'Add health endpoint',
        state: 'ready_for_qa',
        allowedTransitions: ['done', 'changes_requested', 'cancelled'],
      }),
    );
    expect(await screen.findByRole('heading', { name: /Add health endpoint/ })).toBeInTheDocument();
    const buttons = screen
      .getByRole('heading', { name: 'Actions' })
      .parentElement!.querySelectorAll('.transition-buttons button');
    expect([...buttons].map((b) => b.textContent)).toEqual([
      'Approve (done)',
      'Request changes',
      'Cancel task',
    ]);
  });

  it('says a done task has no further actions', async () => {
    setup(makeTask({ state: 'done', allowedTransitions: [] }));
    expect(await screen.findByText(/Done is a final state/)).toBeInTheDocument();
  });

  it('sends a transition with expectedVersion and shows the new state', async () => {
    const task = makeTask({ title: 'Move me' });
    const moved: Task = {
      ...task,
      state: 'in_progress',
      version: 2,
      allowedTransitions: ['verification', 'blocked', 'cancelled'],
    };
    const { fetchMock, setCurrent } = setup(task, {
      [`POST /api/v1/tasks/${task.id}/transitions`]: () => {
        setCurrent(moved);
        return { json: moved };
      },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Start work' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Send to verification' })).toBeInTheDocument(),
    );
    expect(posted(fetchMock, '/transitions')).toEqual([{ to: 'in_progress', expectedVersion: 1 }]);
  });

  it('asks for a reason before blocking', async () => {
    const task = makeTask({ title: 'Block me' });
    const { fetchMock } = setup(task, {
      [`POST /api/v1/tasks/${task.id}/transitions`]: () => ({
        json: {
          ...task,
          state: 'blocked',
          version: 2,
          allowedTransitions: ['backlog', 'planning', 'in_progress', 'cancelled'],
        },
      }),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Block' }));
    const confirm = screen.getByRole('button', { name: 'Confirm' });
    expect(confirm).toBeDisabled();
    expect(posted(fetchMock, '/transitions')).toEqual([]);

    await userEvent.type(screen.getByLabelText(/Reason for/), 'Waiting for API key');
    await userEvent.click(confirm);
    await waitFor(() =>
      expect(posted(fetchMock, '/transitions')).toEqual([
        { to: 'blocked', expectedVersion: 1, reason: 'Waiting for API key' },
      ]),
    );
  });

  it('shows a reload prompt on a version conflict instead of overwriting', async () => {
    const task = makeTask({ title: 'Contested' });
    setup(task, {
      [`PATCH /api/v1/tasks/${task.id}`]: () => ({
        status: 409,
        json: {
          error: {
            code: 'VERSION_CONFLICT',
            message: 'changed',
            details: { expectedVersion: 1, actualVersion: 2 },
          },
        },
      }),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    const title = screen.getByLabelText('Title');
    await userEvent.clear(title);
    await userEvent.type(title, 'Mine');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Someone else changed this task.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
  });

  it('shows the status history and placeholders for later milestones', async () => {
    setup(makeTask());
    expect(await screen.findByText(/Created in/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Runs' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Runs' })).toBeInTheDocument();
    expect(await screen.findByText(/No branch yet: the first run creates one/)).toBeInTheDocument();
  });
});
