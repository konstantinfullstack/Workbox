import { homedir } from 'node:os';
import { DomainError } from '#core';
import {
  connections,
  projectRepositories,
  projects,
  workspaces,
  type Database,
  type ProjectRepositoryRow,
  type WorkspaceRow,
} from '#database';
import { instanceHost, isCodeHostError, type CodeHostRegistry } from '#integrations';
import {
  ERROR_CODES,
  type LinkRepositoryInput,
  type ProjectRepository,
  type RemoteRepository,
  type RepositoryAccess,
} from '#shared';
import { eq, sql } from 'drizzle-orm';
import { recordAudit } from './audit.js';
import { toDomainError } from './code-host-errors.js';
import { asCodeHost, type ConnectionService } from './connection-service.js';
import type { WorkerGateway } from './agent-runtime-service.js';
import type { ActionContext } from './context.js';
import { PG_UNIQUE_VIOLATION, pgErrorInfo } from './pg-errors.js';
import { findProject } from './project-service.js';

/**
 * A project's primary repository. Stored by the provider's stable id, so renames and transfers
 * are picked up on the next verification instead of breaking the link.
 */
export class RepositoryService {
  constructor(
    private readonly db: Database,
    private readonly codeHosts: CodeHostRegistry,
    private readonly connectionService: ConnectionService,
    private readonly gateway?: WorkerGateway,
  ) {}

  async get(projectIdOrSlug: string): Promise<ProjectRepository | null> {
    const project = await findProject(this.db, projectIdOrSlug);
    return this.load(project.id);
  }

  async link(
    projectIdOrSlug: string,
    input: LinkRepositoryInput,
    context: ActionContext,
  ): Promise<ProjectRepository> {
    const project = await findProject(this.db, projectIdOrSlug);
    const remote = await this.fetchRemote(input.connectionId, input.externalId, context);
    if (!remote.repository.access.pull) {
      throw new DomainError(
        ERROR_CODES.repositoryAccessDenied,
        `the account cannot read ${remote.repository.fullPath}; grant it access and try again`,
      );
    }

    try {
      await this.db.transaction(async (tx) => {
        await tx
          .select({ id: projects.id })
          .from(projects)
          .where(eq(projects.id, project.id))
          .for('no key update');
        await tx.delete(projectRepositories).where(eq(projectRepositories.projectId, project.id));
        const [linked] = await tx
          .insert(projectRepositories)
          .values({
            projectId: project.id,
            connectionId: input.connectionId,
            purpose: 'primary',
            provider: remote.provider,
            host: remote.host,
            ...repositoryFields(remote.repository),
          })
          .returning({ id: projectRepositories.id });
        // The clone is made by a worker; record it as queued so the UI shows progress at once.
        await tx.insert(workspaces).values({ projectRepositoryId: linked!.id, status: 'queued' });
        await tx
          .update(projects)
          .set({
            repoUrl: remote.repository.cloneUrlHttps,
            defaultBranch: remote.repository.defaultBranch,
            updatedAt: sql`now()`,
          })
          .where(eq(projects.id, project.id));
        await recordAudit(tx, context, {
          action: 'repository.linked',
          resourceType: 'project',
          resourceId: project.id,
          metadata: {
            provider: remote.provider,
            host: remote.host,
            fullPath: remote.repository.fullPath,
            externalId: remote.repository.externalId,
            connectionId: input.connectionId,
          },
        });
      });
    } catch (error) {
      const info = pgErrorInfo(error);
      if (
        info?.code === PG_UNIQUE_VIOLATION &&
        info.constraint === 'project_repositories_repository_unique'
      ) {
        const [owner] = await this.db
          .select({ slug: projects.slug, name: projects.name })
          .from(projectRepositories)
          .innerJoin(projects, eq(projects.id, projectRepositories.projectId))
          .where(eq(projectRepositories.externalId, remote.repository.externalId))
          .limit(1);
        throw new DomainError(
          ERROR_CODES.repositoryTaken,
          `${remote.repository.fullPath} is already linked to project "${owner?.name ?? 'another project'}"; a repository can belong to only one project`,
          { projectSlug: owner?.slug },
        );
      }
      throw error;
    }
    const linked = (await this.load(project.id))!;
    await this.gateway?.enqueueWorkspaceSync?.(linked.id, 'linked');
    return linked;
  }

