import { assertRunTransition, ORCHESTRATOR_ACTOR } from '#core';
import {
  buildTaskInstructions,
  type AgentEvent,
  type AgentRegistry,
  type AgentResult,
} from '#agents';
import {
  projectRepositories,
  projects,
  runEvents,
  taskRuns,
  tasks,
  workspaces,
  type Database,
} from '#database';
import {
  checkoutTaskBranch,
  collectBranchChanges,
  commitTaskChanges,
  GitError,
  hasUncommittedChanges,
  taskBranchName,
  type CommitAuthor,
} from '#git';
import { noReplyEmail } from '#integrations';
import {
  ACTIVE_RUN_STATES,
  AGENT_LABELS,
  CODE_HOST_PROVIDERS,
  type CodeHostProvider,
  type RunEventType,
  type RunState,
  type TaskState,
} from '#shared';
import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { recordAudit } from './audit.js';
import type { ConnectionService } from './connection-service.js';
import type { ActionContext, Transaction } from './context.js';
import { transitionTaskInTx } from './task-service.js';
import type { WorkspaceSyncer } from './workspace-syncer.js';

export interface RunExecutorOptions {
  db: Database;
  agents: AgentRegistry;
  syncer: WorkspaceSyncer;
  workerId: string;
  /** Agent time limit (default 30 min). */
  timeoutMs?: number;
  /** How often to check for a cancel request (default 2 s). */
  cancelPollMs?: number;
  /** Used to resolve the commit author's no-reply email from the repository's account. */
  connections: ConnectionService;
  /** Commit author name (WORKBOX_GIT_AUTHOR_NAME); defaults to the account login. */
  authorName?: string;
}

const orchestrator: ActionContext = { actor: ORCHESTRATOR_ACTOR };

/**
 * Executes one run on a worker: fetch → task branch in the project's working copy → agent →
 * commit locally → hand the task to QA.
 * Run state and task state always change in the same transaction. Agent failures, timeouts and
 * cancellations end the run cleanly and block the task with the reason. Nothing is pushed (B2).
 */
export class RunExecutor {
  constructor(private readonly options: RunExecutorOptions) {}

