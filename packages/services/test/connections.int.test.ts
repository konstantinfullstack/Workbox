import { DomainError } from '#core';
import {
  auditLogs,
  connections,
  createDatabase,
  credentials,
  projectRepositories,
  type DatabaseHandle,
} from '#database';
import { createCodeHostRegistry } from '#integrations';
import {
  ERROR_CODES,
  LOCAL_USER_ACTOR,
  type ErrorCode,
  type ProbeAgentRuntimeJobResult,
} from '#shared';
import { generateMasterKey, Keyring } from '#vault';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  startFakeGitHub,
  startFakeGitLab,
  type FakeCodeHost,
} from '../../../test/fake-code-hosts.js';
import { createMigratedTestDatabase, type TestDatabase } from '../../../test/support.js';
import {
  createServices,
  rotateCredentialKeys,
  type Services,
  type WorkerGateway,
} from '../src/index.js';

const ctx = { actor: LOCAL_USER_ACTOR, traceId: 'trace-conn' };
const GH_TOKEN = 'github_pat_11AAAA0000realLookingFineGrained_Zz99';
const GH_TOKEN_2 = 'github_pat_11BBBB1111secondFineGrainedToken_Yy88';
const GL_TOKEN = 'glpat-projectToken0123456789abcd';
const ALL_TOKENS = [GH_TOKEN, GH_TOKEN_2, GL_TOKEN];

let testDb: TestDatabase;
let handle: DatabaseHandle;
let github: FakeCodeHost;
let gitlab: FakeCodeHost;
let masterKey: string;
let services: Services;
let probeResult: ProbeAgentRuntimeJobResult | Error;

const gateway: WorkerGateway = {
  probeAgentRuntime: async () => {
    if (probeResult instanceof Error) throw probeResult;
    return probeResult;
  },
};
const build = (key = masterKey, now?: () => Date) =>
  createServices({
    db: handle.db,
    keyring: Keyring.fromConfig({ currentKey: key }),
    codeHosts: createCodeHostRegistry({ timeoutMs: 1_000 }),
    workerGateway: gateway,
    ...(now ? { now } : {}),
  });

beforeAll(async () => {
  testDb = await createMigratedTestDatabase();
  handle = createDatabase({ connectionString: testDb.url });
  [github, gitlab] = await Promise.all([startFakeGitHub(), startFakeGitLab()]);
  masterKey = generateMasterKey();
  services = build();
});

afterAll(async () => {
  await Promise.all([github.close(), gitlab.close()]);
  await handle.close();
  await testDb.drop();
});

beforeEach(async () => {
  // Each test links repositories afresh (a repository can belong to only one project).
  await handle.db.delete(projectRepositories);
  github.tokens.clear();
  gitlab.tokens.clear();
  github.tokens.set(GH_TOKEN, {
    account: 'kost',
    expiresAt: '2030-01-01 00:00:00 UTC',
    repos: [
      { id: 101, fullPath: 'kost/workbox', defaultBranch: 'main' },
      { id: 102, fullPath: 'kost/notes', push: false },
      { id: 103, fullPath: 'kost/read-nothing', pull: false, push: false },
    ],
  });
  gitlab.tokens.set(GL_TOKEN, {
    account: 'project_42_bot_x1',
    expiresAt: '2030-06-01',
    repos: [
      { id: 42, fullPath: 'company/platform/api', defaultBranch: 'develop', accessLevel: 30 },
    ],
  });
});

async function expectDomainError(promise: Promise<unknown>, code: ErrorCode): Promise<DomainError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(DomainError);
  expect((error as DomainError).code).toBe(code);
  return error as DomainError;
}

let n = 0;
const addGitHub = (secret = GH_TOKEN, name = `GitHub ${++n}`) =>
  services.connections.create({ provider: 'github', name, baseUrl: github.baseUrl, secret }, ctx);
