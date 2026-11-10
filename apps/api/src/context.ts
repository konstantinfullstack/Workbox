import type { ActionContext } from '#services';
import { LOCAL_USER_ACTOR } from '#shared';
import type { FastifyRequest } from 'fastify';

/**
 * Workbox is single-user and local-only for now (see docs/plans/M2-projects-tasks-admin.md, D6),
 * so every request acts as the local user. ADR-002 will replace this with authenticated actors.
 */
export function actionContext(request: FastifyRequest): ActionContext {
  return { actor: LOCAL_USER_ACTOR, traceId: request.id };
}
