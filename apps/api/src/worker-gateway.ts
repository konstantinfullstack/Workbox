import { DomainError } from '#core';
import type { WorkerGateway } from '#services';
import {
  ERROR_CODES,
  probeAgentRuntimeJobResultSchema,
  QUEUE_NAMES,
  SYSTEM_JOB_NAMES,
  RUN_JOB_NAMES,
  WORKSPACE_JOB_NAMES,
  type ExecuteRunJobData,
  type PublishTaskJobData,
  type ProbeAgentRuntimeJobData,
  type RemoveWorkspaceJobData,
  type SyncWorkspaceJobData,
} from '#shared';
import { Queue, QueueEvents } from 'bullmq';

export interface BullMqWorkerGateway extends WorkerGateway {
  close(): Promise<void>;
}

/**
 * Asks a worker to run checks that must happen where agents run (e.g. "is Claude Code installed
 * and signed in on this machine?"), via the `system` queue.
 */
export function createWorkerGateway(options: {
  redisUrl: string;
  timeoutMs?: number;
  prefix?: string;
}): BullMqWorkerGateway {
  const connection = { url: options.redisUrl, maxRetriesPerRequest: null };
  const prefix = options.prefix ? { prefix: options.prefix } : {};
  let queue: Queue | undefined;
  let events: QueueEvents | undefined;
  let workspaceQueue: Queue | undefined;
  let runQueue: Queue | undefined;
  const workspaces = () =>
    (workspaceQueue ??= new Queue(QUEUE_NAMES.workspaces, { connection, ...prefix }));
  const timeoutMs = options.timeoutMs ?? 20_000;

  return {
    async probeAgentRuntime(provider) {
      queue ??= new Queue(QUEUE_NAMES.system, { connection, ...prefix });
      events ??= new QueueEvents(QUEUE_NAMES.system, { connection, ...prefix });
      await events.waitUntilReady();
      const data: ProbeAgentRuntimeJobData = { provider, requestedAt: new Date().toISOString() };
      const job = await queue.add(SYSTEM_JOB_NAMES.probeAgentRuntime, data, {
        attempts: 1,
        removeOnComplete: 50,
        removeOnFail: 50,
      });
      try {
        return probeAgentRuntimeJobResultSchema.parse(
          await job.waitUntilFinished(events, timeoutMs),
        );
      } catch (error) {
        await job.remove().catch(() => undefined); // nobody picked it up; don't let it run later
        if (error instanceof Error && /timed out/i.test(error.message)) {
          throw new DomainError(
            ERROR_CODES.workerUnavailable,
            `no worker answered within ${Math.round(timeoutMs / 1000)} s; is the worker running (pnpm dev)?`,
          );
        }
        throw error;
      }
    },
    async enqueueWorkspaceSync(projectRepositoryId, reason) {
      const data: SyncWorkspaceJobData = { projectRepositoryId, reason };
      // Same jobId while queued → duplicate requests collapse into one sync.
      await workspaces().add(WORKSPACE_JOB_NAMES.sync, data, {
        jobId: `sync-${projectRepositoryId}`,
        attempts: 3,
        backoff: { type: 'exponential', delay: 10_000 },
        removeOnComplete: true,
        removeOnFail: true,
      });
    },
    async enqueueWorkspaceRemoval(projectSlug) {
      const data: RemoveWorkspaceJobData = { projectSlug };
      await workspaces().add(WORKSPACE_JOB_NAMES.remove, data, {
        attempts: 3,
        removeOnComplete: true,
        removeOnFail: 100,
      });
    },
    async enqueueRun(runId) {
      runQueue ??= new Queue(QUEUE_NAMES.runs, { connection, ...prefix });
      const data: ExecuteRunJobData = { runId };
      // attempts 1: an agent run is never re-executed automatically.
      await runQueue.add(RUN_JOB_NAMES.execute, data, {
        jobId: `run-${runId}`,
        attempts: 1,
        removeOnComplete: 200,
        removeOnFail: 200,
      });
    },
    async enqueuePublish(taskId) {
      runQueue ??= new Queue(QUEUE_NAMES.runs, { connection, ...prefix });
      const data: PublishTaskJobData = { taskId };
      // Same jobId while queued: double clicks collapse into one publish.
      await runQueue.add(RUN_JOB_NAMES.publish, data, {
        jobId: `publish-${taskId}-${Date.now() - (Date.now() % 5_000)}`,
        attempts: 1,
        removeOnComplete: 200,
        removeOnFail: 200,
      });
    },
    async close() {
      await Promise.all([
        queue?.close(),
        events?.close(),
        workspaceQueue?.close(),
        runQueue?.close(),
      ]);
    },
  };
}
