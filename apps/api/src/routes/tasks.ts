import type { Services } from '#services';
import {
  errorResponseSchema,
  taskSchema,
  taskTransitionSchema,
  transitionTaskInputSchema,
  updateTaskInputSchema,
} from '#shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { actionContext } from '../context.js';

const taskParams = z.object({ taskId: z.uuid() });
const errors = {
  400: errorResponseSchema,
  404: errorResponseSchema,
  409: errorResponseSchema,
  422: errorResponseSchema,
};

export const taskRoutes: FastifyPluginAsyncZod<{ services: Services }> = async (
  app,
  { services },
) => {
  app.get(
    '/tasks/:taskId',
    {
      schema: {
        tags: ['tasks'],
        summary: 'Get a task, including the states it may move to next',
        params: taskParams,
        response: { 200: taskSchema, ...errors },
      },
    },
    async (request) => services.tasks.get(request.params.taskId),
  );

  app.patch(
    '/tasks/:taskId',
    {
      schema: {
        tags: ['tasks'],
        summary: 'Edit task fields (not state). Send expectedVersion to avoid lost updates',
        params: taskParams,
        body: updateTaskInputSchema,
        response: { 200: taskSchema, ...errors },
      },
    },
    async (request) =>
      services.tasks.update(request.params.taskId, request.body, actionContext(request)),
  );

  app.post(
    '/tasks/:taskId/transitions',
    {
      schema: {
        tags: ['tasks'],
        summary: 'Move a task to another state',
        description:
          'Rejected with 422 INVALID_TRANSITION if the state machine forbids it, 422 REASON_REQUIRED ' +
          'for blocked/changes_requested/cancelled without a reason, and 409 VERSION_CONFLICT if ' +
          'expectedVersion is stale.',
        params: taskParams,
        body: transitionTaskInputSchema,
        response: { 200: taskSchema, ...errors },
      },
    },
    async (request) =>
      services.tasks.transition(request.params.taskId, request.body, actionContext(request)),
  );

  app.get(
    '/tasks/:taskId/history',
    {
      schema: {
        tags: ['tasks'],
        summary: 'Status history, oldest first',
        params: taskParams,
        response: { 200: z.object({ items: z.array(taskTransitionSchema) }), ...errors },
      },
    },
    async (request) => ({ items: await services.tasks.history(request.params.taskId) }),
  );
};
