import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema/index.js';

export type Database = NodePgDatabase<typeof schema>;

export interface DatabaseHandle {
  db: Database;
  pool: pg.Pool;
  /** Lightweight connectivity probe used by readiness checks. */
  ping(): Promise<void>;
  close(): Promise<void>;
}

export interface CreateDatabaseOptions {
  connectionString: string;
  /** Maximum pool size. */
  max?: number;
  /** Fail fast instead of hanging when the server is unreachable. */
  connectionTimeoutMillis?: number;
  applicationName?: string;
}

export function createDatabase(options: CreateDatabaseOptions): DatabaseHandle {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.max ?? 10,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 5_000,
    application_name: options.applicationName ?? 'workbox',
  });
  // Idle client errors (e.g. server restart) must not crash the process; the next query reconnects.
  pool.on('error', () => undefined);

  const db = drizzle(pool, { schema, casing: 'snake_case' });

  return {
    db,
    pool,
    async ping() {
      await pool.query('SELECT 1');
    },
    async close() {
      await pool.end();
    },
  };
}
