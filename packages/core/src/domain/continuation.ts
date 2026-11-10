import type { TaskPriority, TaskState } from '#shared';

/** What "Continue development" needs to know about each task of a project. */
export interface ContinuationTask {
  id: string;
  number: number;
  state: TaskState;
  priority: TaskPriority;
  dependsOn: readonly string[];
}

/** States "Continue development" picks from: requested changes first, then the backlog. */
export const CONTINUABLE_TASK_STATES: readonly TaskState[] = ['changes_requested', 'backlog'];

const PRIORITY_RANK: Record<TaskPriority, number> = { urgent: 0, high: 1, medium: 2, low: 3 };

export type NextTaskPick<T extends ContinuationTask> =
  | { kind: 'task'; task: T }
  /** Every candidate depends on a task that isn't done; `waitingOn` explains the first one. */
  | { kind: 'waiting_on_dependencies'; task: T; waitingOn: T[] }
  | { kind: 'none' };

/**
 * Picks the next task to work on (B3):
 * 1. tasks with requested changes come before new work, so reviews get closed first
 * 2. then backlog tasks
 * 3. within each group: highest priority, then lowest number
 * A task is skipped while any of its dependencies is not done.
 */
export function pickNextTask<T extends ContinuationTask>(tasks: readonly T[]): NextTaskPick<T> {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const candidates = tasks
    .filter((task) => CONTINUABLE_TASK_STATES.includes(task.state))
    .sort(
      (a, b) =>
        CONTINUABLE_TASK_STATES.indexOf(a.state) - CONTINUABLE_TASK_STATES.indexOf(b.state) ||
        PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
        a.number - b.number,
    );
  if (candidates.length === 0) return { kind: 'none' };

  const unfinished = (task: T) =>
    task.dependsOn
      .map((id) => byId.get(id))
      .filter((dep): dep is T => dep !== undefined && dep.state !== 'done');
  for (const task of candidates) {
    if (unfinished(task).length === 0) return { kind: 'task', task };
  }
  const first = candidates[0]!;
  return { kind: 'waiting_on_dependencies', task: first, waitingOn: unfinished(first) };
}
