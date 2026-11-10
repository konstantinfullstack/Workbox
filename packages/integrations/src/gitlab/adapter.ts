import type { CredentialAuthType, CredentialCheck, RemoteRepository } from '#shared';
import type { Secret } from '#vault';
import type { CodeHostAccount, CodeHostAdapter } from '../code-host.js';
import { CodeHostError } from '../code-host.js';
import { getJson, type HttpOptions } from '../http.js';

interface GitLabTokenSelf {
  scopes: string[];
  expires_at: string | null;
  active: boolean;
  revoked: boolean;
}

interface GitLabUser {
  id?: number;
  username: string;
  bot?: boolean;
}

interface GitLabProject {
  id: number;
  path_with_namespace: string;
  name: string;
  web_url: string;
  http_url_to_repo: string;
  ssh_url_to_repo?: string;
  default_branch?: string | null;
  visibility?: string;
  permissions?: {
    project_access?: { access_level: number } | null;
    group_access?: { access_level: number } | null;
  };
}

/** GitLab access levels (https://docs.gitlab.com/api/members/#roles). */
export const GITLAB_ACCESS = { reporter: 20, developer: 30 } as const;
const REQUIRED_SCOPES = ['api', 'read_repository', 'write_repository'];
const MAX_PAGES = 10;

/** GitLab (gitlab.com and self-managed) via the REST API v4. */
export class GitLabAdapter implements CodeHostAdapter {
  readonly provider = 'gitlab' as const;

  constructor(private readonly http: HttpOptions = {}) {}

  async verifyCredential(account: CodeHostAccount, token: Secret): Promise<CredentialCheck> {
    const { data: self } = await this.get<GitLabTokenSelf>(
      account,
      token,
      '/personal_access_tokens/self',
    );
    if (!self.active || self.revoked) {
      throw new CodeHostError(
        'unauthorized',
        'GitLab reports this token as inactive or revoked',
        401,
      );
    }
    const { data: user } = await this.get<GitLabUser>(account, token, '/user');

    const tokenKind: CredentialAuthType = /^project_\d+_bot/.test(user.username)
      ? 'project_access_token'
      : /^group_\d+_bot/.test(user.username)
        ? 'group_access_token'
        : 'personal_access_token';
    const warnings: string[] = [];
    const missing = REQUIRED_SCOPES.filter((scope) => !self.scopes.includes(scope));
    if (missing.length > 0) {
      warnings.push(
        `Missing scopes: ${missing.join(', ')}. Workbox needs them to push branches and open merge requests.`,
      );
    }
    if (tokenKind === 'personal_access_token' && self.scopes.includes('api')) {
      warnings.push(
        'This personal token can reach every project you can access. A project or group access token limits that.',
      );
    }
    if (!self.expires_at)
      warnings.push('This token never expires. Consider setting an expiry date.');

    return {
      accountName: user.username,
      accountId: user.id !== undefined ? String(user.id) : null,
      tokenKind,
      scopes: self.scopes,
      // GitLab tokens expire at the start of the given day (UTC).
      expiresAt: self.expires_at ? new Date(`${self.expires_at}T00:00:00Z`).toISOString() : null,
      warnings,
    };
  }

  async listRepositories(
    account: CodeHostAccount,
    token: Secret,
    options: { search?: string | undefined; limit?: number | undefined } = {},
  ): Promise<RemoteRepository[]> {
    const limit = options.limit ?? 50;
    const results: RemoteRepository[] = [];
    const search = options.search
      ? `&search=${encodeURIComponent(options.search)}&search_namespaces=true`
      : '';
    for (let page = 1; page <= MAX_PAGES && results.length < limit; page++) {
      const { data, headers } = await this.get<GitLabProject[]>(
        account,
        token,
        `/projects?membership=true&min_access_level=${GITLAB_ACCESS.reporter}&order_by=last_activity_at&per_page=100&page=${page}${search}`,
      );
      results.push(...data.map(toRepository));
      if (!headers.get('x-next-page')) break;
    }
    return results.slice(0, limit);
  }

  async getRepository(
    account: CodeHostAccount,
    token: Secret,
    externalId: string,
  ): Promise<RemoteRepository> {
    if (!/^\d+$/.test(externalId)) {
      throw new CodeHostError('not_found', 'GitLab project ids are numeric');
    }
    const { data } = await this.get<GitLabProject>(account, token, `/projects/${externalId}`);
    return toRepository(data);
  }

  private get<T>(account: CodeHostAccount, token: Secret, path: string) {
    const raw = token.reveal();
    return getJson<T>(
      `${account.baseUrl.replace(/\/$/, '')}/api/v4${path}`,
      { providerLabel: 'GitLab', token: raw, headers: { 'private-token': raw } },
      this.http,
    );
  }
}

function toRepository(project: GitLabProject): RemoteRepository {
  const level = Math.max(
    project.permissions?.project_access?.access_level ?? 0,
    project.permissions?.group_access?.access_level ?? 0,
  );
  return {
    externalId: String(project.id),
    fullPath: project.path_with_namespace,
    name: project.name,
    webUrl: project.web_url,
    cloneUrlHttps: project.http_url_to_repo,
    cloneUrlSsh: project.ssh_url_to_repo ?? null,
    defaultBranch: project.default_branch ?? 'main',
    visibility: project.visibility ?? 'private',
    access: { pull: level >= GITLAB_ACCESS.reporter, push: level >= GITLAB_ACCESS.developer },
  };
}
