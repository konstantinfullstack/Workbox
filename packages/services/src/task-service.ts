import { assertTransition, DomainError, findDependencyCycle, INITIAL_TASK_STATE } from '#core';
import { projects, taskDependencies, tasks, taskStateTransitions, type Database } from '#database';
import {
  ERROR_CODES,
  type CreateTaskInput,
  type ListTasksQuery,
  type Task,
  type TaskList,
  type TaskTransition,
  type TaskState,
  type TransitionTaskInput,
  type UpdateTaskInput,
} from '#shared';
import { and, asc, count, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import { recordAudit } from './audit.js';
import type { ActionContext, Executor, Transaction } from './context.js';
import { toTask, toTransition } from './mappers.js';
import { findProject } from './project-service.js';

/** Urgent first, then high, medium, low. */
const PRIORITY_RANK = sql`CASE ${tasks.priority}
  WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END`;

export class TaskService {
  constructor(private readonly db: Database) {}

  async list(projectIdOrSlug: string, query: ListTasksQuery): Promise<TaskList> {
    const project = await findProject(this.db, projectIdOrSlug);
    const conditions: SQL[] = [eq(tasks.projectId, project.id)];
    if (query.state) conditions.push(eq(tasks.state, query.state));
    if (query.priority) conditions.push(eq(tasks.priority, query.priority));
    if (query.q) {
      const pattern = `%${escapeLike(query.q)}%`;
      conditions.push(or(ilike(tasks.title, pattern), ilike(tasks.description, pattern))!);
    }
    const where = and(...conditions);

    const [rows, [totals]] = await Promise.all([
      this.db
        .select()
        .from(tasks)
        .where(where)
        .orderBy(PRIORITY_RANK, asc(tasks.number))
        .limit(query.limit)
        .offset(query.offset),
      this.db.select({ total: count() }).from(tasks).where(where),
    ]);
    const deps = await loadDependencies(
      this.db,
      rows.map((row) => row.id),
    );
    return {
      items: rows.map((row) => toTask(row, deps.get(row.id) ?? [])),
      total: totals?.total ?? 0,
      limit: query.limit,
      offset: query.offset,
    };
  }

  async get(id: string): Promise<Task> {
    return loadTask(this.db, id);
  }

  async history(id: string): Promise<TaskTransition[]> {
    await findTaskRow(this.db, id);
    const rows = await this.db
      .select()
      .from(taskStateTransitions)
      .where(eq(taskStateTransitions.taskId, id))
      .orderBy(asc(taskStateTransitions.createdAt), asc(taskStateTransitions.id));
    return rows.map(toTransition);
  }

  async create(
    projectIdOrSlug: string,
    input: CreateTaskInput,
    context: ActionContext,
  ): Promise<Task> {
    const id = await this.db.transaction(async (tx) => {
      const project = await findProject(tx, projectIdOrSlug);
      // Atomically reserve the next number. The UPDATE also takes the project lock (see
      // lockProject), keeping the lock order project → task.
      const [reserved] = await tx
        .update(projects)
        .set({ nextTaskNumber: sql`${projects.nextTaskNumber} + 1` })
        .where(eq(projects.id, project.id))
        .returning({
          number: sql<number>`${projects.nextTaskNumber} - 1`,
          status: projects.status,
        });
      if (reserved!.status === 'archived') {
        throw new DomainError(
          ERROR_CODES.projectArchived,
          `project "${project.slug}" is archived; unarchive it to add tasks`,
        );
      }

      const [row] = await tx
        .insert(tasks)
        .values({
          projectId: project.id,
          number: reserved!.number,
          title: input.title,
          description: input.description ?? '',
          acceptanceCriteria: input.acceptanceCriteria ?? [],
          priority: input.priority ?? 'medium',
          state: INITIAL_TASK_STATE,
        })
        .returning();
      const task = row!;

      if (input.dependsOn && input.dependsOn.length > 0) {
        await setDependencies(tx, task.id, project.id, input.dependsOn);
      }
      await tx.insert(taskStateTransitions).values({
        taskId: task.id,
        fromState: null,
        toState: INITIAL_TASK_STATE,
        actor: context.actor,
      });
      await recordAudit(tx, context, {
        action: 'task.created',
        resourceType: 'task',
        resourceId: task.id,
        metadata: { projectId: project.id, number: task.number },
      });
      return task.id;
    });
    return this.get(id);
  }

  async update(id: string, input: UpdateTaskInput, context: ActionContext): Promise<Task> {
    const { expectedVersion, dependsOn, ...fields } = input;
    await this.db.transaction(async (tx) => {
      // Lock order is always project → task (same as create), so concurrent requests cannot
      // deadlock. The project lock is only needed when dependencies change.
      if (dependsOn !== undefined) {
        const { projectId } = await findTaskRow(tx, id);
        await lockProject(tx, projectId);
      }
      const existing = await findTaskRow(tx, id, { forUpdate: true });
      assertVersion(existing.version, expectedVersion);

      const changes = Object.fromEntries(
        Object.entries(fields).filter(([, value]) => value !== undefined),
      );
      if (dependsOn !== undefined) {
        await setDependencies(tx, id, existing.projectId, dependsOn);
      }
      await tx
        .update(tasks)
        .set({ ...changes, version: sql`${tasks.version} + 1`, updatedAt: sql`now()` })
        .where(eq(tasks.id, id));
      await recordAudit(tx, context, {
        action: 'task.updated',
        resourceType: 'task',
        resourceId: id,
        metadata: {
          changedFields: [
            ...Object.keys(changes),
            ...(dependsOn !== undefined ? ['dependsOn'] : []),
          ],
        },
      });
    });
    return this.get(id);
  }

  async transition(id: string, input: TransitionTaskInput, context: ActionContext): Promise<Task> {
    await this.db.transaction((tx) => transitionTaskInTx(tx, id, input, context));
    return this.get(id);
  }
}

/**
 * Validates and applies one task state change inside the caller's transaction: row lock, version
 * check, state machine, history row and audit row (ADR-005). Used by TaskService and by the
 * orchestrator, so run state and task state always change together.
 */
export async function transitionTaskInTx(
  tx: Transaction,
  id: string,
  input: TransitionTaskInput,
  context: ActionContext,
): Promise<TaskState> {
  // Row lock: concurrent transitions on the same task are serialised, and each one validates
  // against the state left by the previous one.
  const existing = await findTaskRow(tx, id, { forUpdate: true });
  assertVersion(existing.version, input.expectedVersion);
  const reason = input.reason?.trim() || null;
  assertTransition(existing.state, input.to, reason);

  await tx
    .update(tasks)
    .set({
      state: input.to,
      version: sql`${tasks.version} + 1`,
      stateChangedAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(eq(tasks.id, id));
  await tx.insert(taskStateTransitions).values({
    taskId: id,
    fromState: existing.state,
    toState: input.to,
    actor: context.actor,
    reason,
  });
  await recordAudit(tx, context, {
    action: 'task.state_changed',
    resourceType: 'task',
    resourceId: id,
    metadata: { from: existing.state, to: input.to },
  });
  return existing.state;
}

async function findTaskRow(executor: Executor, id: string, options: { forUpdate?: boolean } = {}) {
  const query = executor.select().from(tasks).where(eq(tasks.id, id)).limit(1);
  const [row] = options.forUpdate ? await query.for('no key update') : await query;
  if (!row) throw new DomainError(ERROR_CODES.notFound, `task "${id}" not found`);
  return row;
}

async function loadTask(executor: Executor, id: string): Promise<Task> {
  const row = await findTaskRow(executor, id);
  const deps = await loadDependencies(executor, [id]);
  return toTask(row, deps.get(id) ?? []);
}

async function loadDependencies(
  executor: Executor,
  taskIds: string[],
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  if (taskIds.length === 0) return result;
  const rows = await executor
    .select()
    .from(taskDependencies)
    .where(inArray(taskDependencies.taskId, taskIds))
    .orderBy(asc(taskDependencies.createdAt));
  for (const row of rows) {
    result.set(row.taskId, [...(result.get(row.taskId) ?? []), row.dependsOnTaskId]);
  }
  return result;
}

function assertVersion(actual: number, expected: number | undefined): void {
  if (expected !== undefined && expected !== actual) {
    throw new DomainError(
      ERROR_CODES.versionConflict,
      'the task was changed by someone else; reload and try again',
      { expectedVersion: expected, actualVersion: actual },
    );
  }
}

/**
 * Serialises dependency changes and task creation within a project, so two concurrent edits
 * cannot each pass the cycle check and together create a cycle.
 */
async function lockProject(tx: Transaction, projectId: string): Promise<void> {
  await tx
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.id, projectId))
    .for('no key update');
}

/**
 * Replaces a task's dependencies after validating them: same project, no self-reference, no
 * cycles. The caller must hold the project lock (see lockProject).
 */
async function setDependencies(
  tx: Transaction,
  taskId: string,
  projectId: string,
  dependsOn: readonly string[],
): Promise<void> {
  const unique = [...new Set(dependsOn)];
  if (unique.includes(taskId)) {
    throw new DomainError(ERROR_CODES.invalidDependency, 'a task cannot depend on itself');
  }

  if (unique.length > 0) {
    const found = await tx
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(inArray(tasks.id, unique), eq(tasks.projectId, projectId)));
    const foundIds = new Set(found.map((row) => row.id));
    const missing = unique.filter((id) => !foundIds.has(id));
    if (missing.length > 0) {
      throw new DomainError(
        ERROR_CODES.invalidDependency,
        'dependencies must be existing tasks in the same project',
        { missing },
      );
    }

    const edges = await tx
      .select({ taskId: taskDependencies.taskId, dependsOn: taskDependencies.dependsOnTaskId })
      .from(taskDependencies)
      .innerJoin(tasks, eq(tasks.id, taskDependencies.taskId))
      .where(eq(tasks.projectId, projectId));
    const graph = new Map<string, string[]>();
    for (const edge of edges) {
      if (edge.taskId === taskId) continue; // being replaced
      graph.set(edge.taskId, [...(graph.get(edge.taskId) ?? []), edge.dependsOn]);
    }
    const cycle = findDependencyCycle(taskId, unique, graph);
    if (cycle) {
      throw new DomainError(ERROR_CODES.invalidDependency, 'dependencies would create a cycle', {
        cycle,
      });
    }
  }

  await tx.delete(taskDependencies).where(eq(taskDependencies.taskId, taskId));
  if (unique.length > 0) {
    await tx
      .insert(taskDependencies)
      .values(unique.map((dependsOnTaskId) => ({ taskId, dependsOnTaskId })));
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}
