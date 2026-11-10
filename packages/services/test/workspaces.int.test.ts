import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditLogs, createDatabase, workspaces, type DatabaseHandle } from '#database';
import { createCodeHostRegistry } from '#integrations';
import { LOCAL_USER_ACTOR } from '#shared';
import { generateMasterKey, Keyring } from '#vault';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  startFakeGitHub,
  startFakeGitLab,
  type FakeCodeHost,
} from '../../../test/fake-code-hosts.js';
import { startGitHttpServer, type GitHttpServer } from '../../../test/git-http-server.js';
import { createMigratedTestDatabase, type TestDatabase } from '../../../test/support.js';
import {
  createServices,
  WorkspaceSyncer,
  type Services,
  type WorkerGateway,
} from '../src/index.js';

const ctx = { actor: LOCAL_USER_ACTOR };
const GH_TOKEN = 'github_pat_11WSWSWS0000workspaceIntegration_Kk21';
const GL_TOKEN = 'glpat-workspaceIntegration12345';

let testDb: TestDatabase;
let handle: DatabaseHandle;
let github: FakeCodeHost;
let gitlab: FakeCodeHost;
let git: GitHttpServer;
let root: string;
let services: Services;
let syncer: WorkspaceSyncer;
const queued: Array<{ kind: 'sync' | 'remove'; value: string; reason?: string }> = [];

const gateway: WorkerGateway = {
  probeAgentRuntime: () => Promise.reject(new Error('not used')),
  enqueueWorkspaceSync: async (id, reason) => void queued.push({ kind: 'sync', value: id, reason }),
  enqueueWorkspaceRemoval: async (slug) => void queued.push({ kind: 'remove', value: slug }),
};

beforeAll(async () => {
  testDb = await createMigratedTestDatabase();
  handle = createDatabase({ connectionString: testDb.url });
  [github, gitlab, git] = await Promise.all([
    startFakeGitHub(),
    startFakeGitLab(),
    startGitHttpServer(),
  ]);
  git.accounts.set('x-access-token', GH_TOKEN);
  git.accounts.set('oauth2', GL_TOKEN);
  git.createRepo('kost/app.git');
  git.createRepo('team/api.git', 'develop');
  github.tokens.set(GH_TOKEN, {
    account: 'kost',
    repos: [
      { id: 101, fullPath: 'kost/app', cloneUrl: git.url('kost/app.git') },
      { id: 102, fullPath: 'kost/missing', cloneUrl: git.url('kost/missing.git') },
    ],
  });
  gitlab.tokens.set(GL_TOKEN, {
    account: 'project_9_bot',
    repos: [
      { id: 9, fullPath: 'team/api', defaultBranch: 'develop', cloneUrl: git.url('team/api.git') },
    ],
  });
  root = mkdtempSync(join(tmpdir(), 'workbox-ws-int-'));
  const keyring = Keyring.fromConfig({ currentKey: generateMasterKey() });
  const codeHosts = createCodeHostRegistry({ timeoutMs: 2_000 });
  services = createServices({ db: handle.db, keyring, codeHosts, workerGateway: gateway });
  syncer = new WorkspaceSyncer({
    db: handle.db,
    connections: services.connections,
    root,
    workerId: 'test-worker',
    timeoutMs: 30_000,
  });
});

afterAll(async () => {
  await Promise.all([github.close(), gitlab.close(), git.close()]);
  rmSync(root, { recursive: true, force: true });
  await handle.close();
  await testDb.drop();
});

async function linkGitHub(externalId: string, name: string) {
  const account = await services.connections.create(
    { provider: 'github', name: `GH ${name}`, baseUrl: github.baseUrl, secret: GH_TOKEN },
    ctx,
  );
  const project = await services.projects.create({ name }, ctx);
  const repo = await services.repositories.link(
    project.slug,
    { connectionId: account.id, externalId },
    ctx,
  );
  return { account, project, repo };
}

