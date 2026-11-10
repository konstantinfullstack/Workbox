import { randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger, DomainError } from '#core';
import { afterAll, describe, expect, it } from 'vitest';
import { createSystemWorker } from '../../worker/src/worker.js';
import { testRedisUrl } from '../../../test/support.js';
import { createWorkerGateway } from '../src/worker-gateway.js';

const dir = mkdtempSync(join(tmpdir(), 'workbox-gateway-'));
const fakeClaude = join(dir, 'claude');
writeFileSync(
  fakeClaude,
  `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "9.9.9 (Claude Code)"; else echo '{"loggedIn":true,"authMethod":"claude.ai"}'; fi\n`,
);
chmodSync(fakeClaude, 0o755);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('worker gateway (API → Redis → worker)', () => {
  it('runs the agent-runtime probe on a worker and returns its result', async () => {
    const prefix = `wb-gw-${randomBytes(4).toString('hex')}`;
    const worker = createSystemWorker({
      redisUrl: testRedisUrl(),
      prefix,
      workerId: 'gateway-test-worker',
      claudeCommand: fakeClaude,
      logger: createLogger({ service: 'test', level: 'silent' }),
    });
    const gateway = createWorkerGateway({ redisUrl: testRedisUrl(), prefix, timeoutMs: 10_000 });
    try {
      await worker.waitUntilReady();
      expect(await gateway.probeAgentRuntime('claude_code')).toMatchObject({
        workerId: 'gateway-test-worker',
        installed: true,
        version: '9.9.9',
        loggedIn: true,
        ok: true,
      });
    } finally {
      await gateway.close();
      await worker.close();
    }
  });

  it('reports WORKER_UNAVAILABLE when no worker answers', async () => {
    const gateway = createWorkerGateway({
      redisUrl: testRedisUrl(),
      prefix: `wb-gw-${randomBytes(4).toString('hex')}`,
      timeoutMs: 500,
    });
    try {
      const error = await gateway.probeAgentRuntime('claude_code').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).code).toBe('WORKER_UNAVAILABLE');
    } finally {
      await gateway.close();
    }
  });
});
