import { databaseConfigShape, parseConfig, postgresUrl, redisConfigShape, redisUrl } from '#core';
import { generateMasterKey, Keyring } from '#vault';
import { z } from 'zod';

/**
 * Integration tests use the same DB_* / REDIS_* variables as the app, with one difference: they
 * connect to DB_TEST_NAME instead of DB_NAME so development data is never touched.
 */
const testConfigSchema = z.object({
  ...databaseConfigShape,
  ...redisConfigShape,
  DB_TEST_NAME: z.string().min(1).default('workbox_test'),
});

let cached: z.output<typeof testConfigSchema> | undefined;

function config(): z.output<typeof testConfigSchema> {
  cached ??= parseConfig(testConfigSchema);
  return cached;
}

/** Connection string for the integration-test database (DB_TEST_NAME). */
export function testDatabaseUrl(): string {
  const settings = config();
  return postgresUrl(settings, settings.DB_TEST_NAME);
}

export function testRedisUrl(): string {
  return redisUrl(config());
}

export interface TestDatabase {
  url: string;
  name: string;
  drop(): Promise<void>;
}

/**
 * Creates a brand-new database next to DB_TEST_NAME and applies all migrations, so each test file
 * starts from an empty, fully migrated schema and never sees another file's data.
 */
export async function createMigratedTestDatabase(): Promise<TestDatabase> {
  const { randomBytes } = await import('node:crypto');
  const pg = (await import('pg')).default;
  const { runMigrations } = await import('#database');

  const adminUrl = testDatabaseUrl();
  const name = `workbox_it_${randomBytes(4).toString('hex')}`;
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;

  const admin = async (sql: string) => {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      await client.query(sql);
    } finally {
      await client.end();
    }
  };

  await admin(`CREATE DATABASE "${name}"`);
  await runMigrations({ connectionString: url.toString() });
  return {
    url: url.toString(),
    name,
    drop: () => admin(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`),
  };
}

/** A throwaway vault keyring with a random key (never a real key). */
export function testKeyring(version = 1): Keyring {
  return Keyring.fromConfig({ currentKey: generateMasterKey(), currentVersion: version });
}
