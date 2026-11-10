import { DomainError, ORCHESTRATOR_ACTOR } from '#core';
import {
  connections,
  gitReferences,
  projectRepositories,
  projects,
  taskRuns,
  tasks,
  workspaces,
  type Database,
  type GitReferenceRow,
} from '#database';
import { allowsHttp, commitsAhead, GitError, pushTaskBranch } from '#git';
import { gitUsername, isCodeHostError, type CodeHostRegistry } from '#integrations';
import { AGENT_LABELS, ERROR_CODES, type CheckResult, type GitReference } from '#shared';
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import { recordAudit } from './audit.js';
import type { ConnectionService } from './connection-service.js';
import type { ActionContext } from './context.js';

export interface PublishResult {
  reference: GitReference;
  /** True when a new pull/merge request was opened (false = an existing one was updated). */
  opened: boolean;
}

/**
 * Publishes a task: pushes its workbox/ branch with the account token (Workbox only; agents never
 * hold tokens) and opens or updates its **draft** pull/merge request. Idempotent: re-publishing
 * pushes new commits to the same branch and updates the same PR (spec §6 idempotency).
 */
export class Publisher {
  constructor(
    private readonly db: Database,
    private readonly codeHosts: CodeHostRegistry,
    private readonly connections: ConnectionService,
  ) {}

  /**
   * @param options.describeRunId the run whose summary/checks go into the PR description
   *   (default: the task's latest completed run).
   */
  async publish(
    taskId: string,
    context: ActionContext = { actor: ORCHESTRATOR_ACTOR },
    options: { describeRunId?: string } = {},
  ): Promise<PublishResult> {
    const [ctx] = await this.db
      .select({
        task: tasks,
        repo: projectRepositories,
        workspace: workspaces,
        provider: connections.provider,
        baseBranch: projects.defaultBranch,
      })
      .from(tasks)
      .innerJoin(projectRepositories, eq(projectRepositories.projectId, tasks.projectId))
      .innerJoin(projects, eq(projects.id, tasks.projectId))
      .innerJoin(connections, eq(connections.id, projectRepositories.connectionId))
      .leftJoin(workspaces, eq(workspaces.projectRepositoryId, projectRepositories.id))
      .where(eq(tasks.id, taskId))
      .limit(1);
    if (!ctx)
      throw new DomainError(ERROR_CODES.notFound, `task "${taskId}" has no linked repository`);
    const [run] = await this.db
      .select()
      .from(taskRuns)
      .where(and(eq(taskRuns.taskId, taskId), isNotNull(taskRuns.branch)))
      .orderBy(desc(taskRuns.attempt))
      .limit(1);
    if (!run?.branch || !ctx.workspace?.path) {
      throw new DomainError(
        ERROR_CODES.nothingToPublish,
        'this task has no branch yet; run it first',
      );
    }
    const branch = run.branch;
    const path = ctx.workspace.path;
    if ((await commitsAhead(path, branch, ctx.baseBranch)) === 0) {
      throw new DomainError(
        ERROR_CODES.nothingToPublish,
        `${branch} has no commits that aren't already on ${ctx.baseBranch}`,
      );
    }
    const [latestSuccess] = await this.db
      .select()
      .from(taskRuns)
      .where(
        options.describeRunId
          ? eq(taskRuns.id, options.describeRunId)
          : and(eq(taskRuns.taskId, taskId), eq(taskRuns.state, 'completed')),
      )
      .orderBy(desc(taskRuns.attempt))
      .limit(1);
    const provider = ctx.repo.provider;
    const adapter = this.codeHosts[provider];
    const repoRef = { externalId: ctx.repo.externalId, fullPath: ctx.repo.fullPath };
    const [connection] = await this.db
      .select()
      .from(connections)
      .where(eq(connections.id, ctx.repo.connectionId))
      .limit(1);

    try {
      const result = await this.connections.withToken(
        ctx.repo.connectionId,
        'task.publish',
        context,
        async (token) => {
          const pushedSha = await pushTaskBranch({
            path,
            branch,
            credentials: { username: gitUsername(provider), token },
            allowHttp: allowsHttp(ctx.repo.cloneUrlHttps),
          });
          const account = { baseUrl: connection!.baseUrl };
          const title = ctx.task.title;
          const body = pullRequestBody({
            task: ctx.task,
            summary: latestSuccess?.summary ?? null,
            qaSteps: latestSuccess?.qaSteps ?? [],
            checks: latestSuccess?.checkResults ?? [],
            verification: latestSuccess?.verification ?? 'skipped',
            attempt: latestSuccess?.attempt ?? run.attempt,
            agent: AGENT_LABELS[run.agent],
          });
          const existing = await adapter.findOpenReviewRequest(account, token, repoRef, branch);
          const review = existing
            ? await adapter.updateReviewRequest(account, token, repoRef, existing.number, {
                title,
                body,
              })
            : await adapter.createReviewRequest(account, token, repoRef, {
                head: branch,
                base: ctx.baseBranch,
                title,
                body,
                draft: true,
              });
          return { pushedSha, review, opened: !existing };
        },
      );
      const row = await this.upsert(taskId, ctx.task.projectId, provider, branch, {
        pushedSha: result.pushedSha,
        pushedAt: new Date(),
        reviewNumber: result.review.number,
        reviewUrl: result.review.url,
        reviewState: result.review.state,
        lastSyncedAt: new Date(),
        lastError: null,
      });
      await this.setReviewAccess(ctx.repo.id, 'verified');
      await recordAudit(this.db, context, {
        action: result.opened ? 'task.review_opened' : 'task.review_updated',
        resourceType: 'task',
        resourceId: taskId,
        metadata: {
          branch,
          pushedSha: result.pushedSha,
          review: result.review.number,
          url: result.review.url,
        },
      });
      return { reference: toGitReference(row), opened: result.opened };
    } catch (error) {
      const message = publishFailure(error);
      if (message === null) throw error;
      if (isCodeHostError(error) && error.kind === 'forbidden')
        await this.setReviewAccess(ctx.repo.id, 'denied');
      await this.upsert(taskId, ctx.task.projectId, provider, branch, { lastError: message });
      await recordAudit(this.db, context, {
        action: 'task.publish_failed',
        resourceType: 'task',
        resourceId: taskId,
        metadata: { branch, error: message },
      });
      throw new DomainError(ERROR_CODES.codeHostUnavailable, message);
    }
  }

