import type { Services } from '#services';
import {
  errorResponseSchema,
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
