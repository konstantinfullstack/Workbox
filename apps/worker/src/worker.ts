import type { Logger } from '#core';
import { QUEUE_NAMES, SYSTEM_JOB_NAMES } from '#shared';
import { UnrecoverableError, Worker, type Job } from 'bullmq';
import { processPing } from './processors/ping.js';
import { processProbeAgentRuntime } from './processors/probe-agent-runtime.js';

export interface CreateSystemWorkerOptions {
  redisUrl: string;
  workerId: string;
  logger: Logger;
  concurrency?: number;
  /** Redis key prefix; override in tests to isolate queues. */
  prefix?: string;
  /** Start consuming immediately (default true). */
  autorun?: boolean;
  /** Override the Claude Code executable used by the agent-runtime probe. */
  claudeCommand?: string | undefined;
}

/**
 * Consumer for the `system` queue. Delivery is at-least-once: every processor must be idempotent.
 */
export function createSystemWorker(options: CreateSystemWorkerOptions): Worker {
  const { logger, workerId } = options;

  const worker = new Worker(
    QUEUE_NAMES.system,
    async (job: Job) => {
      switch (job.name) {
        case SYSTEM_JOB_NAMES.ping:
          return processPing(job.data, workerId);
        case SYSTEM_JOB_NAMES.probeAgentRuntime:
          return processProbeAgentRuntime(job.data, workerId, {
            claudeCommand: options.claudeCommand,
          });
        default:
          // Retrying cannot fix an unknown job type.
          throw new UnrecoverableError(`unknown job name: ${job.name}`);
      }
    },
    {
      // BullMQ owns these connections and closes them in worker.close().
      // maxRetriesPerRequest must be null for blocking worker connections.
      connection: { url: options.redisUrl, maxRetriesPerRequest: null },
      concurrency: options.concurrency ?? 1,
      autorun: options.autorun ?? true,
      ...(options.prefix ? { prefix: options.prefix } : {}),
    },
  );

  worker.on('completed', (job) => {
    logger.debug({ queue: QUEUE_NAMES.system, jobId: job.id, jobName: job.name }, 'job completed');
  });
  worker.on('failed', (job, error) => {
    logger.warn(
      { queue: QUEUE_NAMES.system, jobId: job?.id, jobName: job?.name, err: error },
      'job failed',
    );
  });
  worker.on('error', (error) => {
    logger.error({ err: error }, 'worker error');
  });

  return worker;
}
