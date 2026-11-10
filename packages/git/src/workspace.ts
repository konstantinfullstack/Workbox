import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { GitError, runGit, type GitCredentials } from './run.js';

/** Which repository a workspace holds. Stored in `.git/workbox.json` (never in the working tree). */
export interface RepositoryIdentity {
  provider: string;
  host: string;
  externalId: string;
}

export interface SyncResult {
  action: 'cloned' | 'fetched' | 'recloned';
  /** Commit of origin/<default branch>, or null for an empty repository. */
  headSha: string | null;
  sizeKb: number;
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const IDENTITY_FILE = 'workbox.json';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * `<root>/<projectSlug>`: one normal working copy per project (ADR-007, option A). Refuses
 * anything that could escape the root.
 */
export function workspacePath(root: string, projectSlug: string): string {
  if (!isAbsolute(root)) throw new Error('workspaces root must be an absolute path');
  if (!SLUG.test(projectSlug))
    throw new Error(`invalid project slug for a workspace path: ${projectSlug}`);
  return join(resolve(root), projectSlug);
}

export function allowsHttp(url: string): boolean {
  const parsed = new URL(url);
  return parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname);
}

/**
 * Clones the repository as a normal working copy, or fetches into an existing one. Fetching only
 * updates `origin/*` refs: the checked-out branch and any work in it are never touched.
 *
 * Safety: an existing directory is replaced only when it is a Workbox workspace for a *different*
 * repository *and* has no uncommitted changes. Anything Workbox doesn't recognise as its own is
 * never deleted; the sync fails with an explanation instead.
 */
export async function syncRepository(options: {
  path: string;
  cloneUrl: string;
  defaultBranch: string;
  identity: RepositoryIdentity;
  credentials: GitCredentials;
  timeoutMs?: number;
}): Promise<SyncResult> {
  const url = new URL(options.cloneUrl);
  if (url.username || url.password)
    throw new GitError('failed', 'clone URLs must not contain credentials');
  const git = {
    credentials: options.credentials,
    allowHttp: allowsHttp(options.cloneUrl),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
  };

  let action: SyncResult['action'] = 'cloned';
  if (existsSync(options.path)) {
    const identity = await readIdentity(options.path);
    if (identity && sameIdentity(identity, options.identity)) {
      await runGit(['-C', options.path, 'remote', 'set-url', 'origin', options.cloneUrl], git);
      await runGit(['-C', options.path, 'fetch', '--prune', '--tags', 'origin'], git);
      return {
        action: 'fetched',
        headSha: await originHead(options.path, options.defaultBranch),
        sizeKb: await sizeKb(options.path),
      };
    }
    if (!identity) {
      if (readdirSync(options.path).length > 0) {
        throw new GitError(
          'failed',
          `${options.path} exists but is not a Workbox workspace; move or delete it manually, then sync again`,
        );
      }
    } else if (await hasUncommittedChanges(options.path)) {
      throw new GitError(
        'failed',
        `${options.path} holds another repository with uncommitted changes; resolve them manually, then sync again`,
      );
    }
    action = 'recloned';
  }

  const staging = `${options.path}.tmp-${randomBytes(4).toString('hex')}`;
  await mkdir(dirname(options.path), { recursive: true });
  try {
    await runGit(['clone', '--quiet', '--no-checkout', options.cloneUrl, staging], git);
    await writeFile(
      join(staging, '.git', IDENTITY_FILE),
      `${JSON.stringify(options.identity, null, 2)}\n`,
    );
    // Check out the default branch (if the repository isn't empty).
    if (await originHead(staging, options.defaultBranch)) {
      await runGit([
        '-C',
        staging,
        'checkout',
        '--quiet',
        '-B',
        options.defaultBranch,
        `origin/${options.defaultBranch}`,
      ]);
    }
    await rm(options.path, { recursive: true, force: true });
    await rename(staging, options.path);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  return {
    action,
    headSha: await originHead(options.path, options.defaultBranch),
    sizeKb: await sizeKb(options.path),
  };
}

/** Deletes a project's workspace, only if it lies inside `root` and is a Workbox workspace. */
export async function removeWorkspace(root: string, projectSlug: string): Promise<boolean> {
  const path = workspacePath(root, projectSlug);
  const rel = relative(resolve(root), path);
  if (rel.startsWith('..') || isAbsolute(rel) || rel === '') {
    throw new Error('refusing to delete a path outside the workspaces root');
  }
  if (!existsSync(path)) return false;
  if (!(await readIdentity(path))) {
    throw new Error(`${path} is not a Workbox workspace; not deleting it`);
  }
  await rm(path, { recursive: true, force: true });
  return true;
}

export async function hasUncommittedChanges(path: string): Promise<boolean> {
  const { stdout } = await runGit(['-C', path, 'status', '--porcelain']);
  return stdout.trim() !== '';
}

async function readIdentity(path: string): Promise<RepositoryIdentity | null> {
  try {
    return JSON.parse(
      await readFile(join(path, '.git', IDENTITY_FILE), 'utf8'),
    ) as RepositoryIdentity;
  } catch {
    return null;
  }
}

function sameIdentity(a: RepositoryIdentity, b: RepositoryIdentity): boolean {
  return a.provider === b.provider && a.host === b.host && a.externalId === b.externalId;
}

export async function originHead(path: string, defaultBranch: string): Promise<string | null> {
  try {
    const { stdout } = await runGit([
      '-C',
      path,
      'rev-parse',
      '--verify',
      '--quiet',
      `refs/remotes/origin/${defaultBranch}^{commit}`,
    ]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function sizeKb(path: string): Promise<number> {
  const { stdout } = await runGit(['-C', path, 'count-objects', '-v']);
  const value = (key: string) => Number(new RegExp(`^${key}: (\\d+)$`, 'm').exec(stdout)?.[1] ?? 0);
  return value('size') + value('size-pack');
}

/**
 * Validates the workspaces root. Cloned repositories must never end up committed to the Workbox
 * repository: a root inside `projectRoot` is accepted only if git confirms it is ignored there.
 */
export async function assertWorkspacesRoot(root: string, projectRoot: string): Promise<void> {
  if (!isAbsolute(root)) throw new Error('WORKBOX_WORKSPACES_DIR must be an absolute path');
  const rel = relative(resolve(projectRoot), resolve(root));
  const inside = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  if (!inside) return;
  if (rel === '')
    throw new Error('WORKBOX_WORKSPACES_DIR must not be the Workbox repository itself');
  try {
    await runGit(['-C', projectRoot, 'check-ignore', '--quiet', `${rel}/`]);
  } catch {
    throw new Error(
      `WORKBOX_WORKSPACES_DIR (${root}) is inside the Workbox repository but not git-ignored; ` +
        'cloned code could be committed. Use the default (workspaces/, already git-ignored) or add it to .gitignore.',
    );
  }
}
