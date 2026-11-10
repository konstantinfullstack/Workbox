import { Secret } from '#vault';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startFakeGitHub, type FakeCodeHost } from '../../../test/fake-code-hosts.js';
import { apiRoot, CodeHostError, GitHubAdapter, parseGitHubExpiry } from '../src/index.js';

const FINE = 'github_pat_11AAAAAAA0fineGrainedTokenValue_abcd';
const CLASSIC = 'ghp_classicTokenValue0123456789abcdefgh';
let fake: FakeCodeHost;
const adapter = new GitHubAdapter({ timeoutMs: 500 });
const account = () => ({ baseUrl: fake.baseUrl });

beforeAll(async () => {
  fake = await startFakeGitHub();
});
afterAll(() => fake.close());
beforeEach(() => {
  fake.tokens.clear();
  fake.requests.length = 0;
  fake.delayMs = 0;
  fake.tokens.set(FINE, {
    account: 'kost',
    expiresAt: '2026-12-01 10:00:00 UTC',
    repos: [
      { id: 101, fullPath: 'kost/workbox', push: true },
      { id: 102, fullPath: 'kost/notes', push: false, visibility: 'public' },
    ],
  });
  fake.tokens.set(CLASSIC, { account: 'kost', scopes: ['repo', 'workflow'], repos: [] });
});

describe('GitHubAdapter', () => {
  it('verifies a fine-grained token and reads account and expiry', async () => {
    const check = await adapter.verifyCredential(account(), new Secret(FINE));
    expect(check).toEqual({
      accountName: 'kost',
      accountId: '1000',
      tokenKind: 'personal_access_token',
      scopes: [],
      expiresAt: '2026-12-01T10:00:00.000Z',
      warnings: [],
    });
    expect(fake.requests[0]?.headers.authorization).toBe(`Bearer ${FINE}`);
    expect(fake.requests[0]?.headers['x-github-api-version']).toBe('2022-11-28');
  });

  it('warns about classic tokens and missing expiry', async () => {
    const check = await adapter.verifyCredential(account(), new Secret(CLASSIC));
    expect(check.scopes).toEqual(['repo', 'workflow']);
    expect(check.warnings.join(' ')).toMatch(/classic token/);
  });

  it('maps a bad token to unauthorized without leaking it', async () => {
    const error = await adapter
      .verifyCredential(account(), new Secret('github_pat_wrong_000000000000'))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CodeHostError);
    expect((error as CodeHostError).kind).toBe('unauthorized');
    expect((error as CodeHostError).message).not.toContain('github_pat_wrong');
  });

  it('maps rate limits, server errors and timeouts', async () => {
    fake.failNext(403, 1, { 'x-ratelimit-remaining': '0' });
    await expect(adapter.verifyCredential(account(), new Secret(FINE))).rejects.toMatchObject({
      kind: 'rate_limited',
    });
    fake.failNext(429);
    await expect(adapter.verifyCredential(account(), new Secret(FINE))).rejects.toMatchObject({
      kind: 'rate_limited',
    });
    fake.failNext(403);
    await expect(adapter.verifyCredential(account(), new Secret(FINE))).rejects.toMatchObject({
      kind: 'forbidden',
    });
    fake.failNext(502);
    await expect(adapter.verifyCredential(account(), new Secret(FINE))).rejects.toMatchObject({
      kind: 'unavailable',
    });
    fake.delayMs = 1_000;
    await expect(adapter.verifyCredential(account(), new Secret(FINE))).rejects.toMatchObject({
      kind: 'unavailable',
      message: 'GitHub did not respond in time',
    });
  });

  it('lists repositories with permissions, search and pagination', async () => {
    const repos = await adapter.listRepositories(account(), new Secret(FINE));
    expect(repos.map((r) => [r.externalId, r.fullPath, r.access.push])).toEqual([
      ['101', 'kost/workbox', true],
      ['102', 'kost/notes', false],
    ]);
    expect(repos[1]?.visibility).toBe('public');

    fake.tokens.get(FINE)!.repos = Array.from({ length: 230 }, (_, i) => ({
      id: 1000 + i,
      fullPath: `kost/repo-${i}`,
    }));
    const many = await adapter.listRepositories(account(), new Secret(FINE), { limit: 500 });
    expect(many).toHaveLength(230);
    const searched = await adapter.listRepositories(account(), new Secret(FINE), {
      search: 'REPO-22',
    });
    expect(searched.map((r) => r.fullPath)).toEqual(
      expect.arrayContaining(['kost/repo-22', 'kost/repo-220', 'kost/repo-229']),
    );
  });

  it('gets a repository by its stable id and reports not found', async () => {
    expect((await adapter.getRepository(account(), new Secret(FINE), '101')).fullPath).toBe(
      'kost/workbox',
    );
    await expect(adapter.getRepository(account(), new Secret(FINE), '999')).rejects.toMatchObject({
      kind: 'not_found',
    });
    await expect(adapter.getRepository(account(), new Secret(FINE), 'abc')).rejects.toMatchObject({
      kind: 'not_found',
    });
  });
});

