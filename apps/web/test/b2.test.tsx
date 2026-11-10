import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ProjectPage } from '../src/pages/ProjectPage.js';
import { TaskPage } from '../src/pages/TaskPage.js';
import {
  makeConnection,
  makeProject,
  makeProjectRepository,
  makeTask,
  makeTransition,
  mockApi,
  renderRoute,
  requestUrl,
} from './helpers.js';

const linkedProject = makeProject({
  repository: {
    provider: 'github',
    fullPath: 'kost/workbox',
    webUrl: 'https://github.com/kost/workbox',
    accessStatus: 'verified',
  },
});
const projectRoutes = {
  'GET /api/v1/projects/demo': () => ({ json: linkedProject }),
  'GET /api/v1/projects/demo/tasks': () => ({
    json: { items: [], total: 0, limit: 500, offset: 0 },
  }),
  'GET /api/v1/projects/demo/repository': () => ({ json: { repository: makeProjectRepository() } }),
  'GET /api/v1/connections': () => ({ json: { items: [makeConnection()] } }),
};
const unconfirmed = {
  confirmed: false,
  setup: null,
  commands: [],
  detectedFrom: [],
  confirmedAt: null,
};

describe('checks card', () => {
  it('detects commands from the repository, lets you edit them, and confirms', async () => {
    const fetchMock = mockApi({
      ...projectRoutes,
      'GET /api/v1/projects/demo/checks': () => ({ json: unconfirmed }),
      'POST /api/v1/projects/demo/checks/detect': () => ({
        json: {
          setup: 'pnpm install --frozen-lockfile',
          commands: [
            { name: 'lint', command: 'pnpm run lint' },
            { name: 'test', command: 'pnpm test' },
          ],
          detectedFrom: ['package.json', 'pnpm-lock.yaml'],
          notes: [],
        },
      }),
      'PUT /api/v1/projects/demo/checks': () => ({
        json: { ...unconfirmed, confirmed: true, confirmedAt: new Date().toISOString() },
      }),
    });
    renderRoute(<ProjectPage />, '/projects/:slug', '/projects/demo');
    const card = within(await screen.findByRole('region', { name: 'Checks' }));
    expect(card.getByText(/Not confirmed yet/)).toBeInTheDocument();
    await userEvent.click(card.getByRole('button', { name: 'Detect from repository' }));
    expect(await card.findByText(/Proposed from package.json, pnpm-lock.yaml/)).toBeInTheDocument();
    await userEvent.click(card.getByRole('button', { name: 'Remove check 1' })); // drop lint
    await userEvent.click(card.getByRole('button', { name: 'Confirm checks' }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) => init?.method === 'PUT' && requestUrl(url).endsWith('/checks'),
      );
      const body = call?.[1]?.body;
      expect(JSON.parse(typeof body === 'string' ? body : '{}')).toEqual({
        setup: 'pnpm install --frozen-lockfile',
        commands: [{ name: 'test', command: 'pnpm test' }],
        detectedFrom: ['package.json', 'pnpm-lock.yaml'],
      });
    });
  });

  it('shows confirmed "no checks"', async () => {
    mockApi({
      ...projectRoutes,
      'GET /api/v1/projects/demo/checks': () => ({ json: { ...unconfirmed, confirmed: true } }),
    });
    renderRoute(<ProjectPage />, '/projects/:slug', '/projects/demo');
    expect(
      await screen.findByText(/No automatic checks: every run is reviewed manually/),
    ).toBeInTheDocument();
  });
});

describe('git panel', () => {
  const task = makeTask({
    state: 'ready_for_qa',
    allowedTransitions: ['done', 'changes_requested', 'cancelled'],
  });
  const taskRoutes = {
    [`GET /api/v1/tasks/${task.id}`]: () => ({ json: task }),
    [`GET /api/v1/tasks/${task.id}/history`]: () => ({ json: { items: [makeTransition(task)] } }),
    [`GET /api/v1/projects/${task.projectId}`]: () => ({ json: makeProject() }),
    [`GET /api/v1/projects/${task.projectId}/tasks`]: () => ({
      json: { items: [task], total: 1, limit: 500, offset: 0 },
    }),
    [`GET /api/v1/tasks/${task.id}/runs`]: () => ({ json: { items: [] } }),
    [`GET /api/v1/tasks/${task.id}/run-readiness`]: () => ({
      json: { ready: false, reasons: ['The task is ready for qa.'] },
    }),
  };

  it('shows the draft pull request with its state', async () => {
    mockApi({
      ...taskRoutes,
      [`GET /api/v1/tasks/${task.id}/git`]: () => ({
        json: {
          branch: 'workbox/2-add-docs',
          localCommitSha: 'c'.repeat(40),
          reference: {
            provider: 'github',
            branch: 'workbox/2-add-docs',
            pushedSha: 'c'.repeat(40),
            pushedAt: new Date().toISOString(),
            reviewNumber: 7,
            reviewUrl: 'https://github.com/kost/app/pull/7',
            reviewState: 'draft',
            lastSyncedAt: new Date().toISOString(),
            lastError: null,
          },
        },
      }),
    });
    renderRoute(<TaskPage />, '/tasks/:taskId', `/tasks/${task.id}`);
    const panel = within(await screen.findByRole('region', { name: 'Git' }));
    expect(await panel.findByRole('link', { name: /#7/ })).toHaveAttribute(
      'href',
      'https://github.com/kost/app/pull/7',
    );
    expect(panel.getByText('draft')).toBeInTheDocument();
    expect(panel.queryByRole('button', { name: /Publish/ })).not.toBeInTheDocument();
  });

  it('offers publishing for an unpublished commit and shows the last error', async () => {
    const fetchMock = mockApi({
      ...taskRoutes,
      [`GET /api/v1/tasks/${task.id}/git`]: () => ({
        json: {
          branch: 'workbox/2-add-docs',
          localCommitSha: 'd'.repeat(40),
          reference: {
            provider: 'github',
            branch: 'workbox/2-add-docs',
            pushedSha: null,
            pushedAt: null,
            reviewNumber: null,
            reviewUrl: null,
            reviewState: null,
            lastSyncedAt: null,
            lastError: 'The token may not open pull/merge requests',
          },
        },
      }),
      [`POST /api/v1/tasks/${task.id}/publish`]: () => ({ status: 202, json: { queued: true } }),
    });
    renderRoute(<TaskPage />, '/tasks/:taskId', `/tasks/${task.id}`);
    const panel = within(await screen.findByRole('region', { name: 'Git' }));
    expect(await panel.findByText(/not published yet/)).toBeInTheDocument();
    expect(panel.getByText('The token may not open pull/merge requests')).toBeInTheDocument();
    await userEvent.click(panel.getByRole('button', { name: 'Retry publishing' }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) => init?.method === 'POST' && requestUrl(url).endsWith('/publish'),
        ),
      ).toBe(true),
    );
  });
});
