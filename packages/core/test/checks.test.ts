import { describe, expect, it } from 'vitest';
import { detectChecks } from '../src/domain/checks.js';

describe('detectChecks', () => {
  it('detects a pnpm monorepo with lint/typecheck/test/build scripts', () => {
    const result = detectChecks({
      'package.json': JSON.stringify({
        packageManager: 'pnpm@10.0.0',
        scripts: {
          lint: 'eslint .',
          typecheck: 'tsc -b',
          test: 'vitest run',
          build: 'turbo build',
          dev: 'vite',
        },
      }),
      'pnpm-lock.yaml': 'lockfileVersion: 9',
    });
    expect(result).toEqual({
      setup: 'pnpm install --frozen-lockfile',
      commands: [
        { name: 'lint', command: 'pnpm run lint' },
        { name: 'typecheck', command: 'pnpm run typecheck' },
        { name: 'test', command: 'pnpm test' },
        { name: 'build', command: 'pnpm run build' },
      ],
      detectedFrom: ['package.json', 'pnpm-lock.yaml'],
      notes: [],
    });
  });

  it('uses npm ci / npm test for npm projects and warns about watch mode', () => {
    const result = detectChecks({
      'package.json': JSON.stringify({ scripts: { test: 'jest --watch', 'type-check': 'tsc' } }),
      'package-lock.json': '{}',
    });
    expect(result.setup).toBe('npm ci');
    expect(result.commands).toEqual([
      { name: 'typecheck', command: 'npm run type-check' },
      { name: 'test', command: 'npm test' },
    ]);
    expect(result.notes.join(' ')).toMatch(/watch mode/);
  });

  it.each([
    [{ 'yarn.lock': '' }, 'yarn install --frozen-lockfile', 'yarn test'],
    [{ 'bun.lock': '' }, 'bun install', 'bun test'],
  ])('detects other package managers %#', (lock, setup, test) => {
    const result = detectChecks({
      'package.json': JSON.stringify({ scripts: { test: 'x' } }),
      ...lock,
    });
    expect(result.setup).toBe(setup);
    expect(result.commands).toEqual([{ name: 'test', command: test }]);
  });

  it('detects Python, Go and Rust projects', () => {
    expect(
      detectChecks({ 'pyproject.toml': '[tool.ruff]\n[tool.pytest.ini_options]\n' }),
    ).toMatchObject({
      setup: 'pip install -e .',
      commands: [
        { name: 'lint', command: 'ruff check .' },
        { name: 'test', command: 'pytest' },
      ],
    });
    expect(detectChecks({ 'go.mod': 'module x' }).commands.map((c) => c.command)).toEqual([
      'go build ./...',
      'go test ./...',
    ]);
    expect(detectChecks({ 'Cargo.toml': '[package]' }).commands.map((c) => c.command)).toEqual([
      'cargo build',
      'cargo test',
    ]);
  });

  it('adds Makefile targets that are not already covered', () => {
    const result = detectChecks({
      'go.mod': 'module x',
      Makefile: 'lint:\n\tgolangci-lint run\ntest:\n\tgo test ./...\n',
    });
    expect(result.commands.map((c) => c.command)).toEqual([
      'go build ./...',
      'go test ./...',
      'make lint',
    ]);
    expect(result.detectedFrom).toEqual(['go.mod', 'Makefile']);
  });

  it('explains when nothing is found or package.json is broken', () => {
    expect(detectChecks({ 'README.md': '# hi' })).toEqual({
      setup: null,
      commands: [],
      detectedFrom: [],
      notes: [expect.stringMatching(/No known project files/)],
    });
    expect(detectChecks({ 'package.json': '{oops' }).notes[0]).toMatch(/could not be parsed/);
  });
});
