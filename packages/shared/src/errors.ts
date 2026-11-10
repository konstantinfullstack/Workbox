import { z } from 'zod';

/** Machine-readable error codes. Clients branch on `code`, never on `message`. */
export const ERROR_CODES = {
  validation: 'VALIDATION_ERROR',
  notFound: 'NOT_FOUND',
  slugTaken: 'SLUG_TAKEN',
  versionConflict: 'VERSION_CONFLICT',
  projectArchived: 'PROJECT_ARCHIVED',
  invalidTransition: 'INVALID_TRANSITION',
  reasonRequired: 'REASON_REQUIRED',
  invalidDependency: 'INVALID_DEPENDENCY',
  credentialRejected: 'CREDENTIAL_REJECTED',
  credentialUnreadable: 'CREDENTIAL_UNREADABLE',
  codeHostUnavailable: 'CODE_HOST_UNAVAILABLE',
  connectionUnusable: 'CONNECTION_UNUSABLE',
  repositoryTaken: 'REPOSITORY_TAKEN',
  repositoryAccessDenied: 'REPOSITORY_ACCESS_DENIED',
  workerUnavailable: 'WORKER_UNAVAILABLE',
  runActive: 'RUN_ALREADY_ACTIVE',
  taskNotRunnable: 'TASK_NOT_RUNNABLE',
  runNotActive: 'RUN_NOT_ACTIVE',
  nothingToPublish: 'NOTHING_TO_PUBLISH',
  internal: 'INTERNAL_ERROR',
} as const;
export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/** Uniform error envelope returned by every API endpoint. Never includes stack traces. */
export const errorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string().optional(),
    details: z.unknown().optional(),
  }),
});
export type ErrorResponse = z.infer<typeof errorResponseSchema>;
