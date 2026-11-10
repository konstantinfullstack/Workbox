import type { Services } from '#services';
import {
  agentRuntimeStatusSchema,
  CODE_HOSTS,
  codeHostProviderSchema,
  connectionSchema,
  createConnectionInputSchema,
  errorResponseSchema,
  listRepositoriesQuerySchema,
  remoteRepositorySchema,
  rotateConnectionInputSchema,
} from '#shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { actionContext } from '../context.js';

const idParams = z.object({ id: z.uuid() });
const errors = {
  400: errorResponseSchema,
  404: errorResponseSchema,
  409: errorResponseSchema,
  422: errorResponseSchema,
  502: errorResponseSchema,
  503: errorResponseSchema,
};

const providerSchema = z.object({
  provider: codeHostProviderSchema,
  label: z.string(),
  reviewRequestLabel: z.string(),
  defaultBaseUrl: z.string(),
  selfHosted: z.boolean(),
  tokenLabel: z.string(),
  tokenPlaceholder: z.string(),
  tokenHelp: z.object({ summary: z.string(), steps: z.array(z.string()), settingsUrl: z.string() }),
});

export const connectionRoutes: FastifyPluginAsyncZod<{ services: Services }> = async (
  app,
  { services },
) => {
  app.get(
    '/providers',
    {
      schema: {
        tags: ['connections'],
        summary: 'Supported code hosts and how to create a token for each',
        response: { 200: z.object({ items: z.array(providerSchema) }) },
      },
    },
    async () => ({
      items: Object.values(CODE_HOSTS).map((host) => ({
        ...host,
        tokenHelp: {
          ...host.tokenHelp,
          settingsUrl: host.tokenHelp.settingsUrl(host.defaultBaseUrl),
        },
      })),
    }),
  );

  app.get(
    '/connections',
    {
      schema: {
        tags: ['connections'],
        summary: 'List accounts (never includes tokens)',
        querystring: z.object({ provider: codeHostProviderSchema.optional() }),
        response: { 200: z.object({ items: z.array(connectionSchema) }) },
      },
    },
    async (request) => ({ items: await services.connections.list(request.query.provider) }),
  );

  app.post(
    '/connections',
    {
      schema: {
        tags: ['connections'],
        summary: 'Add an account. The token is verified with the provider before it is stored',
        body: createConnectionInputSchema,
        response: { 201: connectionSchema, ...errors },
      },
    },
    async (request, reply) =>
      reply.code(201).send(await services.connections.create(request.body, actionContext(request))),
  );

  app.get(
    '/connections/:id',
    {
      schema: {
        tags: ['connections'],
        summary: 'Get an account',
        params: idParams,
        response: { 200: connectionSchema, ...errors },
      },
    },
    async (request) => services.connections.get(request.params.id),
  );

  app.post(
    '/connections/:id/test',
    {
      schema: {
        tags: ['connections'],
        summary: 'Re-check the stored token with the provider (result is recorded, not thrown)',
        params: idParams,
        response: { 200: connectionSchema, ...errors },
      },
    },
    async (request) => services.connections.test(request.params.id, actionContext(request)),
  );

  app.post(
    '/connections/:id/rotate',
    {
      schema: {
        tags: ['connections'],
        summary: 'Replace the token (verified first); linked repositories are re-verified',
        params: idParams,
        body: rotateConnectionInputSchema,
        response: { 200: connectionSchema, ...errors },
      },
    },
    async (request) => {
      const context = actionContext(request);
      await services.connections.rotate(request.params.id, request.body.secret, context);
      await services.repositories.verifyAllForConnection(request.params.id, context);
      return services.connections.get(request.params.id);
    },
  );

  app.post(
    '/connections/:id/disconnect',
    {
      schema: {
        tags: ['connections'],
        summary: 'Delete the stored token; linked repositories become unverified',
        params: idParams,
        response: { 200: connectionSchema, ...errors },
      },
    },
    async (request) => services.connections.disconnect(request.params.id, actionContext(request)),
  );

  app.get(
    '/connections/:id/repositories',
    {
      schema: {
        tags: ['connections'],
        summary: 'Repositories this account can access',
        params: idParams,
        querystring: listRepositoriesQuerySchema,
        response: { 200: z.object({ items: z.array(remoteRepositorySchema) }), ...errors },
      },
    },
    async (request) => ({
      items: await services.connections.listRepositories(
        request.params.id,
        request.query,
        actionContext(request),
      ),
    }),
  );

  app.get(
    '/agent-runtimes/claude-code',
    {
      schema: {
        tags: ['connections'],
        summary: 'Last known Claude Code status on the worker machine',
        response: { 200: agentRuntimeStatusSchema },
      },
    },
    async () => services.agentRuntimes.status(),
  );

  app.post(
    '/agent-runtimes/claude-code/check',
    {
      schema: {
        tags: ['connections'],
        summary: 'Ask a worker to check that Claude Code is installed and signed in',
        response: { 200: agentRuntimeStatusSchema, ...errors },
      },
    },
    async (request) => services.agentRuntimes.check(actionContext(request)),
  );
};