  private async upsert(
    taskId: string,
    projectId: string,
    provider: 'github' | 'gitlab',
    branch: string,
    values: Partial<typeof gitReferences.$inferInsert>,
  ): Promise<GitReferenceRow> {
    const [row] = await this.db
      .insert(gitReferences)
      .values({ taskId, projectId, provider, branch, ...values })
      .onConflictDoUpdate({
        target: gitReferences.taskId,
        set: { branch, ...values, updatedAt: sql`now()` },
      })
      .returning();
    return row!;
  }

  private async setReviewAccess(projectRepositoryId: string, value: 'verified' | 'denied') {
    await this.db
      .update(projectRepositories)
      .set({
        access: sql`jsonb_set(${projectRepositories.access}, '{reviewRequests}', ${JSON.stringify(value)}::jsonb)`,
        updatedAt: sql`now()`,
      })
      .where(eq(projectRepositories.id, projectRepositoryId));
  }
}

export function toGitReference(row: GitReferenceRow): GitReference {
  return {
    provider: row.provider,
    branch: row.branch,
    pushedSha: row.pushedSha,
    pushedAt: row.pushedAt?.toISOString() ?? null,
    reviewNumber: row.reviewNumber,
    reviewUrl: row.reviewUrl,
    reviewState: row.reviewState,
    lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
    lastError: row.lastError,
  };
}

function publishFailure(error: unknown): string | null {
  if (error instanceof GitError) {
    if (error.kind === 'rejected') {
      return `Push rejected: ${error.message}. Pull the branch's new commits into the workspace (a re-run does this), then publish again.`;
    }
    if (error.kind === 'auth')
      return `Push failed: ${error.message}. Check that the token has Contents: write.`;
    return `Push failed: ${error.message}`;
  }
  if (isCodeHostError(error)) {
    if (error.kind === 'forbidden') {
      return `The branch was pushed, but the token may not open pull/merge requests (${error.message}). Give it "Pull requests: write" (GitHub) or the api scope (GitLab), then publish again.`;
    }
    return `Opening the pull/merge request failed: ${error.message}`;
  }
  if (error instanceof DomainError) return error.message;
  return null;
}

/** PR/MR description: the agent's claims, the verification evidence, and how to test. */
export function pullRequestBody(input: {
  task: { number: number; title: string; description: string; acceptanceCriteria: string[] };
  summary: string | null;
  qaSteps: string[];
  checks: CheckResult[];
  verification: string;
  attempt: number;
  agent: string;
}): string {
  const checks =
    input.checks.length === 0
      ? '_No automatic checks are configured for this project: please review and test manually._'
      : input.checks
          .map(
            (c) =>
              `- ${c.status === 'passed' ? '✅' : '❌'} \`${c.command}\` (${Math.round(c.durationMs / 1000)} s)`,
          )
          .join('\n');
  const criteria = input.task.acceptanceCriteria.length
    ? input.task.acceptanceCriteria.map((c) => `- [ ] ${c}`).join('\n')
    : '';
  const qa = input.qaSteps.length
    ? input.qaSteps.map((s, i) => `${i + 1}. ${s}`).join('\n')
    : '_The agent did not provide test steps._';
  return [
    `## Summary`,
    input.summary?.trim() || '_No summary was provided._',
    ...(criteria ? ['', '## Acceptance criteria', criteria] : []),
    '',
    `## Checks (${input.verification})`,
    checks,
    '',
    '## Manual QA steps',
    qa,
    '',
    '---',
    `Task #${input.task.number}, run ${input.attempt} · Draft opened by Workbox (${input.agent}). Review, test, then mark ready and merge yourself.`,
  ].join('\n');
}