  async execute(runId: string): Promise<RunState> {
    const { db } = this.options;
    const [run] = await db.select().from(taskRuns).where(eq(taskRuns.id, runId)).limit(1);
    if (!run || run.state !== 'queued') return run?.state ?? 'cancelled'; // already handled (or cancelled while queued)
    let seq = 0;
    const event = async (
      type: RunEventType,
      message: string,
      data: Record<string, unknown> = {},
    ) => {
      seq += 1;
      await db
        .insert(runEvents)
        .values({ runId, seq, type, message: message.slice(0, 4_000), data });
    };

    await this.moveRun(runId, 'queued', 'preparing', {
      workerId: this.options.workerId,
      startedAt: new Date(),
    });
    await event('stage', 'Preparing workspace');

    try {
      const [ctx] = await db
        .select({
          task: tasks,
          project: projects,
          repo: projectRepositories,
          workspace: workspaces,
        })
        .from(tasks)
        .innerJoin(projects, eq(projects.id, tasks.projectId))
        .innerJoin(projectRepositories, eq(projectRepositories.projectId, projects.id))
        .leftJoin(workspaces, eq(workspaces.projectRepositoryId, projectRepositories.id))
        .where(eq(tasks.id, run.taskId))
        .limit(1);
      if (!ctx)
        return await this.fail(
          runId,
          'preparing',
          'The project no longer has a linked repository.',
          event,
        );

      const sync = await this.options.syncer.sync(ctx.repo.id);
      if (sync.status !== 'ready') {
        return await this.fail(
          runId,
          'preparing',
          `Could not update the repository clone: ${sync.status === 'failed' ? sync.error : sync.reason}`,
          event,
        );
      }
      await event(
        'stage',
        `Repository up to date (${ctx.repo.defaultBranch} @ ${sync.headSha?.slice(0, 7) ?? 'empty'})`,
      );
      if (await this.cancelRequested(runId)) return await this.cancelled(runId, 'preparing', event);

      const [workspace] = await db
        .select()
        .from(workspaces)
        .where(eq(workspaces.projectRepositoryId, ctx.repo.id))
        .limit(1);
      const path = workspace!.path!;
      // Later runs of the same task continue on the branch of the first one.
      const [previous] = await db
        .select({ branch: taskRuns.branch })
        .from(taskRuns)
        .where(and(eq(taskRuns.taskId, run.taskId), isNotNull(taskRuns.branch)))
        .orderBy(desc(taskRuns.attempt))
        .limit(1);
      const branch = previous?.branch ?? taskBranchName(ctx.task.number, ctx.task.title);
      let checkout: { created: boolean };
      try {
        checkout = await checkoutTaskBranch({
          path,
          branch,
          defaultBranch: ctx.repo.defaultBranch,
        });
      } catch (error) {
        if (error instanceof GitError)
          return await this.fail(runId, 'preparing', error.message, event);
        throw error;
      }
      await db
        .update(taskRuns)
        .set({ branch, worktreePath: path, updatedAt: new Date() })
        .where(eq(taskRuns.id, runId));
      await event('stage', `${checkout.created ? 'Created' : 'Switched to'} branch ${branch}`, {
        branch,
      });

      await this.moveRun(runId, 'preparing', 'running');
      const adapter = this.options.agents[run.agent];
      const controller = new AbortController();
      const poll = setInterval(() => {
        void this.cancelRequested(runId).then(
          (requested) => requested && controller.abort(),
          () => undefined,
        );
      }, this.options.cancelPollMs ?? 2_000);
      let result: AgentResult;
      const pending: Promise<void>[] = [];
      try {
        result = await adapter.execute(
          {
            runId,
            workspacePath: path,
            instructions: buildTaskInstructions({
              projectName: ctx.project.name,
              repositoryPath: ctx.repo.fullPath,
              branch,
              task: ctx.task,
              note: run.note,
              checkCommands: [],
            }),
            timeoutMs: this.options.timeoutMs ?? 30 * 60_000,
            allowedCommands: [],
          },
          (e: AgentEvent) =>
            void pending.push(event(e.type, e.message, e.data).catch(() => undefined)),
          controller.signal,
        );
      } finally {
        clearInterval(poll);
        await Promise.all(pending);
      }
      const usage = {
        costUsd: result.usage?.costUsd ?? null,
        durationMs: result.usage?.durationMs ?? null,
      };

      if (result.status !== 'completed') {
        const state: RunState =
          result.status === 'cancelled'
            ? 'cancelled'
            : result.status === 'timed_out'
              ? 'timed_out'
              : 'failed';
        await event('failed', result.failureReason ?? `Agent ${result.status}`);
        // The task's partial work stays uncommitted on its own branch; a re-run continues from it.
        return await this.finish(
          runId,
          'running',
          state,
          result.failureReason ?? `Agent ${result.status}`,
          { ...usage, summary: result.summary || null },
        );
      }

      // Verifying (B1: collect, commit locally and show the changes; checks + push arrive in B2).
      await this.moveRun(runId, 'running', 'verifying');
      await this.taskTo(
        run.taskId,
        'verification',
        `Run #${run.attempt}: agent finished, verifying`,
      );
      if (!(await hasUncommittedChanges(path))) {
        return await this.finish(
          runId,
          'verifying',
          'failed',
          'The agent finished without changing any files.',
          {
            ...usage,
            summary: result.summary,
          },
        );
      }
      // The branch's full change set versus the default branch: what the PR will show.
      const changes = await collectBranchChanges(path, ctx.repo.defaultBranch);
      await event('stage', `${changes.files.length} file(s) changed on the branch`, {
        files: changes.files.length,
      });
      await event('log', 'No automatic checks configured yet: review the changes manually.', {
        level: 'warn',
      });

      const author = await this.commitAuthor(ctx.repo.connectionId);
      const commitSha = await commitTaskChanges({
        path,
        author,
        message: commitMessage({
          title: ctx.task.title,
          number: ctx.task.number,
          attempt: run.attempt,
          summary: result.summary,
          agent: AGENT_LABELS[run.agent],
        }),
      });
      if (commitSha) {
        await event(
          'stage',
          `Committed ${commitSha.slice(0, 7)} on ${branch} as ${author.name} (not pushed yet)`,
          {
            commitSha,
          },
        );
      }
      await event('completed', 'Run completed: ready for your review');
      return await this.finish(runId, 'verifying', 'completed', null, {
        ...usage,
        summary: result.summary,
        qaSteps: result.qaSteps,
        changedFiles: changes.files,
        diff: changes.diff,
        diffTruncated: changes.truncated ? 1 : 0,
        baseSha: changes.baseSha,
        commitSha,
      });
    } catch (error) {
      const [current] = await db
        .select({ state: taskRuns.state })
        .from(taskRuns)
        .where(eq(taskRuns.id, runId))
        .limit(1);
      const state = current?.state ?? 'preparing';
      if ((ACTIVE_RUN_STATES as readonly string[]).includes(state)) {
        const message = error instanceof Error ? error.message : 'unexpected error';
        await event('failed', `Internal error: ${message}`).catch(() => undefined);
        await this.finish(runId, state, 'failed', `Internal error: ${message}`, {}).catch(
          () => undefined,
        );
      }
      throw error;
    }
  }

