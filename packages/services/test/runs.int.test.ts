import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeCodeAdapter } from '#agents';
import { DomainError } from '#core';
import { createDatabase, taskRuns, type DatabaseHandle } from '#database';
import { runGit } from '#git';
import { createCodeHostRegistry } from '#integrations';
import { ERROR_CODES, LOCAL_USER_ACTOR, type ErrorCode } from '#shared';
import { generateMasterKey, Keyring, Secret } from '#vault';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFakeGitHub, type FakeCodeHost } from '../../../test/fake-code-hosts.js';
import { startGitHttpServer, type GitHttpServer } from '../../../test/git-http-server.js';
import { createMigratedTestDatabase, type TestDatabase } from '../../../test/support.js';
import { createServices, RunExecutor, WorkspaceSyncer, type Services } from '../src/index.js';

const ctx = { actor: LOCAL_USER_ACTOR };
const TOKEN = 'github_pat_11RUNRUNRUN0000runIntegration_Hh55';
let testDb: TestDatabase;
let handle: DatabaseHandle;
let github: FakeCodeHost;
let git: GitHttpServer;
let root: string;
let scripts: string;
let services: Services;
let syncer: WorkspaceSyncer;
const enqueued: string[] = [];
let initialSha: string;

/** Stand-in agents: each scenario is a separate executable speaking stream-json. */
function agent(name: string, body: string): RunExecutor {
  const path = join(scripts, name);
  writeFileSync(
    path,
    `#!/usr/bin/env node\nconst fs=require('node:fs');const out=(o)=>process.stdout.write(JSON.stringify(o)+'\\n');fs.readFileSync(0,'utf8');\n${body}\n`,
  );
  chmodSync(path, 0o755);
  return new RunExecutor({
    db: handle.db,
    agents: { claude_code: new ClaudeCodeAdapter({ command: path }) },
    syncer,
    workerId: 'run-test-worker',
    timeoutMs: 3_000,
    cancelPollMs: 100,
    connections: services.connections,
    authorName: 'Konstantin Test',
  });
}
const done = (text: string) =>
  `out({type:'system',subtype:'init',model:'m',tools:['Write']});out({type:'result',subtype:'success',is_error:false,num_turns:2,total_cost_usd:0.01,result:${JSON.stringify(text)}});`;
const writes = (file: string, content: string) =>
  `fs.writeFileSync(${JSON.stringify(file)}, ${JSON.stringify(content)});`;

async function expectDomainError(promise: Promise<unknown>, code: ErrorCode) {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(DomainError);
  expect((error as DomainError).code).toBe(code);
  return error as DomainError;
}

beforeAll(async () => {
  testDb = await createMigratedTestDatabase();
  handle = createDatabase({ connectionString: testDb.url });
  [github, git] = await Promise.all([startFakeGitHub(), startGitHttpServer()]);
  git.accounts.set('x-access-token', TOKEN);
  initialSha = git.createRepo('kost/app.git');
  github.tokens.set(TOKEN, {
    account: 'kost',
    repos: [{ id: 701, fullPath: 'kost/app', cloneUrl: git.url('kost/app.git') }],
  });
  root = mkdtempSync(join(tmpdir(), 'workbox-runs-ws-'));
  scripts = mkdtempSync(join(tmpdir(), 'workbox-runs-agents-'));
  services = createServices({
    db: handle.db,
    keyring: Keyring.fromConfig({ currentKey: generateMasterKey() }),
    codeHosts: createCodeHostRegistry({ timeoutMs: 2_000 }),
    workerGateway: {
      probeAgentRuntime: () => Promise.reject(new Error('unused')),
      enqueueWorkspaceSync: async () => undefined,
      enqueueRun: async (id) => void enqueued.push(id),
    },
  });
  syncer = new WorkspaceSyncer({
    db: handle.db,
    connections: services.connections,
    root,
    workerId: 'run-test-worker',
  });
});

afterAll(async () => {
  await Promise.all([github.close(), git.close()]);
  rmSync(root, { recursive: true, force: true });
  rmSync(scripts, { recursive: true, force: true });
  await handle.close();
  await testDb.drop();
});

