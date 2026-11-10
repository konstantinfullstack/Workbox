import { DomainError } from '#core';
import { projectRepositories, projects, tasks, type Database } from '#database';
import {
  ERROR_CODES,
  slugify,
  TASK_STATES,
  type CreateProjectInput,
  type ListProjectsQuery,
  type ProjectStatus,
  type ProjectSummary,
  type TaskCounts,
  type UpdateProjectInput,
} from '#shared';
import { asc, count, eq, inArray, sql } from 'drizzle-orm';
import { recordAudit } from './audit.js';
import type { ActionContext, Executor } from './context.js';
import { toProject, UUID_PATTERN } from './mappers.js';
import { PG_UNIQUE_VIOLATION, pgErrorInfo } from './pg-errors.js';

export class ProjectService {
  constructor(private readonly db: Database) {}

  async list(query: ListProjectsQuery = {}): Promise<ProjectSummary[]> {
    const rows = await this.db
      .select()
      .from(projects)
      .where(query.status ? eq(projects.status, query.status) : undefined)
      .orderBy(asc(projects.name));
    const ids = rows.map((row) => row.id);
    const [counts, repos] = await Promise.all([this.taskCounts(ids), this.repositories(ids)]);
    return rows.map((row) => summary(toProject(row), counts.get(row.id), repos.get(row.id)));
  }

  async get(idOrSlug: string): Promise<ProjectSummary> {
    const row = await findProject(this.db, idOrSlug);
    const [counts, repos] = await Promise.all([
      this.taskCounts([row.id]),
      this.repositories([row.id]),
    ]);
    return summary(toProject(row), counts.get(row.id), repos.get(row.id));
  }

  async create(input: CreateProjectInput, context: ActionContext): Promise<ProjectSummary> {
    const slug = input.slug ?? slugify(input.name);
    if (!slug) {
      throw new DomainError(
        ERROR_CODES.validation,
        'could not derive a slug from the name; provide one explicitly',
      );
    }
    try {
      return await this.db.transaction(async (tx) => {
        const [row] = await tx
          .insert(projects)
          .values({
            name: input.name,
            slug,
            description: input.description ?? '',
            defaultBranch: input.defaultBranch ?? 'main',
          })
          .returning();
        await recordAudit(tx, context, {
          action: 'project.created',
          resourceType: 'project',
          resourceId: row!.id,
          metadata: { slug },
        });
        return summary(toProject(row!), undefined, undefined);
      });
    } catch (error) {
      const info = pgErrorInfo(error);
      if (info?.code === PG_UNIQUE_VIOLATION && info.constraint === 'projects_slug_unique') {
        throw new DomainError(
          ERROR_CODES.slugTaken,
          `a project with slug "${slug}" already exists`,
          {
            slug,
          },
        );
      }
      throw error;
    }
  }

  async update(
    idOrSlug: string,
    input: UpdateProjectInput,
    context: ActionContext,
  ): Promise<ProjectSummary> {
    await this.db.transaction(async (tx) => {
      const existing = await findProject(tx, idOrSlug, { forUpdate: true });
      const changes = Object.fromEntries(
        Object.entries(input).filter(([, value]) => value !== undefined),
      );
      await tx
        .update(projects)
        .set({ ...changes, updatedAt: sql`now()` })
        .where(eq(projects.id, existing.id));
      await recordAudit(tx, context, {
        action: 'project.updated',
        resourceType: 'project',
        resourceId: existing.id,
        metadata: { changedFields: Object.keys(changes) },
      });
    });
    return this.get(idOrSlug);
  }

  async setStatus(
    idOrSlug: string,
    status: ProjectStatus,
    context: ActionContext,
  ): Promise<ProjectSummary> {
    await this.db.transaction(async (tx) => {
      const existing = await findProject(tx, idOrSlug, { forUpdate: true });
      if (existing.status === status) return;
      await tx
        .update(projects)
        .set({ status, updatedAt: sql`now()` })
        .where(eq(projects.id, existing.id));
      await recordAudit(tx, context, {
        action: status === 'archived' ? 'project.archived' : 'project.unarchived',
        resourceType: 'project',
        resourceId: existing.id,
      });
    });
    return this.get(idOrSlug);
  }

  private async repositories(projectIds: string[]): Promise<Map<string, RepositorySummary>> {
    const result = new Map<string, RepositorySummary>();
    if (projectIds.length === 0) return result;
    const rows = await this.db
      .select({
        projectId: projectRepositories.projectId,
        provider: projectRepositories.provider,
        fullPath: projectRepositories.fullPath,
        webUrl: projectRepositories.webUrl,
        accessStatus: projectRepositories.accessStatus,
      })
      .from(projectRepositories)
      .where(inArray(projectRepositories.projectId, projectIds));
    for (const { projectId, ...repo } of rows) result.set(projectId, repo);
    return result;
  }

  private async taskCounts(projectIds: string[]): Promise<Map<string, TaskCounts>> {
    const result = new Map<string, TaskCounts>();
    if (projectIds.length === 0) return result;
    const rows = await this.db
      .select({ projectId: tasks.projectId, state: tasks.state, count: count() })
      .from(tasks)
      .where(inArray(tasks.projectId, projectIds))
      .groupBy(tasks.projectId, tasks.state);
    for (const row of rows) {
      const counts = result.get(row.projectId) ?? emptyCounts();
      counts[row.state] = row.count;
      result.set(row.projectId, counts);
    }
    return result;
  }
}

/** Resolves a project by UUID or slug; throws NOT_FOUND. */
export async function findProject(
  executor: Executor,
  idOrSlug: string,
  options: { forUpdate?: boolean } = {},
) {
  const condition = UUID_PATTERN.test(idOrSlug)
    ? eq(projects.id, idOrSlug)
    : eq(projects.slug, idOrSlug);
  const query = executor.select().from(projects).where(condition).limit(1);
  const [row] = options.forUpdate ? await query.for('no key update') : await query;
  if (!row) {
    throw new DomainError(ERROR_CODES.notFound, `project "${idOrSlug}" not found`);
  }
  return row;
}

function emptyCounts(): TaskCounts {
  return Object.fromEntries(TASK_STATES.map((state) => [state, 0])) as TaskCounts;
}

type RepositorySummary = NonNullable<ProjectSummary['repository']>;

function summary(
  project: ReturnType<typeof toProject>,
  counts: TaskCounts | undefined,
  repository: RepositorySummary | undefined,
): ProjectSummary {
  const taskCounts = counts ?? emptyCounts();
  const totalTasks = Object.values(taskCounts).reduce((sum, value) => sum + value, 0);
  return { ...project, taskCounts, totalTasks, repository: repository ?? null };
}
