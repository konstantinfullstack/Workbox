import { auditLogs } from '#database';
import type { ActionContext, Executor } from './context.js';

export interface AuditEntry {
  action: string;
  resourceType: 'project' | 'task' | 'connection' | 'credential' | 'vault';
  resourceId: string;
  /** Safe, non-secret context only (field names, state names, ids). */
  metadata?: Record<string, unknown>;
}

/** Writes an audit row. Call inside the same transaction as the change it describes. */
export async function recordAudit(
  executor: Executor,
  context: ActionContext,
  entry: AuditEntry,
): Promise<void> {
  await executor.insert(auditLogs).values({
    actor: context.actor,
    action: entry.action,
    resourceType: entry.resourceType,
    resourceId: entry.resourceId,
    metadata: entry.metadata ?? {},
    traceId: context.traceId ?? null,
  });
}