let project: { id: string; slug: string };

describe('readiness', () => {
  it('explains why a task cannot run until a repository is linked and cloned', async () => {
    project = await services.projects.create({ name: 'Runs' }, ctx);
    const task = await services.tasks.create(project.id, { title: 'Add contributing guide' }, ctx);
    expect(await services.runs.readiness(task.id)).toEqual([
      'Link a repository to this project first.',
    ]);

    const account = await services.connections.create(
      { provider: 'github', name: 'GH', baseUrl: github.baseUrl, secret: TOKEN },
      ctx,
    );
    const repo = await services.repositories.link(
      project.slug,
      { connectionId: account.id, externalId: '701' },
      ctx,
    );
    expect(await services.runs.readiness(task.id)).toEqual([
      'The repository is still being cloned.',
      expect.stringMatching(/Confirm the project's check commands/),
    ]);
    await syncer.sync(repo.id);
    await services.checks.confirm(
      project.slug,
      { setup: null, commands: [], detectedFrom: [] },
      ctx,
    ); // "no checks"
    expect(await services.runs.readiness(task.id)).toEqual([]);
  });
});

describe('a successful run', () => {
  it('queues, moves the task to in_progress, and refuses a second run in the project', async () => {
    const task = (await services.tasks.list(project.id, { limit: 10, offset: 0 })).items[0]!;
    const other = await services.tasks.create(project.id, { title: 'Second task' }, ctx);
    const run = await services.runs.start(task.id, {}, ctx);
    expect(run).toMatchObject({ attempt: 1, state: 'queued', agent: 'claude_code' });
    expect(enqueued.at(-1)).toBe(run.id);
    expect((await services.tasks.get(task.id)).state).toBe('in_progress');

    const busy = await expectDomainError(
      services.runs.start(other.id, {}, ctx),
      ERROR_CODES.taskNotRunnable,
    );
    expect(busy.message).toMatch(/already running in this project/);
    await expectDomainError(services.runs.start(task.id, {}, ctx), ERROR_CODES.taskNotRunnable); // in_progress
  });

  it('runs the agent in its own worktree and branch, then hands the task to QA', async () => {
    const task = (await services.tasks.list(project.id, { limit: 10, offset: 0 })).items.find(
      (t) => t.state === 'in_progress',
    )!;
    const [run] = await services.runs.list(task.id);
    const executor = agent(
      'ok',
      writes('CONTRIBUTING.md', '# Contributing\n\nOpen a PR.\n') +
        done(
          'All set.\n## Summary\nAdded CONTRIBUTING.md.\n## Manual QA steps\n- Read CONTRIBUTING.md',
        ),
    );
    expect(await executor.execute(run!.id)).toBe('completed');

    const finished = await services.runs.get(run!.id);
    expect(finished).toMatchObject({
      state: 'completed',
      branch: `workbox/${task.number}-add-contributing-guide`,
      summary: 'Added CONTRIBUTING.md.',
      qaSteps: ['Read CONTRIBUTING.md'],
      changedFiles: [{ path: 'CONTRIBUTING.md', status: 'added' }],
      costUsd: 0.01,
      baseSha: initialSha,
    });
    expect((await services.runs.diff(run!.id)).diff).toContain('+Open a PR.');
    expect((await services.tasks.get(task.id)).state).toBe('ready_for_qa');
    const history = (await services.tasks.history(task.id)).map((h) => [h.toState, h.actor]);
    expect(history).toEqual([
      ['backlog', LOCAL_USER_ACTOR],
      ['in_progress', LOCAL_USER_ACTOR],
      ['verification', 'system:orchestrator'],
      ['ready_for_qa', 'system:orchestrator'],
    ]);

    const events = await services.runs.events(run!.id, 0, 100);
    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining(['stage', 'started', 'completed']),
    );
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));

    // Nothing was committed or pushed: the remote is unchanged and the work is only staged locally.
    // (async: the test git server runs in this process, so a synchronous git call would deadlock)
    const remote = await runGit(
      ['ls-remote', git.url('kost/app.git'), 'refs/heads/main', 'refs/heads/workbox/*'],
      {
        credentials: { username: 'x-access-token', token: new Secret(TOKEN) },
        allowHttp: true,
      },
    );
    expect(remote.stdout).toContain(initialSha);
    expect(remote.stdout).not.toContain('workbox/'); // no branch was pushed
    // Committed locally on the task branch, as the user with the account's no-reply email.
    const worktree = join(root, project.slug);
    expect(finished.worktreePath).toBe(worktree);
    expect(finished.commitSha).toMatch(/^[0-9a-f]{40}$/);
    const log = await runGit([
      '-C',
      worktree,
      'log',
      '-1',
      '--format=%an <%ae>%n%B',
      finished.commitSha!,
    ]);
    expect(log.stdout).toContain(`Konstantin Test <1000+kost@users.noreply.127.0.0.1>`);
    expect(log.stdout).toMatch(/^Add contributing guide$/m);
    expect(log.stdout).toContain('Generated-by: Workbox (Claude Code)');
    expect((await runGit(['-C', worktree, 'status', '--porcelain'])).stdout).toBe('');
    // After the run the copy is back on the up-to-date base branch; the work lives on the task branch.
    expect((await runGit(['-C', worktree, 'branch', '--show-current'])).stdout.trim()).toBe('main');
    expect(existsSync(join(worktree, 'CONTRIBUTING.md'))).toBe(false);
    expect(
      (await runGit(['-C', worktree, 'show', `${finished.branch}:CONTRIBUTING.md`])).stdout,
    ).toContain('Open a PR.');
    // The token never reaches the worktree, events or run row.
    expect(JSON.stringify(events) + JSON.stringify(finished)).not.toContain(TOKEN);
    expect(
      readdirSync(worktree)
        .map((f) =>
          statSync(join(worktree, f)).isFile() ? readFileSync(join(worktree, f), 'utf8') : '',
        )
        .join(),
    ).not.toContain(TOKEN);
  });
});

