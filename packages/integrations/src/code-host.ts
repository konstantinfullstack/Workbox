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

  /** A file's text at `ref`, or null when it doesn't exist (used for check detection). */
  readFile(
    account: CodeHostAccount,
    token: Secret,
    repo: RepositoryRef,
    path: string,
    ref: string,
  ): Promise<string | null>;

  /** The open pull/merge request whose source is `branch`, if any. */
  findOpenReviewRequest(
    account: CodeHostAccount,
    token: Secret,
    repo: RepositoryRef,
    branch: string,
  ): Promise<ReviewRequest | null>;
  createReviewRequest(
    account: CodeHostAccount,
    token: Secret,
    repo: RepositoryRef,
    input: ReviewRequestInput,
  ): Promise<ReviewRequest>;
  updateReviewRequest(
    account: CodeHostAccount,
    token: Secret,
    repo: RepositoryRef,
    number: number,
    input: { title: string; body: string },
  ): Promise<ReviewRequest>;
  getReviewRequest(
    account: CodeHostAccount,
    token: Secret,
    repo: RepositoryRef,
    number: number,
  ): Promise<ReviewRequest>;
}

/** Identifies a repository on its host: stable id plus current path (for APIs that need it). */
export interface RepositoryRef {
  externalId: string;
  fullPath: string;
}

/** A pull request (GitHub) or merge request (GitLab), normalised. */
export interface ReviewRequest {
  number: number;
  url: string;
  state: 'draft' | 'open' | 'merged' | 'closed';
  title: string;
}

export interface ReviewRequestInput {
  /** Source branch (the task branch). */
  head: string;
  /** Target branch (the default branch). */
  base: string;
  title: string;
  body: string;
  /** Always true for Workbox (D5): a human marks it ready and merges. */
  draft: true;
}

export type CodeHostErrorKind =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  | 'unavailable'
  | 'invalid_response'
  | 'invalid_url'
  /** The host refused the request as invalid (e.g. 422 "no commits between branches"). */
  | 'rejected';

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
