import { CODE_HOSTS } from '#shared';
import type { TaskGit } from './api/client.js';

export interface GitLinks {
  /** The task branch on the code host, once pushed. */
  branch: string | null;
  /** A run's commit on the code host, or null while it exists only locally. */
  commit: (sha: string, runFinishedAt: string | null) => string | null;
}

/**
 * Web links for a task's branch and commits. Workbox never rewrites a task branch (no force
 * push), so a commit is on the host if it is the pushed tip or was made before the last push.
 */
export function gitLinks(info: TaskGit | undefined): GitLinks {
  const ref = info?.reference;
  const web = info?.repositoryWebUrl;
  if (!ref?.pushedSha || !ref.pushedAt || !web) return { branch: null, commit: () => null };
  const host = CODE_HOSTS[ref.provider];
  const pushedAt = Date.parse(ref.pushedAt);
  return {
    branch: host.branchUrl(web, ref.branch),
    commit: (sha, finishedAt) =>
      sha === ref.pushedSha || (finishedAt !== null && Date.parse(finishedAt) <= pushedAt)
        ? host.commitUrl(web, sha)
        : null,
  };
}