describe('failures', () => {
  const freshTask = async (title: string) => {
    const task = await services.tasks.create(project.id, { title }, ctx);
    return { task, run: await services.runs.start(task.id, {}, ctx) };
  };

  it('fails a run whose agent changed nothing, and blocks the task with the reason', async () => {
    const { task, run } = await freshTask('Do nothing');
    expect(await agent('noop', done('## Summary\nNothing to do.')).execute(run.id)).toBe('failed');
    expect((await services.runs.get(run.id)).exitReason).toMatch(/without changing any files/);
    const t = await services.tasks.get(task.id);
    expect(t.state).toBe('blocked');
    expect((await services.tasks.history(task.id)).at(-1)?.reason).toMatch(
      /Run #1 failed: The agent finished without changing any files/,
    );
  });

  it('records agent errors', async () => {
    const { task, run } = await freshTask('Agent errors');
    const ex = agent(
      'err',
      `out({type:'result',subtype:'error_during_execution',is_error:true,result:'model overloaded'});`,
    );
    expect(await ex.execute(run.id)).toBe('failed');
    expect((await services.runs.get(run.id)).exitReason).toMatch(/model overloaded/);
    expect((await services.tasks.get(task.id)).state).toBe('blocked');
  });

  it('times out a stuck agent', async () => {
    const { task, run } = await freshTask('Stuck agent');
    expect(await agent('stuck', `setInterval(()=>{},1000);`).execute(run.id)).toBe('timed_out');
    expect((await services.tasks.get(task.id)).state).toBe('blocked');
  });

  it('cancels a queued run immediately and a running one within moments', async () => {
    const queued = await freshTask('Cancel me early');
    expect(await services.runs.cancel(queued.run.id, ctx)).toMatchObject({
      state: 'cancelled',
      cancelRequested: true,
    });
    expect((await services.tasks.get(queued.task.id)).state).toBe('blocked');
    expect(await agent('never', done('x')).execute(queued.run.id)).toBe('cancelled'); // a late job does nothing

    const running = await freshTask('Cancel me later');
    const ex = agent('slow', `setInterval(()=>{},1000);`);
    const promise = ex.execute(running.run.id);
    await new Promise((r) => setTimeout(r, 800));
    await services.runs.cancel(running.run.id, ctx);
    expect(await promise).toBe('cancelled');
    await expectDomainError(services.runs.cancel(running.run.id, ctx), ERROR_CODES.runNotActive);
  });
});

