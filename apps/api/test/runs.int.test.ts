import { createDatabase, type DatabaseHandle } from '#database';
import { createServices } from '#services';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
    services: createServices({
      db: handle.db,
      keyring: testKeyring(),
      workerGateway: {
        probeAgentRuntime: () => Promise.reject(new Error('unused')),
        enqueueRun: async () => undefined,
      },
    }),
  });
});

afterAll(async () => {
  await app.close();
  await handle.close();
  await testDb.drop();
});

describe('runs API', () => {
  it('reports readiness and refuses to start with 409 TASK_NOT_RUNNABLE and the reasons', async () => {
    const project = (
      await app.inject({ method: 'POST', url: '/api/v1/projects', payload: { name: 'No Repo' } })
    ).json<{ slug: string }>();
    const task = (
      await app.inject({
        method: 'POST',
        url: `/api/v1/projects/${project.slug}/tasks`,
        payload: { title: 'x' },
      })
    ).json<{ id: string }>();
    expect(
      (await app.inject({ method: 'GET', url: `/api/v1/tasks/${task.id}/run-readiness` })).json(),
    ).toEqual({
      ready: false,
      reasons: ['Link a repository to this project first.'],
    });
    const start = await app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${task.id}/runs`,
      payload: {},
    });
    expect(start.statusCode).toBe(409);
    expect(start.json()).toMatchObject({
      error: {
        code: 'TASK_NOT_RUNNABLE',
        details: { reasons: ['Link a repository to this project first.'] },
      },
    });
    expect(
      (await app.inject({ method: 'GET', url: `/api/v1/tasks/${task.id}/runs` })).json(),
    ).toEqual({ items: [] });
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/v1/runs/00000000-0000-4000-8000-000000000000',
        })
      ).statusCode,
    ).toBe(404);
  });

  it('confirms checks and refuses to publish a task without commits', async () => {
    await app.inject({ method: 'POST', url: '/api/v1/projects', payload: { name: 'Checks API' } });
    const confirmed = await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/checks-api/checks',
      payload: { setup: null, commands: [{ name: 'test', command: 'npm test' }] },
    });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json()).toMatchObject({
      confirmed: true,
      commands: [{ name: 'test', command: 'npm test' }],
    });
    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/projects/checks-api/checks' })).json(),
    ).toMatchObject({ confirmed: true });
    const task = (
      await app.inject({
        method: 'POST',
        url: '/api/v1/projects/checks-api/tasks',
        payload: { title: 'x' },
      })
    ).json<{ id: string }>();
    expect(
      (await app.inject({ method: 'GET', url: `/api/v1/tasks/${task.id}/git` })).json(),
    ).toEqual({ branch: null, localCommitSha: null, reference: null });
    const publish = await app.inject({ method: 'POST', url: `/api/v1/tasks/${task.id}/publish` });
    expect(publish.statusCode).toBe(409);
    expect(publish.json()).toMatchObject({ error: { code: 'NOTHING_TO_PUBLISH' } });
  });

  it('documents the run routes', async () => {
    const spec = (await app.inject({ method: 'GET', url: '/docs/json' })).json<{
      paths: Record<string, unknown>;
    }>();
    expect(Object.keys(spec.paths)).toEqual(
      expect.arrayContaining([
        '/api/v1/tasks/{taskId}/runs',
        '/api/v1/tasks/{taskId}/run-readiness',
        '/api/v1/runs/{runId}/events',
        '/api/v1/runs/{runId}/diff',
        '/api/v1/runs/{runId}/cancel',
        '/api/v1/projects/{project}/checks',
        '/api/v1/projects/{project}/checks/detect',
        '/api/v1/tasks/{taskId}/git',
        '/api/v1/tasks/{taskId}/publish',
      ]),
    );
  });
});
