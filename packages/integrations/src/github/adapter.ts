import type { CredentialAuthType, CredentialCheck, RemoteRepository } from '#shared';
import type { Secret } from '#vault';
import type {
  CodeHostAccount,
  CodeHostAdapter,
  RepositoryRef,
  ReviewRequest,
  ReviewRequestInput,
} from '../code-host.js';
import { CodeHostError } from '../code-host.js';
import { requestJson, type HttpOptions } from '../http.js';

interface GitHubUser {
  login: string;
  id?: number;
}

interface GitHubRepo {
  id: number;
  full_name: string;
  name: string;
  html_url: string;
  clone_url: string;
  ssh_url?: string;
  default_branch: string;
  private: boolean;
  visibility?: string;
  permissions?: { admin?: boolean; push?: boolean; pull?: boolean };
}

const MAX_PAGES = 10;

/** GitHub (github.com and GitHub Enterprise Server) via the REST API. */
export class GitHubAdapter implements CodeHostAdapter {
  readonly provider = 'github' as const;

  constructor(private readonly http: HttpOptions = {}) {}

  async verifyCredential(account: CodeHostAccount, token: Secret): Promise<CredentialCheck> {
    const { data, headers } = await this.get<GitHubUser>(account, token, '/user');
    const raw = token.reveal();
    const tokenKind: CredentialAuthType = 'personal_access_token';
    const warnings: string[] = [];
    const scopes = (headers.get('x-oauth-scopes') ?? '')
      .split(',')
      .map((scope) => scope.trim())
      .filter(Boolean);
    if (raw.startsWith('ghp_')) {
      warnings.push(
        'This is a classic token. Its scopes apply to every repository you can access; a fine-grained token limited to selected repositories is safer.',
      );
    }
    const expiresAt = parseGitHubExpiry(headers.get('github-authentication-token-expiration'));
    if (!expiresAt && raw.startsWith('github_pat_')) {
      warnings.push('This token never expires. Consider setting an expiry date.');
    }
    return {
      accountName: data.login,
      accountId: data.id !== undefined ? String(data.id) : null,
      tokenKind,
      scopes,
      expiresAt,
      warnings,
    };
  }

  async listRepositories(
    account: CodeHostAccount,
    token: Secret,
    options: { search?: string | undefined; limit?: number | undefined } = {},
  ): Promise<RemoteRepository[]> {
    const limit = options.limit ?? 50;
    const needle = options.search?.toLowerCase();
    const results: RemoteRepository[] = [];
    // GitHub's /user/repos has no search parameter: page through and filter locally.
    for (let page = 1; page <= MAX_PAGES && results.length < limit; page++) {
      const { data, headers } = await this.get<GitHubRepo[]>(
        account,
        token,
        `/user/repos?per_page=100&page=${page}&sort=updated&affiliation=owner,collaborator,organization_member`,
      );
      for (const repo of data) {
        if (!needle || repo.full_name.toLowerCase().includes(needle))
          results.push(toRepository(repo));
      }
      if (!/rel="next"/.test(headers.get('link') ?? '')) break;
    }
    return results.slice(0, limit);
  }

  async getRepository(
    account: CodeHostAccount,
    token: Secret,
    externalId: string,
  ): Promise<RemoteRepository> {
    if (!/^\d+$/.test(externalId)) {
      throw new CodeHostError('not_found', 'GitHub repository ids are numeric');
    }
    const { data } = await this.get<GitHubRepo>(account, token, `/repositories/${externalId}`);
    return toRepository(data);
  }

  async readFile(
    account: CodeHostAccount,
    token: Secret,
    repo: RepositoryRef,
    path: string,
    ref: string,
  ): Promise<string | null> {
    try {
      const { data } = await this.call<{ content?: string; encoding?: string; type?: string }>(
        'GET',
        account,
        token,
        `/repos/${repo.fullPath}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`,
      );
      if (data.type !== 'file' || typeof data.content !== 'string') return null;
      return Buffer.from(data.content, data.encoding === 'base64' ? 'base64' : 'utf8').toString(
        'utf8',
      );
    } catch (error) {
      if (error instanceof CodeHostError && error.kind === 'not_found') return null;
      throw error;
    }
  }

