import {
  connections,
  gitReferences,
  projectRepositories,
  projects,
  taskRuns,
  tasks,
  type Database,
  type GitReferenceRow,
} from '#database';
import type { CodeHostRegistry } from '#integrations';
import { ACTIVE_RUN_STATES, type CodeHostProvider, type TaskState } from '#shared';
import { and, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { recordAudit } from './audit.js';
import type { ConnectionService } from './connection-service.js';
import type { ActionContext } from './context.js';
import { transitionTaskInTx } from './task-service.js';

/** Actor recorded on task changes made because of the pull request's state on the code host. */
export const REVIEW_SYNC_ACTOR = 'system:review-sync';

export interface ReviewSyncOptions {
  db: Database;
  codeHosts: CodeHostRegistry;
  connections: ConnectionService;
}

/** Worker side: deletes a merged task branch from the project's working copy if safe. */
export type CleanupBranch = (input: {
  projectSlug: string;
  branch: string;
  pushedSha: string;
}) => Promise<'deleted' | 'missing' | 'kept'>;

export interface ReviewSyncResult {
  reference: GitReferenceRow;
  /** The task state this sync moved the task to, if any. */
  movedTo: TaskState | null;
}

/**
 * Keeps tasks in step with their pull/merge requests (M5): the code host is the source of truth
 * for whether the work was merged.
 * - merged → the task moves from Ready for QA to Done
 * - closed without merging → the task moves from Ready for QA to Changes requested
 * Other task states are left alone (e.g. a run is in progress, or the user already moved it).
 */
export class ReviewSync {
  constructor(private readonly options: ReviewSyncOptions) {}

  /**
   * Syncs every reference that may still change: draft or open requests, and finished ones
   * whose task still waits in Ready for QA (catch-up after downtime).
   */
  async syncPending(): Promise<{ checked: number; moved: number }> {
    const rows = await this.options.db
      .select({ id: gitReferences.id })
      .from(gitReferences)
      .innerJoin(tasks, eq(tasks.id, gitReferences.taskId))
      .where(
        and(
          isNotNull(gitReferences.reviewNumber),
          or(
            isNull(gitReferences.reviewState),
            inArray(gitReferences.reviewState, ['draft', 'open']),
            eq(tasks.state, 'ready_for_qa'),
          ),
        ),
      );
    let moved = 0;
    for (const row of rows) {
      const result = await this.sync(row.id).catch(() => undefined); // one bad token mustn't stop the rest
      if (result?.movedTo) moved += 1;
    }
    return { checked: rows.length, moved };
  }

  /** Fetches one request's state, records it, and applies it to the task. */
  async sync(referenceId: string): Promise<ReviewSyncResult | undefined> {
    const { db } = this.options;
    const context: ActionContext = { actor: REVIEW_SYNC_ACTOR };
    const [row] = await db
      .select({
        ref: gitReferences,
        repo: projectRepositories,
        baseUrl: connections.baseUrl,
      })
      .from(gitReferences)
      .innerJoin(projectRepositories, eq(projectRepositories.projectId, gitReferences.projectId))
      .innerJoin(connections, eq(connections.id, projectRepositories.connectionId))
      .where(eq(gitReferences.id, referenceId))
      .limit(1);
    if (!row?.ref.reviewNumber) return undefined;
    const number = row.ref.reviewNumber;

    const review = await this.options.connections.withToken(
      row.repo.connectionId,
      'review.status',
      context,
      (token) =>
        this.options.codeHosts[row.repo.provider].getReviewRequest(
          { baseUrl: row.baseUrl },
          token,
          { externalId: row.repo.externalId, fullPath: row.repo.fullPath },
          number,
        ),
    );

    const name = requestName(row.ref.provider, number);
    const outcome = await db.transaction(async (tx) => {
      const [reference] = await tx
        .update(gitReferences)
        .set({
          reviewState: review.state,
          reviewUrl: review.url,
          lastSyncedAt: new Date(),
          updatedAt: sql`now()`,
        })
        .where(eq(gitReferences.id, referenceId))
        .returning();
      const [task] = await tx
        .select({ state: tasks.state })
        .from(tasks)
        .where(eq(tasks.id, row.ref.taskId))
        .limit(1);
      if (task?.state !== 'ready_for_qa') return { reference: reference!, movedTo: null };

      const change =
        review.state === 'merged'
          ? { to: 'done' as const, reason: `${name} was merged on ${hostName(row.ref.provider)}` }
          : review.state === 'closed'
            ? {
                to: 'changes_requested' as const,
                reason: `${name} was closed without merging on ${hostName(row.ref.provider)}`,
              }
            : null;
      if (!change) return { reference: reference!, movedTo: null };
      await transitionTaskInTx(tx, row.ref.taskId, change, context);
      await recordAudit(tx, context, {
        action: 'task.review_synced',
        resourceType: 'task',
        resourceId: row.ref.taskId,
        metadata: { reviewNumber: number, reviewState: review.state, to: change.to },
      });
      return { reference: reference!, movedTo: change.to };
    });

    return outcome;
  }

  /**
   * Worker only: removes merged task branches from the working copies. Skips projects with an
   * active run (the copy is in use); branches that aren't safe to delete are retried later.
   */
  async cleanupMergedBranches(cleanup: CleanupBranch): Promise<number> {
    const { db } = this.options;
    const rows = await db
      .select({ ref: gitReferences, slug: projects.slug })
      .from(gitReferences)
      .innerJoin(projects, eq(projects.id, gitReferences.projectId))
      .where(
        and(
          eq(gitReferences.reviewState, 'merged'),
          isNotNull(gitReferences.pushedSha),
          isNull(gitReferences.localBranchRemovedAt),
        ),
      );
    let removed = 0;
    for (const { ref, slug } of rows) {
      const [active] = await db
        .select({ id: taskRuns.id })
        .from(taskRuns)
        .where(
          and(
            eq(taskRuns.projectId, ref.projectId),
            inArray(taskRuns.state, [...ACTIVE_RUN_STATES]),
          ),
        )
        .limit(1);
      if (active) continue;
      const result = await cleanup({
        projectSlug: slug,
        branch: ref.branch,
        pushedSha: ref.pushedSha!,
      }).catch(() => 'kept' as const);
      if (result === 'kept') continue;
      if (result === 'deleted') removed += 1;
      await db
        .update(gitReferences)
        .set({ localBranchRemovedAt: new Date(), updatedAt: sql`now()` })
        .where(eq(gitReferences.id, ref.id));
    }
    return removed;
  }
}

function requestName(provider: CodeHostProvider, number: number): string {
  return provider === 'gitlab' ? `Merge request !${number}` : `Pull request #${number}`;
}

function hostName(provider: CodeHostProvider): string {
  return provider === 'gitlab' ? 'GitLab' : 'GitHub';
}
