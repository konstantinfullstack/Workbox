import { randomBytes } from 'node:crypto';
import { createLogger } from '#core';
import { pingJobResultSchema, QUEUE_NAMES, SYSTEM_JOB_NAMES } from '#shared';
import { Queue, QueueEvents, type Worker } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSystemWorker } from '../src/worker.js';
import { testRedisUrl } from '../../../test/support.js';

describe('system worker (BullMQ + Redis)', () => {
  const redisUrl = testRedisUrl();
  // Unique prefix isolates this run's keys from development queues and parallel CI jobs.
  const prefix = `workbox-test-${randomBytes(4).toString('hex')}`;
  const connection = { url: redisUrl, maxRetriesPerRequest: null };
  let queue: Queue;
  let events: QueueEvents;
  let worker: Worker;

  beforeAll(async () => {
    queue = new Queue(QUEUE_NAMES.system, { connection, prefix });
    events = new QueueEvents(QUEUE_NAMES.system, { connection, prefix });
    worker = createSystemWorker({
      redisUrl,
      prefix,
      workerId: 'test-worker',
      logger: createLogger({ service: 'worker-test', level: 'silent' }),
    });
    await Promise.all([queue.waitUntilReady(), events.waitUntilReady(), worker.waitUntilReady()]);
  });

  afterAll(async () => {
    await worker.close();
    await queue.obliterate({ force: true });
    await Promise.all([queue.close(), events.close()]);
  });

  it('processes a ping job end to end', async () => {
    const requestedAt = new Date().toISOString();
    const job = await queue.add(SYSTEM_JOB_NAMES.ping, { requestedAt, requestedBy: 'test' });
    const result = pingJobResultSchema.parse(await job.waitUntilFinished(events, 10_000));
    expect(result).toMatchObject({ pong: true, workerId: 'test-worker', requestedAt });
  });

  it('fails unknown job names without retrying', async () => {
    const job = await queue.add('unknown-job', {}, { attempts: 3 });
    await expect(job.waitUntilFinished(events, 10_000)).rejects.toThrow(/unknown job name/);
    const reloaded = await queue.getJob(job.id ?? '');
    expect(reloaded?.attemptsMade).toBe(1);
  });

  it('fails invalid ping payloads', async () => {
    const job = await queue.add(SYSTEM_JOB_NAMES.ping, { requestedAt: 'not-a-date' });
    await expect(job.waitUntilFinished(events, 10_000)).rejects.toThrow();
  });

  it('closes gracefully', async () => {
    const extra = createSystemWorker({
      redisUrl,
      prefix,
      workerId: 'closing-worker',
      logger: createLogger({ service: 'worker-test', level: 'silent' }),
    });
    await extra.waitUntilReady();
    await extra.close();
    expect(extra.isRunning()).toBe(false);
  });
});
