import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Append-only audit trail. Rows record who did what to which resource.
 *
 * `metadata` must contain only safe, non-secret context: never credentials, tokens,
 * raw prompts or unredacted command output (spec §5, §11).
 */
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Stable actor identifier, e.g. `user:<id>`, `system`, `worker:<id>`. */
    actor: text('actor').notNull(),
    /** Dotted action name, e.g. `task.state_changed`, `connection.tested`. */
    action: text('action').notNull(),
    resourceType: text('resource_type').notNull(),
    resourceId: text('resource_id'),
    metadata: jsonb('metadata')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    traceId: text('trace_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('audit_logs_resource_idx').on(table.resourceType, table.resourceId),
    index('audit_logs_created_at_idx').on(table.createdAt),
    index('audit_logs_actor_idx').on(table.actor),
  ],
);

export type AuditLog = typeof auditLogs.$inferSelect;
export type NewAuditLog = typeof auditLogs.$inferInsert;
