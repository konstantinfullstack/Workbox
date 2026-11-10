import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

// Load the local .env (if any) so integration tests find the DB_* / REDIS_* settings.
// Variables already set in the environment (e.g. by CI) take precedence.
const envFile = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(envFile)) {
  for (const [key, value] of Object.entries(parseEnv(readFileSync(envFile, 'utf8')))) {
    if (value !== undefined) process.env[key] ??= value;
  }
}
