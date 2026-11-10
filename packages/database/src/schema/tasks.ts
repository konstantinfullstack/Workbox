import { TASK_PRIORITIES, TASK_STATES, type TaskPriority, type TaskState } from '#shared';
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { inList } from './enums.js';
import { projects } from './projects.js';

export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'restrict' }),
    /** Human-friendly per-project number (#1, #2, ...). */
    number: integer('number').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    acceptanceCriteria: jsonb('acceptance_criteria')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    priority: text('priority').$type<TaskPriority>().notNull().default('medium'),
    state: text('state').$type<TaskState>().notNull().default('backlog'),
    /** Incremented on every change; used for optimistic concurrency (expectedVersion). */
    version: integer('version').notNull().default(1),
    stateChangedAt: timestamp('state_changed_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('tasks_project_number_unique').on(table.projectId, table.number),
    check('tasks_title_length', sql`char_length(${table.title}) BETWEEN 1 AND 200`),
    check('tasks_state_valid', inList(sql`${table.state}`, TASK_STATES)),
    check('tasks_priority_valid', inList(sql`${table.priority}`, TASK_PRIORITIES)),
    check('tasks_version_positive', sql`${table.version} > 0`),
    check('tasks_number_positive', sql`${table.number} > 0`),
    check(
      'tasks_acceptance_criteria_array',
      sql`jsonb_typeof(${table.acceptanceCriteria}) = 'array'`,
    ),
    index('tasks_project_state_idx').on(table.projectId, table.state),
    index('tasks_project_priority_created_idx').on(
      table.projectId,
      table.priority,
      table.createdAt,
    ),
  ],
);

export type TaskRow = typeof tasks.$inferSelect;
export type NewTaskRow = typeof tasks.$inferInsert;

/** Append-only status history. One row per state change, including creation (from_state NULL). */
export const taskStateTransitions = pgTable(
  'task_state_transitions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'restrict' }),
    fromState: text('from_state').$type<TaskState>(),
    toState: text('to_state').$type<TaskState>().notNull(),
    actor: text('actor').notNull(),
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'task_state_transitions_from_valid',
      sql`${table.fromState} IS NULL OR ${inList(sql`${table.fromState}`, TASK_STATES)}`,
    ),
    check('task_state_transitions_to_valid', inList(sql`${table.toState}`, TASK_STATES)),
    index('task_state_transitions_task_created_idx').on(table.taskId, table.createdAt),
  ],
);

export type TaskStateTransitionRow = typeof taskStateTransitions.$inferSelect;

/** `task_id` cannot start until `depends_on_task_id` is done (enforced by the scheduler in M6). */
export const taskDependencies = pgTable(
  'task_dependencies',
  {
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'restrict' }),
    dependsOnTaskId: uuid('depends_on_task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: 'task_dependencies_pk', columns: [table.taskId, table.dependsOnTaskId] }),
    check('task_dependencies_not_self', sql`${table.taskId} <> ${table.dependsOnTaskId}`),
    index('task_dependencies_depends_on_idx').on(table.dependsOnTaskId),
  ],
);
