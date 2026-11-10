import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { MIGRATIONS_FOLDER } from './paths.js';

/** Arbitrary constant identifying the Workbox migration lock in pg_advisory_lock's keyspace. */
export const MIGRATION_LOCK_KEY = 727_001;

export interface RunMigrationsOptions {
  connectionString: string;
  migrationsFolder?: string;
}

export interface MigrationResult {
  appliedCount: number;
  totalCount: number;
}

/**
 * Applies all pending migrations inside a session-level advisory lock so concurrent invocations
 * (e.g. two deploy jobs) serialise instead of racing. Safe to run repeatedly: already-applied
 * migrations are skipped.
 */
export async function runMigrations(options: RunMigrationsOptions): Promise<MigrationResult> {
  const client = new pg.Client({
    connectionString: options.connectionString,
    connectionTimeoutMillis: 10_000,
    application_name: 'workbox-migrate',
  });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    try {
      const before = await countApplied(client);
      await migrate(drizzle(client), {
        migrationsFolder: options.migrationsFolder ?? MIGRATIONS_FOLDER,
      });
      const after = await countApplied(client);
      return { appliedCount: after - before, totalCount: after };
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
    }
  } finally {
    await client.end();
  }
}

async function countApplied(client: pg.Client): Promise<number> {
  const exists = await client.query<{ exists: boolean }>(
    "SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS exists",
  );
  if (!exists.rows[0]?.exists) {
    return 0;
  }
  const result = await client.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations',
  );
  return Number(result.rows[0]?.count ?? 0);
}