const addGitLab = (name = `GitLab ${++n}`) =>
  services.connections.create(
    { provider: 'gitlab', name, baseUrl: gitlab.baseUrl, secret: GL_TOKEN },
    ctx,
  );
const newProject = () => services.projects.create({ name: `Proj ${++n}` }, ctx);

/** Every token must be absent from every row of every table that could plausibly hold it. */
async function expectNoPlaintextTokensInDatabase() {
  const dump = JSON.stringify(
    await Promise.all([
      handle.db.select().from(credentials),
      handle.db.select().from(connections),
      handle.db.select().from(auditLogs),
      handle.db.select().from(projectRepositories),
    ]),
    (_key, value: unknown) =>
      value && typeof value === 'object' && (value as { type?: string }).type === 'Buffer'
        ? Buffer.from((value as { data: number[] }).data).toString('latin1')
        : value,
  );
  for (const token of ALL_TOKENS) expect(dump).not.toContain(token);
}

describe('accounts', () => {
  it('verifies, encrypts and stores a GitHub token, returning only a fingerprint', async () => {
    const connection = await addGitHub();
    expect(connection).toMatchObject({
      provider: 'github',
      account: 'kost',
      baseUrl: github.baseUrl,
      status: 'connected',
      authType: 'personal_access_token',
      fingerprint: 'github_pat_…Zz99',
      hasSecret: true,
      tokenExpiresAt: '2030-01-01T00:00:00.000Z',
      lastCheck: expect.objectContaining({ ok: true, message: 'Connected as kost.' }),
    });
    expect(JSON.stringify(connection)).not.toContain(GH_TOKEN);
    const [row] = await handle.db
      .select()
      .from(credentials)
      .where(eq(credentials.provider, 'github'))
      .limit(1);
    expect(row?.ciphertext?.includes(Buffer.from(GH_TOKEN))).toBe(false);
    await expectNoPlaintextTokensInDatabase();
  });

  it('supports GitLab (self-hosted URL) and several accounts per provider side by side', async () => {
    github.tokens.set(GH_TOKEN_2, {
      account: 'leadoo-bot',
      repos: [{ id: 201, fullPath: 'leadoo/api' }],
    });
    await addGitHub(GH_TOKEN, 'Personal');
    await addGitHub(GH_TOKEN_2, 'Leadoo org');
    const gl = await addGitLab('Company GitLab');
    expect(gl).toMatchObject({
      provider: 'gitlab',
      authType: 'project_access_token',
      account: 'project_42_bot_x1',
    });
    const names = (await services.connections.list()).map((c) => `${c.provider}:${c.account}`);
    expect(names).toEqual(
      expect.arrayContaining(['github:kost', 'github:leadoo-bot', 'gitlab:project_42_bot_x1']),
    );
  });

  it('rejects an invalid token without storing anything', async () => {
    const before = (await handle.db.select().from(credentials)).length;
    const error = await expectDomainError(
      services.connections.create(
        {
          provider: 'github',
          name: 'Bad',
          baseUrl: github.baseUrl,
          secret: 'github_pat_nope_0000000000',
        },
        ctx,
      ),
      ERROR_CODES.credentialRejected,
    );
    expect(error.message).not.toContain('github_pat_nope');
    expect((await handle.db.select().from(credentials)).length).toBe(before);
  });

  it('rejects insecure instance URLs', async () => {
    await expectDomainError(
      services.connections.create(
        {
          provider: 'gitlab',
          name: 'Insecure',
          baseUrl: 'http://gitlab.example.com',
          secret: GL_TOKEN,
        },
        ctx,
      ),
      ERROR_CODES.validation,
    );
  });

  it('records health check outcomes: expired on 401, degraded on rate limit, recovered after', async () => {
    const connection = await addGitHub();
    github.tokens.get(GH_TOKEN)!.revoked = true;
    expect((await services.connections.test(connection.id, ctx)).status).toBe('expired');
    github.tokens.get(GH_TOKEN)!.revoked = false;
    github.failNext(429);
    const degraded = await services.connections.test(connection.id, ctx);
    expect(degraded).toMatchObject({ status: 'degraded', lastCheck: { ok: false } });
    expect((await services.connections.test(connection.id, ctx)).status).toBe('connected');
  });

  it('marks a connection expired once its token expiry date has passed', async () => {
    const connection = await addGitHub();
    const later = build(masterKey, () => new Date('2031-01-01T00:00:00Z'));
    expect((await later.connections.test(connection.id, ctx)).status).toBe('expired');
  });

  it('audits every token decryption', async () => {
    const connection = await addGitHub();
    await services.connections.listRepositories(connection.id, {}, ctx);
    const accesses = await handle.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'credential.accessed'));
    expect(
      accesses.some(
        (a) =>
          a.metadata.purpose === 'repositories.list' && a.metadata.connectionId === connection.id,
      ),
    ).toBe(true);
  });

  it('rotates a token: verified first, re-encrypted, old ciphertext replaced', async () => {
    github.tokens.set(GH_TOKEN_2, {
      account: 'kost',
      repos: [{ id: 101, fullPath: 'kost/workbox' }],
    });
    const connection = await addGitHub();
    const credentialOf = async () => {
      const [row] = await handle.db
        .select({ credential: credentials })
        .from(connections)
        .innerJoin(credentials, eq(credentials.id, connections.credentialId))
        .where(eq(connections.id, connection.id));
      return row!.credential;
    };
    const before = await credentialOf();
    await expectDomainError(
      services.connections.rotate(connection.id, 'github_pat_bogus_000000000', ctx),
      ERROR_CODES.credentialRejected,
    );
    const rotated = await services.connections.rotate(connection.id, GH_TOKEN_2, ctx);
    expect(rotated).toMatchObject({ fingerprint: 'github_pat_…Yy88', status: 'connected' });
    const after = await credentialOf();
    expect(after.id).toBe(before.id);
    expect(after.ciphertext?.equals(before.ciphertext!)).toBe(false);
    expect(after.rotatedAt).toBeInstanceOf(Date);
    await expectNoPlaintextTokensInDatabase();
  });

  it('disconnect deletes the token and makes the account unusable until replaced', async () => {
    const connection = await addGitHub();
    const project = await newProject();
    await services.repositories.link(
      project.id,
      { connectionId: connection.id, externalId: '101' },
      ctx,
    );
    const disconnected = await services.connections.disconnect(connection.id, ctx);
    expect(disconnected).toMatchObject({ status: 'disconnected', hasSecret: false });
    expect((await services.repositories.get(project.id))?.accessStatus).toBe('unverified');
    await expectDomainError(
      services.connections.listRepositories(connection.id, {}, ctx),
      ERROR_CODES.connectionUnusable,
    );
    // A new token revives it.
    expect((await services.connections.rotate(connection.id, GH_TOKEN, ctx)).status).toBe(
      'connected',
    );
  });

  it('reports a token encrypted under a different master key as unreadable, not as a crash', async () => {
    const connection = await addGitHub();
    const wrongKey = build(generateMasterKey());
    const tested = await wrongKey.connections.test(connection.id, ctx);
    expect(tested).toMatchObject({
      status: 'degraded',
      lastCheck: { ok: false, message: expect.stringMatching(/cannot be decrypted/) },
    });
    await expectDomainError(
      wrongKey.connections.listRepositories(connection.id, {}, ctx),
      ERROR_CODES.credentialUnreadable,
    );
  });
});

