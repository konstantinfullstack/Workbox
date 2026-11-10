import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase, taskRuns, type DatabaseHandle } from '#database';
import { createServices, type Services } from '#services';
import { LOCAL_USER_ACTOR } from '#shared';
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
let services: Services;
let root: string;

beforeAll(async () => {
  testDb = await createMigratedTestDatabase();
  handle = createDatabase({ connectionString: testDb.url });
  root = mkdtempSync(join(tmpdir(), 'workbox-api-artifacts-'));
  services = createServices({
    db: handle.db,
    keyring: testKeyring(),
    artifacts: { root, retentionDays: 7 },
  });
  app = await buildApp({
    version: '0.0.0-test',
    logLevel: 'silent',
    readinessChecks: {},
    services,
  });
});

afterAll(async () => {
  await app.close();
  await handle.close();
  await testDb.drop();
  rmSync(root, { recursive: true, force: true });
});

describe('run files API', () => {
  it("lists a run's files and serves them as plain text, inline or as a download", async () => {
    const ctx = { actor: LOCAL_USER_ACTOR };
    const project = await services.projects.create({ name: 'Files' }, ctx);
    const task = await services.tasks.create(project.id, { title: 'x' }, ctx);
    const [run] = await handle.db
      .insert(taskRuns)
      .values({ taskId: task.id, projectId: project.id, attempt: 1, agent: 'claude_code' })
      .returning({ id: taskRuns.id });
    const store = services.artifacts!;
    writeFileSync(
      await store.prepare(run!.id, 'checks/1-1-test.log'),
      '<script>alert(1)</script>\n',
    );
    const artifact = (await store.record(run!.id, 'check_output', 'checks/1-1-test.log'))!;

    const list = await app.inject({ method: 'GET', url: `/api/v1/runs/${run!.id}/artifacts` });
    expect(list.json()).toEqual({
      items: [expect.objectContaining({ name: 'checks/1-1-test.log', sizeBytes: 26 })],
    });

    const url = `/api/v1/runs/${run!.id}/artifacts/${artifact.id}`;
    const inline = await app.inject({ method: 'GET', url });
    expect(inline.statusCode).toBe(200);
    expect(inline.body).toBe('<script>alert(1)</script>\n');
    expect(inline.headers).toMatchObject({
      'content-type': 'text/plain; charset=utf-8',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'",
      'content-disposition': 'inline; filename="1-1-test.log"',
    });
    const download = await app.inject({ method: 'GET', url: `${url}?download=1` });
    expect(download.headers['content-disposition']).toBe('attachment; filename="1-1-test.log"');

    // The file id must belong to the run in the URL.
    const otherRun = '99999999-9999-4999-8999-999999999999';
    const wrong = await app.inject({
      method: 'GET',
      url: `/api/v1/runs/${otherRun}/artifacts/${artifact.id}`,
    });
    expect(wrong.statusCode).toBe(404);
  });
});
