import { DomainError } from '#core';
import {
  connections,
  gitReferences,
  projectRepositories,
  taskRuns,
  tasks,
  type Database,
} from '#database';
import type { CodeHostRegistry } from '#integrations';
import { ERROR_CODES, type GitReference } from '#shared';
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import type { WorkerGateway } from './agent-runtime-service.js';
import { recordAudit } from './audit.js';
import type { ConnectionService } from './connection-service.js';
import type { ActionContext } from './context.js';
import { toGitReference } from './publisher.js';

/** Refresh the PR state from the code host at most this often when the task is viewed. */
const REFRESH_AFTER_MS = 60_000;

export interface TaskGitInfo {
  /** The task's branch (from its runs), even if not published yet. */
  branch: string | null;
  /** Latest local commit made by a run. */
  localCommitSha: string | null;
  reference: GitReference | null;
}

/**
 * A task's branch and pull/merge request as seen from the API (spec §9: branch, commit and PR
 * status shown separately from the task state). PR state is reconciled lazily from the provider.
 */
export class TaskGitService {
  constructor(
    private readonly db: Database,
    private readonly codeHosts: CodeHostRegistry,
    private readonly connectionService: ConnectionService,
    private readonly gateway?: WorkerGateway,
  ) {}

  async get(taskId: string, context: ActionContext): Promise<TaskGitInfo> {
    const [task] = await this.db
      .select({ id: tasks.id })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .limit(1);
    if (!task) throw new DomainError(ERROR_CODES.notFound, `task "${taskId}" not found`);
    const [run] = await this.db
      .select({ branch: taskRuns.branch, commitSha: taskRuns.commitSha })
      .from(taskRuns)
      .where(and(eq(taskRuns.taskId, taskId), isNotNull(taskRuns.branch)))
      .orderBy(desc(taskRuns.attempt))
      .limit(1);
    const [lastCommit] = await this.db
      .select({ commitSha: taskRuns.commitSha })
      .from(taskRuns)
      .where(and(eq(taskRuns.taskId, taskId), isNotNull(taskRuns.commitSha)))
      .orderBy(desc(taskRuns.attempt))
      .limit(1);
    let [ref] = await this.db
      .select()
      .from(gitReferences)
      .where(eq(gitReferences.taskId, taskId))
      .limit(1);
    if (
      ref?.reviewNumber &&
      (!ref.lastSyncedAt || Date.now() - ref.lastSyncedAt.getTime() > REFRESH_AFTER_MS)
    ) {
      ref = (await this.refresh(ref.id, context)) ?? ref;
    }
    return {
      branch: ref?.branch ?? run?.branch ?? null,
      localCommitSha: lastCommit?.commitSha ?? null,
      reference: ref ? toGitReference(ref) : null,
    };
  }

  /** Queues a push + draft PR on a worker (the working copy lives there). */
  async requestPublish(taskId: string, context: ActionContext): Promise<void> {
    const [task] = await this.db
      .select({ id: tasks.id })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .limit(1);
    if (!task) throw new DomainError(ERROR_CODES.notFound, `task "${taskId}" not found`);
    const [run] = await this.db
      .select({ commitSha: taskRuns.commitSha })
      .from(taskRuns)
      .where(and(eq(taskRuns.taskId, taskId), isNotNull(taskRuns.commitSha)))
      .limit(1);
    if (!run)
      throw new DomainError(
        ERROR_CODES.nothingToPublish,
        'this task has no committed changes to publish yet',
      );
    if (!this.gateway?.enqueuePublish)
      throw new DomainError(ERROR_CODES.workerUnavailable, 'no worker connection is configured');
    await this.gateway.enqueuePublish(taskId);
    await recordAudit(this.db, context, {
      action: 'task.publish_requested',
      resourceType: 'task',
      resourceId: taskId,
    });
  }

  private async refresh(referenceId: string, context: ActionContext) {
    const [row] = await this.db
      .select({ ref: gitReferences, repo: projectRepositories, baseUrl: connections.baseUrl })
      .from(gitReferences)
      .innerJoin(projectRepositories, eq(projectRepositories.projectId, gitReferences.projectId))
      .innerJoin(connections, eq(connections.id, projectRepositories.connectionId))
      .where(eq(gitReferences.id, referenceId))
      .limit(1);
    if (!row?.ref.reviewNumber) return undefined;
    try {
      const review = await this.connectionService.withToken(
        row.repo.connectionId,
        'review.status',
        context,
        (token) =>
          this.codeHosts[row.repo.provider].getReviewRequest(
            { baseUrl: row.baseUrl },
            token,
            { externalId: row.repo.externalId, fullPath: row.repo.fullPath },
            row.ref.reviewNumber!,
          ),
      );
      const [updated] = await this.db
        .update(gitReferences)
        .set({
          reviewState: review.state,
          reviewUrl: review.url,
          lastSyncedAt: new Date(),
          updatedAt: sql`now()`,
        })
        .where(eq(gitReferences.id, referenceId))
        .returning();
      return updated;
    } catch {
      return undefined; // showing slightly stale state is better than failing the page
    }
  }
}
