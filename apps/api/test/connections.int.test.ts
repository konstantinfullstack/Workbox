import { createDatabase, type DatabaseHandle } from '#database';
import { createCodeHostRegistry } from '#integrations';
import { createServices } from '#services';
import { connectionSchema, projectRepositorySchema, type Connection } from '#shared';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  startFakeGitHub,
  startFakeGitLab,
  type FakeCodeHost,
} from '../../../test/fake-code-hosts.js';
import {
  createMigratedTestDatabase,
  testKeyring,
  type TestDatabase,
} from '../../../test/support.js';
import { buildApp } from '../src/app.js';

const GH_TOKEN = 'github_pat_11CCCC2222apiLevelLeakTestToken_Ww77';
const GH_TOKEN_NEW = 'github_pat_11DDDD3333apiLevelReplacement_Vv66';
const GL_TOKEN = 'glpat-apiLevelGitLabToken987654';
const BAD_TOKEN = 'github_pat_11EEEE4444doesNotExistAnywhere_Uu55';
const SECRETS = [GH_TOKEN, GH_TOKEN_NEW, GL_TOKEN, BAD_TOKEN];

let testDb: TestDatabase;
let handle: DatabaseHandle;
let app: FastifyInstance;
let github: FakeCodeHost;
let gitlab: FakeCodeHost;
const logs: string[] = [];
const bodies: string[] = [];

beforeAll(async () => {
  testDb = await createMigratedTestDatabase();
  handle = createDatabase({ connectionString: testDb.url });
  [github, gitlab] = await Promise.all([startFakeGitHub(), startFakeGitLab()]);
  github.tokens.set(GH_TOKEN, { account: 'kost', repos: [{ id: 101, fullPath: 'kost/workbox' }] });
  github.tokens.set(GH_TOKEN_NEW, {
    account: 'kost',
    repos: [{ id: 101, fullPath: 'kost/workbox' }],
  });
  gitlab.tokens.set(GL_TOKEN, {
    account: 'kost',
    repos: [{ id: 7, fullPath: 'team/app', accessLevel: 40 }],
  });
  app = await buildApp({
    version: '0.0.0-test',
    logLevel: 'trace', // most verbose: anything that could leak, would
    logStream: { write: (line) => void logs.push(line) },
    readinessChecks: {},
    services: createServices({
      db: handle.db,
      keyring: testKeyring(),
      codeHosts: createCodeHostRegistry({ timeoutMs: 1_000 }),
      workerGateway: {
        probeAgentRuntime: async () => ({
          workerId: 'test-worker',
          checkedAt: new Date().toISOString(),
          installed: true,
          version: '2.1.318',
          loggedIn: true,
          authMethod: 'claude.ai',
          subscriptionType: 'max',
          loginExpiresAt: null,
          ok: true,
          message: 'Claude Code is installed and signed in.',
        }),
      },
    }),
  });
});

afterAll(async () => {
  // The leak check covers every request made in this file.
  const everything = [...logs, ...bodies].join('\n');
  for (const secret of SECRETS) expect(everything).not.toContain(secret);
  expect(logs.length).toBeGreaterThan(10);
  await app.close();
  await Promise.all([github.close(), gitlab.close()]);
  await handle.close();
  await testDb.drop();
});

async function api(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  payload?: object,
): Promise<LightMyRequestResponse> {
  const response = await app.inject({
    method,
    url: `/api/v1${url}`,
    ...(payload ? { payload } : {}),
  });
  bodies.push(response.body);
  return response;
}

