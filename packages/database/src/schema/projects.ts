import { PROJECT_STATUSES, type ProjectStatus } from '#shared';
import { sql } from 'drizzle-orm';
import { check, integer, jsonb, pgTable, text, timestamp, uuid, index } from 'drizzle-orm/pg-core';
import { inList } from './enums.js';

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    /** URL/CLI identifier. Immutable after creation. */
    slug: text('slug').notNull().unique('projects_slug_unique'),
    description: text('description').notNull().default(''),
    /** Remote URL without credentials (validated in the API and by CHECK below). */
    repoUrl: text('repo_url'),
    defaultBranch: text('default_branch').notNull().default('main'),
    status: text('status').$type<ProjectStatus>().notNull().default('active'),
    /** Next per-project task number; incremented atomically when a task is created. */
    nextTaskNumber: integer('next_task_number').notNull().default(1),
    /** Non-secret project settings. Never store credentials here. */
    config: jsonb('config')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('projects_slug_format', sql`${table.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
    check('projects_name_length', sql`char_length(${table.name}) BETWEEN 1 AND 100`),
    check('projects_status_valid', inList(sql`${table.status}`, PROJECT_STATUSES)),
    check('projects_next_task_number_positive', sql`${table.nextTaskNumber} > 0`),
    // Defence in depth for credentials in https URLs (https://user[:pass]@host/...).
    check(
      'projects_repo_url_no_credentials',
      sql`${table.repoUrl} IS NULL OR ${table.repoUrl} !~ '^https?://[^/]*@'`,
    ),
    index('projects_status_idx').on(table.status),
  ],
);

export type ProjectRow = typeof projects.$inferSelect;
export type NewProjectRow = typeof projects.$inferInsert;
