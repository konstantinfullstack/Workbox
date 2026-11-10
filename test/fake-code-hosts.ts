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
  /** File contents on the default branch, for readFile (check detection). */
  files?: Record<string, string>;
  /** Refuse to create pull/merge requests (e.g. token without PR permission). */
  denyReviewRequests?: boolean;
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

export interface FakeReviewRequest {
  number: number;
  repoId: number;
  head: string;
  base: string;
  title: string;
  body: string;
  draft: boolean;
  state: 'open' | 'closed' | 'merged';
}

export interface FakeCodeHost {
  baseUrl: string;
  tokens: Map<string, FakeToken>;
  /** Pull/merge requests created through the API. */
  reviewRequests: FakeReviewRequest[];
  requests: Array<{
    method: string;
    path: string;
    headers: IncomingMessage['headers'];
    body?: unknown;
  }>;
  /** Make the next N requests fail with this status (and optional headers). */
  failNext(status: number, times?: number, headers?: Record<string, string>): void;
  /** Delay every response (to exercise timeouts). */
  delayMs: number;
  close(): Promise<void>;
}

interface Ctx {
  method: string;
  url: URL;
  token: FakeToken | undefined;
  body: Record<string, unknown>;
  res: ServerResponse;
}
type Route = (ctx: Ctx) => boolean;

