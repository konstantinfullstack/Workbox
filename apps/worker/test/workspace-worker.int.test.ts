import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '#core';
import { createDatabase, type DatabaseHandle } from '#database';
import { createCodeHostRegistry } from '#integrations';
import { createServices, WorkspaceSyncer } from '#services';
import { LOCAL_USER_ACTOR, QUEUE_NAMES } from '#shared';
import { generateMasterKey, Keyring } from '#vault';
import { Queue, QueueEvents, type Worker } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorkerGateway } from '../../api/src/worker-gateway.js';
import { startFakeGitHub, type FakeCodeHost } from '../../../test/fake-code-hosts.js';
import { startGitHttpServer, type GitHttpServer } from '../../../test/git-http-server.js';
import {
  createMigratedTestDatabase,
  testRedisUrl,
  type TestDatabase,
} from '../../../test/support.js';
import { createWorkspaceWorker, enqueuePendingSyncs } from '../src/workspace-worker.js';

const TOKEN = 'github_pat_11E2E2E2E0000workerEndToEnd_Jj33';

describe('workspace worker (API link → Redis → worker → git clone)', () => {
  const prefix = `wb-ws-${randomBytes(4).toString('hex')}`;
  let testDb: TestDatabase;
  let handle: DatabaseHandle;
  let github: FakeCodeHost;
  let git: GitHttpServer;
  let root: string;
  let worker: Worker;
  let events: QueueEvents;
  let gateway: ReturnType<typeof createWorkerGateway>;

  beforeAll(async () => {
    testDb = await createMigratedTestDatabase();
    handle = createDatabase({ connectionString: testDb.url });
    [github, git] = await Promise.all([startFakeGitHub(), startGitHttpServer()]);
    git.accounts.set('x-access-token', TOKEN);
    git.createRepo('kost/e2e.git');
    github.tokens.set(TOKEN, {
      account: 'kost',
      repos: [{ id: 501, fullPath: 'kost/e2e', cloneUrl: git.url('kost/e2e.git') }],
    });
    root = mkdtempSync(join(tmpdir(), 'workbox-ws-e2e-'));
    events = new QueueEvents(QUEUE_NAMES.workspaces, {
      connection: { url: testRedisUrl(), maxRetriesPerRequest: null },
      prefix,
    });
    await events.waitUntilReady();
  });

  afterAll(async () => {
    await worker?.close();
    await events.close();
    await gateway?.close();
    await new Queue(QUEUE_NAMES.workspaces, {
      connection: { url: testRedisUrl() },
      prefix,
    }).obliterate({ force: true });
    await Promise.all([github.close(), git.close()]);
    rmSync(root, { recursive: true, force: true });
    await handle.close();
    await testDb.drop();
  });

  it('clones automatically after linking, and re-queues pending workspaces at startup', async () => {
    const keyring = Keyring.fromConfig({ currentKey: generateMasterKey() });
    gateway = createWorkerGateway({ redisUrl: testRedisUrl(), prefix });
    const services = createServices({
      db: handle.db,
      keyring,
      codeHosts: createCodeHostRegistry(),
      workerGateway: gateway,
    });
    const syncer = new WorkspaceSyncer({
      db: handle.db,
      connections: services.connections,
      root,
      workerId: 'e2e-worker',
    });

    // Link while no worker is running: the job waits in Redis.
    const ctx = { actor: LOCAL_USER_ACTOR };
    const account = await services.connections.create(
      { provider: 'github', name: 'GH', baseUrl: github.baseUrl, secret: TOKEN },
      ctx,
    );
    const project = await services.projects.create({ name: 'E2E' }, ctx);
    await services.repositories.link(
      project.slug,
      { connectionId: account.id, externalId: '501' },
      ctx,
    );
    expect((await services.repositories.get(project.slug))?.workspace?.status).toBe('queued');

    const done = new Promise<void>((resolve) => events.once('completed', () => resolve()));
    worker = createWorkspaceWorker({
      redisUrl: testRedisUrl(),
      prefix,
      syncer,
      logger: createLogger({ service: 'test', level: 'silent' }),
    });
    await done;
    expect((await services.repositories.get(project.slug))?.workspace).toMatchObject({
      status: 'ready',
      workerId: 'e2e-worker',
    });
    expect(existsSync(join(root, project.slug, '.git'))).toBe(true);

    // Startup reconciliation finds nothing to do once everything is ready.
    const queue = new Queue(QUEUE_NAMES.workspaces, {
      connection: { url: testRedisUrl(), maxRetriesPerRequest: null },
      prefix,
    });
    expect(await enqueuePendingSyncs(queue, syncer)).toBe(0);
    await queue.close();
  });
});
