import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ProjectPage } from '../src/pages/ProjectPage.js';
import { makeProject, makeProjectRepository, mockApi, renderRoute, requestUrl } from './helpers.js';

const TASK_ID = '00000000-0000-4000-8000-000000000005';
const project = makeProject({
  repository: {
    provider: 'github',
    fullPath: 'kost/workbox',
    webUrl: 'https://github.com/kost/workbox',
    accessStatus: 'verified',
  },
});
const routes = {
  'GET /api/v1/projects/demo': () => ({ json: project }),
  'GET /api/v1/projects/demo/tasks': () => ({
    json: { items: [], total: 0, limit: 500, offset: 0 },
  }),
  'GET /api/v1/projects/demo/repository': () => ({ json: { repository: makeProjectRepository() } }),
  'GET /api/v1/projects/demo/checks': () => ({
    json: { confirmed: true, setup: null, commands: [], detectedFrom: [], confirmedAt: null },
  }),
  'GET /api/v1/connections': () => ({ json: { items: [] } }),
};

describe('continue development card', () => {
  it('shows the next task and starts it', async () => {
    const fetchMock = mockApi({
      ...routes,
      'GET /api/v1/projects/demo/continue': () => ({
        json: {
          canStart: true,
          reason: 'ready',
          message: 'Next up: #5 Add login page',
          task: { id: TASK_ID, number: 5, title: 'Add login page' },
          details: [],
        },
      }),
      'POST /api/v1/projects/demo/continue': () => ({ status: 202, json: {} }),
    });
    renderRoute(<ProjectPage />, '/projects/:slug', '/projects/demo');
    const card = within(await screen.findByRole('region', { name: 'Continue development' }));
    expect(await card.findByRole('link', { name: '#5 Add login page' })).toHaveAttribute(
      'href',
      `/tasks/${TASK_ID}`,
    );
    await userEvent.click(card.getByRole('button', { name: 'Continue development' }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) => init?.method === 'POST' && requestUrl(url).endsWith('/continue'),
        ),
      ).toBe(true),
    );
  });

  it('is disabled and says why while a task waits for review', async () => {
    mockApi({
      ...routes,
      'GET /api/v1/projects/demo/continue': () => ({
        json: {
          canStart: false,
          reason: 'waiting_for_qa',
          message: 'Waiting for your review: #4 Add docs.',
          task: { id: TASK_ID, number: 4, title: 'Add docs' },
          details: ['Review the pull request, then move the task to Done or Changes requested.'],
        },
      }),
    });
    renderRoute(<ProjectPage />, '/projects/:slug', '/projects/demo');
    const card = within(await screen.findByRole('region', { name: 'Continue development' }));
    expect(await card.findByRole('status')).toHaveTextContent(
      'Waiting for your review: #4 Add docs.',
    );
    expect(card.getByRole('button', { name: 'Continue development' })).toBeDisabled();
    expect(card.getByText(/Review the pull request/)).toBeInTheDocument();
  });
});
