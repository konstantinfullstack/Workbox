import type { ErrorCode } from '#shared';

/**
 * Expected business-rule failure (not found, conflict, invalid transition, ...). Interfaces map
 * `code` to their own representation (HTTP status, CLI exit code). `details` must be safe to show
 * to the user: never include secrets.
 */
export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.details = details;
  }
}

export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}
