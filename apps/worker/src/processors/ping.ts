import { pingJobDataSchema, type PingJobResult } from '#shared';

/**
 * No-op job that proves the queue round-trip (producer → Redis → worker → result).
 * Input is validated because queue payloads are untrusted at the consumer boundary.
 */
export function processPing(
  data: unknown,
  workerId: string,
  now: () => Date = () => new Date(),
): PingJobResult {
  const parsed = pingJobDataSchema.parse(data);
  return {
    pong: true,
    workerId,
    requestedAt: parsed.requestedAt,
    processedAt: now().toISOString(),
  };
}
