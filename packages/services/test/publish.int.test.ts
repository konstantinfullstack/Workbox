import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeCodeAdapter } from '#agents';
import { DomainError } from '#core';
import { createDatabase, type DatabaseHandle } from '#database';
import { runGit } from '#git';
import { createCodeHostRegistry } from '#integrations';
import { LOCAL_USER_ACTOR } from '#shared';
import { generateMasterKey, Keyring, Secret } from '#vault';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFakeGitHub, type FakeCodeHost } from '../../../test/fake-code-hosts.js';
import { startGitHttpServer, type GitHttpServer } from '../../../test/git-http-server.js';
import { createMigratedTestDatabase, type TestDatabase } from '../../../test/support.js';
import {
  createServices,
  Publisher,
  RunExecutor,
  WorkspaceSyncer,
  type Services,
} from '../src/index.js';

const ctx = { actor: LOCAL_USER_ACTOR };
const TOKEN = 'github_pat_11PUBPUBPUB0000publishIntegration_Gg66';
let testDb: TestDatabase;
let handle: DatabaseHandle;
let github: FakeCodeHost;
let git: GitHttpServer;
let root: string;
let scripts: string;
let services: Services;
let syncer: WorkspaceSyncer;
let publisher: Publisher;
let project: { id: string; slug: string };

function executor(name: string, body: string): RunExecutor {
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
    workerId: 'publish-test',
    timeoutMs: 10_000,
    cancelPollMs: 100,
    connections: services.connections,
    authorName: 'Konstantin Test',
    publisher,
  });
}
const done = (summary: string) =>
  `out({type:'result',subtype:'success',is_error:false,num_turns:1,total_cost_usd:0.01,result:${JSON.stringify(`## Summary\n${summary}\n## Manual QA steps\n- Look at it`)}});`;
const write = (file: string, content: string) =>
  `fs.writeFileSync(${JSON.stringify(file)}, ${JSON.stringify(content)});`;
const remoteBranches = async () =>
  (
    await runGit(['ls-remote', '--heads', git.url('kost/app.git')], {
      credentials: { username: 'x-access-token', token: new Secret(TOKEN) },
      allowHttp: true,
    })
  ).stdout;

beforeAll(async () => {
  testDb = await createMigratedTestDatabase();
  handle = createDatabase({ connectionString: testDb.url });
  [github, git] = await Promise.all([startFakeGitHub(), startGitHttpServer()]);
  git.accounts.set('x-access-token', TOKEN);
  git.createRepo('kost/app.git');
  github.tokens.set(TOKEN, {
    account: 'kost',
    accountId: 4242,
    repos: [
      {
        id: 801,
        fullPath: 'kost/app',
        cloneUrl: git.url('kost/app.git'),
        files: {
          'package.json': JSON.stringify({ scripts: { test: 'node test.js' } }),
          'package-lock.json': '{}',
        },
      },
    ],
  });
  root = mkdtempSync(join(tmpdir(), 'workbox-pub-ws-'));
  scripts = mkdtempSync(join(tmpdir(), 'workbox-pub-agents-'));
  const codeHosts = createCodeHostRegistry({ timeoutMs: 3_000 });
  services = createServices({
    db: handle.db,
    keyring: Keyring.fromConfig({ currentKey: generateMasterKey() }),
    codeHosts,
    workerGateway: {
      probeAgentRuntime: () => Promise.reject(new Error('unused')),
      enqueueWorkspaceSync: async () => undefined,
      enqueueRun: async () => undefined,
      enqueuePublish: async () => undefined,
    },
  });
  syncer = new WorkspaceSyncer({
    db: handle.db,
    connections: services.connections,
    root,
    workerId: 'publish-test',
  });
  publisher = new Publisher(handle.db, codeHosts, services.connections);
  project = await services.projects.create({ name: 'Publish' }, ctx);
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
});

afterAll(async () => {
  await Promise.all([github.close(), git.close()]);
  rmSync(root, { recursive: true, force: true });
  rmSync(scripts, { recursive: true, force: true });
  await handle.close();
  await testDb.drop();
});

