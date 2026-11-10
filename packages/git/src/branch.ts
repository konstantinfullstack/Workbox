import type { ChangedFile } from '#shared';
import { GitError, runGit, type GitCredentials } from './run.js';
import { hasUncommittedChanges } from './workspace.js';

/** `workbox/12-add-health-endpoint`: always under workbox/, never the default branch. */
export function taskBranchName(taskNumber: number, title: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return `workbox/${taskNumber}${slug ? `-${slug}` : ''}`;
}

export async function currentBranch(path: string): Promise<string | null> {
  const { stdout } = await runGit(['-C', path, 'branch', '--show-current']);
  return stdout.trim() || null;
}

/**
 * Switches the project's working copy to the task's branch: created from `origin/<default>` on
 * the first run, reused afterwards (continuing after a block or review).
 *
 * Refuses when there are uncommitted changes that belong to a different branch: Workbox never
 * carries one task's work into another, and never discards work it didn't commit.
 */
export async function checkoutTaskBranch(options: {
  path: string;
  branch: string;
  defaultBranch: string;
}): Promise<{ created: boolean }> {
  const { path, branch } = options;
  if (!branch.startsWith('workbox/'))
    throw new GitError('failed', 'task branches must be under workbox/');
  const current = await currentBranch(path);
  if (current === branch) return { created: false };
  if (await hasUncommittedChanges(path)) {
    throw new GitError(
      'failed',
      `the workspace has uncommitted changes on ${current ?? 'a detached HEAD'}; commit or discard them in ${path} first`,
    );
  }
  const exists = await runGit([
    '-C',
    path,
    'show-ref',
    '--verify',
    '--quiet',
    `refs/heads/${branch}`,
  ]).then(
    () => true,
    () => false,
  );
  if (exists) {
    await runGit(['-C', path, 'checkout', '--quiet', branch]);
    await fastForwardFromRemote(path, branch);
    return { created: false };
  }
  // A branch published earlier (e.g. from another machine) continues from the remote copy.
  const remote = await remoteBranchSha(path, branch);
  await runGit([
    '-C',
    path,
    'checkout',
    '--quiet',
    '--no-track',
    '-b',
    branch,
    remote ? `refs/remotes/origin/${branch}` : `refs/remotes/origin/${options.defaultBranch}`,
  ]);
  return { created: true };
}

/**
 * If someone pushed to the task branch on the server (e.g. a fix on the PR), bring it in before
 * the agent starts: fast-forward only. Diverged histories are never merged or overwritten
 * automatically.
 */
async function fastForwardFromRemote(path: string, branch: string): Promise<void> {
  const remote = await remoteBranchSha(path, branch);
  if (!remote) return;
  try {
    await runGit(['-C', path, 'merge', '--ff-only', '--quiet', `refs/remotes/origin/${branch}`]);
  } catch {
    throw new GitError(
      'rejected',
      `${branch} has different commits locally and on the server; reconcile them in ${path} (or on the pull request) first`,
    );
  }
}

