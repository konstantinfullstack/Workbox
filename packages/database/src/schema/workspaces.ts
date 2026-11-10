import { WORKSPACE_STATUSES, type WorkspaceStatus } from '#shared';
import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { projectRepositories } from './connections.js';
import { inList } from './enums.js';

/**
 * A worker's local working copy of a project repository (ADR-007). The row disappears with its repository
 * link (cascade); the files are removed by a `remove-workspace` job.
 */
export const workspaces = pgTable(
  'workspaces',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectRepositoryId: uuid('project_repository_id')
      .notNull()
      .unique('workspaces_project_repository_unique')
      .references(() => projectRepositories.id, { onDelete: 'cascade' }),
    status: text('status').$type<WorkspaceStatus>().notNull().default('queued'),
    path: text('path'),
    headSha: text('head_sha'),
    sizeKb: integer('size_kb'),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    lastError: text('last_error'),
    workerId: text('worker_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('workspaces_status_valid', inList(sql`${table.status}`, WORKSPACE_STATUSES)),
    check(
      'workspaces_head_sha_format',
      sql`${table.headSha} IS NULL OR ${table.headSha} ~ '^[0-9a-f]{40,64}$'`,
    ),
    index('workspaces_status_idx').on(table.status),
  ],
);

export type WorkspaceRow = typeof workspaces.$inferSelect;
