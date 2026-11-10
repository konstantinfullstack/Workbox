import { DomainError, pickNextTask } from '#core';
import { taskDependencies, taskRuns, tasks, taskStateTransitions, type Database } from '#database';
import {
  ACTIVE_RUN_STATES,
  ERROR_CODES,
  type ContinueStatus,
  type ContinueTaskRef,
  type TaskRun,
  type TaskState,
} from '#shared';
import { and, asc, desc, eq, inArray, ne } from 'drizzle-orm';
import { recordAudit } from './audit.js';
import type { ActionContext } from './context.js';
import { findProject } from './project-service.js';
import type { RunService } from './run-service.js';

/** A queued run older than this probably means no worker is picking up jobs. */
const STALE_QUEUE_MS = 2 * 60_000;

type TaskRow = {
  id: string;
  number: number;
  title: string;
  state: TaskState;
  priority: (typeof tasks.$inferSelect)['priority'];
  dependsOn: string[];
};

/**
 * "Continue development" (B3): picks the project's next task and starts a run for it. One click
 * runs one task; the autopilot stops at Ready for QA and never starts new work while a task waits
 * for the user's review, a run is active or a task is blocked.
 */
export class ContinueService {
  constructor(
    private readonly db: Database,
    private readonly runs: RunService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async status(projectIdOrSlug: string): Promise<ContinueStatus> {
    return (await this.evaluate(projectIdOrSlug)).status;
  }

  /** Starts the next task's run, or throws CANNOT_CONTINUE with the reason shown by `status`. */
  async start(
    projectIdOrSlug: string,
    context: ActionContext,
  ): Promise<{ task: ContinueTaskRef; run: TaskRun }> {
    const { status, projectId, state } = await this.evaluate(projectIdOrSlug);
    if (!status.canStart || !status.task) {
      throw new DomainError(ERROR_CODES.cannotContinue, status.message, {
        reason: status.reason,
        details: status.details,
      });
    }
    // Requested changes: hand the reviewer's reason to the agent, as the task page would.
    const note = state === 'changes_requested' ? await this.changeRequest(status.task.id) : null;
    const run = await this.runs.start(status.task.id, note ? { note } : {}, context);
    await recordAudit(this.db, context, {
      action: 'project.continued',
      resourceType: 'project',
      resourceId: projectId,
      metadata: { taskId: status.task.id, number: status.task.number, runId: run.id },
    });
    return { task: status.task, run };
  }

  private async evaluate(projectIdOrSlug: string): Promise<{
    status: ContinueStatus;
    projectId: string;
    state: TaskState | null;
  }> {
    const project = await findProject(this.db, projectIdOrSlug);
    const result = (status: ContinueStatus, state: TaskState | null = null) => ({
      status,
      projectId: project.id,
      state,
    });
    const stop = (
      reason: ContinueStatus['reason'],
      message: string,
      task: ContinueTaskRef | null = null,
      details: string[] = [],
    ) => result({ canStart: false, reason, message, task, details });

    if (project.status === 'archived') {
      return stop('archived', 'The project is archived; unarchive it to continue.');
    }

    const [active] = await this.db
      .select({
        id: tasks.id,
        number: tasks.number,
        title: tasks.title,
        state: taskRuns.state,
        attempt: taskRuns.attempt,
        queuedAt: taskRuns.queuedAt,
      })
      .from(taskRuns)
      .innerJoin(tasks, eq(tasks.id, taskRuns.taskId))
      .where(
        and(eq(taskRuns.projectId, project.id), inArray(taskRuns.state, [...ACTIVE_RUN_STATES])),
      )
      .limit(1);
    if (active) {
      const ref = { id: active.id, number: active.number, title: active.title };
      const waited = this.now().getTime() - active.queuedAt.getTime();
      if (active.state === 'queued' && waited > STALE_QUEUE_MS) {
        return stop(
          'running',
          `${label(ref)} has been queued for ${Math.round(waited / 60_000)} min. Is the worker running?`,
          ref,
          ['Start Workbox with `pnpm dev` (or the worker alone) so it picks up the run.'],
        );
      }
      return stop('running', `Working on ${label(ref)}.`, ref);
    }

    const rows = await this.loadTasks(project.id);
    const refOf = (task: TaskRow): ContinueTaskRef => ({
      id: task.id,
      number: task.number,
      title: task.title,
    });

    const inReview = rows.filter((task) => task.state === 'ready_for_qa');
    if (inReview.length > 0) {
      const [first, ...others] = inReview;
      return stop('waiting_for_qa', `Waiting for your review: ${label(first!)}.`, refOf(first!), [
        ...(others.length > 0
          ? [`Also waiting for review: ${others.map((t) => `#${t.number}`).join(', ')}.`]
          : []),
        'Review the pull request, then move the task to Done or Changes requested.',
      ]);
    }

    const [blocked] = rows.filter((task) => task.state === 'blocked');
    if (blocked) {
      return stop(
        'blocked',
        `${label(blocked)} is blocked: ${await this.blockedReason(blocked.id)}`,
        refOf(blocked),
        ['Open the task to run it again, or move it back to Backlog or Cancelled to skip it.'],
      );
    }

    const pick = pickNextTask(rows);
    if (pick.kind === 'none') {
      return stop('queue_empty', 'Nothing left to do: no tasks in Backlog or Changes requested.');
    }
    if (pick.kind === 'waiting_on_dependencies') {
      const deps = pick.waitingOn
        .map((dep) => `#${dep.number} (${dep.state.replaceAll('_', ' ')})`)
        .join(', ');
      return stop(
        'waiting_on_dependencies',
        `${label(pick.task)} is waiting on ${deps}.`,
        refOf(pick.task),
        ['Every remaining task depends on a task that is not done yet.'],
      );
    }

    const reasons = await this.runs.readiness(pick.task.id);
    if (reasons.length > 0) {
      return stop(
        'not_ready',
        `Next up is ${label(pick.task)}, but it can't start yet.`,
        refOf(pick.task),
        reasons,
      );
    }
    const details =
      pick.task.state === 'changes_requested'
        ? ["Requested changes come first; the reviewer's reason is passed to the agent."]
        : [];
    return result(
      {
        canStart: true,
        reason: 'ready',
        message: `Next up: ${label(pick.task)}`,
        task: refOf(pick.task),
        details,
      },
      pick.task.state,
    );
  }

  private async loadTasks(projectId: string): Promise<TaskRow[]> {
    const rows = await this.db
      .select({
        id: tasks.id,
        number: tasks.number,
        title: tasks.title,
        state: tasks.state,
        priority: tasks.priority,
      })
      .from(tasks)
      .where(and(eq(tasks.projectId, projectId), ne(tasks.state, 'cancelled')))
      .orderBy(asc(tasks.number));
    const ids = rows.map((row) => row.id);
    const edges =
      ids.length === 0
        ? []
        : await this.db
            .select()
            .from(taskDependencies)
            .where(inArray(taskDependencies.taskId, ids));
    const deps = new Map<string, string[]>();
    for (const edge of edges) {
      deps.set(edge.taskId, [...(deps.get(edge.taskId) ?? []), edge.dependsOnTaskId]);
    }
    return rows.map((row) => ({ ...row, dependsOn: deps.get(row.id) ?? [] }));
  }

  /** The reason recorded when the task entered Blocked (a run's failure includes its cause). */
  private async blockedReason(taskId: string): Promise<string> {
    const [transition] = await this.db
      .select({ reason: taskStateTransitions.reason })
      .from(taskStateTransitions)
      .where(
        and(eq(taskStateTransitions.taskId, taskId), eq(taskStateTransitions.toState, 'blocked')),
      )
      .orderBy(desc(taskStateTransitions.createdAt), desc(taskStateTransitions.id))
      .limit(1);
    return transition?.reason?.trim() || 'no reason given';
  }

  private async changeRequest(taskId: string): Promise<string | null> {
    const [transition] = await this.db
      .select({ reason: taskStateTransitions.reason })
      .from(taskStateTransitions)
      .where(
        and(
          eq(taskStateTransitions.taskId, taskId),
          eq(taskStateTransitions.toState, 'changes_requested'),
        ),
      )
      .orderBy(desc(taskStateTransitions.createdAt), desc(taskStateTransitions.id))
      .limit(1);
    const reason = transition?.reason?.trim();
    return reason ? reason.slice(0, 5_000) : null;
  }
}

function label(task: { number: number; title: string }): string {
  return `#${task.number} ${task.title}`;
}