describe('re-runs and recovery', () => {
  it('continues on the same branch and checkout with reviewer notes', async () => {
    const task = (await services.tasks.list(project.id, { q: 'Do nothing', limit: 5, offset: 0 }))
      .items[0]!;
    const second = await services.runs.start(task.id, { note: 'Add a CHANGELOG instead' }, ctx);
    expect(second.attempt).toBe(2);
    const ex = agent(
      'changelog',
      `if(!fs.readFileSync(0,'utf8')){}; ${writes('CHANGELOG.md', '# Changelog\n')}` +
        done('## Summary\nAdded a changelog.'),
    );
    expect(await ex.execute(second.id)).toBe('completed');
    const [latest, first] = await services.runs.list(task.id);
    expect(latest!.branch).toBe(`workbox/${task.number}-do-nothing`);
    expect(first!.attempt).toBe(1);
    expect(latest!.changedFiles).toEqual([{ path: 'CHANGELOG.md', status: 'added' }]);
  });

  it("switches the one working copy between task branches, keeping each task's work on its branch", async () => {
    const tasks = (await services.tasks.list(project.id, { limit: 50, offset: 0 })).items;
    const contributing = tasks.find((t) => t.title === 'Add contributing guide')!;
    const path = join(root, project.slug);
    // Every successful run returns the copy to main; each task's work lives on its own branch.
    expect((await runGit(['-C', path, 'branch', '--show-current'])).stdout.trim()).toBe('main');
    expect(existsSync(join(path, 'CONTRIBUTING.md'))).toBe(false);
    expect(existsSync(join(path, 'CHANGELOG.md'))).toBe(false);
    const changelogBranch = `workbox/${tasks.find((t) => t.title === 'Do nothing')!.number}-do-nothing`;
    expect(
      (await runGit(['-C', path, 'show', `${changelogBranch}:CHANGELOG.md`])).stdout,
    ).toContain('# Changelog');
    expect(
      (
        await runGit([
          '-C',
          path,
          'show',
          `workbox/${contributing.number}-add-contributing-guide:CONTRIBUTING.md`,
        ])
      ).stdout,
    ).toContain('Open a PR.');
  });

  it('refuses to start on a branch switch when someone left uncommitted changes in the working copy', async () => {
    const path = join(root, project.slug);
    writeFileSync(join(path, 'hand-edit.txt'), 'edited by hand');
    const task = await services.tasks.create(project.id, { title: 'Blocked by local edits' }, ctx);
    const run = await services.runs.start(task.id, {}, ctx);
    expect(await agent('unused', done('x')).execute(run.id)).toBe('failed');
    expect((await services.runs.get(run.id)).exitReason).toMatch(
      /uncommitted changes on main.*commit or discard them/,
    );
    expect(readFileSync(join(path, 'hand-edit.txt'), 'utf8')).toBe('edited by hand'); // never discarded
    rmSync(join(path, 'hand-edit.txt'));
  });

  it('fails runs orphaned by a worker restart and returns queued ones for re-enqueueing', async () => {
    const task = await services.tasks.create(project.id, { title: 'Orphaned' }, ctx);
    const run = await services.runs.start(task.id, {}, ctx);
    await handle.db.update(taskRuns).set({ state: 'running' }).where(eq(taskRuns.id, run.id));
    const ex = agent('recover', done('x'));
    const recovered = await ex.recover();
    expect(recovered.failed).toBe(1);
    expect((await services.runs.get(run.id)).exitReason).toMatch(/worker restarted/);
    expect((await services.tasks.get(task.id)).state).toBe('blocked');

    const queued = await services.runs.start(
      (await services.tasks.create(project.id, { title: 'Waiting' }, ctx)).id,
      {},
      ctx,
    );
    expect((await ex.recover()).queued).toContain(queued.id);
  });
});
