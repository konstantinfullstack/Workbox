import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Secret } from '#vault';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startGitHttpServer, type GitHttpServer } from '../../../test/git-http-server.js';
import {
  assertWorkspacesRoot,
  checkoutTaskBranch,
  collectBranchChanges,
  commitTaskChanges,
  currentBranch,
  GitError,
  hasUncommittedChanges,
  pushTaskBranch,
  removeWorkspace,
  returnToBaseBranch,
  runGit,
  syncRepository,
  taskBranchName,
  workspacePath,
} from '../src/index.js';

const TOKEN = 'github_pat_11GITGITGIT0000workspaceTestToken_Tt42';
const identity = { provider: 'github', host: 'github.com', externalId: '101' };
let server: GitHttpServer;
let root: string;
let firstSha: string;

beforeAll(async () => {
  server = await startGitHttpServer();
  server.accounts.set('x-access-token', TOKEN);
  firstSha = server.createRepo('kost/app.git');
  server.createRepo('kost/other.git');
});
afterAll(() => server.close());
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'workbox-ws-'));
});

const credentials = (token = TOKEN) => ({ username: 'x-access-token', token: new Secret(token) });
const sync = (path: string, overrides: Partial<Parameters<typeof syncRepository>[0]> = {}) =>
  syncRepository({
    path,
    cloneUrl: server.url('kost/app.git'),
    defaultBranch: 'main',
    identity,
    credentials: credentials(),
    timeoutMs: 30_000,
    ...overrides,
  });

function allFileContents(dir: string): string {
  let out = '';
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    out += entry.isDirectory() ? allFileContents(full) : readFileSync(full).toString('latin1');
  }
  return out;
}