describe('project repositories', () => {
  it('links a repository by stable id, verifies access and updates the project', async () => {
    const connection = await addGitHub();
    const project = await newProject();
    const repo = await services.repositories.link(
      project.slug,
      { connectionId: connection.id, externalId: '101' },
      ctx,
    );
    expect(repo).toMatchObject({
      provider: 'github',
      host: new URL(github.baseUrl).host,
      externalId: '101',
      fullPath: 'kost/workbox',
      access: { pull: true, push: true, reviewRequests: 'unverified' },
      accessStatus: 'verified',
      connectionName: connection.name,
    });
    const summary = await services.projects.get(project.id);
    expect(summary.repository).toMatchObject({
      provider: 'github',
      fullPath: 'kost/workbox',
      accessStatus: 'verified',
    });
    expect(summary.repoUrl).toBe(`${github.baseUrl}/kost/workbox.git`);
    expect((await services.connections.get(connection.id)).projects.map((p) => p.id)).toEqual([
      project.id,
    ]);
  });

  it('links GitLab repositories in nested groups and uses their default branch', async () => {
    const connection = await addGitLab();
    const project = await newProject();
    const repo = await services.repositories.link(
      project.id,
      { connectionId: connection.id, externalId: '42' },
      ctx,
    );
    expect(repo).toMatchObject({
      provider: 'gitlab',
      fullPath: 'company/platform/api',
      defaultBranch: 'develop',
    });
    expect((await services.projects.get(project.id)).defaultBranch).toBe('develop');
  });

  it('allows one repository per project and one project per repository', async () => {
    const connection = await addGitHub();
    const first = await newProject();
    const second = await newProject();
    await services.repositories.link(
      first.id,
      { connectionId: connection.id, externalId: '101' },
      ctx,
    );
    const taken = await expectDomainError(
      services.repositories.link(
        second.id,
        { connectionId: connection.id, externalId: '101' },
        ctx,
      ),
      ERROR_CODES.repositoryTaken,
    );
    expect(taken.details).toEqual({ projectSlug: first.slug });
    // Relinking the first project replaces its repository.
    await services.repositories.link(
      first.id,
      { connectionId: connection.id, externalId: '102' },
      ctx,
    );
    expect((await services.repositories.get(first.id))?.fullPath).toBe('kost/notes');
    expect(
      await services.repositories.link(
        second.id,
        { connectionId: connection.id, externalId: '101' },
        ctx,
      ),
    ).toMatchObject({
      fullPath: 'kost/workbox',
    });
  });

  it('refuses repositories the account cannot read or see', async () => {
    const connection = await addGitHub();
    const project = await newProject();
    await expectDomainError(
      services.repositories.link(
        project.id,
        { connectionId: connection.id, externalId: '103' },
        ctx,
      ),
      ERROR_CODES.repositoryAccessDenied,
    );
    await expectDomainError(
      services.repositories.link(
        project.id,
        { connectionId: connection.id, externalId: '999' },
        ctx,
      ),
      ERROR_CODES.notFound,
    );
    expect(await services.repositories.get(project.id)).toBeNull();
  });

  it('verification picks up renames, lost access and expired tokens', async () => {
    const connection = await addGitHub();
    const project = await newProject();
    await services.repositories.link(
      project.id,
      { connectionId: connection.id, externalId: '101' },
      ctx,
    );

    github.tokens.get(GH_TOKEN)!.repos[0]!.fullPath = 'kost/workbox-renamed';
    expect(await services.repositories.verify(project.id, ctx)).toMatchObject({
      fullPath: 'kost/workbox-renamed',
      accessStatus: 'verified',
    });

    github.tokens.get(GH_TOKEN)!.repos.shift();
    expect(await services.repositories.verify(project.id, ctx)).toMatchObject({
      accessStatus: 'denied',
      lastError: expect.stringMatching(/not found/),
    });

    github.tokens.get(GH_TOKEN)!.revoked = true;
    expect(await services.repositories.verify(project.id, ctx)).toMatchObject({
      accessStatus: 'expired',
    });
    expect((await services.connections.get(connection.id)).status).toBe('expired');
  });

  it('keeps the last known status on transient provider errors', async () => {
    const connection = await addGitHub();
    const project = await newProject();
    await services.repositories.link(
      project.id,
      { connectionId: connection.id, externalId: '101' },
      ctx,
    );
    github.failNext(502);
    expect(await services.repositories.verify(project.id, ctx)).toMatchObject({
      accessStatus: 'verified',
      lastError: expect.stringMatching(/502/),
    });
  });

  it('re-verifies linked repositories after a token is replaced', async () => {
    const connection = await addGitHub();
    const project = await newProject();
    await services.repositories.link(
      project.id,
      { connectionId: connection.id, externalId: '101' },
      ctx,
    );
    github.tokens.get(GH_TOKEN)!.revoked = true;
    await services.repositories.verify(project.id, ctx);
    github.tokens.set(GH_TOKEN_2, {
      account: 'kost',
      repos: [{ id: 101, fullPath: 'kost/workbox' }],
    });
    await services.connections.rotate(connection.id, GH_TOKEN_2, ctx);
    await services.repositories.verifyAllForConnection(connection.id, ctx);
    expect((await services.repositories.get(project.id))?.accessStatus).toBe('verified');
    await expectNoPlaintextTokensInDatabase();
  });
});

