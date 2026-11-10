import { createDatabase, type DatabaseHandle } from '#database';
import { readinessResponseSchema } from '#shared';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { testDatabaseUrl, testRedisUrl } from '../../../test/support.js';

describe('readiness against real infrastructure', () => {
  let database: DatabaseHandle;
  let redis: Redis;
  let app: FastifyInstance;

  beforeAll(async () => {
    database = createDatabase({ connectionString: testDatabaseUrl() });
    redis = new Redis(testRedisUrl(), { lazyConnect: true, maxRetriesPerRequest: 1 });
    await redis.connect();
    app = await buildApp({
      version: '0.0.0-test',
      logLevel: 'silent',
      readinessChecks: {
        postgres: () => database.ping(),
        redis: async () => {
          await redis.ping();
        },
      },
    });
  });

  afterAll(async () => {
    await app.close();
    redis.disconnect();
    await database.close();
  });

  it('reports PostgreSQL and Redis as up', async () => {
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(200);
    const body = readinessResponseSchema.parse(response.json());
    expect(body.checks).toMatchObject({ postgres: { status: 'up' }, redis: { status: 'up' } });
  });

  it('reports 503 when PostgreSQL is unreachable', async () => {
    const unreachable = createDatabase({
      // Port 1 on loopback is never a Postgres server; connection is refused immediately.
      connectionString: 'postgres://workbox:unused@127.0.0.1:1/workbox',
      connectionTimeoutMillis: 1_000,
    });
    const isolated = await buildApp({
      version: '0.0.0-test',
      logLevel: 'silent',
      readinessChecks: { postgres: () => unreachable.ping() },
    });
    try {
      const response = await isolated.inject({ method: 'GET', url: '/health/ready' });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ checks: { postgres: { status: 'down' } } });
    } finally {
      await isolated.close();
      await unreachable.close();
    }
  });
});
