import { Secret } from '#vault';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startFakeGitLab, type FakeCodeHost } from '../../../test/fake-code-hosts.js';
import { GitLabAdapter } from '../src/index.js';

const PROJECT_TOKEN = 'glpat-projectTokenValue0123456789';
const PERSONAL_TOKEN = 'glpat-personalTokenValue012345678';
let fake: FakeCodeHost;
const adapter = new GitLabAdapter({ timeoutMs: 500 });
const account = () => ({ baseUrl: fake.baseUrl });

beforeAll(async () => {
  fake = await startFakeGitLab();
});
afterAll(() => fake.close());
beforeEach(() => {
  fake.tokens.clear();
  fake.requests.length = 0;
  fake.tokens.set(PROJECT_TOKEN, {
    account: 'project_42_bot_abc123',
    expiresAt: '2027-01-15',
    repos: [{ id: 42, fullPath: 'company/platform/api', accessLevel: 30 }],
  });
  fake.tokens.set(PERSONAL_TOKEN, {
    account: 'kost',
    scopes: ['api', 'read_repository'],
    expiresAt: null,
    repos: [
      { id: 1, fullPath: 'kost/tools', accessLevel: 40 },
      { id: 2, fullPath: 'company/docs', accessLevel: 20 },
      { id: 3, fullPath: 'company/guest-only', accessLevel: 10 },
    ],
  });
});

describe('GitLabAdapter', () => {
  it('recognises a project access token and its expiry', async () => {
    const check = await adapter.verifyCredential(account(), new Secret(PROJECT_TOKEN));
    expect(check).toEqual({
      accountName: 'project_42_bot_abc123',
      accountId: '1000',
      tokenKind: 'project_access_token',
      scopes: ['api', 'read_repository', 'write_repository'],
      expiresAt: '2027-01-15T00:00:00.000Z',
      warnings: [],
    });
    expect(fake.requests[0]?.headers['private-token']).toBe(PROJECT_TOKEN);
  });

  it('warns about missing scopes, broad personal tokens and no expiry', async () => {
    const check = await adapter.verifyCredential(account(), new Secret(PERSONAL_TOKEN));
    expect(check.tokenKind).toBe('personal_access_token');
    expect(check.warnings.join(' | ')).toMatch(/Missing scopes: write_repository/);
    expect(check.warnings.join(' | ')).toMatch(/every project you can access/);
    expect(check.warnings.join(' | ')).toMatch(/never expires/);
  });

  it('treats revoked tokens and unknown tokens as unauthorized', async () => {
    fake.tokens.get(PROJECT_TOKEN)!.revoked = true;
    await expect(
      adapter.verifyCredential(account(), new Secret(PROJECT_TOKEN)),
    ).rejects.toMatchObject({ kind: 'unauthorized' });
    await expect(
      adapter.verifyCredential(account(), new Secret('glpat-unknown000000000')),
    ).rejects.toMatchObject({
      kind: 'unauthorized',
    });
  });

  it('lists projects with Reporter+ access, maps access levels and searches', async () => {
    const repos = await adapter.listRepositories(account(), new Secret(PERSONAL_TOKEN));
    expect(repos.map((r) => [r.fullPath, r.access])).toEqual([
      ['kost/tools', { pull: true, push: true }],
      ['company/docs', { pull: true, push: false }],
    ]);
    const searched = await adapter.listRepositories(account(), new Secret(PERSONAL_TOKEN), {
      search: 'docs',
    });
    expect(searched.map((r) => r.fullPath)).toEqual(['company/docs']);
    expect(fake.requests.at(-1)?.path).toContain('search=docs');
  });

  it('follows x-next-page pagination', async () => {
    fake.tokens.get(PERSONAL_TOKEN)!.repos = Array.from({ length: 150 }, (_, i) => ({
      id: 500 + i,
      fullPath: `g/p${i}`,
      accessLevel: 30,
    }));
    expect(
      await adapter.listRepositories(account(), new Secret(PERSONAL_TOKEN), { limit: 200 }),
    ).toHaveLength(150);
  });

  it('supports nested groups and self-hosted instances under a path', async () => {
    const repo = await adapter.getRepository(account(), new Secret(PROJECT_TOKEN), '42');
    expect(repo).toMatchObject({
      externalId: '42',
      fullPath: 'company/platform/api',
      access: { pull: true, push: true },
    });
    expect(fake.requests.at(-1)?.path).toBe('/api/v4/projects/42');
  });
});

describe('GitLab files and merge requests', () => {
  const repo = { externalId: '42', fullPath: 'company/platform/api' };
  beforeEach(() => {
    fake.reviewRequests.length = 0;
    fake.tokens.get(PROJECT_TOKEN)!.repos[0]!.files = {
      'go.mod': 'module x',
      'src/main.go': 'package main',
    };
  });

  it('reads files by path (null when missing)', async () => {
    expect(
      await adapter.readFile(account(), new Secret(PROJECT_TOKEN), repo, 'go.mod', 'main'),
    ).toBe('module x');
    expect(
      await adapter.readFile(account(), new Secret(PROJECT_TOKEN), repo, 'src/main.go', 'main'),
    ).toBe('package main');
    expect(fake.requests.at(-1)?.path).toContain('/repository/files/src%2Fmain.go?ref=main');
    expect(
      await adapter.readFile(account(), new Secret(PROJECT_TOKEN), repo, 'Cargo.toml', 'main'),
    ).toBeNull();
  });

  it('creates draft merge requests via the title prefix and keeps it on update', async () => {
    const token = new Secret(PROJECT_TOKEN);
    const created = await adapter.createReviewRequest(account(), token, repo, {
      head: 'workbox/5-x',
      base: 'develop',
      title: 'Fix it',
      body: 'Summary',
      draft: true,
    });
    expect(created).toMatchObject({ number: 1, state: 'draft', title: 'Fix it' });
    expect(fake.requests.at(-1)).toMatchObject({
      method: 'POST',
      body: { source_branch: 'workbox/5-x', target_branch: 'develop', title: 'Draft: Fix it' },
    });
    expect(
      await adapter.findOpenReviewRequest(account(), token, repo, 'workbox/5-x'),
    ).toMatchObject({ number: 1, state: 'draft' });
    expect(
      await adapter.updateReviewRequest(account(), token, repo, 1, {
        title: 'Fix it properly',
        body: 'B',
      }),
    ).toMatchObject({
      title: 'Fix it properly',
      state: 'draft',
    });
    expect(fake.reviewRequests[0]!.title).toBe('Draft: Fix it properly');
  });
});