describe('vault key rotation', () => {
  it('re-encrypts all credentials under a new key; old key no longer needed afterwards', async () => {
    const connection = await addGitHub();
    const newKey = generateMasterKey();
    const rotating = Keyring.fromConfig({
      currentKey: newKey,
      currentVersion: 2,
      previousKeys: `1:${masterKey}`,
    });
    const summary = await rotateCredentialKeys(handle.db, rotating);
    expect(summary.keyVersion).toBe(2);
    expect(summary.rotated).toBe(summary.total);
    expect(await rotateCredentialKeys(handle.db, rotating)).toMatchObject({ rotated: 0 });

    const afterRotation = createServices({
      db: handle.db,
      keyring: Keyring.fromConfig({ currentKey: newKey, currentVersion: 2 }),
      codeHosts: createCodeHostRegistry({ timeoutMs: 1_000 }),
    });
    expect((await afterRotation.connections.test(connection.id, ctx)).status).toBe('connected');
    // Keep later tests working with the original key.
    await rotateCredentialKeys(
      handle.db,
      Keyring.fromConfig({ currentKey: masterKey, currentVersion: 1, previousKeys: `2:${newKey}` }),
    );
  });
});

describe('agent runtimes', () => {
  it('records the worker probe result and reports it', async () => {
    expect(await services.agentRuntimes.status()).toMatchObject({
      ok: false,
      message: 'Not checked yet.',
      checkedAt: null,
    });
    probeResult = {
      workerId: 'host:1',
      checkedAt: '2026-11-04T12:00:00.000Z',
      installed: true,
      version: '2.1.318',
      loggedIn: true,
      authMethod: 'claude.ai',
      subscriptionType: 'max',
      loginExpiresAt: null,
      ok: true,
      message: 'Claude Code is installed and signed in.',
    };
    const status = await services.agentRuntimes.check(ctx);
    expect(status).toMatchObject({
      ok: true,
      installed: true,
      version: '2.1.318',
      workerId: 'host:1',
      checkedAt: '2026-11-04T12:00:00.000Z',
    });
    probeResult = { ...probeResult, ok: false, loggedIn: false, message: 'not signed in' };
    expect(await services.agentRuntimes.check(ctx)).toMatchObject({ ok: false, loggedIn: false });
    // Agent runtimes are not listed as code-host accounts.
    expect((await services.connections.list()).some((c) => c.provider === 'claude_code')).toBe(
      false,
    );
  });

  it('surfaces an unavailable worker', async () => {
    probeResult = new DomainError(ERROR_CODES.workerUnavailable, 'no worker answered');
    await expectDomainError(services.agentRuntimes.check(ctx), ERROR_CODES.workerUnavailable);
  });
});
