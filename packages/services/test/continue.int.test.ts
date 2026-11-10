import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeCodeAdapter } from '#agents';
import { DomainError } from '#core';
import { createDatabase, taskRuns, type DatabaseHandle } from '#database';
import { createCodeHostRegistry } from '#integrations';
import { ERROR_CODES, LOCAL_USER_ACTOR } from '#shared';
import { generateMasterKey, Keyring } from '#vault';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFakeGitHub, type FakeCodeHost } from '../../../test/fake-code-hosts.js';
import { startGitHttpServer, type GitHttpServer } from '../../../test/git-http-server.js';
import { createMigratedTestDatabase, type TestDatabase } from '../../../test/support.js';
import {
  ContinueService,
  createServices,
  RunExecutor,
  WorkspaceSyncer,
  type Services,
} from '../src/index.js';

const ctx = { actor: LOCAL_USER_ACTOR };
const TOKEN = 'github_pat_11CONTINUE000000continueIntegration_Kk77';
let testDb: TestDatabase;
let handle: DatabaseHandle;
let github: FakeCodeHost;
let git: GitHttpServer;
let root: string;
let scripts: string;
let services: Services;
let syncer: WorkspaceSyncer;
let project: { id: string; slug: string };
const ids: Record<string, string> = {};

async function cannotContinue(promise: Promise<unknown>): Promise<DomainError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(DomainError);
  expect((error as DomainError).code).toBe(ERROR_CODES.cannotContinue);
  return error as DomainError;
}

beforeAll(async () => {
  testDb = await createMigratedTestDatabase();
  handle = createDatabase({ connectionString: testDb.url });
  [github, git] = await Promise.all([startFakeGitHub(), startGitHttpServer()]);
  git.accounts.set('x-access-token', TOKEN);
  git.createRepo('kost/app.git');
  github.tokens.set(TOKEN, {
    account: 'kost',
    repos: [{ id: 801, fullPath: 'kost/app', cloneUrl: git.url('kost/app.git') }],
  });
  root = mkdtempSync(join(tmpdir(), 'workbox-continue-ws-'));
  scripts = mkdtempSync(join(tmpdir(), 'workbox-continue-agents-'));
  services = createServices({
    db: handle.db,
    keyring: Keyring.fromConfig({ currentKey: generateMasterKey() }),
    codeHosts: createCodeHostRegistry({ timeoutMs: 2_000 }),
    workerGateway: {
      probeAgentRuntime: () => Promise.reject(new Error('unused')),
      enqueueWorkspaceSync: async () => undefined,
      enqueueRun: async () => undefined,
    },
  });
  syncer = new WorkspaceSyncer({
    db: handle.db,
    connections: services.connections,
    root,
    workerId: 'continue-test-worker',
  });
});

afterAll(async () => {
  await Promise.all([github.close(), git.close()]);
  rmSync(root, { recursive: true, force: true });
  rmSync(scripts, { recursive: true, force: true });
  await handle.close();
  await testDb.drop();
});