async function remoteBranchSha(path: string, branch: string): Promise<string | null> {
  try {
    const { stdout } = await runGit([
      '-C',
      path,
      'rev-parse',
      '--verify',
      '--quiet',
      `refs/remotes/origin/${branch}^{commit}`,
    ]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** Commits on `branch` that are not on origin/<default> (what a PR would contain). */
export async function commitsAhead(
  path: string,
  branch: string,
  defaultBranch: string,
): Promise<number> {
  const { stdout } = await runGit([
    '-C',
    path,
    'rev-list',
    '--count',
    `refs/remotes/origin/${defaultBranch}..refs/heads/${branch}`,
  ]);
  return Number(stdout.trim());
}

/**
 * Pushes the task branch to origin with the account token (supplied per command, never stored).
 * Never force-pushes, never pushes anything but workbox/ branches.
 */
export async function pushTaskBranch(options: {
  path: string;
  branch: string;
  credentials: GitCredentials;
  allowHttp?: boolean;
}): Promise<string> {
  if (!options.branch.startsWith('workbox/'))
    throw new GitError('failed', 'Workbox only pushes workbox/ branches');
  const ref = `refs/heads/${options.branch}`;
  await runGit(['-C', options.path, 'push', '--quiet', '--no-verify', 'origin', `${ref}:${ref}`], {
    credentials: options.credentials,
    ...(options.allowHttp ? { allowHttp: true } : {}),
  });
  // Record the remote ref locally too, so later fast-forward checks see what was pushed.
  const { stdout } = await runGit(['-C', options.path, 'rev-parse', ref]);
  const sha = stdout.trim();
  await runGit(['-C', options.path, 'update-ref', `refs/remotes/origin/${options.branch}`, sha]);
  return sha;
}

export interface BranchChanges {
  files: ChangedFile[];
  diff: string;
  truncated: boolean;
  /** merge-base with origin/<default>: what a pull request will be compared against. */
  baseSha: string;
}

/**
 * The branch's full change set versus the default branch (committed and uncommitted), i.e. what
 * the pull request will show. Stages everything (Workbox owns this working copy).
 */
export async function collectBranchChanges(
  path: string,
  defaultBranch: string,
  maxDiffBytes = 500_000,
): Promise<BranchChanges> {
  await runGit(['-C', path, 'add', '--all']);
  const { stdout: base } = await runGit([
    '-C',
    path,
    'merge-base',
    'HEAD',
    `refs/remotes/origin/${defaultBranch}`,
  ]);
  const baseSha = base.trim();
  const { stdout: status } = await runGit([
    '-C',
    path,
    'diff',
    '--cached',
    '--name-status',
    '-M',
    '-z',
    baseSha,
  ]);
  const parts = status.split('\0').filter(Boolean);
  const files: ChangedFile[] = [];
  for (let i = 0; i < parts.length;) {
    const code = parts[i++]!;
    if (code.startsWith('R')) {
      i++; // old path
      files.push({ path: parts[i++]!, status: 'renamed' });
    } else {
      const map: Record<string, ChangedFile['status']> = {
        A: 'added',
        D: 'deleted',
        M: 'modified',
      };
      files.push({ path: parts[i++]!, status: map[code[0]!] ?? 'modified' });
    }
  }
  const { stdout: diff } = await runGit([
    '-C',
    path,
    'diff',
    '--cached',
    '-M',
    '--no-color',
    baseSha,
  ]);
  const truncated = Buffer.byteLength(diff) > maxDiffBytes;
  return {
    files,
    diff: truncated ? Buffer.from(diff).subarray(0, maxDiffBytes).toString('utf8') : diff,
    truncated,
    baseSha,
  };
}

export interface CommitAuthor {
  name: string;
  email: string;
}

/**
 * Commits all staged changes on the current task branch. Author and committer are the user
 * (U7); the message carries Workbox trailers. Signing and hooks are off (isolated git config).
 * Returns the new commit, or null when there was nothing to commit.
 */
export async function commitTaskChanges(options: {
  path: string;
  author: CommitAuthor;
  message: string;
}): Promise<string | null> {
  const branch = await currentBranch(options.path);
  if (!branch?.startsWith('workbox/')) {
    throw new GitError(
      'failed',
      `refusing to commit on ${branch ?? 'a detached HEAD'}: Workbox only commits on workbox/ branches`,
    );
  }
  await runGit(['-C', options.path, 'add', '--all']);
  const { stdout: staged } = await runGit(['-C', options.path, 'diff', '--cached', '--name-only']);
  if (!staged.trim()) return null;
  const identity = [
    '-c',
    `user.name=${options.author.name}`,
    '-c',
    `user.email=${options.author.email}`,
    '-c',
    'commit.gpgsign=false',
  ];
  await runGit(['-C', options.path, ...identity, 'commit', '--quiet', '--no-verify', '-F', '-'], {
    input: options.message,
  });
  const { stdout } = await runGit(['-C', options.path, 'rev-parse', 'HEAD']);
  return stdout.trim();
}
