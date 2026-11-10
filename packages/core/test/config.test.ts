import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROJECT_ROOT } from '../src/project-root.js';
import {
  apiConfigSchema,
  ConfigError,
  expandHome,
  parseConfig,
  postgresUrl,
  redisUrl,
  workerConfigSchema,
} from '../src/config.js';

const SECRET = 's3cr3t-value-that-must-not-leak';
const validApiEnv = {
  DB_USER: 'workbox',
  DB_PASSWORD: SECRET,
  DB_NAME: 'workbox',
  WORKBOX_MASTER_KEY: Buffer.alloc(32, 1).toString('base64'),
};

describe('parseConfig', () => {
  it('applies defaults for optional values', () => {
    const config = parseConfig(apiConfigSchema, validApiEnv);
    expect(config).toMatchObject({
      NODE_ENV: 'development',
      LOG_LEVEL: 'info',
      API_HOST: '127.0.0.1',
      API_PORT: 3000,
      CORS_ORIGINS: [],
      DB_HOST: '127.0.0.1',
      DB_PORT: 5432,
      REDIS_HOST: '127.0.0.1',
      REDIS_PORT: 6379,
    });
  });

  it('coerces numbers and splits CORS origins', () => {
    const config = parseConfig(apiConfigSchema, {
      ...validApiEnv,
      API_PORT: '8080',
      DB_PORT: '55432',
      CORS_ORIGINS: 'http://localhost:5173, https://admin.example.test ,',
    });
    expect(config.API_PORT).toBe(8080);
    expect(config.DB_PORT).toBe(55432);
    expect(config.CORS_ORIGINS).toEqual(['http://localhost:5173', 'https://admin.example.test']);
  });

  it('treats empty strings as unset so defaults apply', () => {
    const config = parseConfig(workerConfigSchema, {
      ...validApiEnv,
      WORKER_ID: '',
      WORKER_CONCURRENCY: '',
      REDIS_PASSWORD: '',
    });
    expect(config.WORKER_ID).toBeUndefined();
    expect(config.WORKER_CONCURRENCY).toBe(1);
    expect(config.REDIS_PASSWORD).toBeUndefined();
    // Workspaces default to <project folder>/workspaces (git-ignored), as an absolute path.
    expect(config.WORKBOX_WORKSPACES_DIR).toBe(join(PROJECT_ROOT, 'workspaces'));
  });

  it('explains how to create a missing vault master key', () => {
    const { WORKBOX_MASTER_KEY: _omitted, ...withoutKey } = validApiEnv;
    const error = captureConfigError(() => parseConfig(apiConfigSchema, withoutKey));
    expect(error.issues).toEqual([
      'WORKBOX_MASTER_KEY is required (generate one with: pnpm vault:generate-key)',
    ]);
  });

  it('reports every missing required variable by name', () => {
    const error = captureConfigError(() => parseConfig(apiConfigSchema, { DB_NAME: '' }));
    expect(error.issues).toEqual(
      expect.arrayContaining(['DB_USER is required', 'DB_NAME is required']),
    );
  });

  it('rejects malformed values without echoing them', () => {
    const error = captureConfigError(() =>
      parseConfig(apiConfigSchema, {
        ...validApiEnv,
        DB_PORT: SECRET,
        REDIS_PORT: '99999',
        API_PORT: '0',
        LOG_LEVEL: SECRET,
      }),
    );
    expect(error.issues.map((issue) => issue.split(' ')[0])).toEqual(
      expect.arrayContaining(['DB_PORT', 'REDIS_PORT', 'API_PORT', 'LOG_LEVEL']),
    );
    expect(error.message).not.toContain(SECRET);
    expect(JSON.stringify(error.issues)).not.toContain(SECRET);
  });
});

describe('expandHome', () => {
  it('expands ~ and resolves relative paths against the project folder, not the cwd', () => {
    expect(expandHome('~/x')).toMatch(/^\/.+\/x$/);
    expect(expandHome('workspaces')).toBe(join(PROJECT_ROOT, 'workspaces'));
    expect(expandHome('/abs/path')).toBe('/abs/path');
    expect(expandHome('clones', '/base')).toBe('/base/clones');
  });
});

describe('connection URL builders', () => {
  const db = { DB_HOST: 'db.local', DB_PORT: 5432, DB_USER: 'app', DB_NAME: 'workbox' };

  it('builds a postgres URL, percent-encoding special characters in credentials', () => {
    expect(postgresUrl({ ...db, DB_PASSWORD: 'p@ss:w/rd#1' })).toBe(
      'postgres://app:p%40ss%3Aw%2Frd%231@db.local:5432/workbox',
    );
  });

  it('round-trips credentials through URL parsing', () => {
    const url = new URL(postgresUrl({ ...db, DB_PASSWORD: 'p@ss:w/rd#1' }));
    expect(decodeURIComponent(url.password)).toBe('p@ss:w/rd#1');
  });

  it('supports overriding the database name and omitting the password', () => {
    expect(postgresUrl(db, 'workbox_test')).toBe('postgres://app@db.local:5432/workbox_test');
  });

  it('brackets IPv6 hosts', () => {
    expect(postgresUrl({ ...db, DB_HOST: '::1' })).toBe('postgres://app@[::1]:5432/workbox');
  });

  it('builds a redis URL with optional password', () => {
    expect(redisUrl({ REDIS_HOST: '127.0.0.1', REDIS_PORT: 56379 })).toBe(
      'redis://127.0.0.1:56379',
    );
    expect(redisUrl({ REDIS_HOST: 'cache', REDIS_PORT: 6379, REDIS_PASSWORD: 'x/y' })).toBe(
      'redis://:x%2Fy@cache:6379',
    );
  });
});

function captureConfigError(fn: () => unknown): ConfigError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error('expected ConfigError');
}