describe('accounts API', () => {
  let github1: Connection;

  it('lists the provider catalog with token instructions', async () => {
    const body = (await api('GET', '/providers')).json<{
      items: Array<{ provider: string; tokenHelp: { settingsUrl: string } }>;
    }>();
    expect(body.items.map((p) => p.provider)).toEqual(['github', 'gitlab']);
    expect(body.items[0]?.tokenHelp.settingsUrl).toBe(
      'https://github.com/settings/personal-access-tokens/new',
    );
  });

  it('creates accounts and never returns the token', async () => {
    const created = await api('POST', '/connections', {
      provider: 'github',
      name: 'Mine',
      baseUrl: github.baseUrl,
      secret: GH_TOKEN,
    });
    expect(created.statusCode).toBe(201);
    github1 = connectionSchema.parse(created.json());
    expect(github1).toMatchObject({
      account: 'kost',
      fingerprint: 'github_pat_…Ww77',
      status: 'connected',
      hasSecret: true,
    });
    expect(Object.keys(created.json<object>())).not.toContain('secret');

    const gl = await api('POST', '/connections', {
      provider: 'gitlab',
      name: 'Team GitLab',
      baseUrl: gitlab.baseUrl,
      secret: GL_TOKEN,
    });
    expect(gl.statusCode).toBe(201);
    const list = (await api('GET', '/connections')).json<{ items: Connection[] }>();
    expect(list.items.map((c) => c.name).sort()).toEqual(['Mine', 'Team GitLab']);
    expect(
      (await api('GET', '/connections?provider=gitlab')).json<{ items: Connection[] }>().items,
    ).toHaveLength(1);
  });

  it('rejects a bad token with 422 and a secret in an unknown field with 400', async () => {
    const bad = await api('POST', '/connections', {
      provider: 'github',
      name: 'Bad',
      baseUrl: github.baseUrl,
      secret: BAD_TOKEN,
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.json()).toMatchObject({ error: { code: 'CREDENTIAL_REJECTED' } });
    const typo = await api('POST', '/connections', {
      provider: 'github',
      name: 'Typo',
      baseUrl: github.baseUrl,
      token: BAD_TOKEN,
    });
    expect(typo.statusCode).toBe(400);
  });

  it('tests, lists repositories, rotates and disconnects', async () => {
    expect((await api('POST', `/connections/${github1.id}/test`)).json()).toMatchObject({
      status: 'connected',
    });
    const repos = (await api('GET', `/connections/${github1.id}/repositories?search=work`)).json<{
      items: Array<{ fullPath: string }>;
    }>();
    expect(repos.items.map((r) => r.fullPath)).toEqual(['kost/workbox']);

    github.failNext(503);
    const unavailable = await api('GET', `/connections/${github1.id}/repositories`);
    expect(unavailable.statusCode).toBe(502);
    expect(unavailable.json()).toMatchObject({ error: { code: 'CODE_HOST_UNAVAILABLE' } });

    const rotated = await api('POST', `/connections/${github1.id}/rotate`, {
      secret: GH_TOKEN_NEW,
    });
    expect(rotated.json()).toMatchObject({ fingerprint: 'github_pat_…Vv66', status: 'connected' });
  });

  it('links, verifies and unlinks a project repository', async () => {
    const project = (await api('POST', '/projects', { name: 'Linked' })).json<{
      id: string;
      slug: string;
    }>();
    expect((await api('GET', `/projects/${project.slug}/repository`)).json()).toEqual({
      repository: null,
    });

    const linked = await api('PUT', `/projects/${project.slug}/repository`, {
      connectionId: github1.id,
      externalId: '101',
    });
    expect(linked.statusCode).toBe(200);
    expect(projectRepositorySchema.parse(linked.json())).toMatchObject({
      fullPath: 'kost/workbox',
      accessStatus: 'verified',
    });
    expect((await api('GET', `/projects/${project.slug}`)).json()).toMatchObject({
      repository: { provider: 'github', fullPath: 'kost/workbox', accessStatus: 'verified' },
    });

    const other = (await api('POST', '/projects', { name: 'Other' })).json<{ slug: string }>();
    const taken = await api('PUT', `/projects/${other.slug}/repository`, {
      connectionId: github1.id,
      externalId: '101',
    });
    expect(taken.statusCode).toBe(409);
    expect(taken.json()).toMatchObject({
      error: { code: 'REPOSITORY_TAKEN', details: { projectSlug: project.slug } },
    });

    expect((await api('POST', `/projects/${project.slug}/repository/verify`)).json()).toMatchObject(
      { accessStatus: 'verified' },
    );
    expect((await api('DELETE', `/projects/${project.slug}/repository`)).statusCode).toBe(204);
    expect((await api('GET', `/projects/${project.slug}/repository`)).json()).toEqual({
      repository: null,
    });
  });

  it('disconnects an account and reports it unusable', async () => {
    expect((await api('POST', `/connections/${github1.id}/disconnect`)).json()).toMatchObject({
      status: 'disconnected',
      hasSecret: false,
    });
    const unusable = await api('GET', `/connections/${github1.id}/repositories`);
    expect(unusable.statusCode).toBe(409);
    expect(unusable.json()).toMatchObject({ error: { code: 'CONNECTION_UNUSABLE' } });
  });

  it('checks the agent runtime through a worker', async () => {
    expect((await api('GET', '/agent-runtimes/claude-code')).json()).toMatchObject({
      message: 'Not checked yet.',
    });
    expect((await api('POST', '/agent-runtimes/claude-code/check')).json()).toMatchObject({
      ok: true,
      version: '2.1.318',
      workerId: 'test-worker',
    });
  });

  it('documents the new routes', async () => {
    const spec = (await app.inject({ method: 'GET', url: '/docs/json' })).json<{
      paths: Record<string, unknown>;
    }>();
    expect(Object.keys(spec.paths)).toEqual(
      expect.arrayContaining([
        '/api/v1/connections',
        '/api/v1/connections/{id}/rotate',
        '/api/v1/connections/{id}/repositories',
        '/api/v1/projects/{project}/repository',
        '/api/v1/agent-runtimes/claude-code/check',
      ]),
    );
  });
});
