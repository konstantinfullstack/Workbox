import { join } from 'node:path';
import { PROJECT_ROOT } from '#core';

/** Absolute path to the committed SQL migrations (same location for sources and compiled output). */
export const MIGRATIONS_FOLDER = join(PROJECT_ROOT, 'packages', 'database', 'migrations');
