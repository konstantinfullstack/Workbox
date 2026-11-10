import type { Logger } from '#core';
import type { WorkspaceSyncer } from '#services';
import {
  QUEUE_NAMES,
  removeWorkspaceJobDataSchema,
  syncWorkspaceJobDataSchema,
  WORKSPACE_JOB_NAMES,
} from '#shared';
import { UnrecoverableError, Worker, type Job, type Queue } from 'bullmq';

export interface WorkspaceWorkerOptions {
  redisUrl: string;
  syncer: WorkspaceSyncer;
  logger: Logger;
  prefix?: string;
}

/**
 * Consumer for the `workspaces` queue (clone/fetch/remove). Concurrency 1: git operations on the
 * same workspace never overlap, and the machine's disk/network are not saturated.
 */
export function createWorkspaceWorker(options: WorkspaceWorkerOptions): Worker {
  const { logger, syncer } = options;
  const worker = new Worker(
    QUEUE_NAMES.workspaces,
    async (job: Job) => {
      switch (job.name) {
        case WORKSPACE_JOB_NAMES.sync: {
          const data = syncWorkspaceJobDataSchema.parse(job.data);
          const outcome = await syncer.sync(data.projectRepositoryId);
          logger.info(
            { jobId: job.id, reason: data.reason, ...outcome },
            'workspace sync finished',
          );
          return outcome;
        }
        case WORKSPACE_JOB_NAMES.remove: {
          const data = removeWorkspaceJobDataSchema.parse(job.data);
          const removed = await syncer.remove(data.projectSlug);
          logger.info({ projectSlug: data.projectSlug, removed }, 'workspace removed');
          return { removed };
        }
        default:
          throw new UnrecoverableError(`unknown job name: ${job.name}`);
      }
    },
    {
      connection: { url: options.redisUrl, maxRetriesPerRequest: null },
      concurrency: 1,
      // A clone can take a while; keep the lock alive well past BullMQ's 30 s default.
      lockDuration: 120_000,
      ...(options.prefix ? { prefix: options.prefix } : {}),
    },
  );
  worker.on('failed', (job, error) =>
    logger.warn({ jobId: job?.id, err: error }, 'workspace job failed'),
  );
  worker.on('error', (error) => logger.error({ err: error }, 'workspace worker error'));
  return worker;
}

/** Job options shared by producers: one queued sync per repository; retried on unexpected errors. */
export function syncJobOptions(projectRepositoryId: string) {
  return {
    jobId: `sync-${projectRepositoryId}`,
    attempts: 3,
    backoff: { type: 'exponential' as const, delay: 10_000 },
    removeOnComplete: true,
    removeOnFail: true,
  };
}

/** Queues a sync for every linked repository whose workspace is missing or not ready. */
export async function enqueuePendingSyncs(queue: Queue, syncer: WorkspaceSyncer): Promise<number> {
  const ids = await syncer.pending();
  for (const id of ids) {
    await queue.add(
      WORKSPACE_JOB_NAMES.sync,
      { projectRepositoryId: id, reason: 'startup' },
      syncJobOptions(id),
    );
  }
  return ids.length;
}
