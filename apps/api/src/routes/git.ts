import type { Services } from '#services';
import {
  checksDetectionSchema,
  confirmChecksInputSchema,
  errorResponseSchema,
  gitReferenceSchema,
  projectChecksSchema,
} from '#shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { actionContext } from '../context.js';

const projectParams = z.object({ project: z.string().min(1).max(100) });
const taskParams = z.object({ taskId: z.uuid() });
const errors = {
  400: errorResponseSchema,
  404: errorResponseSchema,
  409: errorResponseSchema,
  422: errorResponseSchema,
  502: errorResponseSchema,
  503: errorResponseSchema,
};

const taskGitSchema = z.object({
  branch: z.string().nullable(),
  localCommitSha: z.string().nullable(),
  reference: gitReferenceSchema.nullable(),
});

export const gitRoutes: FastifyPluginAsyncZod<{ services: Services }> = async (
  app,
  { services },
) => {
  app.get(
    '/projects/:project/checks',
    {
      schema: {
        tags: ['checks'],
        summary: "The project's confirmed check commands",
        params: projectParams,
        response: { 200: projectChecksSchema, ...errors },
      },
    },
    async (request) => services.checks.get(request.params.project),
  );

  app.post(
    '/projects/:project/checks/detect',
    {
      schema: {
        tags: ['checks'],
        summary: 'Propose check commands from repository files (nothing is saved)',
        params: projectParams,
        response: { 200: checksDetectionSchema, ...errors },
      },
    },
    async (request) => services.checks.detect(request.params.project, actionContext(request)),
  );

  app.put(
    '/projects/:project/checks',
    {
      schema: {
        tags: ['checks'],
        summary: 'Confirm (or edit) the check commands; an empty list means "no automatic checks"',
        params: projectParams,
        body: confirmChecksInputSchema,
        response: { 200: projectChecksSchema, ...errors },
      },
    },
    async (request) =>
      services.checks.confirm(request.params.project, request.body, actionContext(request)),
  );

  app.get(
    '/tasks/:taskId/git',
    {
      schema: {
        tags: ['git'],
        summary:
          "The task's branch, latest commit and pull/merge request (PR state refreshed from the host)",
        params: taskParams,
        response: { 200: taskGitSchema, ...errors },
      },
    },
    async (request) => services.git.get(request.params.taskId, actionContext(request)),
  );

  app.post(
    '/tasks/:taskId/publish',
    {
      schema: {
        tags: ['git'],
        summary: "Push the task's branch and open/update its draft pull request (on a worker)",
        params: taskParams,
        response: { 202: z.object({ queued: z.literal(true) }), ...errors },
      },
    },
    async (request, reply) => {
      await services.git.requestPublish(request.params.taskId, actionContext(request));
      return reply.code(202).send({ queued: true as const });
    },
  );
};
