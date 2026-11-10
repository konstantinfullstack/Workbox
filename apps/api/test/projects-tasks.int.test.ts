import { auditLogs, createDatabase, type DatabaseHandle } from '#database';
import { createServices } from '#services';
import {
  errorResponseSchema,
  projectSummarySchema,
  taskListSchema,
  taskSchema,
  taskTransitionSchema,
  type Task,
} from '#shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createMigratedTestDatabase,
  testKeyring,
  type TestDatabase,
} from '../../../test/support.js';
import { buildApp } from '../src/app.js';

let testDb: TestDatabase;
let handle: DatabaseHandle;
let app: FastifyInstance;

beforeAll(async () => {
  testDb = await createMigratedTestDatabase();
  handle = createDatabase({ connectionString: testDb.url });
  app = await buildApp({
    version: '0.0.0-test',
    logLevel: 'silent',
    readinessChecks: {},
    services: createServices({ db: handle.db, keyring: testKeyring() }),
  });
});

afterAll(async () => {
  await app.close();
  await handle.close();
  await testDb.drop();
});

const api = (
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  payload?: object,
): Promise<LightMyRequestResponse> =>
  app.inject({ method, url: `/api/v1${url}`, ...(payload === undefined ? {} : { payload }) });

function expectError(response: LightMyRequestResponse, status: number, code: string) {
  expect(response.statusCode).toBe(status);
  const body = errorResponseSchema.parse(response.json());
  expect(body.error.code).toBe(code);
  expect(body.error.requestId).toBeTruthy();
  return body.error;
}

describe('projects API', () => {
  it('creates, reads, lists, updates and archives a project', async () => {
    const created = await api('POST', '/projects', { name: 'API Demo' });
    expect(created.statusCode).toBe(201);
    const project = projectSummarySchema.parse(created.json());
    expect(project).toMatchObject({
      slug: 'api-demo',
      status: 'active',
      totalTasks: 0,
      repository: null,
    });

    expect(projectSummarySchema.parse((await api('GET', '/projects/api-demo')).json()).id).toBe(
      project.id,
    );
    expect((await api('GET', `/projects/${project.id}`)).statusCode).toBe(200);

    const patched = await api('PATCH', '/projects/api-demo', {
      description: 'Updated',
      defaultBranch: 'trunk',
    });
    expect(patched.json()).toMatchObject({ description: 'Updated', defaultBranch: 'trunk' });

    expect((await api('POST', '/projects/api-demo/archive')).json()).toMatchObject({
      status: 'archived',
    });
    const archived = await api('GET', '/projects?status=archived');
    expect(
      z
        .object({ items: z.array(projectSummarySchema) })
        .parse(archived.json())
        .items.map((p) => p.slug),
    ).toContain('api-demo');
    expect((await api('POST', '/projects/api-demo/unarchive')).json()).toMatchObject({
      status: 'active',
    });
  });

  it('maps errors to the shared envelope and HTTP statuses', async () => {
    await api('POST', '/projects', { name: 'Taken' });
    expectError(await api('POST', '/projects', { name: 'Taken' }), 409, 'SLUG_TAKEN');
    expectError(await api('GET', '/projects/nope'), 404, 'NOT_FOUND');
    expectError(await api('POST', '/projects', { name: '' }), 400, 'VALIDATION_ERROR');
    expectError(
      await api('POST', '/projects', { name: 'Bad', slug: 'Not A Slug' }),
      400,
      'VALIDATION_ERROR',
    );
    expectError(await api('PATCH', '/projects/taken', {}), 400, 'VALIDATION_ERROR');
    expectError(await api('POST', '/projects', { name: '!!!' }), 400, 'VALIDATION_ERROR');
  });

  it('rejects a typed repoUrl (removed in M3) and never echoes it', async () => {
    const response = await api('POST', '/projects', {
      name: 'Leaky',
      repoUrl: 'https://x-access-token:ghp_TOPSECRET@github.com/org/repo.git',
    });
    expectError(response, 400, 'VALIDATION_ERROR');
    expect(response.body).not.toContain('ghp_TOPSECRET');
  });
});

