import type { Logger } from '#core';
import type { Publisher, RunExecutor } from '#services';
import {
  executeRunJobDataSchema,
  publishTaskJobDataSchema,
  QUEUE_NAMES,
  RUN_JOB_NAMES,
} from '#shared';
import { UnrecoverableError, Worker, type Job, type Queue } from 'bullmq';

/**
 * Consumer for the `runs` queue. Concurrency 1: one agent run at a time on this machine. Runs are
 * long, so the job lock is renewed by BullMQ while the agent works; a crash is handled by
 * RunExecutor.recover() at the next start (the run is failed, never silently re-executed).
 */
export function createRunWorker(options: {
  redisUrl: string;
  executor: RunExecutor;
  publisher: Publisher;
  logger: Logger;
  prefix?: string;
}): Worker {
  const worker = new Worker(
    QUEUE_NAMES.runs,
    async (job: Job) => {
      if (job.name === RUN_JOB_NAMES.publish) {
        // Manual (re)publish: push the task branch and open/update its draft PR. Failures are
        // recorded on the task's git reference; the job itself completes.
        const { taskId } = publishTaskJobDataSchema.parse(job.data);
        try {
          const result = await options.publisher.publish(taskId);
          options.logger.info({ taskId, url: result.reference.reviewUrl }, 'task published');
          return { ok: true, url: result.reference.reviewUrl };
        } catch (error) {
          options.logger.warn({ taskId, err: error }, 'publish failed');
          return { ok: false };
        }
      }
      if (job.name !== RUN_JOB_NAMES.execute)
        throw new UnrecoverableError(`unknown job name: ${job.name}`);
      const { runId } = executeRunJobDataSchema.parse(job.data);
      options.logger.info({ runId }, 'run started');
      const state = await options.executor.execute(runId);
      options.logger.info({ runId, state }, 'run finished');
      return { state };
    },
    {
      connection: { url: options.redisUrl, maxRetriesPerRequest: null },
      concurrency: 1,
      lockDuration: 120_000,
      // An agent run must not be executed twice: a stalled job is failed, not retried.
      maxStalledCount: 0,
      ...(options.prefix ? { prefix: options.prefix } : {}),
    },
  );
  worker.on('failed', (job, error) =>
    options.logger.error({ jobId: job?.id, err: error }, 'run job failed'),
  );
  worker.on('error', (error) => options.logger.error({ err: error }, 'run worker error'));
  return worker;
}

export const runJobOptions = (runId: string) => ({
  jobId: `run-${runId}`,
  attempts: 1,
  removeOnComplete: 200,
  removeOnFail: 200,
});

export async function enqueueRuns(queue: Queue, runIds: string[]): Promise<void> {
  for (const runId of runIds)
    await queue.add(RUN_JOB_NAMES.execute, { runId }, runJobOptions(runId));
}
