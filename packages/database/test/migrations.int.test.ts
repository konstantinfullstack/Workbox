import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLogs, createDatabase, MIGRATIONS_FOLDER, runMigrations } from '../src/index.js';
import { testDatabaseUrl } from '../../../test/support.js';

/**
 * Each run creates a brand-new, empty database so "migrations apply from an empty DB"
 * is proven on every execution, independent of the state of the shared test database.
 */
describe('migrations', () => {
  const adminUrl = testDatabaseUrl();
  const dbName = `workbox_it_${randomBytes(4).toString('hex')}`;
  const freshUrl = withDatabase(adminUrl, dbName);
  const journal = JSON.parse(
    readFileSync(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'),
  ) as { entries: unknown[] };

  beforeAll(async () => {
    await admin(adminUrl, `CREATE DATABASE "${dbName}"`);
  });

  afterAll(async () => {
    await admin(adminUrl, `DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  });

  it('applies every migration to an empty database', async () => {
    const result = await runMigrations({ connectionString: freshUrl });
    expect(journal.entries.length).toBeGreaterThan(0);
    expect(result).toEqual({
      appliedCount: journal.entries.length,
      totalCount: journal.entries.length,
    });
  });

  it('is idempotent when run again', async () => {
    const result = await runMigrations({ connectionString: freshUrl });
    expect(result).toEqual({ appliedCount: 0, totalCount: journal.entries.length });
  });

  it('serialises concurrent runs without errors', async () => {
    const results = await Promise.all([
      runMigrations({ connectionString: freshUrl }),
      runMigrations({ connectionString: freshUrl }),
    ]);
    expect(results.every((r) => r.appliedCount === 0)).toBe(true);
  });

  it('creates audit_logs with the expected columns and indexes', async () => {
    const client = new pg.Client({ connectionString: freshUrl });
    await client.connect();
    try {
      const columns = await client.query<{ column_name: string; is_nullable: string }>(
        `SELECT column_name, is_nullable FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'audit_logs' ORDER BY ordinal_position`,
      );
      expect(columns.rows).toEqual([
        { column_name: 'id', is_nullable: 'NO' },
        { column_name: 'actor', is_nullable: 'NO' },
        { column_name: 'action', is_nullable: 'NO' },
        { column_name: 'resource_type', is_nullable: 'NO' },
        { column_name: 'resource_id', is_nullable: 'YES' },
        { column_name: 'metadata', is_nullable: 'NO' },
        { column_name: 'trace_id', is_nullable: 'YES' },
        { column_name: 'created_at', is_nullable: 'NO' },
      ]);

      const indexes = await client.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes WHERE tablename = 'audit_logs' ORDER BY indexname`,
      );
      expect(indexes.rows.map((row) => row.indexname)).toEqual([
        'audit_logs_actor_idx',
        'audit_logs_created_at_idx',
        'audit_logs_pkey',
        'audit_logs_resource_idx',
      ]);
    } finally {
      await client.end();
    }
  });

  it('creates every domain table with its key constraints', async () => {
    const client = new pg.Client({ connectionString: freshUrl });
    await client.connect();
    try {
      const tables = await client.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' ORDER BY table_name`,
      );
      expect(tables.rows.map((row) => row.table_name)).toEqual([
        'audit_logs',
        'connections',
        'credentials',
        'git_references',
        'project_repositories',
        'projects',
        'run_events',
        'task_dependencies',
        'task_runs',
        'task_state_transitions',
        'tasks',
        'workspaces',
      ]);
      const constraints = await client.query<{ conname: string }>(
        `SELECT conname FROM pg_constraint WHERE connamespace = 'public'::regnamespace
         AND contype IN ('u', 'c', 'f') ORDER BY conname`,
      );
      expect(constraints.rows.map((row) => row.conname)).toEqual(
        expect.arrayContaining([
          'projects_slug_unique',
          'projects_repo_url_no_credentials',
          'tasks_project_number_unique',
          'tasks_state_valid',
          'tasks_project_id_projects_id_fk',
          'task_dependencies_not_self',
          'connections_credential_unique',
          'project_repositories_project_purpose_unique',
          'project_repositories_repository_unique',
        ]),
      );
    } finally {
      await client.end();
    }
  });

  it('supports typed inserts and reads through Drizzle with database defaults', async () => {
    const database = createDatabase({ connectionString: freshUrl });
    try {
      const [row] = await database.db
        .insert(auditLogs)
        .values({ actor: 'system', action: 'test.inserted', resourceType: 'test' })
        .returning();
      expect(row).toMatchObject({
        actor: 'system',
        action: 'test.inserted',
        resourceType: 'test',
        resourceId: null,
        metadata: {},
      });
      expect(row?.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(row?.createdAt).toBeInstanceOf(Date);
    } finally {
      await database.close();
    }
  });
});

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

async function admin(url: string, sql: string): Promise<void> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}
