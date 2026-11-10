import { describe, expect, it } from 'vitest';
import {
  checkRepoUrl,
  createProjectInputSchema,
  isValidBranchName,
  slugify,
  updateTaskInputSchema,
} from '../src/index.js';

describe('slugify', () => {
  it.each([
    ['Workbox', 'workbox'],
    ['My App (v2)', 'my-app-v2'],
    ['  --Hello__World--  ', 'hello-world'],
    ['Café Déjà vu', 'cafe-deja-vu'],
    ['!!!', ''],
  ])('%j → %j', (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });

  it('caps length at 64 without a trailing hyphen', () => {
    const slug = slugify(`${'a'.repeat(63)} b`);
    expect(slug.length).toBeLessThanOrEqual(64);
    expect(slug.endsWith('-')).toBe(false);
  });
});

describe('checkRepoUrl', () => {
  it.each([
    'https://github.com/org/repo',
    'https://github.com/org/repo.git',
    'ssh://git@github.com/org/repo.git',
    'ssh://git@git.example.com:2222/org/repo.git',
    'git@github.com:org/repo.git',
  ])('accepts %s', (url) => {
    expect(checkRepoUrl(url)).toEqual({ ok: true });
  });

  it.each([
    ['https://x-access-token:ghp_secret@github.com/org/repo.git', /credentials/],
    ['https://ghp_secret@github.com/org/repo.git', /credentials/],
    ['ssh://git:hunter2@github.com/org/repo.git', /credentials/],
    ['http://github.com/org/repo', /https/],
    ['file:///etc/passwd', /https/],
    ['https://github.com', /repository path/],
    ['https://github.com/org/repo?token=abc', /query/],
    [' https://github.com/org/repo', /whitespace/],
    ['not a url', /whitespace/],
    ['ftp//nope', /Git URL/],
  ])('rejects %s', (url, reason) => {
    const result = checkRepoUrl(url);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(reason);
  });
});

describe('isValidBranchName', () => {
  it.each(['main', 'develop', 'feature/m2-tasks', 'release-1.2'])('accepts %s', (name) => {
    expect(isValidBranchName(name)).toBe(true);
  });
  it.each(['', 'has space', 'a..b', '-flag', 'ends/', 'x.lock', 'a@{1}', 'bad:colon'])(
    'rejects %j',
    (name) => {
      expect(isValidBranchName(name)).toBe(false);
    },
  );
});

describe('input schemas', () => {
  it('rejects the removed repoUrl field (repositories are linked via accounts), without echoing it', () => {
    const result = createProjectInputSchema.safeParse({
      name: 'X',
      repoUrl: 'https://user:ghp_supersecret@github.com/o/r',
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).not.toContain('ghp_supersecret');
  });

  it('requires at least one real field on task update', () => {
    expect(updateTaskInputSchema.safeParse({ expectedVersion: 3 }).success).toBe(false);
    expect(updateTaskInputSchema.safeParse({ title: 'New', expectedVersion: 3 }).success).toBe(
      true,
    );
  });
});
