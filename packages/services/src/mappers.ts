import { allowedTransitions } from '#core';
import type { ProjectRow, TaskRow, TaskStateTransitionRow } from '#database';
import type { Project, Task, TaskTransition } from '#shared';

export function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    repoUrl: row.repoUrl,
    defaultBranch: row.defaultBranch,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toTask(row: TaskRow, dependsOn: string[]): Task {
  return {
    id: row.id,
    projectId: row.projectId,
    number: row.number,
    title: row.title,
    description: row.description,
    acceptanceCriteria: row.acceptanceCriteria,
    priority: row.priority,
    state: row.state,
    version: row.version,
    dependsOn,
    allowedTransitions: [...allowedTransitions(row.state)],
    stateChangedAt: row.stateChangedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toTransition(row: TaskStateTransitionRow): TaskTransition {
  return {
    id: row.id,
    taskId: row.taskId,
    fromState: row.fromState,
    toState: row.toState,
    actor: row.actor,
    reason: row.reason,
    createdAt: row.createdAt.toISOString(),
  };
}

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
