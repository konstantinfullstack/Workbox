import { DomainError } from '#core';
import {
  connections,
  projectRepositories,
  projects,
  runEvents,
  taskRuns,
  tasks,
  workspaces,
  type Database,
} from '#database';
import {
  ERROR_CODES,
  type RunDiff,
  type RunEvent,
  type StartRunInput,
  type TaskRun,
  type TaskState,
} from '#shared';
import { ACTIVE_RUN_STATES } from '#shared';
import { and, asc, desc, eq, gt, inArray, max } from 'drizzle-orm';
import type { WorkerGateway } from './agent-runtime-service.js';
import { recordAudit } from './audit.js';
import { projectChecks } from './project-checks-service.js';
import type { ActionContext } from './context.js';
import { PG_UNIQUE_VIOLATION, pgErrorInfo } from './pg-errors.js';
import { toRunEvent, toTaskRun } from './run-mappers.js';
import { transitionTaskInTx } from './task-service.js';

/** Task states from which a run may start (the run moves the task to in_progress). */
export const RUNNABLE_TASK_STATES: readonly TaskState[] = [
  'backlog',
  'planning',
  'changes_requested',
  'blocked',
];

/**
 * Starting, inspecting and cancelling agent runs (API side). Execution happens on a worker
 * (RunExecutor); this service only validates, records and queues.
 */
export class RunService {
  constructor(
    private readonly db: Database,
    private readonly gateway?: WorkerGateway,
  ) {}

  /** Why a task can't run right now (empty = it can). Shown before the Run button is pressed. */
  async readiness(taskId: string): Promise<string[]> {
    const [task] = await this.db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
    if (!task) throw new DomainError(ERROR_CODES.notFound, `task "${taskId}" not found`);
    const reasons: string[] = [];
    if (!RUNNABLE_TASK_STATES.includes(task.state)) {
      reasons.push(
        `The task is ${task.state.replaceAll('_', ' ')}; runs start from backlog, planning, changes requested or blocked.`,
      );
    }
    const [repo] = await this.db
      .select({
        accessStatus: projectRepositories.accessStatus,
        workspace: workspaces.status,
        workspaceError: workspaces.lastError,
      })
      .from(projectRepositories)
      .leftJoin(workspaces, eq(workspaces.projectRepositoryId, projectRepositories.id))
      .where(eq(projectRepositories.projectId, task.projectId))
      .limit(1);
    if (!repo) reasons.push('Link a repository to this project first.');
    else {
      if (repo.accessStatus !== 'verified')
        reasons.push('The repository access is not verified (see the Repository card).');
      if (repo.workspace !== 'ready') {
        reasons.push(
          repo.workspace === 'failed'
            ? `The repository clone failed: ${repo.workspaceError ?? 'see the Repository card'}.`
            : 'The repository is still being cloned.',
        );
      }
    }
    const [project] = await this.db
      .select({ config: projects.config })
      .from(projects)
      .where(eq(projects.id, task.projectId))
      .limit(1);
    if (repo && !projectChecks(project?.config ?? {}).confirmed) {
      reasons.push(
        'Confirm the project\'s check commands first (project page → Checks), or choose "no checks".',
      );
    }
    const [runtime] = await this.db
      .select()
      .from(connections)
      .where(eq(connections.provider, 'claude_code'))
      .limit(1);
    if (runtime?.lastCheck && !runtime.lastCheck.ok) {
      reasons.push(`Claude Code isn't ready on the worker: ${runtime.lastCheck.message}`);
    }
    const [active] = await this.db
      .select({ number: tasks.number })
      .from(taskRuns)
      .innerJoin(tasks, eq(tasks.id, taskRuns.taskId))
      .where(
        and(
          eq(taskRuns.projectId, task.projectId),
          inArray(taskRuns.state, [...ACTIVE_RUN_STATES]),
        ),
      )
      .limit(1);
    if (active)
      reasons.push(
        `Task #${active.number} is already running in this project (one run at a time).`,
      );
    if (!this.gateway?.enqueueRun) reasons.push('No worker connection is configured.');
    return reasons;
  }