describe('continue development', () => {
  it('says the queue is empty, then why the next task cannot start yet', async () => {
    project = await services.projects.create({ name: 'Continue' }, ctx);
    expect(await services.continuation.status(project.slug)).toMatchObject({
      canStart: false,
      reason: 'queue_empty',
      task: null,
    });

    const low = await services.tasks.create(project.id, { title: 'Low', priority: 'low' }, ctx);
    const high = await services.tasks.create(project.id, { title: 'High', priority: 'high' }, ctx);
    const urgent = await services.tasks.create(
      project.id,
      { title: 'Urgent', priority: 'urgent', dependsOn: [low.id] },
      ctx,
    );
    Object.assign(ids, { low: low.id, high: high.id, urgent: urgent.id });

    const status = await services.continuation.status(project.slug);
    expect(status).toMatchObject({
      canStart: false,
      reason: 'not_ready',
      task: { number: high.number },
      details: ['Link a repository to this project first.'],
    });
    await cannotContinue(services.continuation.start(project.slug, ctx));
  });

  it('picks the highest-priority task whose dependencies are done and starts it', async () => {
    const account = await services.connections.create(
      { provider: 'github', name: 'GH', baseUrl: github.baseUrl, secret: TOKEN },
      ctx,
    );
    const repo = await services.repositories.link(
      project.slug,
      { connectionId: account.id, externalId: '801' },
      ctx,
    );
    await syncer.sync(repo.id);
    await services.checks.confirm(
      project.slug,
      { setup: null, commands: [], detectedFrom: [] },
      ctx,
    );

    // "Urgent" waits on "Low", so "High" is next.
    expect(await services.continuation.status(project.slug)).toMatchObject({
      canStart: true,
      reason: 'ready',
      message: 'Next up: #2 High',
      task: { id: ids.high },
    });
    const started = await services.continuation.start(project.slug, ctx);
    expect(started.task.id).toBe(ids.high);
    expect(started.run).toMatchObject({ state: 'queued', taskId: ids.high });
    expect((await services.tasks.get(ids.high!)).state).toBe('in_progress');

    expect(await services.continuation.status(project.slug)).toMatchObject({
      reason: 'running',
      message: 'Working on #2 High.',
    });
    await cannotContinue(services.continuation.start(project.slug, ctx));

    // A run that sits in the queue for minutes means no worker is picking it up.
    const later = new ContinueService(
      handle.db,
      services.runs,
      () => new Date(Date.now() + 3 * 60_000),
    );
    expect((await later.status(project.slug)).message).toMatch(
      /queued for 3 min\. Is the worker running\?/,
    );
  });

  it('stops at Ready for QA and waits for the review', async () => {
    const [run] = await services.runs.list(ids.high!);
    const path = join(scripts, 'agent');
    writeFileSync(
      path,
      `#!/usr/bin/env node
const fs=require('node:fs');const out=(o)=>process.stdout.write(JSON.stringify(o)+'\\n');
const prompt=fs.readFileSync(0,'utf8');
fs.writeFileSync('NOTES.md', prompt.includes('Use a table') ? 'table\\n' : 'list\\n');
out({type:'system',subtype:'init',model:'m',tools:['Write']});
out({type:'result',subtype:'success',is_error:false,num_turns:1,total_cost_usd:0.01,result:'## Summary\\nDone.'});
`,
    );
    chmodSync(path, 0o755);
    const executor = new RunExecutor({
      db: handle.db,
      agents: { claude_code: new ClaudeCodeAdapter({ command: path }) },
      syncer,
      workerId: 'continue-test-worker',
      timeoutMs: 5_000,
      cancelPollMs: 100,
      connections: services.connections,
      authorName: 'Konstantin Test',
    });
    expect(await executor.execute(run!.id)).toBe('completed');
    expect((await services.tasks.get(ids.high!)).state).toBe('ready_for_qa');

    expect(await services.continuation.status(project.slug)).toMatchObject({
      canStart: false,
      reason: 'waiting_for_qa',
      message: 'Waiting for your review: #2 High.',
      task: { id: ids.high },
    });
    const refused = await cannotContinue(services.continuation.start(project.slug, ctx));
    expect(refused.message).toMatch(/Waiting for your review/);
  });

  it('runs requested changes first and passes the reviewer reason to the agent', async () => {
    await services.tasks.transition(
      ids.high!,
      { to: 'changes_requested', reason: 'Use a table' },
      ctx,
    );
    const status = await services.continuation.status(project.slug);
    expect(status).toMatchObject({ canStart: true, task: { id: ids.high } });
    expect(status.details[0]).toMatch(/Requested changes come first/);

    const started = await services.continuation.start(project.slug, ctx);
    const [run] = await services.runs.list(ids.high!);
    expect(run!.id).toBe(started.run.id);
    expect(run!.attempt).toBe(2);
    const [row] = await handle.db.select().from(taskRuns).where(eq(taskRuns.id, started.run.id));
    expect(row!.note).toBe('Use a table');
  });

  it('stops on a blocked task with its reason', async () => {
    const [run] = await services.runs.list(ids.high!);
    await services.runs.cancel(run!.id, ctx); // queued → cancelled at once; task → blocked
    const status = await services.continuation.status(project.slug);
    expect(status).toMatchObject({ canStart: false, reason: 'blocked', task: { id: ids.high } });
    expect(status.message).toMatch(/^#2 High is blocked: Run #2 cancelled/);
  });

  it('reports tasks waiting on dependencies, an empty queue, and an archived project', async () => {
    await services.tasks.transition(ids.high!, { to: 'cancelled', reason: 'Not needed' }, ctx);
    expect(await services.continuation.status(project.slug)).toMatchObject({
      canStart: true,
      task: { id: ids.low },
    });

    await services.tasks.transition(ids.low!, { to: 'in_progress' }, ctx); // worked on by hand
    expect(await services.continuation.status(project.slug)).toMatchObject({
      canStart: false,
      reason: 'waiting_on_dependencies',
      message: '#3 Urgent is waiting on #1 (in progress).',
    });

    for (const id of [ids.low!, ids.urgent!]) {
      await services.tasks.transition(id, { to: 'cancelled', reason: 'Done elsewhere' }, ctx);
    }
    expect(await services.continuation.status(project.slug)).toMatchObject({
      reason: 'queue_empty',
    });

    await services.projects.setStatus(project.slug, 'archived', ctx);
    expect(await services.continuation.status(project.slug)).toMatchObject({
      reason: 'archived',
    });
  });
});
