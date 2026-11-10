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

  async readFile(
    account: CodeHostAccount,
    token: Secret,
    repo: RepositoryRef,
    path: string,
    ref: string,
  ): Promise<string | null> {
    try {
      const { data } = await this.call<{ content?: string; encoding?: string }>(
        'GET',
        account,
        token,
        `/projects/${repo.externalId}/repository/files/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`,
      );
      if (typeof data.content !== 'string') return null;
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
    const { data } = await this.call<GitLabMergeRequest[]>(
      'GET',
      account,
      token,
      `/projects/${repo.externalId}/merge_requests?state=opened&source_branch=${encodeURIComponent(branch)}`,
    );
    return data[0] ? toReviewRequest(data[0]) : null;
  }

  async createReviewRequest(
    account: CodeHostAccount,
    token: Secret,
    repo: RepositoryRef,
    input: ReviewRequestInput,
  ): Promise<ReviewRequest> {
    const { data } = await this.call<GitLabMergeRequest>(
      'POST',
      account,
      token,
      `/projects/${repo.externalId}/merge_requests`,
      {
        source_branch: input.head,
        target_branch: input.base,
        // GitLab marks drafts by title prefix.
        title: input.draft ? `Draft: ${input.title}` : input.title,
        description: input.body,
        remove_source_branch: false,
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
    const current = await this.getReviewRequest(account, token, repo, number);
    const { data } = await this.call<GitLabMergeRequest>(
      'PUT',
      account,
      token,
      `/projects/${repo.externalId}/merge_requests/${number}`,
      {
        title: current.state === 'draft' ? `Draft: ${input.title}` : input.title,
        description: input.body,
      },
    );
    return toReviewRequest(data);
  }

  async getReviewRequest(
    account: CodeHostAccount,
    token: Secret,
    repo: RepositoryRef,
    number: number,
  ): Promise<ReviewRequest> {
    const { data } = await this.call<GitLabMergeRequest>(
      'GET',
      account,
      token,
      `/projects/${repo.externalId}/merge_requests/${number}`,
    );
    return toReviewRequest(data);
  }

  private get<T>(account: CodeHostAccount, token: Secret, path: string) {
    return this.call<T>('GET', account, token, path);
  }

  private call<T>(
    method: 'GET' | 'POST' | 'PUT',
    account: CodeHostAccount,
    token: Secret,
    path: string,
    body?: unknown,
  ) {
    const raw = token.reveal();
    return requestJson<T>(
      method,
      `${account.baseUrl.replace(/\/$/, '')}/api/v4${path}`,
      {
        providerLabel: 'GitLab',
        token: raw,
        headers: { 'private-token': raw },
        ...(body !== undefined ? { body } : {}),
      },
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

interface GitLabMergeRequest {
  iid: number;
  web_url: string;
  state: 'opened' | 'closed' | 'merged' | 'locked';
  draft?: boolean;
  work_in_progress?: boolean;
  title: string;
}

function toReviewRequest(mr: GitLabMergeRequest): ReviewRequest {
  const state =
    mr.state === 'merged'
      ? 'merged'
      : mr.state === 'closed'
        ? 'closed'
        : mr.draft || mr.work_in_progress
          ? 'draft'
          : 'open';
  return {
    number: mr.iid,
    url: mr.web_url,
    state,
    title: mr.title.replace(/^(Draft:|WIP:)\s*/i, ''),
  };
}
