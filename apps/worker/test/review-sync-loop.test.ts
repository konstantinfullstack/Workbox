import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '#core';
import type { ReviewSync } from '#services';
import { describe, expect, it, vi } from 'vitest';
import { startReviewSyncLoop, workspaceBranchCleanup } from '../src/review-sync-loop.js';

const logger = createLogger({ service: 'test', level: 'silent' });

describe('review sync loop', () => {
  it('syncs right away and on an interval, never overlapping, and stops cleanly', async () => {
    let release!: () => void;
    const first = new Promise<void>((resolve) => (release = resolve));
    const syncPending = vi.fn(async () => {
      await first; // the first pass is slow; later ones are quick
      return { checked: 1, moved: 0 };
    });
    const cleanupMergedBranches = vi.fn(async () => 0);
    const reviews = { syncPending, cleanupMergedBranches } as unknown as ReviewSync;
    const stop = startReviewSyncLoop({ reviews, root: '/nonexistent', logger, intervalMs: 10 });
    expect(syncPending).toHaveBeenCalledTimes(1);
    await new Promise((r) => setTimeout(r, 40)); // ticks while the first pass is still running
    expect(syncPending).toHaveBeenCalledTimes(1);
    release();
    await vi.waitFor(() => expect(cleanupMergedBranches).toHaveBeenCalled());
    await stop();
  });

  it('keeps going after a failed pass', async () => {
    const syncPending = vi
      .fn()
      .mockRejectedValueOnce(new Error('code host down'))
      .mockResolvedValue({ checked: 0, moved: 0 });
    const reviews = { syncPending, cleanupMergedBranches: async () => 0 } as unknown as ReviewSync;
    const stop = startReviewSyncLoop({ reviews, root: '/nonexistent', logger, intervalMs: 10 });
    await vi.waitFor(() => expect(syncPending.mock.calls.length).toBeGreaterThanOrEqual(2));
    await stop();
  });

  it('treats a missing working copy as nothing to clean up', async () => {
    const root = mkdtempSync(join(tmpdir(), 'workbox-review-loop-'));
    try {
      const cleanup = workspaceBranchCleanup(root);
      expect(
        await cleanup({ projectSlug: 'gone', branch: 'workbox/1-x', pushedSha: 'a'.repeat(40) }),
      ).toBe('missing');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