describe('syncRepository (one normal working copy per project)', () => {
  it('clones a normal working copy on the default branch, never storing the token', async () => {
    const path = workspacePath(root, 'demo');
    expect(path).toBe(join(root, 'demo'));
    const result = await sync(path);
    expect(result).toMatchObject({ action: 'cloned', headSha: firstSha });
    expect(await currentBranch(path)).toBe('main');
    expect(readdirSync(path).some((f) => f.endsWith('.txt'))).toBe(true); // real files, like your own clone
    expect(server.authHeaders).toContain(
      `Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString('base64')}`,
    );

    const config = readFileSync(join(path, '.git', 'config'), 'utf8');
    expect(config).toContain(`url = ${server.url('kost/app.git')}`);
    expect(config).not.toMatch(/x-access-token|@127\.0\.0\.1/);
    expect(allFileContents(path)).not.toContain(TOKEN);
    // Workbox metadata lives inside .git, never in the working tree.
    expect(JSON.parse(readFileSync(join(path, '.git', 'workbox.json'), 'utf8'))).toEqual(identity);
    expect(await hasUncommittedChanges(path)).toBe(false);
  });

  it('fetches new commits without touching the checked-out branch or uncommitted work', async () => {
    const path = workspacePath(root, 'demo');
    await sync(path);
    await checkoutTaskBranch({ path, branch: 'workbox/1-x', baseBranch: 'main' });
    writeFileSync(join(path, 'work-in-progress.md'), 'unsaved');
    const next = server.commit('kost/app.git', 'second commit');
    expect(await sync(path)).toMatchObject({ action: 'fetched', headSha: next });
    expect(await currentBranch(path)).toBe('workbox/1-x');
    expect(readFileSync(join(path, 'work-in-progress.md'), 'utf8')).toBe('unsaved');
    firstSha = next;
  });

  it('re-clones a clean workspace when a different repository is linked', async () => {
    const path = workspacePath(root, 'demo');
    await sync(path);
    const result = await sync(path, {
      cloneUrl: server.url('kost/other.git'),
      identity: { ...identity, externalId: '202' },
    });
    expect(result.action).toBe('recloned');
    expect(readFileSync(join(path, '.git', 'config'), 'utf8')).toContain('kost/other.git');
  });

  it('refuses to replace a workspace with uncommitted changes, or a folder it does not own', async () => {
    const path = workspacePath(root, 'demo');
    await sync(path);
    writeFileSync(join(path, 'precious.txt'), 'do not lose me');
    await expect(
      sync(path, {
        cloneUrl: server.url('kost/other.git'),
        identity: { ...identity, externalId: '202' },
      }),
    ).rejects.toThrow(/uncommitted changes/);
    expect(readFileSync(join(path, 'precious.txt'), 'utf8')).toBe('do not lose me');

    const foreign = workspacePath(root, 'foreign');
    mkdirSync(foreign);
    writeFileSync(join(foreign, 'mine.txt'), 'user data');
    await expect(sync(foreign)).rejects.toThrow(/not a Workbox workspace/);
    expect(existsSync(join(foreign, 'mine.txt'))).toBe(true);
  });

  it('only updates the remote URL when the same repository was renamed', async () => {
    const path = workspacePath(root, 'demo');
    await sync(path);
    const result = await sync(path, { cloneUrl: server.url('kost/other.git') }); // same identity, new URL
    expect(result.action).toBe('fetched');
    expect(readFileSync(join(path, '.git', 'config'), 'utf8')).toContain('kost/other.git');
  });

  it('fails fast with "authentication failed" for a wrong token, leaving nothing behind', async () => {
    const path = workspacePath(root, 'demo');
    const error = await sync(path, {
      credentials: credentials('github_pat_wrong_000000000000000000'),
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitError);
    expect((error as GitError).kind).toBe('auth');
    expect((error as GitError).message).not.toContain('github_pat_wrong');
    expect(existsSync(path)).toBe(false);
    expect(readdirSync(root)).toEqual([]); // no half-written staging directory
  });

  it('reports a missing repository and refuses URLs with embedded credentials', async () => {
    const error = await sync(workspacePath(root, 'demo'), {
      cloneUrl: server.url('kost/missing.git'),
    }).catch((e: unknown) => e);
    expect((error as GitError).kind).toBe('not_found');
    await expect(
      sync(workspacePath(root, 'demo'), {
        cloneUrl: server.url('kost/app.git').replace('http://', 'http://user:pw@'),
      }),
    ).rejects.toThrow(/must not contain credentials/);
  });
});

describe('task branches and commits', () => {
  const author = { name: 'Konstantin Test', email: '1000+kost@users.noreply.github.com' };

  it('creates the task branch from origin/<default>, reuses it later, and commits as the user', async () => {
    const path = workspacePath(root, 'demo');
    await sync(path);
    expect(
      await checkoutTaskBranch({ path, branch: 'workbox/2-add-docs', baseBranch: 'main' }),
    ).toEqual({ created: true });
    writeFileSync(join(path, 'CONTRIBUTING.md'), '# Contributing\n');
    const changes = await collectBranchChanges(path, 'main');
    expect(changes.files).toEqual([{ path: 'CONTRIBUTING.md', status: 'added' }]);
    expect(changes.baseSha).toBe(firstSha);
    expect(changes.diff).toContain('+# Contributing');

    const sha = await commitTaskChanges({
      path,
      author,
      message: 'Add docs\n\nGenerated-by: Workbox (Claude Code)\n',
    });
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    const log = (await runGit(['-C', path, 'log', '-1', '--format=%an <%ae>|%cn <%ce>|%B'])).stdout;
    expect(log).toContain(
      'Konstantin Test <1000+kost@users.noreply.github.com>|Konstantin Test <1000+kost@users.noreply.github.com>|Add docs',
    );
    expect(log).toContain('Generated-by: Workbox (Claude Code)');
    expect(await hasUncommittedChanges(path)).toBe(false);
    expect(await commitTaskChanges({ path, author, message: 'nothing' })).toBeNull(); // nothing to commit

    // Switch to another task and back: work is kept on its own branch.
    expect(
      await checkoutTaskBranch({ path, branch: 'workbox/3-other', baseBranch: 'main' }),
    ).toEqual({ created: true });
    expect(existsSync(join(path, 'CONTRIBUTING.md'))).toBe(false);
    expect(
      await checkoutTaskBranch({ path, branch: 'workbox/2-add-docs', baseBranch: 'main' }),
    ).toEqual({ created: false });
    expect(existsSync(join(path, 'CONTRIBUTING.md'))).toBe(true);
    // Later changes on the branch still compare against the default branch (the PR view).
    writeFileSync(join(path, 'CHANGELOG.md'), '# Changes\n');
    expect((await collectBranchChanges(path, 'main')).files.map((f) => f.path).sort()).toEqual([
      'CHANGELOG.md',
      'CONTRIBUTING.md',
    ]);
  });

  it("refuses to switch while another task's changes are uncommitted, and never commits on the default branch", async () => {
    const path = workspacePath(root, 'demo');
    await sync(path);
    writeFileSync(join(path, 'stray.txt'), 'x');
    await expect(
      checkoutTaskBranch({ path, branch: 'workbox/4-x', baseBranch: 'main' }),
    ).rejects.toThrow(/uncommitted changes on main/);
    await expect(commitTaskChanges({ path, author, message: 'nope' })).rejects.toThrow(
      /only commits on workbox\/ branches/,
    );
    await expect(
      checkoutTaskBranch({ path, branch: 'feature/x', baseBranch: 'main' }),
    ).rejects.toThrow(/under workbox\//);
  });

  it('names task branches safely', () => {
    expect(taskBranchName(12, 'Add /health endpoint & tests!')).toBe(
      'workbox/12-add-health-endpoint-tests',
    );
    expect(taskBranchName(3, '!!!')).toBe('workbox/3');
    expect(taskBranchName(7, 'Ünïcödé títle')).toBe('workbox/7-unicode-title');
  });
});

describe('git isolation', () => {
  it("ignores the user's git config (insteadOf rewrites, credential helpers) and stores no credentials", async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'workbox-fakehome-'));
    writeFileSync(
      join(fakeHome, '.gitconfig'),
      `[url "http://127.0.0.1:1/"]\n  insteadOf = ${server.url('')}\n[credential]\n  helper = store\n`,
    );
    const originalHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      expect((await sync(workspacePath(root, 'demo'))).action).toBe('cloned');
      expect(existsSync(join(fakeHome, '.git-credentials'))).toBe(false);
    } finally {
      process.env.HOME = originalHome;
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it('allows only https remotes (plus http for loopback tests)', async () => {
    expect(await runGit(['ls-remote', 'file:///etc']).catch((e: unknown) => e)).toBeInstanceOf(
      GitError,
    );
  });
});

describe('workspace paths', () => {
  it('builds <root>/<slug> and rejects unsafe slugs', () => {
    expect(workspacePath('/w', 'my-app')).toBe('/w/my-app');
    for (const slug of ['../etc', 'a/b', '', 'UPPER', '.hidden'])
      expect(() => workspacePath('/w', slug)).toThrow(/invalid project slug/);
    expect(() => workspacePath('relative', 'x')).toThrow(/absolute/);
  });

  it('removes only its own workspaces inside the root', async () => {
    const path = workspacePath(root, 'demo');
    await sync(path);
    expect(await removeWorkspace(root, 'demo')).toBe(true);
    expect(existsSync(path)).toBe(false);
    expect(await removeWorkspace(root, 'demo')).toBe(false);
    mkdirSync(join(root, 'notmine'));
    writeFileSync(join(root, 'notmine', 'x'), 'x');
    await expect(removeWorkspace(root, 'notmine')).rejects.toThrow(/not a Workbox workspace/);
    await expect(removeWorkspace(root, '../outside')).rejects.toThrow(/invalid project slug/);
  });

  it('accepts roots outside the repo and git-ignored roots inside it, rejects others', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'workbox-fakerepo-'));
    execFileSync('git', ['init', '--quiet', repo]);
    writeFileSync(join(repo, '.gitignore'), 'workspaces/\n');
    await expect(assertWorkspacesRoot(join(tmpdir(), 'elsewhere'), repo)).resolves.toBeUndefined();
    await expect(assertWorkspacesRoot(join(repo, 'workspaces'), repo)).resolves.toBeUndefined();
    await expect(assertWorkspacesRoot(join(repo, 'clones'), repo)).rejects.toThrow(
      /not git-ignored/,
    );
    await expect(assertWorkspacesRoot(repo, repo)).rejects.toThrow(
      /must not be the Workbox repository/,
    );
    expect(statSync(repo).isDirectory()).toBe(true);
    rmSync(repo, { recursive: true, force: true });
  });
});

