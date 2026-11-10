import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { findProjectRoot, PROJECT_ROOT, WORKBOX_VERSION } from '../src/project-root.js';

describe('findProjectRoot', () => {
  it('resolves the repository root containing the root package.json', () => {
    const pkg = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8')) as {
      name: string;
      version: string;
    };
    expect(pkg.name).toBe('workbox');
    expect(WORKBOX_VERSION).toBe(pkg.version);
    expect(existsSync(join(PROJECT_ROOT, 'packages', 'database', 'migrations'))).toBe(true);
  });

  it('finds the same root from a deeper start location (as compiled dist/ files do)', () => {
    const deep = pathToFileURL(join(PROJECT_ROOT, 'dist', 'packages', 'core', 'src', 'x.js')).href;
    expect(findProjectRoot(deep)).toBe(PROJECT_ROOT);
  });

  it('throws when no root package.json exists above the start location', () => {
    expect(() => findProjectRoot('file:///nonexistent-workbox-dir/a/b.js')).toThrow(/project root/);
  });
});
