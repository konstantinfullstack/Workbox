import { CHECK_DETECTION_FILES, detectChecks, DomainError } from '#core';
import { connections, projectRepositories, projects, type Database } from '#database';
import type { CodeHostRegistry } from '#integrations';
import {
  ERROR_CODES,
  projectChecksSchema,
  type ChecksDetection,
  type ConfirmChecksInput,
  type ProjectChecks,
} from '#shared';
import { eq, sql } from 'drizzle-orm';
import { recordAudit } from './audit.js';
import { toDomainError } from './code-host-errors.js';
import type { ConnectionService } from './connection-service.js';
import type { ActionContext } from './context.js';
import { findProject } from './project-service.js';

const UNCONFIRMED: ProjectChecks = {
  confirmed: false,
  setup: null,
  commands: [],
  detectedFrom: [],
  confirmedAt: null,
};

/** The project's check configuration from `projects.config.checks` (unconfirmed if absent or invalid). */
export function projectChecks(config: Record<string, unknown>): ProjectChecks {
  const parsed = projectChecksSchema.safeParse(config.checks);
  return parsed.success ? parsed.data : UNCONFIRMED;
}

/**
 * Check commands per project (U9): proposed from repository files via the code host API, then
 * confirmed or edited by the user. Runs require a confirmed configuration (possibly empty).
 */
export class ProjectChecksService {
  constructor(
    private readonly db: Database,
    private readonly codeHosts: CodeHostRegistry,
    private readonly connectionService: ConnectionService,
  ) {}

  async get(projectIdOrSlug: string): Promise<ProjectChecks> {
    const project = await findProject(this.db, projectIdOrSlug);
    return projectChecks(project.config);
  }

  /** Reads the candidate files from the repository's default branch and proposes commands. */
  async detect(projectIdOrSlug: string, context: ActionContext): Promise<ChecksDetection> {
    const project = await findProject(this.db, projectIdOrSlug);
    const [row] = await this.db
      .select({ repo: projectRepositories, baseUrl: connections.baseUrl })
      .from(projectRepositories)
      .innerJoin(connections, eq(connections.id, projectRepositories.connectionId))
      .where(eq(projectRepositories.projectId, project.id))
      .limit(1);
    if (!row)
      throw new DomainError(
        ERROR_CODES.notFound,
        `project "${project.slug}" has no linked repository`,
      );
    const adapter = this.codeHosts[row.repo.provider];
    const ref = { externalId: row.repo.externalId, fullPath: row.repo.fullPath };
    try {
      const files = await this.connectionService.withToken(
        row.repo.connectionId,
        'checks.detect',
        context,
        async (token) => {
          const entries = await Promise.all(
            CHECK_DETECTION_FILES.map(
              async (path) =>
                [
                  path,
                  await adapter.readFile(
                    { baseUrl: row.baseUrl },
                    token,
                    ref,
                    path,
                    row.repo.defaultBranch,
                  ),
                ] as const,
            ),
          );
          return Object.fromEntries(entries);
        },
      );
      return detectChecks(files);
    } catch (error) {
      throw toDomainError(error);
    }
  }

  async confirm(
    projectIdOrSlug: string,
    input: ConfirmChecksInput,
    context: ActionContext,
  ): Promise<ProjectChecks> {
    const project = await findProject(this.db, projectIdOrSlug);
    const names = input.commands.map((c) => c.name);
    if (new Set(names).size !== names.length) {
      throw new DomainError(ERROR_CODES.validation, 'check names must be unique');
    }
    const checks: ProjectChecks = {
      confirmed: true,
      setup: input.setup,
      commands: input.commands,
      detectedFrom: input.detectedFrom,
      confirmedAt: new Date().toISOString(),
    };
    await this.db.transaction(async (tx) => {
      await tx
        .update(projects)
        .set({
          config: sql`jsonb_set(${projects.config}, '{checks}', ${JSON.stringify(checks)}::jsonb)`,
          updatedAt: sql`now()`,
        })
        .where(eq(projects.id, project.id));
      await recordAudit(tx, context, {
        action: 'project.checks_confirmed',
        resourceType: 'project',
        resourceId: project.id,
        metadata: { setup: input.setup, commands: input.commands.map((c) => c.command) },
      });
    });
    return checks;
  }
}
