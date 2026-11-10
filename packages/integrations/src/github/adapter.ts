import type { CredentialAuthType, CredentialCheck, RemoteRepository } from '#shared';
import type { Secret } from '#vault';
import type { CodeHostAccount, CodeHostAdapter } from '../code-host.js';
import { CodeHostError } from '../code-host.js';
import { getJson, type HttpOptions } from '../http.js';

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

  private get<T>(account: CodeHostAccount, token: Secret, path: string) {
    const raw = token.reveal();
    return getJson<T>(
      `${apiRoot(account.baseUrl)}${path}`,
      {
        providerLabel: 'GitHub',
        token: raw,
        headers: {
          authorization: `Bearer ${raw}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
        },
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
