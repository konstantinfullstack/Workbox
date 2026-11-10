import { isDomainError } from '#core';
import { ERROR_CODES, type ErrorCode, type ErrorResponse } from '#shared';
import type { FastifyError, FastifyInstance } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
} from 'fastify-type-provider-zod';

/** Converts every error into the shared ErrorResponse envelope. Internal details are logged, not returned. */
export interface ErrorHandlingOptions {
  /** Serve index.html for unknown browser routes (dashboard deep links like /tasks/:id). */
  spaFallback?: boolean;
}

const NON_SPA_PREFIXES = ['/api/', '/docs', '/health'];

export function registerErrorHandling(
  app: FastifyInstance,
  options: ErrorHandlingOptions = {},
): void {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (isDomainError(error)) {
      const body: ErrorResponse = {
        error: {
          code: error.code,
          message: error.message,
          requestId: request.id,
          ...(error.details ? { details: error.details } : {}),
        },
      };
      return reply.code(DOMAIN_ERROR_STATUS[error.code] ?? 400).send(body);
    }

    if (hasZodFastifySchemaValidationErrors(error)) {
      const body: ErrorResponse = {
        error: {
          code: ERROR_CODES.validation,
          message: 'Request validation failed',
          requestId: request.id,
          details: error.validation.map((issue) => ({
            path: issue.instancePath,
            message: issue.message,
          })),
        },
      };
      return reply.code(400).send(body);
    }

    if (isResponseSerializationError(error)) {
      request.log.error({ err: error }, 'response failed schema serialization');
      return reply.code(500).send(internalError(request.id));
    }

    const statusCode = error.statusCode ?? 500;
    if (statusCode >= 500) {
      request.log.error({ err: error }, 'unhandled error');
      return reply.code(statusCode).send(internalError(request.id));
    }

    const body: ErrorResponse = {
      error: { code: error.code ?? 'REQUEST_ERROR', message: error.message, requestId: request.id },
    };
    return reply.code(statusCode).send(body);
  });

  app.setNotFoundHandler((request, reply) => {
    const path = request.url.split('?')[0] ?? '';
    if (
      options.spaFallback &&
      request.method === 'GET' &&
      !NON_SPA_PREFIXES.some((prefix) => path.startsWith(prefix)) &&
      !/\.[a-z0-9]+$/i.test(path) &&
      (request.headers.accept ?? '').includes('text/html')
    ) {
      return reply.type('text/html').sendFile('index.html');
    }
    const body: ErrorResponse = {
      error: {
        code: 'NOT_FOUND',
        message: `Route ${request.method} ${path} not found`,
        requestId: request.id,
      },
    };
    return reply.code(404).send(body);
  });
}

function internalError(requestId: string): ErrorResponse {
  return { error: { code: ERROR_CODES.internal, message: 'Internal server error', requestId } };
}

/** HTTP status for each business-rule failure. */
const DOMAIN_ERROR_STATUS: Partial<Record<ErrorCode, number>> = {
  [ERROR_CODES.validation]: 400,
  [ERROR_CODES.notFound]: 404,
  [ERROR_CODES.slugTaken]: 409,
  [ERROR_CODES.versionConflict]: 409,
  [ERROR_CODES.projectArchived]: 409,
  [ERROR_CODES.invalidTransition]: 422,
  [ERROR_CODES.reasonRequired]: 422,
  [ERROR_CODES.invalidDependency]: 422,
  [ERROR_CODES.credentialRejected]: 422,
  [ERROR_CODES.credentialUnreadable]: 409,
  [ERROR_CODES.codeHostUnavailable]: 502,
  [ERROR_CODES.connectionUnusable]: 409,
  [ERROR_CODES.repositoryTaken]: 409,
  [ERROR_CODES.repositoryAccessDenied]: 422,
  [ERROR_CODES.workerUnavailable]: 503,
  [ERROR_CODES.runActive]: 409,
  [ERROR_CODES.taskNotRunnable]: 409,
  [ERROR_CODES.runNotActive]: 409,
};
