import type { Services } from '#services';
import {
  createProjectInputSchema,
  linkRepositoryInputSchema,
  projectRepositorySchema,
  createTaskInputSchema,
  errorResponseSchema,
  listProjectsQuerySchema,
  listTasksQuerySchema,
  projectSummarySchema,
  taskListSchema,
  taskSchema,
  updateProjectInputSchema,
} from '#shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { actionContext } from '../context.js';

const projectParams = z.object({
  project: z.string().min(1).max(100).describe('Project id (UUID) or slug'),
});
const errors = {
  400: errorResponseSchema,
  404: errorResponseSchema,
  409: errorResponseSchema,
  422: errorResponseSchema,
  502: errorResponseSchema,
  503: errorResponseSchema,
};

export const projectRoutes: FastifyPluginAsyncZod<{ services: Services }> = async (
  app,
  { services },
) => {
  app.get(
    '/projects',
    {
      schema: {
        tags: ['projects'],
        summary: 'List projects with task counts',
        querystring: listProjectsQuerySchema,
        response: { 200: z.object({ items: z.array(projectSummarySchema) }) },
      },
    },
    async (request) => ({ items: await services.projects.list(request.query) }),
  );

  app.post(
    '/projects',
    {
      schema: {
        tags: ['projects'],
        summary: 'Create a project',
        body: createProjectInputSchema,
        response: { 201: projectSummarySchema, ...errors },
      },
    },
    async (request, reply) =>
      reply.code(201).send(await services.projects.create(request.body, actionContext(request))),
  );

  app.get(
    '/projects/:project',
    {
      schema: {
        tags: ['projects'],
        summary: 'Get a project by id or slug',
        params: projectParams,
        response: { 200: projectSummarySchema, ...errors },
      },
    },
    async (request) => services.projects.get(request.params.project),
  );

  app.patch(
    '/projects/:project',
    {
      schema: {
        tags: ['projects'],
        summary: 'Update project metadata (slug is immutable)',
        params: projectParams,
        body: updateProjectInputSchema,
        response: { 200: projectSummarySchema, ...errors },
      },
    },
    async (request) =>
      services.projects.update(request.params.project, request.body, actionContext(request)),
  );

  for (const [action, status] of [
    ['archive', 'archived'],
    ['unarchive', 'active'],
  ] as const) {
    app.post(
      `/projects/:project/${action}`,
      {
        schema: {
          tags: ['projects'],
          summary: action === 'archive' ? 'Archive a project' : 'Unarchive a project',
          params: projectParams,
          response: { 200: projectSummarySchema, ...errors },
        },
      },
      async (request) =>
        services.projects.setStatus(request.params.project, status, actionContext(request)),
    );
  }

  app.get(
    '/projects/:project/repository',
    {
      schema: {
        tags: ['projects'],
        summary: "The project's linked repository (null if none)",
        params: projectParams,
        response: { 200: z.object({ repository: projectRepositorySchema.nullable() }), ...errors },
      },
    },
    async (request) => ({ repository: await services.repositories.get(request.params.project) }),
  );

  app.put(
    '/projects/:project/repository',
    {
      schema: {
        tags: ['projects'],
        summary: 'Link (or replace) the repository: fetched from the provider and access-checked',
        params: projectParams,
        body: linkRepositoryInputSchema,
        response: { 200: projectRepositorySchema, ...errors },
      },
    },
    async (request) =>
      services.repositories.link(request.params.project, request.body, actionContext(request)),
  );

  app.post(
    '/projects/:project/repository/verify',
    {
      schema: {
        tags: ['projects'],
        summary: 'Re-check repository access (also picks up renames and default-branch changes)',
        params: projectParams,
        response: { 200: projectRepositorySchema, ...errors },
      },
    },
    async (request) => services.repositories.verify(request.params.project, actionContext(request)),
  );

  app.post(
    '/projects/:project/repository/sync',
    {
      schema: {
        tags: ['projects'],
        summary: "Queue a clone/fetch of the project's repository on a worker",
        params: projectParams,
        response: { 202: projectRepositorySchema, ...errors },
      },
    },
    async (request, reply) =>
      reply
        .code(202)
        .send(
          await services.repositories.requestWorkspaceSync(
            request.params.project,
            actionContext(request),
          ),
        ),
  );

  app.delete(
    '/projects/:project/repository',
    {
      schema: {
        tags: ['projects'],
        summary: 'Unlink the repository (the account and its token are kept)',
        params: projectParams,
        response: { 204: z.null(), ...errors },
      },
    },
    async (request, reply) => {
      await services.repositories.unlink(request.params.project, actionContext(request));
      return reply.code(204).send(null);
    },
  );

  app.get(
    '/projects/:project/tasks',
    {
      schema: {
        tags: ['tasks'],
        summary: "List a project's tasks (urgent first, then by number)",
        params: projectParams,
        querystring: listTasksQuerySchema,
        response: { 200: taskListSchema, ...errors },
      },
    },
    async (request) => services.tasks.list(request.params.project, request.query),
  );

  app.post(
    '/projects/:project/tasks',
    {
      schema: {
        tags: ['tasks'],
        summary: 'Create a task (starts in backlog)',
        params: projectParams,
        body: createTaskInputSchema,
        response: { 201: taskSchema, ...errors },
      },
    },
    async (request, reply) =>
      reply
        .code(201)
        .send(
          await services.tasks.create(request.params.project, request.body, actionContext(request)),
        ),
  );
};