describe('base branch handling', () => {
  it('starts every new task from the latest base branch and returns there afterwards', async () => {
    const path = workspacePath(root, 'demo');
    await sync(path);
    // Task A on the current main.
    await checkoutTaskBranch({ path, branch: 'workbox/10-a', baseBranch: 'main' });
    writeFileSync(join(path, 'a.md'), 'a');
    await commitTaskChanges({ path, author: { name: 'T', email: 't@example.com' }, message: 'a' });
    expect(await returnToBaseBranch(path, 'main')).toBe(true);
    expect(await currentBranch(path)).toBe('main');

    // Someone merges to main on the server; the next task must start from it.
    const newMain = server.commit('kost/app.git', 'merged elsewhere');
    await sync(path);
    await checkoutTaskBranch({ path, branch: 'workbox/11-b', baseBranch: 'main' });
    expect((await runGit(['-C', path, 'rev-parse', 'HEAD'])).stdout.trim()).toBe(newMain);
    expect((await runGit(['-C', path, 'rev-parse', 'main'])).stdout.trim()).toBe(newMain); // local main fast-forwarded
    firstSha = newMain;
  });

  it('uses another base branch (e.g. dev) and refuses a base that does not exist', async () => {
    const devSha = server.commit('kost/app.git', 'dev work', 'dev');
    const path = workspacePath(root, 'demo');
    await sync(path);
    await checkoutTaskBranch({ path, branch: 'workbox/12-on-dev', baseBranch: 'dev' });
    expect((await runGit(['-C', path, 'rev-parse', 'HEAD'])).stdout.trim()).toBe(devSha);
    expect((await collectBranchChanges(path, 'dev')).baseSha).toBe(devSha);
    await expect(
      checkoutTaskBranch({ path, branch: 'workbox/13-x', baseBranch: 'nope' }),
    ).rejects.toThrow(/base branch "nope" doesn't exist/);
  });

  it('fast-forwards commits pushed to the task branch on the server even when already on it', async () => {
    const path = workspacePath(root, 'demo');
    await sync(path);
    await checkoutTaskBranch({ path, branch: 'workbox/14-shared', baseBranch: 'main' });
    writeFileSync(join(path, 'mine.md'), 'mine');
    await commitTaskChanges({
      path,
      author: { name: 'T', email: 't@example.com' },
      message: 'mine',
    });
    await pushTaskBranch({
      path,
      branch: 'workbox/14-shared',
      credentials: credentials(),
      allowHttp: true,
    });
    const fix = server.commit('kost/app.git', 'reviewer fix', 'workbox/14-shared');
    await sync(path);
    await checkoutTaskBranch({ path, branch: 'workbox/14-shared', baseBranch: 'main' }); // already current
    expect((await runGit(['-C', path, 'rev-parse', 'HEAD'])).stdout.trim()).toBe(fix);
  });
});

describe('runGit robustness', () => {
  it('does not crash when git exits before reading its stdin (EPIPE)', async () => {
    // `git --version` never reads stdin; a large input makes the write race the exit.
    const big = 'x'.repeat(8 * 1024 * 1024);
    for (let i = 0; i < 5; i++) {
      await expect(runGit(['--version'], { input: big })).resolves.toMatchObject({
        stdout: expect.stringMatching(/^git version/),
      });
    }
  });
});
