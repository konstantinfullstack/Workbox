import { DomainError } from '#core';
import { connections, projectRepositories, projects, workspaces, type Database } from '#database';
import { GitError, removeWorkspace, syncRepository, workspacePath } from '#git';
import type { CodeHostProvider } from '#shared';
import { eq, sql } from 'drizzle-orm';
import { recordAudit } from './audit.js';
import type { ConnectionService } from './connection-service.js';

/** Username that code hosts accept together with a token over https. */
const GIT_USERNAME: Record<CodeHostProvider, string> = {
  github: 'x-access-token',
  gitlab: 'oauth2',
};

export interface WorkspaceSyncerOptions {
  db: Database;
  connections: ConnectionService;
  /** Absolute workspaces root on this worker (WORKBOX_WORKSPACES_DIR). */
  root: string;
  workerId: string;
  timeoutMs?: number;
}

export type SyncOutcome =
  | { status: 'ready'; action: 'cloned' | 'fetched' | 'recloned'; headSha: string | null }
  | { status: 'failed'; error: string }
  | { status: 'skipped'; reason: string };

/**
 * Worker-side workspace management: clones/fetches linked repositories into the workspaces root
 * using the account's token (decrypted per operation, audited, never written to disk).
 */
export class WorkspaceSyncer {
  constructor(private readonly options: WorkspaceSyncerOptions) {}

  async sync(projectRepositoryId: string): Promise<SyncOutcome> {
    const { db } = this.options;
    const context = { actor: `worker:${this.options.workerId}` };
    const [row] = await db
      .select({ repo: projectRepositories, slug: projects.slug, connection: connections })
      .from(projectRepositories)
      .innerJoin(projects, eq(projects.id, projectRepositories.projectId))
      .innerJoin(connections, eq(connections.id, projectRepositories.connectionId))
      .where(eq(projectRepositories.id, projectRepositoryId))
      .limit(1);
    if (!row) return { status: 'skipped', reason: 'repository is no longer linked' };

    const path = workspacePath(this.options.root, row.slug);
    await this.update(projectRepositoryId, {
      status: 'syncing',
      path,
      workerId: this.options.workerId,
      lastError: null,
    });

    try {
      const provider = row.repo.provider;
      const result = await this.options.connections.withToken(
        row.repo.connectionId,
        'workspace.sync',
        context,
        (token) =>
          syncRepository({
            path,
            cloneUrl: row.repo.cloneUrlHttps,
            defaultBranch: row.repo.defaultBranch,
            identity: { provider, host: row.repo.host, externalId: row.repo.externalId },
            credentials: { username: GIT_USERNAME[provider], token },
            ...(this.options.timeoutMs ? { timeoutMs: this.options.timeoutMs } : {}),
          }),
      );
      await this.update(projectRepositoryId, {
        status: 'ready',
        headSha: result.headSha,
        sizeKb: result.sizeKb,
        lastSyncedAt: new Date(),
        lastError: null,
      });
      await recordAudit(db, context, {
        action: 'workspace.synced',
        resourceType: 'project',
        resourceId: row.repo.projectId,
        metadata: { action: result.action, headSha: result.headSha },
      });
      return { status: 'ready', action: result.action, headSha: result.headSha };
    } catch (error) {
      const message = failureMessage(error);
      if (message === null) throw error; // unexpected (e.g. database down): let the job fail and retry
      await this.update(projectRepositoryId, { status: 'failed', lastError: message });
      await recordAudit(db, context, {
        action: 'workspace.sync_failed',
        resourceType: 'project',
        resourceId: row.repo.projectId,
        metadata: { error: message },
      });
      return { status: 'failed', error: message };
    }
  }

  async remove(projectSlug: string): Promise<boolean> {
    return removeWorkspace(this.options.root, projectSlug);
  }

  /**
   * Linked repositories that need a sync: no workspace yet, not ready (e.g. after a crash), or
   * recorded at a different location than this worker's root (WORKBOX_WORKSPACES_DIR changed).
   */
  async pending(): Promise<string[]> {
    const rows = await this.options.db
      .select({
        id: projectRepositories.id,
        slug: projects.slug,
        status: workspaces.status,
        path: workspaces.path,
      })
      .from(projectRepositories)
      .innerJoin(projects, eq(projects.id, projectRepositories.projectId))
      .leftJoin(workspaces, eq(workspaces.projectRepositoryId, projectRepositories.id));
    return rows
      .filter(
        (row) => row.status !== 'ready' || row.path !== workspacePath(this.options.root, row.slug),
      )
      .map((row) => row.id);
  }

  private async update(
    projectRepositoryId: string,
    values: Partial<typeof workspaces.$inferInsert>,
  ) {
    await this.options.db
      .insert(workspaces)
      .values({ projectRepositoryId, status: 'queued', ...values })
      .onConflictDoUpdate({
        target: workspaces.projectRepositoryId,
        set: { ...values, updatedAt: sql`now()` },
      });
  }
}

/** A displayable reason for expected failures; null for unexpected errors. */
function failureMessage(error: unknown): string | null {
  if (error instanceof GitError) {
    return error.kind === 'auth'
      ? `${error.message}. Replace the token on the Connections page.`
      : error.message;
  }
  if (error instanceof DomainError) return error.message;
  return null;
}