  /** Queues a fetch (or clone) of the project's repository on a worker ("Sync now"). */
  async requestWorkspaceSync(
    projectIdOrSlug: string,
    context: ActionContext,
  ): Promise<ProjectRepository> {
    const project = await findProject(this.db, projectIdOrSlug);
    const row = await this.loadRow(project.id);
    if (!row) {
      throw new DomainError(
        ERROR_CODES.notFound,
        `project "${project.slug}" has no linked repository`,
      );
    }
    if (!this.gateway?.enqueueWorkspaceSync) {
      throw new DomainError(ERROR_CODES.workerUnavailable, 'no worker connection is configured');
    }
    await this.db
      .insert(workspaces)
      .values({ projectRepositoryId: row.id, status: 'queued' })
      .onConflictDoUpdate({
        target: workspaces.projectRepositoryId,
        // Don't flip a sync that is already running back to queued.
        set: {
          status: sql`CASE WHEN ${workspaces.status} = 'syncing' THEN 'syncing' ELSE 'queued' END`,
          updatedAt: sql`now()`,
        },
      });
    await this.gateway.enqueueWorkspaceSync(row.id, 'manual');
    await recordAudit(this.db, context, {
      action: 'workspace.sync_requested',
      resourceType: 'project',
      resourceId: project.id,
    });
    return (await this.load(project.id))!;
  }

  /** Re-reads the repository from its provider and records current access (and renames). */
  async verify(projectIdOrSlug: string, context: ActionContext): Promise<ProjectRepository> {
    const project = await findProject(this.db, projectIdOrSlug);
    const row = await this.loadRow(project.id);
    if (!row)
      throw new DomainError(
        ERROR_CODES.notFound,
        `project "${project.slug}" has no linked repository`,
      );
    await this.refresh(row, context);
    return (await this.load(project.id))!;
  }

  async unlink(projectIdOrSlug: string, context: ActionContext): Promise<void> {
    const project = await findProject(this.db, projectIdOrSlug);
    await this.db.transaction(async (tx) => {
      const removed = await tx
        .delete(projectRepositories)
        .where(eq(projectRepositories.projectId, project.id))
        .returning({ fullPath: projectRepositories.fullPath });
      if (removed.length === 0) return;
      await recordAudit(tx, context, {
        action: 'repository.unlinked',
        resourceType: 'project',
        resourceId: project.id,
        metadata: { fullPath: removed[0]!.fullPath },
      });
    });
    await this.gateway?.enqueueWorkspaceRemoval?.(project.slug);
  }

  /** Re-verifies every repository using an account (e.g. after its token was replaced). */
  async verifyAllForConnection(connectionId: string, context: ActionContext): Promise<void> {
    const rows = await this.db
      .select()
      .from(projectRepositories)
      .where(eq(projectRepositories.connectionId, connectionId));
    for (const row of rows) await this.refresh(row, context);
  }

