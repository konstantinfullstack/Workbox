import type { CodeHostProvider, CredentialCheck, RemoteRepository } from '#shared';
import type { Secret } from '#vault';

/** Where an account lives: the instance URL (https://github.com, https://gitlab.company.com). */
export interface CodeHostAccount {
  baseUrl: string;
}

/**
 * Provider-agnostic contract every code host implements (GitHub, GitLab, ...). Adapters receive
 * the token as a Secret and reveal it only when building the outgoing request.
 *
 * M5 extends this with branch, push (brokered credentials) and review-request operations.
 */
export interface CodeHostAdapter {
  readonly provider: CodeHostProvider;
  verifyCredential(account: CodeHostAccount, token: Secret): Promise<CredentialCheck>;
  listRepositories(
    account: CodeHostAccount,
    token: Secret,
    options?: { search?: string | undefined; limit?: number | undefined },
  ): Promise<RemoteRepository[]>;
  getRepository(
    account: CodeHostAccount,
    token: Secret,
    externalId: string,
  ): Promise<RemoteRepository>;
}

export type CodeHostErrorKind =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  | 'unavailable'
  | 'invalid_response'
  | 'invalid_url';

/** A failure talking to a code host. Messages are safe to show and never contain tokens. */
export class CodeHostError extends Error {
  constructor(
    readonly kind: CodeHostErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'CodeHostError';
  }
}

export function isCodeHostError(error: unknown): error is CodeHostError {
  return error instanceof CodeHostError;
}
