import {
  CODE_HOST_PROVIDERS,
  REVIEW_REQUEST_STATES,
  type CodeHostProvider,
  type ReviewRequestState,
} from '#shared';
import { sql } from 'drizzle-orm';
import { check, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { inList } from './enums.js';
import { projects } from './projects.js';
import { tasks } from './tasks.js';

/**
 * A task's published branch and its pull/merge request (spec §5). One per task: later runs push
 * more commits to the same branch and update the same PR.
 */
export const gitReferences = pgTable(
  'git_references',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .unique('git_references_task_unique')
      .references(() => tasks.id, { onDelete: 'restrict' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'restrict' }),
    provider: text('provider').$type<CodeHostProvider>().notNull(),
    branch: text('branch').notNull(),
    pushedSha: text('pushed_sha'),
    pushedAt: timestamp('pushed_at', { withTimezone: true }),
    reviewNumber: integer('review_number'),
    reviewUrl: text('review_url'),
    reviewState: text('review_state').$type<ReviewRequestState>(),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    lastError: text('last_error'),
    /** When the merged task branch was removed from the local working copy (or found gone). */
    localBranchRemovedAt: timestamp('local_branch_removed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('git_references_provider_valid', inList(sql`${table.provider}`, CODE_HOST_PROVIDERS)),
    check(
      'git_references_review_state_valid',
      sql`${table.reviewState} IS NULL OR ${inList(sql`${table.reviewState}`, REVIEW_REQUEST_STATES)}`,
    ),
    check('git_references_branch_namespace', sql`${table.branch} LIKE 'workbox/%'`),
  ],
);

export type GitReferenceRow = typeof gitReferences.$inferSelect;