  private async refresh(row: ProjectRepositoryRow, context: ActionContext): Promise<void> {
    let update: Partial<typeof projectRepositories.$inferInsert>;
    try {
      const { repository } = await this.fetchRemote(row.connectionId, row.externalId, context);
      const fields = repositoryFields(repository);
      update = {
        ...fields,
        access: { ...fields.access, reviewRequests: row.access.reviewRequests },
        accessStatus: repository.access.pull ? 'verified' : 'denied',
        lastError: repository.access.pull
          ? null
          : 'The account can no longer read this repository.',
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'verification failed';
      if (error instanceof DomainError && error.code === ERROR_CODES.codeHostUnavailable) {
        // Transient: keep the last known status, just note the problem.
        update = { lastError: message };
      } else if (error instanceof DomainError && error.code === ERROR_CODES.notFound) {
        update = {
          accessStatus: 'denied',
          lastError: 'Repository not found or no longer accessible with this account.',
        };
      } else if (error instanceof DomainError && error.code === ERROR_CODES.credentialRejected) {
        update = { accessStatus: 'expired', lastError: message };
      } else if (error instanceof DomainError) {
        update = { accessStatus: 'unverified', lastError: message };
      } else {
        throw error;
      }
    }
    await this.db
      .update(projectRepositories)
      .set({ ...update, verifiedAt: sql`now()`, updatedAt: sql`now()` })
      .where(eq(projectRepositories.id, row.id));
    if (update.cloneUrlHttps || update.defaultBranch) {
      await this.db
        .update(projects)
        .set({
          ...(update.cloneUrlHttps ? { repoUrl: update.cloneUrlHttps } : {}),
          updatedAt: sql`now()`,
        })
        .where(eq(projects.id, row.projectId));
    }
    await recordAudit(this.db, context, {
      action: 'repository.verified',
      resourceType: 'project',
      resourceId: row.projectId,
      metadata: { accessStatus: update.accessStatus ?? row.accessStatus },
    });
  }

  private async fetchRemote(connectionId: string, externalId: string, context: ActionContext) {
    const [connection] = await this.db
      .select()
      .from(connections)
      .where(eq(connections.id, connectionId))
      .limit(1);
    if (!connection)
      throw new DomainError(ERROR_CODES.notFound, `account "${connectionId}" not found`);
    const provider = asCodeHost(connection.provider);
    try {
      const repository = await this.connectionService.withToken(
        connectionId,
        'repository.read',
        context,
        (token) =>
          this.codeHosts[provider].getRepository(
            { baseUrl: connection.baseUrl },
            token,
            externalId,
          ),
      );
      return { repository, provider, host: instanceHost(connection.baseUrl) };
    } catch (error) {
      if (isCodeHostError(error) && error.kind !== 'not_found') {
        await this.connectionService.recordFailure(connectionId, error);
      }
      throw toDomainError(error);
    }
  }

  private async loadRow(projectId: string) {
    const [row] = await this.db
      .select()
      .from(projectRepositories)
      .where(eq(projectRepositories.projectId, projectId))
      .limit(1);
    return row;
  }

  private async load(projectId: string): Promise<ProjectRepository | null> {
    const [row] = await this.db
      .select({
        repo: projectRepositories,
        connectionName: connections.name,
        connectionStatus: connections.status,
        workspace: workspaces,
      })
      .from(projectRepositories)
      .innerJoin(connections, eq(connections.id, projectRepositories.connectionId))
      .leftJoin(workspaces, eq(workspaces.projectRepositoryId, projectRepositories.id))
      .where(eq(projectRepositories.projectId, projectId))
      .limit(1);
    if (!row) return null;
    const { repo } = row;
    return {
      id: repo.id,
      projectId: repo.projectId,
      connectionId: repo.connectionId,
      connectionName: row.connectionName,
      connectionStatus: row.connectionStatus,
      provider: repo.provider,
      host: repo.host,
      externalId: repo.externalId,
      fullPath: repo.fullPath,
      webUrl: repo.webUrl,
      cloneUrlHttps: repo.cloneUrlHttps,
      cloneUrlSsh: repo.cloneUrlSsh,
      defaultBranch: repo.defaultBranch,
      visibility: repo.visibility,
      access: repo.access,
      accessStatus: repo.accessStatus,
      verifiedAt: repo.verifiedAt?.toISOString() ?? null,
      lastError: repo.lastError,
      workspace: row.workspace ? toWorkspace(row.workspace) : null,
    };
  }
}

const HOME = homedir();

function toWorkspace(row: WorkspaceRow) {
  return {
    status: row.status,
    // Shown with ~ for readability; the worker stores the absolute path.
    path:
      row.path && row.path.startsWith(`${HOME}/`) ? `~${row.path.slice(HOME.length)}` : row.path,
    headSha: row.headSha,
    sizeKb: row.sizeKb,
    lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
    lastError: row.lastError,
    workerId: row.workerId,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function repositoryFields(repository: RemoteRepository) {
  const access: RepositoryAccess = { ...repository.access, reviewRequests: 'unverified' };
  return {
    externalId: repository.externalId,
    fullPath: repository.fullPath,
    webUrl: repository.webUrl,
    cloneUrlHttps: repository.cloneUrlHttps,
    cloneUrlSsh: repository.cloneUrlSsh,
    defaultBranch: repository.defaultBranch,
    visibility: repository.visibility,
    access,
    accessStatus: repository.access.pull ? ('verified' as const) : ('denied' as const),
    lastError: null,
    verifiedAt: new Date(),
  };
}