  /**
   * After a worker restart: runs it was executing are failed (their agent process is gone) and
   * their tasks blocked; queued runs are returned so they can be re-enqueued.
   */
  async recover(): Promise<{ failed: number; queued: string[] }> {
    const { db } = this.options;
    const stale = await db
      .select()
      .from(taskRuns)
      .where(inArray(taskRuns.state, ['preparing', 'running', 'verifying']));
    for (const run of stale) {
      await this.finish(
        run.id,
        run.state,
        'failed',
        'The worker restarted during this run; start it again.',
        {},
      ).catch(() => undefined);
    }
    const queued = await db
      .select({ id: taskRuns.id })
      .from(taskRuns)
      .where(eq(taskRuns.state, 'queued'));
    return { failed: stale.length, queued: queued.map((r) => r.id) };
  }

  /** You (configured name) at the account's no-reply address; refreshes the account id if unknown. */
  private async commitAuthor(connectionId: string): Promise<CommitAuthor> {
    let connection = await this.options.connections.get(connectionId);
    if (!connection.accountId && connection.hasSecret) {
      connection = await this.options.connections.test(connectionId, orchestrator);
    }
    const provider = (CODE_HOST_PROVIDERS as readonly string[]).includes(connection.provider)
      ? (connection.provider as CodeHostProvider)
      : 'github';
    const account = connection.account ?? 'workbox';
    return {
      name: this.options.authorName ?? account,
      email: noReplyEmail(provider, connection.baseUrl, account, connection.accountId),
    };
  }

  private async cancelRequested(runId: string): Promise<boolean> {
    const [row] = await this.options.db
      .select({ at: taskRuns.cancelRequestedAt })
      .from(taskRuns)
      .where(eq(taskRuns.id, runId))
      .limit(1);
    return Boolean(row?.at);
  }

  private async cancelled(
    runId: string,
    from: RunState,
    event: (t: RunEventType, m: string) => Promise<void>,
  ): Promise<RunState> {
    await event('failed', 'Run cancelled');
    return this.finish(runId, from, 'cancelled', 'Run cancelled.', {});
  }

