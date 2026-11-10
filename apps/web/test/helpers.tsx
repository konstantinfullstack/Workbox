import type {
  Connection,
  ProjectRepository,
  ProjectSummary,
  RemoteRepository,
  Task,
  TaskTransition,
} from '#shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, type RenderResult } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { vi } from 'vitest';

export const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const NOW = '2026-11-04T12:00:00.000Z';

export function makeProject(overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    id: PROJECT_ID,
    name: 'Demo',
    slug: 'demo',
    description: '',
    repoUrl: 'git@github.com:org/demo.git',
    defaultBranch: 'main',
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
    taskCounts: {
      backlog: 0,
      planning: 0,
      in_progress: 0,
      verification: 0,
      ready_for_qa: 0,
      done: 0,
      blocked: 0,
      changes_requested: 0,
      cancelled: 0,
    },
    totalTasks: 0,
    repository: null,
    ...overrides,
  };
}

let taskSeq = 0;
export function makeTask(overrides: Partial<Task> = {}): Task {
  taskSeq += 1;
  return {
    id: `22222222-2222-4222-8222-${String(taskSeq).padStart(12, '0')}`,
    projectId: PROJECT_ID,
    number: taskSeq,
    title: `Task ${taskSeq}`,
    description: '',
    acceptanceCriteria: [],
    priority: 'medium',
    state: 'backlog',
    version: 1,
    dependsOn: [],
    allowedTransitions: ['planning', 'in_progress', 'blocked', 'cancelled'],
    stateChangedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

export function makeTransition(
  task: Task,
  overrides: Partial<TaskTransition> = {},
): TaskTransition {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    taskId: task.id,
    fromState: null,
    toState: 'backlog',
    actor: 'user:local',
    reason: null,
    createdAt: NOW,
    ...overrides,
  };
}

type Handler = (body: unknown) => { status?: number; json: unknown };

/**
 * Stubs global fetch with a tiny router keyed by "METHOD /path" (query string ignored). Returns
 * the mock so tests can assert on calls.
 */
export function mockApi(routes: Record<string, Handler>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      input instanceof Request ? input.url : input.toString(),
      'http://localhost',
    );
    const key = `${init?.method ?? 'GET'} ${url.pathname}`;
    const handler = routes[key];
    if (!handler) {
      return new Response(
        JSON.stringify({ error: { code: 'NOT_FOUND', message: `no mock for ${key}` } }),
        { status: 404 },
      );
    }
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    const result = handler(body);
    return new Response(JSON.stringify(result.json), {
      status: result.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

export function renderRoute(element: ReactElement, path: string, url: string): RenderResult {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path={path} element={element} />
          <Route path="*" element={<div>other page</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

export const CONNECTION_ID = '44444444-4444-4444-8444-444444444444';

export function makeConnection(overrides: Partial<Connection> = {}): Connection {
  return {
    id: CONNECTION_ID,
    provider: 'github',
    name: 'GitHub – personal',
    baseUrl: 'https://github.com',
    account: 'kost',
    accountId: '1000',
    authType: 'personal_access_token',
    fingerprint: 'github_pat_…a1B2',
    hasSecret: true,
    tokenExpiresAt: null,
    scopes: [],
    status: 'connected',
    lastCheckedAt: NOW,
    lastCheck: { ok: true, message: 'Connected as kost.' },
    projects: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

export function makeRemoteRepo(overrides: Partial<RemoteRepository> = {}): RemoteRepository {
  return {
    externalId: '101',
    fullPath: 'kost/workbox',
    name: 'workbox',
    webUrl: 'https://github.com/kost/workbox',
    cloneUrlHttps: 'https://github.com/kost/workbox.git',
    cloneUrlSsh: 'git@github.com:kost/workbox.git',
    defaultBranch: 'main',
    visibility: 'private',
    access: { pull: true, push: true },
    ...overrides,
  };
}

export function makeProjectRepository(
  overrides: Partial<ProjectRepository> = {},
): ProjectRepository {
  return {
    id: '55555555-5555-4555-8555-555555555555',
    projectId: PROJECT_ID,
    connectionId: CONNECTION_ID,
    connectionName: 'GitHub – personal',
    connectionStatus: 'connected',
    provider: 'github',
    host: 'github.com',
    externalId: '101',
    fullPath: 'kost/workbox',
    webUrl: 'https://github.com/kost/workbox',
    cloneUrlHttps: 'https://github.com/kost/workbox.git',
    cloneUrlSsh: null,
    defaultBranch: 'main',
    visibility: 'private',
    access: { pull: true, push: true, reviewRequests: 'unverified' },
    accessStatus: 'verified',
    verifiedAt: NOW,
    lastError: null,
    workspace: {
      status: 'ready',
      path: '~/code/workbox/workspaces/demo',
      headSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
      sizeKb: 2048,
      lastSyncedAt: NOW,
      lastError: null,
      workerId: 'host:1',
      updatedAt: NOW,
    },
    ...overrides,
  };
}

/** URL string of a fetch() input (string, URL or Request). */
export function requestUrl(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}