  async findOpenReviewRequest(
    account: CodeHostAccount,
    token: Secret,
    repo: RepositoryRef,
    branch: string,
  ): Promise<ReviewRequest | null> {
    const owner = repo.fullPath.split('/')[0]!;
    const { data } = await this.call<GitHubPull[]>(
      'GET',
      account,
      token,
      `/repos/${repo.fullPath}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`,
    );
    return data[0] ? toReviewRequest(data[0]) : null;
  }

  async createReviewRequest(
    account: CodeHostAccount,
    token: Secret,
    repo: RepositoryRef,
    input: ReviewRequestInput,
  ): Promise<ReviewRequest> {
    const { data } = await this.call<GitHubPull>(
      'POST',
      account,
      token,
      `/repos/${repo.fullPath}/pulls`,
      {
        title: input.title,
        head: input.head,
        base: input.base,
        body: input.body,
        draft: input.draft,
      },
    );
    return toReviewRequest(data);
  }

  async updateReviewRequest(
    account: CodeHostAccount,
    token: Secret,
    repo: RepositoryRef,
    number: number,
    input: { title: string; body: string },
  ): Promise<ReviewRequest> {
    const { data } = await this.call<GitHubPull>(
      'PATCH',
      account,
      token,
      `/repos/${repo.fullPath}/pulls/${number}`,
      input,
    );
    return toReviewRequest(data);
  }

  async getReviewRequest(
    account: CodeHostAccount,
    token: Secret,
    repo: RepositoryRef,
    number: number,
  ): Promise<ReviewRequest> {
    const { data } = await this.call<GitHubPull>(
      'GET',
      account,
      token,
      `/repos/${repo.fullPath}/pulls/${number}`,
    );
    return toReviewRequest(data);
  }

  private get<T>(account: CodeHostAccount, token: Secret, path: string) {
    return this.call<T>('GET', account, token, path);
  }

  private call<T>(
    method: 'GET' | 'POST' | 'PATCH',
    account: CodeHostAccount,
    token: Secret,
    path: string,
    body?: unknown,
  ) {
    const raw = token.reveal();
    return requestJson<T>(
      method,
      `${apiRoot(account.baseUrl)}${path}`,
      {
        providerLabel: 'GitHub',
        token: raw,
        headers: {
          authorization: `Bearer ${raw}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
        },
        ...(body !== undefined ? { body } : {}),
      },
      this.http,
    );
  }
}

/** github.com uses api.github.com; Enterprise Server uses <instance>/api/v3. */
export function apiRoot(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (url.hostname === 'github.com') return 'https://api.github.com';
  return `${baseUrl.replace(/\/$/, '')}/api/v3`;
}

/** Parses GitHub's `2026-12-01 10:00:00 UTC` (or `+0000`) expiration header. */
export function parseGitHubExpiry(value: string | null): string | null {
  if (!value) return null;
  const iso = value
    .trim()
    .replace(' ', 'T')
    .replace(/\s*(UTC|\+0000)$/, 'Z');
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toRepository(repo: GitHubRepo): RemoteRepository {
  return {
    externalId: String(repo.id),
    fullPath: repo.full_name,
    name: repo.name,
    webUrl: repo.html_url,
    cloneUrlHttps: repo.clone_url,
    cloneUrlSsh: repo.ssh_url ?? null,
    defaultBranch: repo.default_branch,
    visibility: repo.visibility ?? (repo.private ? 'private' : 'public'),
    access: { pull: repo.permissions?.pull ?? false, push: repo.permissions?.push ?? false },
  };
}

interface GitHubPull {
  number: number;
  html_url: string;
  state: 'open' | 'closed';
  draft?: boolean;
  merged_at?: string | null;
  title: string;
}

function toReviewRequest(pull: GitHubPull): ReviewRequest {
  const state = pull.merged_at
    ? 'merged'
    : pull.state === 'closed'
      ? 'closed'
      : pull.draft
        ? 'draft'
        : 'open';
  return { number: pull.number, url: pull.html_url, state, title: pull.title };
}

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}