async function startFake(
  routes: (host: FakeCodeHost) => Route[],
  tokenOf: (req: IncomingMessage) => string | undefined,
): Promise<FakeCodeHost> {
  const failures: Array<{ status: number; headers: Record<string, string> }> = [];
  const state = { delayMs: 0 };
  const host = {
    baseUrl: '',
    tokens: new Map<string, FakeToken>(),
    reviewRequests: [] as FakeReviewRequest[],
    requests: [] as FakeCodeHost['requests'],
    failNext(status: number, times = 1, headers: Record<string, string> = {}) {
      for (let i = 0; i < times; i++) failures.push({ status, headers });
    },
    get delayMs() {
      return state.delayMs;
    },
    set delayMs(value: number) {
      state.delayMs = value;
    },
    close: async () => undefined,
  } as FakeCodeHost;
  const handlers = routes(host);

  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://fake');
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      host.requests.push({
        method: req.method ?? 'GET',
        path: url.pathname + url.search,
        headers: req.headers,
        ...(raw ? { body } : {}),
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
        const raw = tokenOf(req);
        const ctx: Ctx = {
          method: req.method ?? 'GET',
          url,
          token: raw ? host.tokens.get(raw) : undefined,
          body,
          res,
        };
        if (!handlers.some((route) => route(ctx))) json(res, 404, { message: 'Not Found' });
      };
      if (state.delayMs > 0) setTimeout(respond, state.delayMs);
      else respond();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  host.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  host.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return host;
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

/** `route('GET', /^\/x\/(\d+)$/, (ctx, m) => …)`: matches method + path, returns true if handled. */
function route(
  method: string,
  pattern: RegExp,
  handler: (ctx: Ctx, match: RegExpExecArray) => void,
): Route {
  return (ctx) => {
    if (ctx.method !== method) return false;
    const match = pattern.exec(ctx.url.pathname);
    if (!match) return false;
    handler(ctx, match);
    return true;
  };
}

// ---------------------------------------------------------------------------------------------
// GitHub (served as Enterprise-style /api/v3 because the base URL is not github.com)

export function startFakeGitHub(): Promise<FakeCodeHost> {
  const unauthorized = (res: ServerResponse) => json(res, 401, { message: 'Bad credentials' });
  return startFake(
    (host) => {
      const repoJson = (repo: FakeRepo) => ({
        id: repo.id,
        full_name: repo.fullPath,
        name: repo.fullPath.split('/').at(-1),
        html_url: `${host.baseUrl}/${repo.fullPath}`,
        clone_url: repo.cloneUrl ?? `${host.baseUrl}/${repo.fullPath}.git`,
        ssh_url: `git@fake-github:${repo.fullPath}.git`,
        default_branch: repo.defaultBranch ?? 'main',
        private: (repo.visibility ?? 'private') !== 'public',
        visibility: repo.visibility ?? 'private',
        permissions: { pull: repo.pull ?? true, push: repo.push ?? true, admin: false },
      });
      const pullJson = (pr: FakeReviewRequest, repo: FakeRepo) => ({
        number: pr.number,
        html_url: `${host.baseUrl}/${repo.fullPath}/pull/${pr.number}`,
        state: pr.state === 'open' ? 'open' : 'closed',
        draft: pr.draft,
        merged_at: pr.state === 'merged' ? new Date().toISOString() : null,
        title: pr.title,
      });
      const repoByPath = (token: FakeToken, path: string) =>
        token.repos.find((r) => r.fullPath === path);
      return [
        route('GET', /^\/api\/v3\/user$/, ({ token, res }) => {
          if (!token || token.revoked) return unauthorized(res);
          const headers: Record<string, string> = {};
          if (token.scopes) headers['x-oauth-scopes'] = token.scopes.join(', ');
          if (token.expiresAt) headers['github-authentication-token-expiration'] = token.expiresAt;
          json(res, 200, { login: token.account, id: token.accountId ?? 1000 }, headers);
        }),
        route('GET', /^\/api\/v3\/user\/repos$/, ({ url, token, res }) => {
          if (!token || token.revoked) return unauthorized(res);
          const { page, hasNext, pageNumber } = paginate(token.repos, url);
          const headers: Record<string, string> = hasNext
            ? { link: `<${host.baseUrl}/api/v3/user/repos?page=${pageNumber + 1}>; rel="next"` }
            : {};
          json(res, 200, page.map(repoJson), headers);
        }),
        route('GET', /^\/api\/v3\/repositories\/(\d+)$/, ({ token, res }, m) => {
          if (!token || token.revoked) return unauthorized(res);
          const repo = token.repos.find((r) => String(r.id) === m[1]);
          if (!repo) return json(res, 404, { message: 'Not Found' });
          json(res, 200, repoJson(repo));
        }),
        route('GET', /^\/api\/v3\/repos\/([^/]+\/[^/]+)\/contents\/(.+)$/, ({ token, res }, m) => {
          if (!token || token.revoked) return unauthorized(res);
          const repo = repoByPath(token, m[1]!);
          const content = repo?.files?.[decodeURIComponent(m[2]!)];
          if (!repo || content === undefined) return json(res, 404, { message: 'Not Found' });
          json(res, 200, {
            type: 'file',
            encoding: 'base64',
            content: Buffer.from(content).toString('base64'),
          });
        }),
        route('GET', /^\/api\/v3\/repos\/([^/]+\/[^/]+)\/pulls$/, ({ url, token, res }, m) => {
          if (!token || token.revoked) return unauthorized(res);
          const repo = repoByPath(token, m[1]!);
          if (!repo) return json(res, 404, { message: 'Not Found' });
          const head = url.searchParams.get('head')?.split(':')[1];
          const wantOpen = url.searchParams.get('state') === 'open';
          const items = host.reviewRequests.filter(
            (pr) =>
              pr.repoId === repo.id &&
              (!head || pr.head === head) &&
              (!wantOpen || pr.state === 'open'),
          );
          json(
            res,
            200,
            items.map((pr) => pullJson(pr, repo)),
          );
        }),
        route('POST', /^\/api\/v3\/repos\/([^/]+\/[^/]+)\/pulls$/, ({ token, body, res }, m) => {
          if (!token || token.revoked) return unauthorized(res);
          const repo = repoByPath(token, m[1]!);
          if (!repo) return json(res, 404, { message: 'Not Found' });
          if (repo.denyReviewRequests)
            return json(res, 403, { message: 'Resource not accessible by personal access token' });
          if (
            host.reviewRequests.some(
              (pr) => pr.repoId === repo.id && pr.head === body.head && pr.state === 'open',
            )
          ) {
            return json(res, 422, { message: 'Validation Failed: A pull request already exists' });
          }
          const pr: FakeReviewRequest = {
            number: host.reviewRequests.length + 1,
            repoId: repo.id,
            head: String(body.head),
            base: String(body.base),
            title: String(body.title),
            body: typeof body.body === 'string' ? body.body : '',
            draft: body.draft === true,
            state: 'open',
          };
          host.reviewRequests.push(pr);
          json(res, 201, pullJson(pr, repo));
        }),
        route(
          'PATCH',
          /^\/api\/v3\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/,
          ({ token, body, res }, m) => {
            if (!token || token.revoked) return unauthorized(res);
            const repo = repoByPath(token, m[1]!);
            const pr = host.reviewRequests.find(
              (p) => p.repoId === repo?.id && p.number === Number(m[2]),
            );
            if (!repo || !pr) return json(res, 404, { message: 'Not Found' });
            if (typeof body.title === 'string') pr.title = body.title;
            if (typeof body.body === 'string') pr.body = body.body;
            json(res, 200, pullJson(pr, repo));
          },
        ),
        route('GET', /^\/api\/v3\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/, ({ token, res }, m) => {
          if (!token || token.revoked) return unauthorized(res);
          const repo = repoByPath(token, m[1]!);
          const pr = host.reviewRequests.find(
            (p) => p.repoId === repo?.id && p.number === Number(m[2]),
          );
          if (!repo || !pr) return json(res, 404, { message: 'Not Found' });
          json(res, 200, pullJson(pr, repo));
        }),
      ];
    },
    (req) => /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1],
  );
}

// ---------------------------------------------------------------------------------------------
// GitLab (/api/v4)

export function startFakeGitLab(): Promise<FakeCodeHost> {
  const unauthorized = (res: ServerResponse) => json(res, 401, { message: '401 Unauthorized' });
  return startFake(
    (host) => {
      const projectJson = (repo: FakeRepo) => ({
        id: repo.id,
        path_with_namespace: repo.fullPath,
        name: repo.fullPath.split('/').at(-1),
        web_url: `${host.baseUrl}/${repo.fullPath}`,
        http_url_to_repo: repo.cloneUrl ?? `${host.baseUrl}/${repo.fullPath}.git`,
        ssh_url_to_repo: `git@fake-gitlab:${repo.fullPath}.git`,
        default_branch: repo.defaultBranch ?? 'main',
        visibility: repo.visibility ?? 'private',
        permissions: {
          project_access: { access_level: repo.accessLevel ?? 30 },
          group_access: null,
        },
      });
      const mrJson = (mr: FakeReviewRequest, repo: FakeRepo) => ({
        iid: mr.number,
        web_url: `${host.baseUrl}/${repo.fullPath}/-/merge_requests/${mr.number}`,
        state: mr.state === 'open' ? 'opened' : mr.state,
        draft: /^Draft:/i.test(mr.title),
        title: mr.title,
      });
      const repoById = (token: FakeToken, id: string) =>
        token.repos.find((r) => String(r.id) === id);
      return [
        route('GET', /^\/api\/v4\/personal_access_tokens\/self$/, ({ token, res }) => {
          if (!token) return unauthorized(res);
          json(res, 200, {
            scopes: token.scopes ?? ['api', 'read_repository', 'write_repository'],
            expires_at: token.expiresAt ?? null,
            active: !token.revoked,
            revoked: Boolean(token.revoked),
          });
        }),
        route('GET', /^\/api\/v4\/user$/, ({ token, res }) => {
          if (!token || token.revoked) return unauthorized(res);
          json(res, 200, {
            id: token.accountId ?? 1000,
            username: token.account,
            bot: /_bot/.test(token.account),
          });
        }),
        route('GET', /^\/api\/v4\/projects$/, ({ url, token, res }) => {
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
        }),
        route('GET', /^\/api\/v4\/projects\/(\d+)$/, ({ token, res }, m) => {
          if (!token || token.revoked) return unauthorized(res);
          const repo = repoById(token, m[1]!);
          if (!repo) return json(res, 404, { message: '404 Project Not Found' });
          json(res, 200, projectJson(repo));
        }),
        route(
          'GET',
          /^\/api\/v4\/projects\/(\d+)\/repository\/files\/([^/]+)$/,
          ({ token, res }, m) => {
            if (!token || token.revoked) return unauthorized(res);
            const content = repoById(token, m[1]!)?.files?.[decodeURIComponent(m[2]!)];
            if (content === undefined) return json(res, 404, { message: '404 File Not Found' });
            json(res, 200, {
              encoding: 'base64',
              content: Buffer.from(content).toString('base64'),
            });
          },
        ),
        route('GET', /^\/api\/v4\/projects\/(\d+)\/merge_requests$/, ({ url, token, res }, m) => {
          if (!token || token.revoked) return unauthorized(res);
          const repo = repoById(token, m[1]!);
          if (!repo) return json(res, 404, { message: '404 Project Not Found' });
          const branch = url.searchParams.get('source_branch');
          const items = host.reviewRequests.filter(
            (mr) =>
              mr.repoId === repo.id &&
              (!branch || mr.head === branch) &&
              (url.searchParams.get('state') !== 'opened' || mr.state === 'open'),
          );
          json(
            res,
            200,
            items.map((mr) => mrJson(mr, repo)),
          );
        }),
        route('POST', /^\/api\/v4\/projects\/(\d+)\/merge_requests$/, ({ token, body, res }, m) => {
          if (!token || token.revoked) return unauthorized(res);
          const repo = repoById(token, m[1]!);
          if (!repo) return json(res, 404, { message: '404 Project Not Found' });
          if (repo.denyReviewRequests) return json(res, 403, { message: '403 Forbidden' });
          const mr: FakeReviewRequest = {
            number: host.reviewRequests.length + 1,
            repoId: repo.id,
            head: String(body.source_branch),
            base: String(body.target_branch),
            title: String(body.title),
            body: typeof body.description === 'string' ? body.description : '',
            draft: /^Draft:/i.test(String(body.title)),
            state: 'open',
          };
          host.reviewRequests.push(mr);
          json(res, 201, mrJson(mr, repo));
        }),
        route(
          'PUT',
          /^\/api\/v4\/projects\/(\d+)\/merge_requests\/(\d+)$/,
          ({ token, body, res }, m) => {
            if (!token || token.revoked) return unauthorized(res);
            const repo = repoById(token, m[1]!);
            const mr = host.reviewRequests.find(
              (r) => r.repoId === repo?.id && r.number === Number(m[2]),
            );
            if (!repo || !mr) return json(res, 404, { message: '404 Not found' });
            if (typeof body.title === 'string') mr.title = body.title;
            if (typeof body.description === 'string') mr.body = body.description;
            json(res, 200, mrJson(mr, repo));
          },
        ),
        route('GET', /^\/api\/v4\/projects\/(\d+)\/merge_requests\/(\d+)$/, ({ token, res }, m) => {
          if (!token || token.revoked) return unauthorized(res);
          const repo = repoById(token, m[1]!);
          const mr = host.reviewRequests.find(
            (r) => r.repoId === repo?.id && r.number === Number(m[2]),
          );
          if (!repo || !mr) return json(res, 404, { message: '404 Not found' });
          json(res, 200, mrJson(mr, repo));
        }),
      ];
    },
    (req) => {
      const header = req.headers['private-token'];
      return typeof header === 'string' ? header : undefined;
    },
  );
}
