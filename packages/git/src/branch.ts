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
 * Switches the project's working copy to the task's branch.
 *
 * - **New task:** check out the project's base branch (e.g. main or dev), fast-forward it to the
 *   server, then create `workbox/<n>-…` from it. Every task starts from the latest base.
 * - **Existing task** (re-run after a block or review): switch to its branch and fast-forward any
 *   commits pushed to it on the server.
 *
 * Refuses when there are uncommitted changes that belong to a different branch: Workbox never
 * carries one task's work into another, and never discards work it didn't commit.
 */
export async function checkoutTaskBranch(options: {
  path: string;
  branch: string;
  baseBranch: string;
}): Promise<{ created: boolean }> {
  const { path, branch } = options;
  if (!branch.startsWith('workbox/')) {
    throw new GitError('failed', 'task branches must be under workbox/');
  }
  const current = await currentBranch(path);
  const dirty = await hasUncommittedChanges(path);
  if (current === branch) {
    if (!dirty) await fastForwardFromRemote(path, branch);
    return { created: false };
  }
  if (dirty) {
    throw new GitError(
      'failed',
      `the workspace has uncommitted changes on ${current ?? 'a detached HEAD'}; commit or discard them in ${path} first`,
    );
  }
  if (await localBranchExists(path, branch)) {
    await runGit(['-C', path, 'checkout', '--quiet', branch]);
    await fastForwardFromRemote(path, branch);
    return { created: false };
  }
  // Published earlier (e.g. from another machine) but not here: continue from the remote copy.
  if (await remoteBranchSha(path, branch)) {
    await runGit([
      '-C',
      path,
      'checkout',
      '--quiet',
      '--no-track',
      '-b',
      branch,
      `refs/remotes/origin/${branch}`,
    ]);
    return { created: true };
  }
  // A new task: start from the freshly updated base branch.
  await updateBaseBranch(path, options.baseBranch);
  await runGit(['-C', path, 'checkout', '--quiet', '--no-track', '-b', branch]);
  return { created: true };
}

/**
 * Checks out the base branch (e.g. main or dev) and fast-forwards it to the server copy. Workbox
 * never commits to the base branch, so this is always a fast-forward unless someone committed
 * there by hand in the workspace, which is refused rather than overwritten.
 * Returns the base branch's commit.
 */
export async function updateBaseBranch(path: string, baseBranch: string): Promise<string> {
  if (!(await remoteBranchSha(path, baseBranch))) {
    throw new GitError(
      'failed',
      `the base branch "${baseBranch}" doesn't exist on the server; check the project's Default branch setting`,
    );
  }
  if (await hasUncommittedChanges(path)) {
    throw new GitError(
      'failed',
      `the workspace has uncommitted changes; commit or discard them in ${path} first`,
    );
  }
  if (await localBranchExists(path, baseBranch)) {
    await runGit(['-C', path, 'checkout', '--quiet', baseBranch]);
    try {
      await runGit([
        '-C',
        path,
        'merge',
        '--ff-only',
        '--quiet',
        `refs/remotes/origin/${baseBranch}`,
      ]);
    } catch {
      throw new GitError(
        'rejected',
        `the local ${baseBranch} in ${path} has commits that aren't on the server; Workbox never commits to ${baseBranch}, so resolve this by hand`,
      );
    }
  } else {
    await runGit([
      '-C',
      path,
      'checkout',
      '--quiet',
      '--no-track',
      '-b',
      baseBranch,
      `refs/remotes/origin/${baseBranch}`,
    ]);
  }
  const { stdout } = await runGit(['-C', path, 'rev-parse', 'HEAD']);
  return stdout.trim();
}

/**
 * After a run, leave the working copy on the up-to-date base branch, if it's clean (it is once
 * the run's work is committed). Returns false when there is uncommitted work to keep in place.
 */
export async function returnToBaseBranch(path: string, baseBranch: string): Promise<boolean> {
  if (await hasUncommittedChanges(path)) return false;
  await updateBaseBranch(path, baseBranch);
  return true;
}

/**
 * Deletes a task branch from the working copy after its pull request was merged. Only when it is
 * safe: a `workbox/` branch that isn't checked out and whose tip is exactly what was pushed, so
 * no unpublished work can be lost. `kept` means it wasn't safe (try again later or leave it).
 */
export async function deleteMergedTaskBranch(options: {
  path: string;
  branch: string;
  pushedSha: string;
}): Promise<'deleted' | 'missing' | 'kept'> {
  const { path, branch, pushedSha } = options;
  if (!branch.startsWith('workbox/')) return 'kept';
  if ((await currentBranch(path)) === branch) return 'kept';
  let tip: string;
  try {
    tip = (
      await runGit([
        '-C',
        path,
        'rev-parse',
        '--verify',
        '--quiet',
        `refs/heads/${branch}^{commit}`,
      ])
    ).stdout.trim();
  } catch {
    return 'missing';
  }
  if (tip !== pushedSha) return 'kept'; // has commits that were never pushed
  await runGit(['-C', path, 'branch', '--quiet', '-D', branch]);
  // The remote-tracking ref is a local cache; drop it too so the next fetch doesn't resurrect it.
  await runGit(['-C', path, 'update-ref', '-d', `refs/remotes/origin/${branch}`]).catch(
    () => undefined,
  );
  return 'deleted';
}

async function localBranchExists(path: string, branch: string): Promise<boolean> {
  return runGit(['-C', path, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).then(
    () => true,
    () => false,
  );
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
