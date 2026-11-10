import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_PACKAGE_NAME = 'workbox';

/**
 * Locates the repository root (the directory holding the root `package.json`) by walking up from
 * this module. Works both from TypeScript sources and from compiled output under `dist/`, whose
 * directory depth differs.
 */
export function findProjectRoot(startUrl: string = import.meta.url): string {
  let dir = dirname(fileURLToPath(startUrl));
  for (;;) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) {
      const pkg = JSON.parse(readFileSync(candidate, 'utf8')) as { name?: string };
      if (pkg.name === ROOT_PACKAGE_NAME) return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`could not locate the ${ROOT_PACKAGE_NAME} project root`);
    }
    dir = parent;
  }
}

export const PROJECT_ROOT = findProjectRoot();

/** Version of the Workbox platform, from the root package.json. */
export const WORKBOX_VERSION: string = (
  JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8')) as { version: string }
).version;