describe('GitHub helpers', () => {
  it('uses api.github.com for github.com and /api/v3 for Enterprise', () => {
    expect(apiRoot('https://github.com')).toBe('https://api.github.com');
    expect(apiRoot('https://ghe.example.com')).toBe('https://ghe.example.com/api/v3');
  });

  it.each([
    ['2026-12-01 10:00:00 UTC', '2026-12-01T10:00:00.000Z'],
    ['2026-12-01 10:00:00 +0000', '2026-12-01T10:00:00.000Z'],
    ['garbage', null],
    [null, null],
  ])('parses expiry %j', (input, expected) => {
    expect(parseGitHubExpiry(input)).toBe(expected);
  });
});

describe('GitHub files and pull requests', () => {
  const repo = { externalId: '101', fullPath: 'kost/workbox' };
  beforeEach(() => {
    fake.reviewRequests.length = 0;
    const r = fake.tokens.get(FINE)!.repos[0]!;
    r.files = { 'package.json': '{"scripts":{"test":"vitest"}}', 'docs/a b.md': 'spaced' };
    r.denyReviewRequests = false;
  });

  it('reads files (null when missing)', async () => {
    expect(await adapter.readFile(account(), new Secret(FINE), repo, 'package.json', 'main')).toBe(
      '{"scripts":{"test":"vitest"}}',
    );
    expect(await adapter.readFile(account(), new Secret(FINE), repo, 'docs/a b.md', 'main')).toBe(
      'spaced',
    );
    expect(
      await adapter.readFile(account(), new Secret(FINE), repo, 'missing.txt', 'main'),
    ).toBeNull();
  });

  it('creates a draft pull request, finds it again, updates and reads it', async () => {
    const token = new Secret(FINE);
    expect(
      await adapter.findOpenReviewRequest(account(), token, repo, 'workbox/2-docs'),
    ).toBeNull();
    const created = await adapter.createReviewRequest(account(), token, repo, {
      head: 'workbox/2-docs',
      base: 'main',
      title: 'Add docs',
      body: 'Summary',
      draft: true,
    });
    expect(created).toMatchObject({
      number: 1,
      state: 'draft',
      title: 'Add docs',
      url: `${fake.baseUrl}/kost/workbox/pull/1`,
    });
    expect(fake.requests.at(-1)).toMatchObject({
      method: 'POST',
      body: { head: 'workbox/2-docs', base: 'main', draft: true },
    });
    expect(
      await adapter.findOpenReviewRequest(account(), token, repo, 'workbox/2-docs'),
    ).toMatchObject({ number: 1 });
    expect(fake.requests.at(-1)?.path).toContain('head=kost%3Aworkbox%2F2-docs');
    expect(
      await adapter.updateReviewRequest(account(), token, repo, 1, {
        title: 'Add docs v2',
        body: 'B',
      }),
    ).toMatchObject({ title: 'Add docs v2' });
    fake.reviewRequests[0]!.state = 'merged';
    expect(await adapter.getReviewRequest(account(), token, repo, 1)).toMatchObject({
      state: 'merged',
    });
  });

  it('reports a token without pull-request permission as forbidden', async () => {
    fake.tokens.get(FINE)!.repos[0]!.denyReviewRequests = true;
    await expect(
      adapter.createReviewRequest(account(), new Secret(FINE), repo, {
        head: 'x',
        base: 'main',
        title: 't',
        body: '',
        draft: true,
      }),
    ).rejects.toMatchObject({ kind: 'forbidden' });
  });
});
