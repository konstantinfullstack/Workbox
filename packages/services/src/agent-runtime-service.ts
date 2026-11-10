import { DomainError } from '#core';
import { connections, type Database } from '#database';
import {
  ERROR_CODES,
  type AgentRuntimeStatus,
  type ProbeAgentRuntimeJobResult,
  type SyncWorkspaceJobData,
} from '#shared';
import { eq, sql } from 'drizzle-orm';
import { recordAudit } from './audit.js';
import type { ActionContext } from './context.js';

/** How services reach a worker. The API implements it with BullMQ; tests use a stub. */
export interface WorkerGateway {
  /** Runs the agent-runtime probe on a worker. Throws DomainError WORKER_UNAVAILABLE on timeout. */
  probeAgentRuntime(provider: 'claude_code'): Promise<ProbeAgentRuntimeJobResult>;
  /** Queues a clone/fetch of a linked repository (fire and forget; deduplicated while queued). */
  enqueueWorkspaceSync?(
    projectRepositoryId: string,
    reason: SyncWorkspaceJobData['reason'],
  ): Promise<void>;
  /** Queues deletion of a project's local clone. */
  enqueueWorkspaceRemoval?(projectSlug: string): Promise<void>;
  /** Queues an agent run for execution by a worker. */
  enqueueRun?(runId: string): Promise<void>;
  /** Queues push + draft PR for a task's branch. */
  enqueuePublish?(taskId: string): Promise<void>;
}

const LOCAL_BASE_URL = 'http://localhost';

/**
 * Agent runtimes (Claude Code for now) are capabilities of the machine a worker runs on, not
 * stored credentials (spec §8). The worker performs the check; the result is recorded as a
 * connection row without a credential.
 */
export class AgentRuntimeService {
  constructor(
    private readonly db: Database,
    private readonly gateway: WorkerGateway | undefined,
  ) {}

  async status(): Promise<AgentRuntimeStatus> {
    const [row] = await this.db
      .select()
      .from(connections)
      .where(eq(connections.provider, 'claude_code'))
      .limit(1);
    const details = (row?.lastCheck?.details ?? {}) as Partial<ProbeAgentRuntimeJobResult>;
    return {
      provider: 'claude_code',
      installed: details.installed ?? false,
      version: details.version ?? null,
      loggedIn: details.loggedIn ?? null,
      authMethod: details.authMethod ?? null,
      subscriptionType: details.subscriptionType ?? null,
      loginExpiresAt: details.loginExpiresAt ?? null,
      ok: row?.lastCheck?.ok ?? false,
      message: row?.lastCheck?.message ?? 'Not checked yet.',
      checkedAt: row?.lastCheckedAt?.toISOString() ?? null,
      workerId: details.workerId ?? null,
    };
  }

  async check(context: ActionContext): Promise<AgentRuntimeStatus> {
    if (!this.gateway) {
      throw new DomainError(ERROR_CODES.workerUnavailable, 'no worker connection is configured');
    }
    const result = await this.gateway.probeAgentRuntime('claude_code');
    const values = {
      status: result.ok ? ('connected' as const) : ('degraded' as const),
      account: result.authMethod,
      lastCheck: { ok: result.ok, message: result.message, details: { ...result } },
      lastCheckedAt: new Date(result.checkedAt),
      updatedAt: sql`now()`,
    };
    await this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ id: connections.id })
        .from(connections)
        .where(eq(connections.provider, 'claude_code'))
        .limit(1)
        .for('no key update');
      const id = existing
        ? (
            await tx
              .update(connections)
              .set(values)
              .where(eq(connections.id, existing.id))
              .returning({ id: connections.id })
          )[0]!.id
        : (
            await tx
              .insert(connections)
              .values({
                provider: 'claude_code',
                name: 'Claude Code (this machine)',
                baseUrl: LOCAL_BASE_URL,
                ...values,
              })
              .returning({ id: connections.id })
          )[0]!.id;
      await recordAudit(tx, context, {
        action: 'agent_runtime.checked',
        resourceType: 'connection',
        resourceId: id,
        metadata: { ok: result.ok, version: result.version, workerId: result.workerId },
      });
    });
    return this.status();
  }
}