describe('checks configuration', () => {
  it('proposes commands from repository files and requires confirmation before runs', async () => {
    expect(await services.checks.detect(project.slug, ctx)).toEqual({
      setup: 'npm ci',
      commands: [{ name: 'test', command: 'npm test' }],
      detectedFrom: ['package.json', 'package-lock.json'],
      notes: [],
    });
    const task = await services.tasks.create(project.id, { title: 'Needs checks' }, ctx);
    expect(await services.runs.readiness(task.id)).toEqual([
      expect.stringMatching(/Confirm the project's check commands/),
    ]);
    // Confirm simple shell checks for the test repo (the real proposal would be npm).
    const confirmed = await services.checks.confirm(
      project.slug,
      {
        setup: null,
        commands: [{ name: 'status', command: 'grep -qx pass STATUS' }],
        detectedFrom: [],
      },
      ctx,
    );
    expect(confirmed).toMatchObject({ confirmed: true, commands: [{ name: 'status' }] });
    expect(await services.runs.readiness(task.id)).toEqual([]);
    await expect(
      services.checks.confirm(
        project.slug,
        {
          setup: null,
          commands: [
            { name: 'a', command: 'x' },
            { name: 'a', command: 'y' },
          ],
          detectedFrom: [],
        },
        ctx,
      ),
    ).rejects.toThrow(/unique/);
  });
});

describe('a run that passes its checks', () => {
  it('commits, pushes the branch and opens a draft pull request; re-runs update the same PR', async () => {
    const task = (await services.tasks.list(project.id, { q: 'Needs checks', limit: 5, offset: 0 }))
      .items[0]!;
    const run = await services.runs.start(task.id, {}, ctx);
    expect(
      await executor('ok', write('STATUS', 'pass\n') + done('Wrote STATUS.')).execute(run.id),
    ).toBe('completed');

    const finished = await services.runs.get(run.id);
    expect(finished).toMatchObject({
      verification: 'passed',
      checkResults: [{ name: 'status', status: 'passed', exitCode: 0 }],
    });
    const branch = `workbox/${task.number}-needs-checks`;
    expect(await remoteBranches()).toContain(`refs/heads/${branch}`);
    expect(github.reviewRequests).toHaveLength(1);
    expect(github.reviewRequests[0]).toMatchObject({
      head: branch,
      base: 'main',
      title: 'Needs checks',
      draft: true,
      state: 'open',
    });
    expect(github.reviewRequests[0]!.body).toContain('Wrote STATUS.');
    expect(github.reviewRequests[0]!.body).toContain('✅ `grep -qx pass STATUS`');

    const info = await services.git.get(task.id, ctx);
    expect(info).toMatchObject({
      branch,
      localCommitSha: finished.commitSha,
      reference: {
        pushedSha: finished.commitSha,
        reviewNumber: 1,
        reviewState: 'draft',
        lastError: null,
      },
    });
    const t = await services.tasks.get(task.id);
    expect(t.state).toBe('ready_for_qa');
    expect((await services.tasks.history(task.id)).at(-1)?.reason).toContain(
      info.reference!.reviewUrl!,
    );
    expect((await services.repositories.get(project.slug))?.access.reviewRequests).toBe('verified');

    // Request changes → re-run → new commit on the same branch, same PR updated (not a second one).
    await services.tasks.transition(
      task.id,
      { to: 'changes_requested', reason: 'Add docs too' },
      ctx,
    );
    const rerun = await services.runs.start(task.id, { note: 'Add docs too' }, ctx);
    expect(
      await executor('ok2', write('DOCS.md', '# Docs\n') + done('Added docs.')).execute(rerun.id),
    ).toBe('completed');
    expect(github.reviewRequests).toHaveLength(1);
    expect(github.reviewRequests[0]!.body).toContain('Added docs.');
    expect((await services.git.get(task.id, ctx)).reference?.pushedSha).toBe(
      (await services.runs.get(rerun.id)).commitSha,
    );
  });
});

describe('failing checks', () => {
  it('gives the agent one retry with the failure output', async () => {
    const task = await services.tasks.create(project.id, { title: 'Fix on retry' }, ctx);
    const run = await services.runs.start(task.id, {}, ctx);
    const counter = join(scripts, 'retry-counter');
    writeFileSync(counter, '0');
    // First pass writes a failing STATUS; the retry (which receives the failure output) fixes it.
    const ex = executor(
      'retry',
      `const n=Number(fs.readFileSync(${JSON.stringify(counter)},'utf8'))+1;fs.writeFileSync(${JSON.stringify(counter)},String(n));` +
        `fs.writeFileSync('STATUS', n===1?'fail\\n':'pass\\n');` +
        done('Fixed after retry.'),
    );
    expect(await ex.execute(run.id)).toBe('completed');
    expect((await services.runs.get(run.id)).verification).toBe('passed');
    const events = (await services.runs.events(run.id, 0, 200)).map((e) => e.message);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/Checks failed: asking the agent to fix them/),
        'Running checks again',
      ]),
    );
  });

  it('never publishes when checks still fail, but keeps the work committed locally', async () => {
    const task = await services.tasks.create(project.id, { title: 'Always broken' }, ctx);
    const run = await services.runs.start(task.id, {}, ctx);
    const before = github.reviewRequests.length;
    expect(
      await executor('broken', write('STATUS', 'fail\n') + done('Tried.')).execute(run.id),
    ).toBe('failed');
    const finished = await services.runs.get(run.id);
    expect(finished).toMatchObject({
      verification: 'failed',
      exitReason: expect.stringMatching(/Checks failed after one retry: status.*committed locally/),
    });
    expect(finished.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(github.reviewRequests).toHaveLength(before);
    expect(await remoteBranches()).not.toContain(`workbox/${task.number}-always-broken`);
    expect((await services.tasks.get(task.id)).state).toBe('blocked');
  });
});

