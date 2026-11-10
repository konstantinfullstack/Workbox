import { healthResponseSchema, readinessResponseSchema } from '#shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp, type BuildAppOptions } from '../src/app.js';

let app: FastifyInstance | undefined;

async function build(overrides: Partial<BuildAppOptions> = {}): Promise<FastifyInstance> {
  app = await buildApp({
    version: '0.0.0-test',
    logLevel: 'silent',
    readinessChecks: { postgres: async () => {}, redis: async () => {} },
    ...overrides,
  });
  return app;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('GET /health', () => {
  it('returns 200 with the shared liveness schema', async () => {
    const response = await (await build()).inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    const body = healthResponseSchema.parse(response.json());
    expect(body).toMatchObject({ status: 'ok', service: 'workbox-api', version: '0.0.0-test' });
  });

  it('does not depend on readiness checks', async () => {
    const instance = await build({
      readinessChecks: { postgres: () => Promise.reject(new Error('down')) },
    });
    const response = await instance.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
  });
});

describe('GET /health/ready', () => {
  it('returns 200 when all dependencies are up', async () => {
    const response = await (await build()).inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(200);
    const body = readinessResponseSchema.parse(response.json());
    expect(body.status).toBe('ready');
    expect(body.checks.postgres?.status).toBe('up');
    expect(body.checks.redis?.status).toBe('up');
  });

  it('returns 503 and hides error details when a dependency is down', async () => {
    const instance = await build({
      readinessChecks: {
        postgres: async () => {},
        redis: () => Promise.reject(new Error('ECONNREFUSED redis://:hunter2@cache:6379')),
      },
    });
    const response = await instance.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(503);
    const body = readinessResponseSchema.parse(response.json());
    expect(body.status).toBe('not_ready');
    expect(body.checks.postgres?.status).toBe('up');
    expect(body.checks.redis?.status).toBe('down');
    expect(response.body).not.toContain('hunter2');
    expect(response.body).not.toContain('ECONNREFUSED');
  });

  it('marks a hanging dependency as down after the timeout', async () => {
    const instance = await build({
      readinessTimeoutMs: 50,
      readinessChecks: { postgres: () => new Promise<void>(() => {}) },
    });
    const response = await instance.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ checks: { postgres: { status: 'down' } } });
  });
});

describe('cross-cutting behaviour', () => {
  it('echoes a well-formed x-request-id and replaces a malformed one', async () => {
    const instance = await build();
    const echoed = await instance.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': 'trace-abc_123' },
    });
    expect(echoed.headers['x-request-id']).toBe('trace-abc_123');

    const replaced = await instance.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': 'bad id\nwith newline' },
    });
    expect(replaced.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('returns the shared error envelope for unknown routes', async () => {
    const response = await (await build()).inject({ method: 'GET', url: '/does-not-exist?x=1' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      error: { code: 'NOT_FOUND', message: 'Route GET /does-not-exist not found' },
    });
  });

  it('publishes an OpenAPI document containing the health routes', async () => {
    const response = await (await build()).inject({ method: 'GET', url: '/docs/json' });
    expect(response.statusCode).toBe(200);
    const spec = response.json<{ openapi: string; paths: Record<string, unknown> }>();
    expect(spec.openapi).toMatch(/^3\./);
    expect(Object.keys(spec.paths)).toEqual(expect.arrayContaining(['/health', '/health/ready']));
  });

  it('can disable API docs', async () => {
    const response = await (
      await build({ docs: false })
    ).inject({ method: 'GET', url: '/docs/json' });
    expect(response.statusCode).toBe(404);
  });

  it('does not emit CORS headers unless origins are configured', async () => {
    const closed = await (
      await build()
    ).inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://evil.example' },
    });
    expect(closed.headers['access-control-allow-origin']).toBeUndefined();
    await app?.close();

    const open = await (
      await build({ corsOrigins: ['http://localhost:5173'] })
    ).inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'http://localhost:5173' },
    });
    expect(open.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });
});
