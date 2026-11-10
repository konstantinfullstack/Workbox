import { healthResponseSchema, readinessResponseSchema } from '#shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { runCheck, type ReadinessCheck } from '../readiness.js';

export interface HealthRoutesOptions {
  service: string;
  version: string;
  checks: Record<string, ReadinessCheck>;
  checkTimeoutMs: number;
}

export const healthRoutes: FastifyPluginAsyncZod<HealthRoutesOptions> = async (app, options) => {
  app.get(
    '/health',
    {
      schema: {
        tags: ['system'],
        summary: 'Liveness probe',
        description: 'Returns 200 while the process is running. Does not check dependencies.',
        response: { 200: healthResponseSchema },
      },
    },
    async () => ({
      status: 'ok' as const,
      service: options.service,
      version: options.version,
      uptimeSec: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    }),
  );

  app.get(
    '/health/ready',
    {
      schema: {
        tags: ['system'],
        summary: 'Readiness probe',
        description:
          'Checks PostgreSQL and Redis connectivity. Returns 503 if any dependency is unavailable.',
        response: { 200: readinessResponseSchema, 503: readinessResponseSchema },
      },
    },
    async (request, reply) => {
      const entries = await Promise.all(
        Object.entries(options.checks).map(
          async ([name, check]) => [name, await runCheck(check, options.checkTimeoutMs)] as const,
        ),
      );

      const checks: Record<string, { status: 'up' | 'down'; latencyMs: number }> = {};
      for (const [name, outcome] of entries) {
        checks[name] = { status: outcome.status, latencyMs: outcome.latencyMs };
        if (outcome.status === 'down') {
          request.log.warn({ dependency: name, err: outcome.error }, 'readiness check failed');
        }
      }

      const ready = entries.every(([, outcome]) => outcome.status === 'up');
      return reply.code(ready ? 200 : 503).send({
        status: ready ? 'ready' : 'not_ready',
        checks,
        timestamp: new Date().toISOString(),
      });
    },
  );
};