describe('workspaces', () => {
  it('queues a clone when a repository is linked, then the worker clones it', async () => {
    const { project, repo } = await linkGitHub('101', 'Clone Me');
    expect(repo.workspace).toMatchObject({ status: 'queued', path: null });
    expect(queued.at(-1)).toEqual({ kind: 'sync', value: repo.id, reason: 'linked' });

    const outcome = await syncer.sync(repo.id);
    expect(outcome).toMatchObject({ status: 'ready', action: 'cloned' });
    const after = await services.repositories.get(project.slug);
    expect(after?.workspace).toMatchObject({
      status: 'ready',
      workerId: 'test-worker',
      lastError: null,
    });
    expect(after?.workspace?.headSha).toMatch(/^[0-9a-f]{40}$/);
    const path = join(root, project.slug);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(join(path, '.git', 'config'), 'utf8')).not.toContain(GH_TOKEN);

    // Token use is audited with its purpose.
    const audit = await handle.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'credential.accessed'));
    expect(
      audit.some(
        (row) => row.metadata.purpose === 'workspace.sync' && row.actor === 'worker:test-worker',
      ),
    ).toBe(true);
  });

  it('"Sync now" fetches new commits', async () => {
    // Repository 101 is linked to "clone-me" by the previous test (one project per repository).
    const project = await services.projects.get('clone-me');
    const repo = (await services.repositories.get(project.slug))!;
    const requested = await services.repositories.requestWorkspaceSync(project.slug, ctx);
    expect(requested.workspace?.status).toBe('queued');
    expect(queued.at(-1)).toEqual({ kind: 'sync', value: repo.id, reason: 'manual' });
    const sha = git.commit('kost/app.git', 'new work');
    expect(await syncer.sync(repo.id)).toMatchObject({
      status: 'ready',
      action: 'fetched',
      headSha: sha,
    });
  });

  it('clones GitLab repositories with their own default branch', async () => {
    const account = await services.connections.create(
      { provider: 'gitlab', name: 'GL', baseUrl: gitlab.baseUrl, secret: GL_TOKEN },
      ctx,
    );
    const project = await services.projects.create({ name: 'GitLab Clone' }, ctx);
    const repo = await services.repositories.link(
      project.slug,
      { connectionId: account.id, externalId: '9' },
      ctx,
    );
    expect(await syncer.sync(repo.id)).toMatchObject({ status: 'ready', action: 'cloned' });
    expect((await services.repositories.get(project.slug))?.defaultBranch).toBe('develop');
  });

  it('records a readable failure instead of hanging when git cannot clone', async () => {
    const { project, repo } = await linkGitHub('102', 'Missing Remote');
    expect(await syncer.sync(repo.id)).toMatchObject({ status: 'failed' });
    const after = await services.repositories.get(project.slug);
    expect(after?.workspace).toMatchObject({
      status: 'failed',
      lastError: expect.stringMatching(/not found/),
    });
    expect(existsSync(join(root, project.slug))).toBe(false);
  });

  it('reports authentication failures with a hint, and recovers after the token works again', async () => {
    const project = (await services.projects.list()).find((p) => p.slug === 'clone-me')!;
    const repo = (await services.repositories.get(project.slug))!;
    git.accounts.set('x-access-token', 'github_pat_rotated_elsewhere_000000000');
    const failed = await syncer.sync(repo.id);
    expect(failed).toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/authentication failed.*Replace the token/),
    });
    git.accounts.set('x-access-token', GH_TOKEN);
    expect(await syncer.sync(repo.id)).toMatchObject({ status: 'ready', action: 'fetched' });
  });

  it('lists workspaces that need a sync after a restart', async () => {
    const pending = await syncer.pending();
    const missing = (await services.repositories.get('missing-remote'))!;
    expect(pending).toContain(missing.id);
    expect(pending).not.toContain((await services.repositories.get('clone-me'))!.id);
  });

  it('re-syncs into the new location when the workspaces folder changes', async () => {
    const cloneMe = (await services.repositories.get('clone-me'))!;
    const newRoot = mkdtempSync(join(tmpdir(), 'workbox-ws-moved-'));
    try {
      const moved = new WorkspaceSyncer({
        db: handle.db,
        connections: services.connections,
        root: newRoot,
        workerId: 'test-worker',
      });
      expect(await moved.pending()).toContain(cloneMe.id); // ready, but recorded under the old root
      expect(await moved.sync(cloneMe.id)).toMatchObject({ status: 'ready', action: 'cloned' });
      expect(existsSync(join(newRoot, 'clone-me', '.git'))).toBe(true);
      expect(await moved.pending()).not.toContain(cloneMe.id);
      // Back to the original root for the remaining tests.
      await syncer.sync(cloneMe.id);
    } finally {
      rmSync(newRoot, { recursive: true, force: true });
    }
  });

  it('removes the clone when the repository is unlinked', async () => {
    const path = join(root, 'clone-me');
    expect(existsSync(path)).toBe(true);
    await services.repositories.unlink('clone-me', ctx);
    expect(queued.at(-1)).toEqual({ kind: 'remove', value: 'clone-me' });
    expect(await handle.db.select().from(workspaces)).not.toContainEqual(
      expect.objectContaining({ path }),
    );
    expect(await syncer.remove('clone-me')).toBe(true);
    expect(existsSync(path)).toBe(false);
    // A sync for a since-unlinked repository is skipped, not an error.
    expect(await syncer.sync('00000000-0000-4000-8000-000000000000')).toMatchObject({
      status: 'skipped',
    });
  });
});
