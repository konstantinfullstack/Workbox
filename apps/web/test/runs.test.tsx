import type { TaskRun } from '#shared';
import { screen, waitFor, within } from '@testing-library/react';
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

const RUN_ID = '77777777-7777-4777-8777-777777777777';
const makeRun = (overrides: Partial<TaskRun> = {}): TaskRun => ({
  id: RUN_ID,
  taskId: '',
  projectId: '11111111-1111-4111-8111-111111111111',
  attempt: 1,
  state: 'completed',
  agent: 'claude_code',
  branch: 'workbox/4-add-contributing-guide',
  baseSha: 'a'.repeat(40),
  commitSha: 'b'.repeat(40),
  worktreePath: '~/code/workbox/workspaces/demo',
  summary: 'Added CONTRIBUTING.md with setup steps.',
  qaSteps: ['Open CONTRIBUTING.md', 'Follow the setup steps'],
  changedFiles: [{ path: 'CONTRIBUTING.md', status: 'added' }],
  verification: 'passed',
  checkResults: [
    {
      name: 'test',
      command: 'pnpm test',
      status: 'passed',
      exitCode: 0,
      durationMs: 4_000,
      output: '3 passed',
    },
  ],
  exitReason: null,
  costUsd: 0.12,
  durationMs: 42_000,
  cancelRequested: false,
  queuedAt: new Date().toISOString(),
  startedAt: new Date().toISOString(),
  finishedAt: new Date().toISOString(),
  ...overrides,
});

function setup(
  task = makeTask({ title: 'Add contributing guide' }),
  routes: Parameters<typeof mockApi>[0] = {},
) {
  return mockApi({
    [`GET /api/v1/tasks/${task.id}`]: () => ({ json: task }),
    [`GET /api/v1/tasks/${task.id}/history`]: () => ({ json: { items: [makeTransition(task)] } }),
    [`GET /api/v1/projects/${task.projectId}`]: () => ({ json: makeProject() }),
    [`GET /api/v1/projects/${task.projectId}/tasks`]: () => ({
      json: { items: [task], total: 1, limit: 500, offset: 0 },
    }),
    [`GET /api/v1/tasks/${task.id}/run-readiness`]: () => ({ json: { ready: true, reasons: [] } }),
    [`GET /api/v1/tasks/${task.id}/runs`]: () => ({ json: { items: [] } }),
    [`GET /api/v1/runs/${RUN_ID}/events`]: () => ({
      json: {
        items: [
          {
            seq: 1,
            type: 'stage',
            message: 'Preparing workspace',
            data: {},
            createdAt: new Date().toISOString(),
          },
        ],
      },
    }),
    ...routes,
  });
}

describe('runs panel', () => {
  it('explains why a task cannot run', async () => {
    const task = makeTask();
    setup(task, {
      [`GET /api/v1/tasks/${task.id}/run-readiness`]: () => ({
        json: { ready: false, reasons: ['Link a repository to this project first.'] },
      }),
    });
    renderRoute(<TaskPage />, '/tasks/:taskId', `/tasks/${task.id}`);
    const list = await screen.findByRole('list', { name: "Why this task can't run yet" });
    expect(within(list).getByText('Link a repository to this project first.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Run with Claude Code/ })).not.toBeInTheDocument();
  });

  it('starts a run', async () => {
    const task = makeTask();
    let runs: TaskRun[] = [];
    const fetchMock = setup(task, {
      [`GET /api/v1/tasks/${task.id}/runs`]: () => ({ json: { items: runs } }),
      [`POST /api/v1/tasks/${task.id}/runs`]: () => {
        runs = [
          makeRun({
            state: 'running',
            taskId: task.id,
            summary: null,
            qaSteps: [],
            changedFiles: [],
            finishedAt: null,
          }),
        ];
        return { status: 202, json: runs[0] };
      },
    });
    renderRoute(<TaskPage />, '/tasks/:taskId', `/tasks/${task.id}`);
    await userEvent.click(await screen.findByRole('button', { name: 'Run with Claude Code' }));
    expect(await screen.findByText('Agent working')).toBeInTheDocument();
    expect(await screen.findByText('Preparing workspace')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel run' })).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) => init?.method === 'POST' && requestUrl(url).endsWith('/runs'),
      ),
    ).toBe(true);
  });

  it('cancels an active run', async () => {
    const task = makeTask({ state: 'in_progress' });
    const fetchMock = setup(task, {
      [`GET /api/v1/tasks/${task.id}/runs`]: () => ({
        json: { items: [makeRun({ state: 'running', taskId: task.id })] },
      }),
      [`POST /api/v1/runs/${RUN_ID}/cancel`]: () => ({
        json: makeRun({ state: 'running', cancelRequested: true }),
      }),
    });
    renderRoute(<TaskPage />, '/tasks/:taskId', `/tasks/${task.id}`);
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel run' }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) => init?.method === 'POST' && requestUrl(url).endsWith('/cancel'),
        ),
      ).toBe(true),
    );
  });

  it('shows the result: summary, QA steps, changed files and the diff', async () => {
    const task = makeTask({
      state: 'ready_for_qa',
      allowedTransitions: ['done', 'changes_requested', 'cancelled'],
    });
    setup(task, {
      [`GET /api/v1/tasks/${task.id}/runs`]: () => ({
        json: { items: [makeRun({ taskId: task.id })] },
      }),
      [`GET /api/v1/runs/${RUN_ID}/diff`]: () => ({
        json: {
          diff: 'diff --git a/CONTRIBUTING.md b/CONTRIBUTING.md\n+# Contributing\n',
          truncated: false,
        },
      }),
    });
    renderRoute(<TaskPage />, '/tasks/:taskId', `/tasks/${task.id}`);
    const run = within(await screen.findByRole('article', { name: 'Run #1' }));
    expect(run.getByText('Added CONTRIBUTING.md with setup steps.')).toBeInTheDocument();
    expect(run.getByText('Follow the setup steps')).toBeInTheDocument();
    expect(run.getByText('CONTRIBUTING.md')).toBeInTheDocument();
    expect(run.getByText(/\$0\.12/)).toBeInTheDocument();
    await userEvent.click(run.getByRole('button', { name: 'View diff' }));
    expect(await run.findByText('+# Contributing')).toHaveClass('diff-add');
  });

  it('offers notes for the agent when re-running after a block', async () => {
    const task = makeTask({
      state: 'blocked',
      allowedTransitions: ['backlog', 'planning', 'in_progress', 'cancelled'],
    });
    const fetchMock = setup(task, {
      [`GET /api/v1/tasks/${task.id}/runs`]: () => ({
        json: {
          items: [
            makeRun({
              state: 'failed',
              taskId: task.id,
              exitReason: 'The agent finished without changing any files.',
            }),
          ],
        },
      }),
      [`POST /api/v1/tasks/${task.id}/runs`]: () => ({
        status: 202,
        json: makeRun({ attempt: 2, state: 'queued' }),
      }),
    });
    renderRoute(<TaskPage />, '/tasks/:taskId', `/tasks/${task.id}`);
    expect(
      await screen.findByText('The agent finished without changing any files.'),
    ).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/Notes for the agent/), 'Create the file in docs/');
    await userEvent.click(screen.getByRole('button', { name: 'Run again' }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) => init?.method === 'POST' && requestUrl(url).endsWith('/runs'),
      );
      const body = call?.[1]?.body;
      expect(JSON.parse(typeof body === 'string' ? body : '{}')).toEqual({
        note: 'Create the file in docs/',
      });
    });
  });
});
