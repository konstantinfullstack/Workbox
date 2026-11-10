import { RUN_ARTIFACT_KINDS, type RunArtifactKind } from '#shared';
import { sql } from 'drizzle-orm';
import { bigint, check, index, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { inList } from './enums.js';
import { taskRuns } from './runs.js';

/**
 * Files saved for a run (agent transcript, full check output, patch). The files live under
 * WORKBOX_ARTIFACTS_DIR; `path` is relative to it. Rows and files are deleted at `expires_at`.
 */
export const runArtifacts = pgTable(
  'run_artifacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => taskRuns.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<RunArtifactKind>().notNull(),
    name: text('name').notNull(),
    path: text('path').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    unique('run_artifacts_run_name_unique').on(table.runId, table.name),
    check('run_artifacts_kind_valid', inList(sql`${table.kind}`, RUN_ARTIFACT_KINDS)),
    check(
      'run_artifacts_path_relative',
      sql`${table.path} NOT LIKE '/%' AND ${table.path} NOT LIKE '%..%'`,
    ),
    index('run_artifacts_expires_idx').on(table.expiresAt),
  ],
);

export type RunArtifactRow = typeof runArtifacts.$inferSelect;