describe('publishing problems and manual publish', () => {
  it('records a token without PR permission, then publishes manually once fixed', async () => {
    const repo = github.tokens.get(TOKEN)!.repos[0]!;
    repo.denyReviewRequests = true;
    const task = await services.tasks.create(project.id, { title: 'No PR permission' }, ctx);
    const run = await services.runs.start(task.id, {}, ctx);
    expect(await executor('noperm', write('STATUS', 'pass\n') + done('ok')).execute(run.id)).toBe(
      'completed',
    );
    const info = await services.git.get(task.id, ctx);
    expect(info.reference).toMatchObject({
      reviewNumber: null,
      lastError: expect.stringMatching(/Pull requests: write/),
    });
    expect((await services.repositories.get(project.slug))?.access.reviewRequests).toBe('denied');
    expect((await services.tasks.history(task.id)).at(-1)?.reason).toMatch(/publishing failed/);

    repo.denyReviewRequests = false;
    const result = await publisher.publish(task.id);
    expect(result).toMatchObject({
      opened: true,
      reference: { lastError: null, reviewState: 'draft' },
    });
    await expect(services.git.requestPublish(task.id, ctx)).resolves.toBeUndefined();
  });

  it('refuses to publish a task without commits', async () => {
    const task = await services.tasks.create(project.id, { title: 'Nothing yet' }, ctx);
    await expect(services.git.requestPublish(task.id, ctx)).rejects.toBeInstanceOf(DomainError);
  });

  it('picks up commits pushed to the task branch on the server before the next run', async () => {
    const task = (await services.tasks.list(project.id, { q: 'Needs checks', limit: 5, offset: 0 }))
      .items[0]!;
    const branch = `workbox/${task.number}-needs-checks`;
    const humanSha = git.commit('kost/app.git', 'reviewer fix', branch); // someone pushed to the PR branch
    await services.tasks.transition(task.id, { to: 'changes_requested', reason: 'one more' }, ctx);
    const run = await services.runs.start(task.id, {}, ctx);
    expect(
      await executor('after-human', write('MORE.md', 'more\n') + done('More.')).execute(run.id),
    ).toBe('completed');
    const log = (await runGit(['-C', join(root, project.slug), 'log', '--format=%H', '-3', branch]))
      .stdout;
    expect(log).toContain(humanSha); // fast-forwarded, not overwritten
    expect(await remoteBranches()).toContain(`refs/heads/${branch}`);
  });

  it("uses the project's base branch (e.g. develop): branch from it, PR into it, copy returns to it", async () => {
    const developSha = git.commit('kost/app.git', 'develop work', 'develop');
    await services.projects.update(project.slug, { defaultBranch: 'develop' }, ctx);
    try {
      const task = await services.tasks.create(project.id, { title: 'On develop' }, ctx);
      const run = await services.runs.start(task.id, {}, ctx);
      expect(
        await executor('develop', write('STATUS', 'pass\n') + done('On develop.')).execute(run.id),
      ).toBe('completed');
      const finished = await services.runs.get(run.id);
      expect(finished.baseSha).toBe(developSha);
      expect(github.reviewRequests.at(-1)).toMatchObject({
        head: `workbox/${task.number}-on-develop`,
        base: 'develop',
      });
      const path = join(root, project.slug);
      expect((await runGit(['-C', path, 'branch', '--show-current'])).stdout.trim()).toBe(
        'develop',
      );
      const events = (await services.runs.events(run.id, 0, 200)).map((e) => e.message);
      expect(events).toContain('Switched the working copy back to develop (up to date)');
    } finally {
      await services.projects.update(project.slug, { defaultBranch: 'main' }, ctx);
    }
  });

  it('refreshes the PR state from the host when viewed', async () => {
    const task = (await services.tasks.list(project.id, { q: 'Needs checks', limit: 5, offset: 0 }))
      .items[0]!;
    github.reviewRequests[0]!.state = 'merged';
    // Force staleness.
    await handle.pool.query(
      "UPDATE git_references SET last_synced_at = now() - interval '5 minutes'",
    );
    expect((await services.git.get(task.id, ctx)).reference?.reviewState).toBe('merged');
  });
});