  async start(taskId: string, input: StartRunInput, context: ActionContext): Promise<TaskRun> {
    const reasons = await this.readiness(taskId);
    if (reasons.length > 0) {
      throw new DomainError(ERROR_CODES.taskNotRunnable, reasons[0]!, { reasons });
    }
    let runId: string;
    try {
      runId = await this.db.transaction(async (tx) => {
        const [task] = await tx.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
        const [{ last } = { last: 0 }] = await tx
          .select({ last: max(taskRuns.attempt) })
          .from(taskRuns)
          .where(eq(taskRuns.taskId, taskId));
        const attempt = (last ?? 0) + 1;
        const [run] = await tx
          .insert(taskRuns)
          .values({
            taskId,
            projectId: task!.projectId,
            attempt,
            agent: 'claude_code',
            note: input.note ?? null,
          })
          .returning({ id: taskRuns.id });
        await transitionTaskInTx(
          tx,
          taskId,
          { to: 'in_progress', reason: `Run #${attempt} started` },
          context,
        );
        await recordAudit(tx, context, {
          action: 'run.queued',
          resourceType: 'task',
          resourceId: taskId,
          metadata: { runId: run!.id, attempt, agent: 'claude_code' },
        });
        return run!.id;
      });
    } catch (error) {
      const info = pgErrorInfo(error);
      if (
        info?.code === PG_UNIQUE_VIOLATION &&
        info.constraint === 'task_runs_one_active_per_project'
      ) {
        throw new DomainError(
          ERROR_CODES.runActive,
          'another run is already active in this project; wait for it or cancel it',
        );
      }
      throw error;
    }
    await this.gateway!.enqueueRun!(runId);
    return this.get(runId);
  }

  async list(taskId: string): Promise<TaskRun[]> {
    const rows = await this.db
      .select()
      .from(taskRuns)
      .where(eq(taskRuns.taskId, taskId))
      .orderBy(desc(taskRuns.attempt));
    return rows.map(toTaskRun);
  }

  async get(runId: string): Promise<TaskRun> {
    return toTaskRun(await this.row(runId));
  }

  async events(runId: string, after: number, limit: number): Promise<RunEvent[]> {
    await this.row(runId);
    const rows = await this.db
      .select()
      .from(runEvents)
      .where(and(eq(runEvents.runId, runId), gt(runEvents.seq, after)))
      .orderBy(asc(runEvents.seq))
      .limit(limit);
    return rows.map(toRunEvent);
  }

  async diff(runId: string): Promise<RunDiff> {
    const row = await this.row(runId);
    return { diff: row.diff ?? '', truncated: row.diffTruncated === 1 };
  }

  /**
   * Requests cancellation. A queued run is cancelled immediately; an active one is stopped by its
   * worker within a few seconds (it polls for this flag).
   */
  async cancel(runId: string, context: ActionContext): Promise<TaskRun> {
    await this.db.transaction(async (tx) => {
      const [run] = await tx
        .select()
        .from(taskRuns)
        .where(eq(taskRuns.id, runId))
        .limit(1)
        .for('update');
      if (!run) throw new DomainError(ERROR_CODES.notFound, `run "${runId}" not found`);
      if (!(ACTIVE_RUN_STATES as readonly string[]).includes(run.state)) {
        throw new DomainError(
          ERROR_CODES.runNotActive,
          `run #${run.attempt} is already ${run.state}`,
        );
      }
      await tx
        .update(taskRuns)
        .set({ cancelRequestedAt: new Date(), updatedAt: new Date() })
        .where(eq(taskRuns.id, runId));
      if (run.state === 'queued') {
        await tx
          .update(taskRuns)
          .set({
            state: 'cancelled',
            exitReason: 'Cancelled before it started.',
            finishedAt: new Date(),
          })
          .where(eq(taskRuns.id, runId));
        await transitionTaskInTx(
          tx,
          run.taskId,
          { to: 'blocked', reason: `Run #${run.attempt} cancelled` },
          context,
        );
      }
      await recordAudit(tx, context, {
        action: 'run.cancel_requested',
        resourceType: 'task',
        resourceId: run.taskId,
        metadata: { runId },
      });
    });
    return this.get(runId);
  }

  private async row(runId: string) {
    const [row] = await this.db.select().from(taskRuns).where(eq(taskRuns.id, runId)).limit(1);
    if (!row) throw new DomainError(ERROR_CODES.notFound, `run "${runId}" not found`);
    return row;
  }
}
