import { describe, expect, it } from 'vitest';
import { CODE_HOSTS } from '../src/index.js';

describe('code host links', () => {
  it('builds GitHub commit and branch links', () => {
    const github = CODE_HOSTS.github;
    expect(github.commitUrl('https://github.com/kost/app/', 'abc')).toBe(
      'https://github.com/kost/app/commit/abc',
    );
    expect(github.branchUrl('https://github.com/kost/app', 'workbox/3-add #1')).toBe(
      'https://github.com/kost/app/tree/workbox/3-add%20%231',
    );
  });

  it('builds GitLab (also self-hosted) commit and branch links', () => {
    const gitlab = CODE_HOSTS.gitlab;
    expect(gitlab.commitUrl('https://gitlab.company.com/group/app', 'abc')).toBe(
      'https://gitlab.company.com/group/app/-/commit/abc',
    );
    expect(gitlab.branchUrl('https://gitlab.com/g/sub/app', 'workbox/3-x')).toBe(
      'https://gitlab.com/g/sub/app/-/tree/workbox/3-x',
    );
  });
});
