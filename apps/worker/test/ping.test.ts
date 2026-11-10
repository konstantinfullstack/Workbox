import { pingJobResultSchema } from '#shared';
import { describe, expect, it } from 'vitest';
import { processPing } from '../src/processors/ping.js';

describe('processPing', () => {
  it('returns a pong that satisfies the shared result schema', () => {
    const now = new Date('2026-11-04T12:00:01.000Z');
    const result = processPing(
      { requestedAt: '2026-11-04T12:00:00.000Z', requestedBy: 'test' },
      'worker-1',
      () => now,
    );
    expect(pingJobResultSchema.parse(result)).toEqual({
      pong: true,
      workerId: 'worker-1',
      requestedAt: '2026-11-04T12:00:00.000Z',
      processedAt: '2026-11-04T12:00:01.000Z',
    });
  });

  it('rejects malformed payloads', () => {
    expect(() => processPing({ requestedAt: 'yesterday' }, 'worker-1')).toThrow();
    expect(() => processPing(null, 'worker-1')).toThrow();
  });
});
