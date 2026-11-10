import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { instanceHost, normalizeInstanceUrl, probeClaudeCode } from '../src/index.js';

describe('normalizeInstanceUrl', () => {
  it.each([
    ['github', undefined, 'https://github.com'],
    ['gitlab', '', 'https://gitlab.com'],
    ['gitlab', 'https://gitlab.company.com/', 'https://gitlab.company.com'],
    ['gitlab', 'https://git.example.com/gitlab/api/v4', 'https://git.example.com/gitlab'],
    ['github', 'https://api.github.com', 'https://github.com'],
    ['github', 'https://ghe.example.com/api/v3', 'https://ghe.example.com'],
    ['github', 'http://127.0.0.1:9999', 'http://127.0.0.1:9999'],
  ] as const)('%s %j → %s', (provider, input, expected) => {
    expect(normalizeInstanceUrl(provider, input)).toBe(expected);
  });

  it.each([
    ['http://gitlab.company.com', /https/],
    ['https://user:pass@gitlab.company.com', /credentials/],
    ['https://gitlab.company.com/?x=1', /query/],
    ['not a url', /valid URL/],
  ])('rejects %s', (input, message) => {
    expect(() => normalizeInstanceUrl('gitlab', input)).toThrow(message);
  });

  it('extracts the host', () => {
    expect(instanceHost('https://gitlab.company.com/gitlab')).toBe('gitlab.company.com');
  });
});

describe('probeClaudeCode', () => {
  const dir = mkdtempSync(join(tmpdir(), 'workbox-probe-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const fakeCli = (name: string, script: string) => {
    const path = join(dir, name);
    writeFileSync(path, `#!/bin/sh\n${script}\n`);
    chmodSync(path, 0o755);
    return path;
  };

  it('reports installed and signed in, without personal fields', async () => {
    const command = fakeCli(
      'claude-ok',
      `if [ "$1" = "--version" ]; then echo "2.1.318 (Claude Code)"; else echo '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max","email":"me@example.com","orgId":"org-1"}'; fi`,
    );
    const result = await probeClaudeCode({ command });
    expect(result).toEqual({
      installed: true,
      version: '2.1.318',
      loggedIn: true,
      authMethod: 'claude.ai',
      subscriptionType: 'max',
      loginExpiresAt: null,
      ok: true,
      message: 'Claude Code is installed and signed in.',
    });
    expect(JSON.stringify(result)).not.toContain('me@example.com');
  });

  it('reports installed but signed out', async () => {
    const command = fakeCli(
      'claude-out',
      `if [ "$1" = "--version" ]; then echo "2.0.0"; else echo '{"loggedIn":false}'; fi`,
    );
    expect(await probeClaudeCode({ command })).toMatchObject({
      installed: true,
      loggedIn: false,
      ok: false,
    });
  });

  it('reports not installed', async () => {
    expect(await probeClaudeCode({ command: join(dir, 'does-not-exist') })).toMatchObject({
      installed: false,
      ok: false,
      message: expect.stringMatching(/not found/),
    });
  });

  it('does not pass Workbox secrets to the CLI environment', async () => {
    process.env.WORKBOX_MASTER_KEY = 'must-not-leak';
    const command = fakeCli(
      'claude-env',
      `if [ "$1" = "--version" ]; then echo "1.0.0"; else echo "{\\"loggedIn\\":true,\\"authMethod\\":\\"$WORKBOX_MASTER_KEY\\"}"; fi`,
    );
    const result = await probeClaudeCode({ command });
    delete process.env.WORKBOX_MASTER_KEY;
    expect(result.authMethod).toBe('');
  });
});