describe('tasks API', () => {
  let projectSlug: string;
  const createTask = async (body: Record<string, unknown>): Promise<Task> => {
    const response = await api('POST', `/projects/${projectSlug}/tasks`, body);
    expect(response.statusCode).toBe(201);
    return taskSchema.parse(response.json());
  };

  beforeAll(async () => {
    projectSlug = projectSummarySchema.parse(
      (await api('POST', '/projects', { name: 'Task Board' })).json(),
    ).slug;
  });

  it('creates a task in backlog with allowed transitions and history', async () => {
    const task = await createTask({
      title: 'Add a /health endpoint and a unit test',
      acceptanceCriteria: ['GET /health returns 200', 'unit test passes'],
      priority: 'high',
    });
    expect(task).toMatchObject({
      number: 1,
      state: 'backlog',
      version: 1,
      allowedTransitions: ['planning', 'in_progress', 'blocked', 'cancelled'],
    });
    const history = z
      .object({ items: z.array(taskTransitionSchema) })
      .parse((await api('GET', `/tasks/${task.id}/history`)).json());
    expect(history.items).toEqual([
      expect.objectContaining({ fromState: null, toState: 'backlog' }),
    ]);
  });

  it('edits a task and rejects a stale version with 409', async () => {
    const task = await createTask({ title: 'Editable' });
    const updated = await api('PATCH', `/tasks/${task.id}`, {
      title: 'Edited',
      expectedVersion: 1,
    });
    expect(updated.json()).toMatchObject({ title: 'Edited', version: 2 });
    const conflict = expectError(
      await api('PATCH', `/tasks/${task.id}`, { title: 'Stale', expectedVersion: 1 }),
      409,
      'VERSION_CONFLICT',
    );
    expect(conflict.details).toEqual({ expectedVersion: 1, actualVersion: 2 });
  });

  it('applies valid transitions, rejects invalid ones with 422, and persists history + audit', async () => {
    const task = await createTask({ title: 'Lifecycle' });
    const moved = await api('POST', `/tasks/${task.id}/transitions`, {
      to: 'in_progress',
      expectedVersion: 1,
    });
    expect(moved.statusCode).toBe(200);
    expect(taskSchema.parse(moved.json())).toMatchObject({
      state: 'in_progress',
      version: 2,
      allowedTransitions: ['verification', 'blocked', 'cancelled'],
    });

    const invalid = expectError(
      await api('POST', `/tasks/${task.id}/transitions`, { to: 'done' }),
      422,
      'INVALID_TRANSITION',
    );
    expect(invalid.message).toBe(
      'cannot move a task from in_progress to done (allowed: verification, blocked, cancelled)',
    );
    expectError(
      await api('POST', `/tasks/${task.id}/transitions`, { to: 'blocked' }),
      422,
      'REASON_REQUIRED',
    );
    expectError(
      await api('POST', `/tasks/${task.id}/transitions`, { to: 'not_a_state' }),
      400,
      'VALIDATION_ERROR',
    );

    const blocked = await api('POST', `/tasks/${task.id}/transitions`, {
      to: 'blocked',
      reason: 'Need repo access',
    });
    expect(blocked.json()).toMatchObject({ state: 'blocked', version: 3 });

    const history = (await api('GET', `/tasks/${task.id}/history`)).json<{
      items: Array<{ toState: string; reason: string | null }>;
    }>();
    expect(history.items.map((h) => h.toState)).toEqual(['backlog', 'in_progress', 'blocked']);
    expect(history.items.at(-1)?.reason).toBe('Need repo access');

    const audit = await handle.db.select().from(auditLogs).where(eq(auditLogs.resourceId, task.id));
    expect(audit.map((row) => row.action)).toEqual([
      'task.created',
      'task.state_changed',
      'task.state_changed',
    ]);
    // Trace id ties audit rows to the request id returned in x-request-id.
    expect(audit.at(-1)?.traceId).toBe(blocked.headers['x-request-id']);
  });

  it('lists tasks with filters and counts them on the project', async () => {
    const list = taskListSchema.parse(
      (await api('GET', `/projects/${projectSlug}/tasks?state=blocked`)).json(),
    );
    expect(list.items.map((t) => t.title)).toEqual(['Lifecycle']);
    const project = projectSummarySchema.parse(
      (await api('GET', `/projects/${projectSlug}`)).json(),
    );
    expect(project.taskCounts.blocked).toBe(1);
    expect(project.totalTasks).toBeGreaterThanOrEqual(3);
    expectError(
      await api('GET', `/projects/${projectSlug}/tasks?limit=0`),
      400,
      'VALIDATION_ERROR',
    );
  });

  it('validates dependencies with 422 INVALID_DEPENDENCY', async () => {
    const a = await createTask({ title: 'Dep A' });
    const b = await createTask({ title: 'Dep B', dependsOn: [a.id] });
    expect(b.dependsOn).toEqual([a.id]);
    const cycle = expectError(
      await api('PATCH', `/tasks/${a.id}`, { dependsOn: [b.id] }),
      422,
      'INVALID_DEPENDENCY',
    );
    expect(cycle.details).toEqual({ cycle: [a.id, b.id, a.id] });
  });

  it('returns 404 for unknown tasks and 400 for malformed ids', async () => {
    expectError(await api('GET', '/tasks/00000000-0000-4000-8000-000000000000'), 404, 'NOT_FOUND');
    expectError(await api('GET', '/tasks/not-a-uuid'), 400, 'VALIDATION_ERROR');
    expectError(await api('POST', '/projects/nope/tasks', { title: 'x' }), 404, 'NOT_FOUND');
  });

  it('refuses tasks in an archived project with 409', async () => {
    await api('POST', '/projects', { name: 'Frozen' });
    await api('POST', '/projects/frozen/archive');
    expectError(
      await api('POST', '/projects/frozen/tasks', { title: 'x' }),
      409,
      'PROJECT_ARCHIVED',
    );
  });

  it('documents the resource routes in OpenAPI', async () => {
    const spec = (await app.inject({ method: 'GET', url: '/docs/json' })).json<{
      paths: Record<string, unknown>;
    }>();
    expect(Object.keys(spec.paths)).toEqual(
      expect.arrayContaining([
        '/api/v1/projects',
        '/api/v1/projects/{project}',
        '/api/v1/projects/{project}/tasks',
        '/api/v1/tasks/{taskId}',
        '/api/v1/tasks/{taskId}/transitions',
        '/api/v1/tasks/{taskId}/history',
      ]),
    );
  });
});
