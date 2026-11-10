import { randomUUID } from 'node:crypto';
import fastifyCors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import { loggerOptions } from '#core';
import Fastify, { LogController, type FastifyInstance } from 'fastify';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { Services } from '#services';
import { registerErrorHandling } from './plugins/error-handler.js';
import type { ReadinessCheck } from './readiness.js';
import { healthRoutes } from './routes/health.js';
import { connectionRoutes } from './routes/connections.js';
import { gitRoutes } from './routes/git.js';
import { projectRoutes } from './routes/projects.js';
import { runRoutes } from './routes/runs.js';
import { taskRoutes } from './routes/tasks.js';

export const SERVICE_NAME = 'workbox-api';
export const API_PREFIX = '/api/v1';
const REQUEST_ID_HEADER = 'x-request-id';
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

export interface BuildAppOptions {
  version: string;
  logLevel?: string;
  /** Allowed CORS origins. Empty array disables CORS headers entirely. */
  corsOrigins?: string[];
  /** Named readiness probes, e.g. `{ postgres, redis }`. */
  readinessChecks: Record<string, ReadinessCheck>;
  readinessTimeoutMs?: number;
  /** Serve OpenAPI JSON and Swagger UI under /docs. */
  docs?: boolean;
  /** Where logs go (default stdout). Tests capture logs here to assert nothing secret is logged. */
  logStream?: { write(line: string): void };
  /** Domain services. When omitted (e.g. health-only tests), /api/v1 routes are not registered. */
  services?: Services;
  /**
   * Directory holding the built dashboard (index.html + assets). When set, it is served at `/`
   * and unknown non-API GET routes fall back to index.html for client-side routing.
   */
  webRoot?: string;
}

/**
 * Builds a fully configured Fastify instance without binding a port. Dependencies are injected so
 * tests can exercise the app with `app.inject()` and stubbed probes.
 */
export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      ...loggerOptions(SERVICE_NAME, options.logLevel ?? 'info'),
      ...(options.logStream ? { stream: options.logStream } : {}),
    },
    // Accept a caller-supplied request id only if it is well-formed; otherwise generate one.
    genReqId: (req) => {
      const incoming = req.headers[REQUEST_ID_HEADER];
      return typeof incoming === 'string' && REQUEST_ID_PATTERN.test(incoming)
        ? incoming
        : randomUUID();
    },
    logController: new LogController({
      requestIdLogLabel: 'requestId',
      // Probes hit these every few seconds; logging each request would drown useful output.
      // Failed readiness checks are still logged explicitly by the route.
      disableRequestLogging: (request) => request.url.startsWith('/health'),
    }),
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.addHook('onRequest', async (request, reply) => {
    reply.header(REQUEST_ID_HEADER, request.id);
  });

  registerErrorHandling(app, { spaFallback: Boolean(options.webRoot) });

  await app.register(fastifyCors, {
    origin: options.corsOrigins && options.corsOrigins.length > 0 ? options.corsOrigins : false,
  });

  if (options.docs ?? true) {
    await app.register(fastifySwagger, {
      openapi: {
        info: {
          title: 'Workbox API',
          description: 'Workbox control-plane API',
          version: options.version,
        },
        tags: [
          { name: 'system', description: 'Health and operational endpoints' },
          { name: 'projects', description: 'Projects and repository metadata' },
          { name: 'tasks', description: 'Tasks, state transitions and history' },
          { name: 'connections', description: 'Accounts on code hosts and agent runtimes' },
          { name: 'runs', description: 'Agent runs: start, follow, cancel, review changes' },
          { name: 'checks', description: 'Per-project verification commands' },
          { name: 'git', description: 'Task branches and draft pull/merge requests' },
        ],
      },
      transform: jsonSchemaTransform,
    });
    await app.register(fastifySwaggerUi, { routePrefix: '/docs' });
  }

  await app.register(healthRoutes, {
    service: SERVICE_NAME,
    version: options.version,
    checks: options.readinessChecks,
    checkTimeoutMs: options.readinessTimeoutMs ?? 2_000,
  });

  if (options.webRoot) {
    await app.register(fastifyStatic, { root: options.webRoot, prefix: '/', index: 'index.html' });
  }

  if (options.services) {
    const services = options.services;
    await app.register(
      async (api) => {
        await api.register(projectRoutes, { services });
        await api.register(taskRoutes, { services });
        await api.register(connectionRoutes, { services });
        await api.register(runRoutes, { services });
        await api.register(gitRoutes, { services });
      },
      { prefix: API_PREFIX },
    );
  }

  return app;
}
