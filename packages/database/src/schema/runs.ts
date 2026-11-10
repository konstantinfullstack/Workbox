import {
  ACTIVE_RUN_STATES,
  AGENT_RUNTIMES,
  RUN_EVENT_TYPES,
  RUN_STATES,
  type AgentRuntime,
  type ChangedFile,
  type RunEventType,
  type RunState,
} from '#shared';
import { sql } from 'drizzle-orm';
import {
  bigserial,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { inList } from './enums.js';
import { projects } from './projects.js';
import { tasks } from './tasks.js';

/** One execution attempt of a task by an agent (spec §5 task_runs). */
export const taskRuns = pgTable(
  'task_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'restrict' }),
    /** Denormalised for the one-active-run-per-project rule. */
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'restrict' }),
    attempt: integer('attempt').notNull(),
    state: text('state').$type<RunState>().notNull().default('queued'),
    agent: text('agent').$type<AgentRuntime>().notNull(),
    /** Extra guidance given for this run (e.g. review notes). */
    note: text('note'),
    branch: text('branch'),
    baseSha: text('base_sha'),
    commitSha: text('commit_sha'),
    worktreePath: text('worktree_path'),
    workerId: text('worker_id'),
    summary: text('summary'),
    qaSteps: jsonb('qa_steps')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    changedFiles: jsonb('changed_files')
      .$type<ChangedFile[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** Unified diff of the run's changes (truncated); review aid until PRs exist (M5). */
    diff: text('diff'),
    diffTruncated: integer('diff_truncated').notNull().default(0),
    exitReason: text('exit_reason'),
    costUsd: doublePrecision('cost_usd'),
    durationMs: integer('duration_ms'),
    cancelRequestedAt: timestamp('cancel_requested_at', { withTimezone: true }),
    queuedAt: timestamp('queued_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('task_runs_task_attempt_unique').on(table.taskId, table.attempt),
    check('task_runs_state_valid', inList(sql`${table.state}`, RUN_STATES)),
    check('task_runs_agent_valid', inList(sql`${table.agent}`, AGENT_RUNTIMES)),
    // One writer per repository (spec §6): at most one active run per project.
    uniqueIndex('task_runs_one_active_per_project')
      .on(table.projectId)
      .where(inList(sql`${table.state}`, ACTIVE_RUN_STATES)),
    index('task_runs_task_idx').on(table.taskId, table.attempt),
  ],
);

export type TaskRunRow = typeof taskRuns.$inferSelect;

/** Persisted, redacted run timeline (spec §6: durable event persistence). */
export const runEvents = pgTable(
  'run_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    runId: uuid('run_id')
      .notNull()
      .references(() => taskRuns.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    type: text('type').$type<RunEventType>().notNull(),
    message: text('message').notNull(),
    data: jsonb('data')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('run_events_run_seq_unique').on(table.runId, table.seq),
    check('run_events_type_valid', inList(sql`${table.type}`, RUN_EVENT_TYPES)),
  ],
);

export type RunEventRow = typeof runEvents.$inferSelect;
