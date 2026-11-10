/**
 * In-process fake GitHub and GitLab APIs for tests. They implement only the endpoints Workbox
 * calls, with realistic status codes, headers and pagination, and record every request so tests
 * can assert on what was sent.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeRepo {
  id: number;
  fullPath: string;
  defaultBranch?: string;
  visibility?: 'public' | 'private' | 'internal';
  /** GitHub: pull/push flags. GitLab: derived from accessLevel. */
  pull?: boolean;
  push?: boolean;
  /** GitLab access level (20 reporter, 30 developer, 40 maintainer). */
  accessLevel?: number;
  /** Override the https clone URL (e.g. point it at a test git server). */
  cloneUrl?: string;
}

export interface FakeToken {
  account: string;
  /** Numeric account id (defaults to 1000). */
  accountId?: number;
  repos: FakeRepo[];
  /** GitHub: x-oauth-scopes header. GitLab: token scopes. */
  scopes?: string[];
  /** GitHub: `2026-12-01 10:00:00 UTC`. GitLab: `2026-12-01`. */
  expiresAt?: string | null;
  revoked?: boolean;
}

export interface FakeCodeHost {
  baseUrl: string;
  tokens: Map<string, FakeToken>;
  requests: Array<{ method: string; path: string; headers: IncomingMessage['headers'] }>;
  /** Make the next N requests fail with this status (and optional headers). */
  failNext(status: number, times?: number, headers?: Record<string, string>): void;
  /** Delay every response (to exercise timeouts). */
  delayMs: number;
  close(): Promise<void>;
}

type Handler = (url: URL, token: FakeToken | undefined, res: ServerResponse) => void;

