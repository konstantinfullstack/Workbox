import { existsSync } from 'node:fs';
import type { Logger } from '#core';
import { deleteMergedTaskBranch, workspacePath } from '#git';
import type { CleanupBranch, ReviewSync } from '#services';

export const REVIEW_SYNC_INTERVAL_MS = 3 * 60_000;

/** Removes merged task branches from `<root>/<slug>`; a missing working copy counts as done. */
export function workspaceBranchCleanup(root: string): CleanupBranch {
  return async ({ projectSlug, branch, pushedSha }) => {
    const path = workspacePath(root, projectSlug);
    if (!existsSync(path)) return 'missing';
    return deleteMergedTaskBranch({ path, branch, pushedSha });
  };
}

/**
 * Periodically brings tasks in step with their pull/merge requests (merged → Done, closed →
 * Changes requested) and tidies merged branches out of the working copies. Runs once right away.
 * Several workers may run it: every step is idempotent. Returns a stop function.
 */
export function startReviewSyncLoop(options: {
  reviews: ReviewSync;
  root: string;
  logger: Logger;
  intervalMs?: number;
}): () => Promise<void> {
  const { reviews, logger } = options;
  const cleanup = workspaceBranchCleanup(options.root);
  let running: Promise<void> | null = null;

  const tick = () => {
    if (running) return; // previous pass still going (slow code host)
    running = (async () => {
      try {
        const { checked, moved } = await reviews.syncPending();
        const removed = await reviews.cleanupMergedBranches(cleanup);
        if (moved > 0 || removed > 0) {
          logger.info({ checked, moved, removedBranches: removed }, 'review sync');
        }
      } catch (error) {
        logger.warn({ err: error }, 'review sync failed; will retry');
      } finally {
        running = null;
      }
    })();
  };

  tick();
  const timer = setInterval(tick, options.intervalMs ?? REVIEW_SYNC_INTERVAL_MS);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await running;
  };
}
