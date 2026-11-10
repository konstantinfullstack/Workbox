import { createReadStream } from 'node:fs';
import { DomainError } from '#core';
import type { Services } from '#services';
import {
  continueStatusSchema,
  continueTaskRefSchema,
  errorResponseSchema,
  runArtifactSchema,
  ERROR_CODES,
  runDiffSchema,
  runEventSchema,
  runEventsQuerySchema,
  startRunInputSchema,
  taskRunSchema,
} from '#shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { actionContext } from '../context.js';

const taskParams = z.object({ taskId: z.uuid() });
const runParams = z.object({ runId: z.uuid() });
const projectParams = z.object({ project: z.string().min(1).max(100) });
const errors = {
  400: errorResponseSchema,
  404: errorResponseSchema,
  409: errorResponseSchema,
  422: errorResponseSchema,
  503: errorResponseSchema,
};

export const runRoutes: FastifyPluginAsyncZod<{ services: Services }> = async (
  app,
  { services },
) => {
  app.get(
    '/projects/:project/continue',
    {
      schema: {
        tags: ['runs'],
        summary: 'What "Continue development" would do next, or why it stopped',
        params: projectParams,
        response: { 200: continueStatusSchema, ...errors },
      },
    },
    async (request) => services.continuation.status(request.params.project),
  );

  app.post(
    '/projects/:project/continue',
    {
      schema: {
        tags: ['runs'],
        summary: "Start a run for the project's next task (stops at Ready for QA)",
        params: projectParams,
        response: {
          202: z.object({ task: continueTaskRefSchema, run: taskRunSchema }),
          ...errors,
        },
      },
    },
    async (request, reply) =>
      reply
        .code(202)
        .send(await services.continuation.start(request.params.project, actionContext(request))),
  );

  app.get(
    '/tasks/:taskId/run-readiness',
    {
      schema: {
        tags: ['runs'],
        summary: 'Why the task cannot run right now (empty list = it can)',
        params: taskParams,
        response: {
          200: z.object({ ready: z.boolean(), reasons: z.array(z.string()) }),
          ...errors,
        },
      },
    },
    async (request) => {
      const reasons = await services.runs.readiness(request.params.taskId);
      return { ready: reasons.length === 0, reasons };
    },
  );

  app.post(
    '/tasks/:taskId/runs',
    {
      schema: {
        tags: ['runs'],
        summary: 'Start an agent run for this task (moves the task to in_progress)',
        params: taskParams,
        body: startRunInputSchema,
        response: { 202: taskRunSchema, ...errors },
      },
    },
    async (request, reply) =>
      reply
        .code(202)
        .send(
          await services.runs.start(request.params.taskId, request.body, actionContext(request)),
        ),
  );

  app.get(
    '/tasks/:taskId/runs',
    {
      schema: {
        tags: ['runs'],
        summary: "The task's runs, newest first",
        params: taskParams,
        response: { 200: z.object({ items: z.array(taskRunSchema) }), ...errors },
      },
    },
    async (request) => ({ items: await services.runs.list(request.params.taskId) }),
  );

  app.get(
    '/runs/:runId',
    {
      schema: {
        tags: ['runs'],
        summary: 'Get a run',
        params: runParams,
        response: { 200: taskRunSchema, ...errors },
      },
    },
    async (request) => services.runs.get(request.params.runId),
  );

  app.get(
    '/runs/:runId/events',
    {
      schema: {
        tags: ['runs'],
        summary: 'Run timeline after a sequence number (poll with ?after=<last seq>)',
        params: runParams,
        querystring: runEventsQuerySchema,
        response: { 200: z.object({ items: z.array(runEventSchema) }), ...errors },
      },
    },
    async (request) => ({
      items: await services.runs.events(
        request.params.runId,
        request.query.after,
        request.query.limit,
      ),
    }),
  );

  app.get(
    '/runs/:runId/diff',
    {
      schema: {
        tags: ['runs'],
        summary: "The run's changes as a unified diff",
        params: runParams,
        response: { 200: runDiffSchema, ...errors },
      },
    },
    async (request) => services.runs.diff(request.params.runId),
  );

  app.get(
    '/runs/:runId/artifacts',
    {
      schema: {
        tags: ['runs'],
        summary: "The run's saved files (transcript, full check output, patch) until they expire",
        params: runParams,
        response: { 200: z.object({ items: z.array(runArtifactSchema) }), ...errors },
      },
    },
    async (request) => ({
      items: services.artifacts ? await services.artifacts.list(request.params.runId) : [],
    }),
  );

  app.get(
    '/runs/:runId/artifacts/:artifactId',
    {
      schema: {
        tags: ['runs'],
        summary: 'One saved file, as plain text (add ?download=1 to save it)',
        params: z.object({ runId: z.uuid(), artifactId: z.uuid() }),
        querystring: z.object({ download: z.enum(['0', '1']).optional() }),
        // A file stream (text/plain); streams are sent as-is, never serialized.
        response: { 200: z.unknown().describe('The file (text/plain)'), ...errors },
      },
    },
    async (request, reply) => {
      if (!services.artifacts) {
        throw new DomainError(ERROR_CODES.notFound, 'no artifacts folder is configured');
      }
      const { artifact, path } = await services.artifacts.open(
        request.params.runId,
        request.params.artifactId,
      );
      const filename = artifact.name
        .split('/')
        .at(-1)!
        .replace(/[^\w.-]/g, '_');
      return reply
        .header('content-type', 'text/plain; charset=utf-8')
        .header('x-content-type-options', 'nosniff')
        .header('content-security-policy', "default-src 'none'")
        .header(
          'content-disposition',
          `${request.query.download === '1' ? 'attachment' : 'inline'}; filename="${filename}"`,
        )
        .send(createReadStream(path));
    },
  );

  app.post(
    '/runs/:runId/cancel',
    {
      schema: {
        tags: ['runs'],
        summary: 'Cancel a queued or active run',
        params: runParams,
        response: { 200: taskRunSchema, ...errors },
      },
    },
    async (request) => services.runs.cancel(request.params.runId, actionContext(request)),
  );
};