  private async fail(
    runId: string,
    from: RunState,
    reason: string,
    event: (t: RunEventType, m: string) => Promise<void>,
  ): Promise<RunState> {
    await event('failed', reason);
    return this.finish(runId, from, 'failed', reason, {});
  }

  private async moveRun(
    runId: string,
    from: RunState,
    to: RunState,
    extra: Partial<typeof taskRuns.$inferInsert> = {},
  ) {
    assertRunTransition(from, to);
    await this.options.db
      .update(taskRuns)
      .set({ state: to, ...extra, updatedAt: sql`now()` })
      .where(and(eq(taskRuns.id, runId), eq(taskRuns.state, from)));
  }

  private async taskTo(taskId: string, to: TaskState, reason: string, tx?: Transaction) {
    const apply = (t: Transaction) => transitionTaskInTx(t, taskId, { to, reason }, orchestrator);
    try {
      if (tx) await apply(tx);
      else await this.options.db.transaction(apply);
    } catch {
      // The task was moved by someone else meanwhile (e.g. cancelled by the user): the run's own
      // state is still recorded; never fight a human decision.
    }
  }

  /** Ends the run and moves the task accordingly, in one transaction. */
  private async finish(
    runId: string,
    from: RunState,
    to: RunState,
    exitReason: string | null,
    values: Partial<typeof taskRuns.$inferInsert>,
  ): Promise<RunState> {
    assertRunTransition(from, to);
    await this.options.db.transaction(async (tx) => {
      const [run] = await tx
        .update(taskRuns)
        .set({ state: to, exitReason, finishedAt: new Date(), ...values, updatedAt: sql`now()` })
        .where(and(eq(taskRuns.id, runId), eq(taskRuns.state, from)))
        .returning();
      if (!run) return;
      const [task] = await tx
        .select({ state: tasks.state })
        .from(tasks)
        .where(eq(tasks.id, run.taskId))
        .limit(1);
      if (to === 'completed') {
        if (task?.state === 'verification') {
          const count = run.changedFiles.length;
          await savepoint(tx, () =>
            transitionTaskInTx(
              tx,
              run.taskId,
              {
                to: 'ready_for_qa',
                reason: `Run #${run.attempt} completed: ${count} file(s) changed. Review the changes.`,
              },
              orchestrator,
            ),
          );
        }
      } else if (task && (task.state === 'in_progress' || task.state === 'verification')) {
        const label = to === 'timed_out' ? 'timed out' : to;
        await savepoint(tx, () =>
          transitionTaskInTx(
            tx,
            run.taskId,
            {
              to: 'blocked',
              reason: `Run #${run.attempt} ${label}: ${exitReason ?? 'no reason given'}`,
            },
            orchestrator,
          ),
        );
      }
      await recordAudit(tx, orchestrator, {
        action: `run.${to}`,
        resourceType: 'task',
        resourceId: run.taskId,
        metadata: {
          runId,
          attempt: run.attempt,
          ...(exitReason ? { reason: exitReason.slice(0, 300) } : {}),
        },
      });
    });
    return to;
  }
}

/** Runs `fn` in a savepoint so a refused task transition doesn't abort the outer transaction. */
async function savepoint(tx: Transaction, fn: () => Promise<unknown>): Promise<void> {
  await tx.execute(sql`SAVEPOINT task_transition`);
  try {
    await fn();
    await tx.execute(sql`RELEASE SAVEPOINT task_transition`);
  } catch {
    await tx.execute(sql`ROLLBACK TO SAVEPOINT task_transition`);
  }
}

/** Commit message: task title, the agent's summary, and Workbox trailers. */
export function commitMessage(input: {
  title: string;
  number: number;
  attempt: number;
  summary: string;
  agent: string;
}): string {
  const body = input.summary.trim();
  return `${input.title}\n\n${body ? `${body}\n\n` : ''}Workbox-Task: #${input.number} (run ${input.attempt})\nGenerated-by: Workbox (${input.agent})\n`;
}