async function startFake(
  route: (path: string) => Handler | undefined,
  tokenOf: (req: IncomingMessage) => string | undefined,
): Promise<FakeCodeHost> {
  const tokens = new Map<string, FakeToken>();
  const requests: FakeCodeHost['requests'] = [];
  const failures: Array<{ status: number; headers: Record<string, string> }> = [];
  const state = { delayMs: 0 };

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fake');
    requests.push({
      method: req.method ?? 'GET',
      path: url.pathname + url.search,
      headers: req.headers,
    });
    const respond = () => {
      const failure = failures.shift();
      if (failure)
        return json(
          res,
          failure.status,
          { message: `simulated ${failure.status}` },
          failure.headers,
        );
      const handler = route(url.pathname);
      if (!handler) return json(res, 404, { message: 'Not Found' });
      const raw = tokenOf(req);
      handler(url, raw ? tokens.get(raw) : undefined, res);
    };
    if (state.delayMs > 0) setTimeout(respond, state.delayMs);
    else respond();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    tokens,
    requests,
    failNext(status, times = 1, headers = {}) {
      for (let i = 0; i < times; i++) failures.push({ status, headers });
    },
    get delayMs() {
      return state.delayMs;
    },
    set delayMs(value: number) {
      state.delayMs = value;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function json(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

function paginate<T>(items: T[], url: URL): { page: T[]; hasNext: boolean; pageNumber: number } {
  const perPage = Number(url.searchParams.get('per_page') ?? 30);
  const pageNumber = Number(url.searchParams.get('page') ?? 1);
  const start = (pageNumber - 1) * perPage;
  return {
    page: items.slice(start, start + perPage),
    hasNext: start + perPage < items.length,
    pageNumber,
  };
}

// ---------------------------------------------------------------------------------------------
// GitHub (served as Enterprise-style /api/v3 because the base URL is not github.com)

export function startFakeGitHub(): Promise<FakeCodeHost> {
  const unauthorized = (res: ServerResponse) => json(res, 401, { message: 'Bad credentials' });
  const repoJson = (repo: FakeRepo, base: string) => ({
    id: repo.id,
    full_name: repo.fullPath,
    name: repo.fullPath.split('/').at(-1),
    html_url: `${base}/${repo.fullPath}`,
    clone_url: repo.cloneUrl ?? `${base}/${repo.fullPath}.git`,
    ssh_url: `git@fake-github:${repo.fullPath}.git`,
    default_branch: repo.defaultBranch ?? 'main',
    private: (repo.visibility ?? 'private') !== 'public',
    visibility: repo.visibility ?? 'private',
    permissions: { pull: repo.pull ?? true, push: repo.push ?? true, admin: false },
  });
  let base = '';
  const host = startFake(
    (path) => {
      if (path === '/api/v3/user')
        return (_url, token, res) => {
          if (!token || token.revoked) return unauthorized(res);
          const headers: Record<string, string> = {};
          if (token.scopes) headers['x-oauth-scopes'] = token.scopes.join(', ');
          if (token.expiresAt) headers['github-authentication-token-expiration'] = token.expiresAt;
          json(res, 200, { login: token.account, id: token.accountId ?? 1000 }, headers);
        };
      if (path === '/api/v3/user/repos')
        return (url, token, res) => {
          if (!token || token.revoked) return unauthorized(res);
          const { page, hasNext, pageNumber } = paginate(token.repos, url);
          const headers: Record<string, string> = hasNext
            ? { link: `<${base}/api/v3/user/repos?page=${pageNumber + 1}>; rel="next"` }
            : {};
          json(
            res,
            200,
            page.map((repo) => repoJson(repo, base)),
            headers,
          );
        };
      const match = /^\/api\/v3\/repositories\/(\d+)$/.exec(path);
      if (match)
        return (_url, token, res) => {
          if (!token || token.revoked) return unauthorized(res);
          const repo = token.repos.find((r) => String(r.id) === match[1]);
          if (!repo) return json(res, 404, { message: 'Not Found' });
          json(res, 200, repoJson(repo, base));
        };
      return undefined;
    },
    (req) => /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1],
  );
  return host.then((fake) => {
    base = fake.baseUrl;
    return fake;
  });
}

// ---------------------------------------------------------------------------------------------
// GitLab (/api/v4)

export function startFakeGitLab(): Promise<FakeCodeHost> {
  const unauthorized = (res: ServerResponse) => json(res, 401, { message: '401 Unauthorized' });
  let base = '';
  const projectJson = (repo: FakeRepo) => ({
    id: repo.id,
    path_with_namespace: repo.fullPath,
    name: repo.fullPath.split('/').at(-1),
    web_url: `${base}/${repo.fullPath}`,
    http_url_to_repo: repo.cloneUrl ?? `${base}/${repo.fullPath}.git`,
    ssh_url_to_repo: `git@fake-gitlab:${repo.fullPath}.git`,
    default_branch: repo.defaultBranch ?? 'main',
    visibility: repo.visibility ?? 'private',
    permissions: { project_access: { access_level: repo.accessLevel ?? 30 }, group_access: null },
  });
  const host = startFake(
    (path) => {
      if (path === '/api/v4/personal_access_tokens/self')
        return (_url, token, res) => {
          if (!token) return unauthorized(res);
          json(res, 200, {
            scopes: token.scopes ?? ['api', 'read_repository', 'write_repository'],
            expires_at: token.expiresAt ?? null,
            active: !token.revoked,
            revoked: Boolean(token.revoked),
          });
        };
      if (path === '/api/v4/user')
        return (_url, token, res) => {
          if (!token || token.revoked) return unauthorized(res);
          json(res, 200, {
            id: token.accountId ?? 1000,
            username: token.account,
            bot: /_bot/.test(token.account),
          });
        };
      if (path === '/api/v4/projects')
        return (url, token, res) => {
          if (!token || token.revoked) return unauthorized(res);
          const min = Number(url.searchParams.get('min_access_level') ?? 0);
          const search = url.searchParams.get('search')?.toLowerCase();
          const visible = token.repos.filter(
            (repo) =>
              (repo.accessLevel ?? 30) >= min &&
              (!search || repo.fullPath.toLowerCase().includes(search)),
          );
          const { page, hasNext, pageNumber } = paginate(visible, url);
          json(res, 200, page.map(projectJson), {
            'x-next-page': hasNext ? String(pageNumber + 1) : '',
          });
        };
      const match = /^\/api\/v4\/projects\/(\d+)$/.exec(path);
      if (match)
        return (_url, token, res) => {
          if (!token || token.revoked) return unauthorized(res);
          const repo = token.repos.find((r) => String(r.id) === match[1]);
          if (!repo) return json(res, 404, { message: '404 Project Not Found' });
          json(res, 200, projectJson(repo));
        };
      return undefined;
    },
    (req) => {
      const header = req.headers['private-token'];
      return typeof header === 'string' ? header : undefined;
    },
  );
  return host.then((fake) => {
    base = fake.baseUrl;
    return fake;
  });
}
