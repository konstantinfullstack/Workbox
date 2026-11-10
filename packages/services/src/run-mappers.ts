import { homedir } from 'node:os';
import type { RunEventRow, TaskRunRow } from '#database';
import type { RunEvent, TaskRun } from '#shared';

const HOME = homedir();
export const displayPath = (path: string | null) =>
  path && path.startsWith(`${HOME}/`) ? `~${path.slice(HOME.length)}` : path;

export function toTaskRun(row: TaskRunRow): TaskRun {
  return {
    id: row.id,
    taskId: row.taskId,
    projectId: row.projectId,
    attempt: row.attempt,
    state: row.state,
    agent: row.agent,
    branch: row.branch,
    baseSha: row.baseSha,
    commitSha: row.commitSha,
    worktreePath: displayPath(row.worktreePath),
    summary: row.summary,
    qaSteps: row.qaSteps,
    changedFiles: row.changedFiles,
    verification: row.verification,
    checkResults: row.checkResults,
    exitReason: row.exitReason,
    costUsd: row.costUsd,
    durationMs: row.durationMs,
    cancelRequested: row.cancelRequestedAt !== null,
    queuedAt: row.queuedAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

export function toRunEvent(row: RunEventRow): RunEvent {
  return {
    seq: row.seq,
    type: row.type,
    message: row.message,
    data: row.data,
    createdAt: row.createdAt.toISOString(),
  };
}
