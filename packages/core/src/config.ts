import { homedir } from 'node:os';
import { PROJECT_ROOT } from './project-root.js';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';

/**
 * `~/x` → `/home/me/x`. Relative paths resolve against `base` (the Workbox project folder), not
 * the current directory, so the result doesn't depend on where a command was started.
 */
export function expandHome(path: string, base: string = PROJECT_ROOT): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return isAbsolute(path) ? path : resolve(base, path);
}

const logLevelSchema = z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);

const portSchema = z.coerce.number().int().min(1).max(65535);
const requiredString = z.string({ error: 'is required' }).min(1, 'is required');

/**
 * PostgreSQL connection settings. The single source of truth: the app, the tests and the optional
 * bundled Compose container (compose.yaml) all read these same variables.
 */
export const databaseConfigShape = {
  DB_HOST: z.string().min(1).default('127.0.0.1'),
  DB_PORT: portSchema.default(5432),
  DB_USER: requiredString,
  DB_PASSWORD: z.string().optional(),
  DB_NAME: requiredString,
};

/** Redis connection settings, shared by the app, the tests and the Compose Redis container. */
export const redisConfigShape = {
  REDIS_HOST: z.string().min(1).default('127.0.0.1'),
  REDIS_PORT: portSchema.default(6379),
  REDIS_PASSWORD: z.string().optional(),
};

/** Credential vault master key(s); see docs/adr/003-credential-vault-and-master-key.md. */
export const vaultConfigShape = {
  WORKBOX_MASTER_KEY: z
    .string({ error: 'is required (generate one with: pnpm vault:generate-key)' })
    .min(1, 'is required (generate one with: pnpm vault:generate-key)'),
  WORKBOX_MASTER_KEY_VERSION: z.coerce.number().int().min(1).default(1),
  /** Comma-separated `<version>:<base64>` pairs, kept only while rotating keys. */
  WORKBOX_PREVIOUS_MASTER_KEYS: z.string().optional(),
};

const baseConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: logLevelSchema.default('info'),
});

/** Saved files of each run (agent transcript, full check output, patch). */
const artifactsConfigShape = {
  /** Default: `artifacts/` inside the Workbox project folder (git-ignored). */
  WORKBOX_ARTIFACTS_DIR: z
    .string()
    .min(1)
    .optional()
    .transform((value) => expandHome(value ?? 'artifacts')),
  /** Run files are deleted this many days after the run. */
  WORKBOX_ARTIFACT_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(7),
};

export const apiConfigSchema = baseConfigSchema.extend({
  API_HOST: z.string().min(1).default('127.0.0.1'),
  API_PORT: portSchema.default(3000),
  /** Comma-separated list of allowed browser origins. Empty disables CORS. */
  CORS_ORIGINS: z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    ),
  ...databaseConfigShape,
  ...redisConfigShape,
  ...vaultConfigShape,
  ...artifactsConfigShape,
});
export type ApiConfig = z.infer<typeof apiConfigSchema>;

export const workerConfigSchema = baseConfigSchema.extend({
  WORKER_ID: z.string().min(1).max(200).optional(),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(1),
  /** Claude Code executable (name on PATH or absolute path). */
  CLAUDE_CODE_COMMAND: z.string().min(1).optional(),
  /** Author name for commits Workbox makes (the email is the account's no-reply address). */
  WORKBOX_GIT_AUTHOR_NAME: z.string().trim().min(1).max(200).optional(),
  /** Agent time limit per run. */
  WORKBOX_RUN_TIMEOUT_MINUTES: z.coerce.number().int().min(1).max(240).default(30),
  /**
   * Where cloned repositories live. Default: `workspaces/` inside the Workbox project folder
   * (git-ignored). Relative paths are resolved against the project folder.
   */
  WORKBOX_WORKSPACES_DIR: z
    .string()
    .min(1)
    .optional()
    .transform((value) => expandHome(value ?? 'workspaces')),
  ...redisConfigShape,
  ...databaseConfigShape,
  ...vaultConfigShape,
  ...artifactsConfigShape,
});
export type WorkerConfig = z.infer<typeof workerConfigSchema>;

export const migrationConfigSchema = baseConfigSchema.extend({
  ...databaseConfigShape,
});
export type MigrationConfig = z.infer<typeof migrationConfigSchema>;

export interface DatabaseSettings {
  DB_HOST: string;
  DB_PORT: number;
  DB_USER: string;
  DB_PASSWORD?: string | undefined;
  DB_NAME: string;
}

export interface RedisSettings {
  REDIS_HOST: string;
  REDIS_PORT: number;
  REDIS_PASSWORD?: string | undefined;
}

/** Builds a postgres:// connection string. `database` overrides DB_NAME (e.g. for tests). */
export function postgresUrl(
  settings: DatabaseSettings,
  database: string = settings.DB_NAME,
): string {
  const url = new URL(`postgres://${formatHost(settings.DB_HOST)}:${settings.DB_PORT}`);
  url.username = settings.DB_USER;
  if (settings.DB_PASSWORD) url.password = settings.DB_PASSWORD;
  url.pathname = `/${encodeURIComponent(database)}`;
  return url.toString();
}

/** Builds a redis:// connection string. */
export function redisUrl(settings: RedisSettings): string {
  const url = new URL(`redis://${formatHost(settings.REDIS_HOST)}:${settings.REDIS_PORT}`);
  if (settings.REDIS_PASSWORD) url.password = settings.REDIS_PASSWORD;
  return url.toString();
}

/** Wraps bare IPv6 addresses in brackets so they form a valid URL authority. */
function formatHost(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

export class ConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid configuration:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

/**
 * Validates environment variables against a schema.
 *
 * Error messages name the offending variable and the rule it violated, but never echo the
 * supplied value: configuration routinely contains credentials (e.g. DB_PASSWORD).
 */
export function parseConfig<T extends z.ZodType>(
  schema: T,
  env: Record<string, string | undefined> = process.env,
): z.output<T> {
  // `FOO=` in a .env file means "unset", so defaults and optionality apply.
  const normalized = Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== undefined && value !== ''),
  );
  const result = schema.safeParse(normalized, { reportInput: false });
  if (result.success) {
    return result.data;
  }
  const issues = result.error.issues.map((issue) => {
    const key = issue.path.join('.') || '(root)';
    const message =
      issue.code === 'invalid_type' &&
      normalized[key] === undefined &&
      !issue.message.startsWith('is required')
        ? 'is required'
        : issue.message;
    return `${key} ${message}`;
  });
  throw new ConfigError(issues);
}
