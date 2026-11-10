import { DomainError } from '#core';
import {
  auditLogs,
  createDatabase,
  taskStateTransitions,
  tasks,
  type DatabaseHandle,
} from '#database';
import { ERROR_CODES, LOCAL_USER_ACTOR, type ErrorCode } from '#shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createMigratedTestDatabase,
  testKeyring,
  type TestDatabase,
} from '../../../test/support.js';
import { createServices, type Services } from '../src/index.js';

const ctx = { actor: LOCAL_USER_ACTOR, traceId: 'trace-test' };

let testDb: TestDatabase;
let handle: DatabaseHandle;
let services: Services;

beforeAll(async () => {
  testDb = await createMigratedTestDatabase();
  handle = createDatabase({ connectionString: testDb.url, max: 30 });
  services = createServices({ db: handle.db, keyring: testKeyring() });
});

afterAll(async () => {
  await handle.close();
  await testDb.drop();
});

async function expectDomainError(promise: Promise<unknown>, code: ErrorCode): Promise<DomainError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe(code);
    return error as DomainError;
  }
  throw new Error(`expected DomainError ${code}`);
}

let slugCounter = 0;
const newProject = (name = `Project ${++slugCounter}`) => services.projects.create({ name }, ctx);

describe('ProjectService', () => {
  it('creates a project with a generated slug, defaults and an audit event', async () => {
    const project = await services.projects.create({ name: 'Workbox Demo' }, ctx);
    expect(project).toMatchObject({
      name: 'Workbox Demo',
      slug: 'workbox-demo',
      defaultBranch: 'main',
      status: 'active',
      totalTasks: 0,
      repoUrl: null,
      repository: null,
    });
    const audit = await handle.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.resourceId, project.id));
    expect(audit).toEqual([
      expect.objectContaining({
        action: 'project.created',
        actor: LOCAL_USER_ACTOR,
        traceId: 'trace-test',
      }),
    ]);
  });

  it('rejects a duplicate slug with SLUG_TAKEN', async () => {
    await services.projects.create({ name: 'Dup' }, ctx);
    await expectDomainError(services.projects.create({ name: 'Dup' }, ctx), ERROR_CODES.slugTaken);
  });

  it('gets by id or slug, updates, archives and unarchives', async () => {
    const created = await services.projects.create({ name: 'Lifecycle' }, ctx);
    expect((await services.projects.get('lifecycle')).id).toBe(created.id);

    const updated = await services.projects.update(
      created.id,
      { description: 'hello', defaultBranch: 'develop' },
      ctx,
    );
    expect(updated).toMatchObject({ description: 'hello', defaultBranch: 'develop' });

    expect((await services.projects.setStatus('lifecycle', 'archived', ctx)).status).toBe(
      'archived',
    );
    expect((await services.projects.list({ status: 'archived' })).map((p) => p.slug)).toContain(
      'lifecycle',
    );
    expect((await services.projects.setStatus('lifecycle', 'active', ctx)).status).toBe('active');

    const actions = (
      await handle.db.select().from(auditLogs).where(eq(auditLogs.resourceId, created.id))
    ).map((row) => row.action);
    expect(actions).toEqual([
      'project.created',
      'project.updated',
      'project.archived',
      'project.unarchived',
    ]);
  });

  it('returns NOT_FOUND for unknown projects', async () => {
    await expectDomainError(services.projects.get('does-not-exist'), ERROR_CODES.notFound);
    await expectDomainError(
      services.projects.get('00000000-0000-4000-8000-000000000000'),
      ERROR_CODES.notFound,
    );
  });

  it('enforces the no-credentials rule in the database as defence in depth', async () => {
    const project = await newProject();
    await expect(
      handle.pool.query('UPDATE projects SET repo_url = $1 WHERE id = $2', [
        'https://user:token@github.com/o/r',
        project.id,
      ]),
    ).rejects.toThrow(/projects_repo_url_no_credentials/);
  });
});

describe('TaskService: create and edit', () => {
  it('creates a task in backlog with history and audit rows written together', async () => {
    const project = await newProject();
    const task = await services.tasks.create(
      project.slug,
      {
        title: 'Add health endpoint',
        acceptanceCriteria: ['GET /health returns 200'],
        priority: 'high',
      },
      ctx,
    );
    expect(task).toMatchObject({
      number: 1,
      state: 'backlog',
      version: 1,
      priority: 'high',
      acceptanceCriteria: ['GET /health returns 200'],
      allowedTransitions: ['planning', 'in_progress', 'blocked', 'cancelled'],
      dependsOn: [],
    });
    expect(await services.tasks.history(task.id)).toEqual([
      expect.objectContaining({ fromState: null, toState: 'backlog', actor: LOCAL_USER_ACTOR }),
    ]);
    const audit = await handle.db.select().from(auditLogs).where(eq(auditLogs.resourceId, task.id));
    expect(audit.map((row) => row.action)).toEqual(['task.created']);
    expect((await services.projects.get(project.id)).taskCounts.backlog).toBe(1);
  });

  it('assigns unique sequential numbers under 20 concurrent creates', async () => {
    const project = await newProject();
    const created = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        services.tasks.create(project.id, { title: `T${i}` }, ctx),
      ),
    );
    expect(created.map((task) => task.number).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 1),
    );
  });

  it('refuses new tasks in an archived project', async () => {
    const project = await newProject();
    await services.projects.setStatus(project.id, 'archived', ctx);
    await expectDomainError(
      services.tasks.create(project.id, { title: 'nope' }, ctx),
      ERROR_CODES.projectArchived,
    );
    // The failed attempt must not have consumed a number or left rows behind.
    await services.projects.setStatus(project.id, 'active', ctx);
    expect((await services.tasks.create(project.id, { title: 'yes' }, ctx)).number).toBe(1);
  });

  it('updates fields, bumps the version and rejects stale versions', async () => {
    const project = await newProject();
    const task = await services.tasks.create(project.id, { title: 'Original' }, ctx);
    const updated = await services.tasks.update(
      task.id,
      { title: 'Renamed', expectedVersion: 1 },
      ctx,
    );
    expect(updated).toMatchObject({ title: 'Renamed', version: 2, state: 'backlog' });

    const error = await expectDomainError(
      services.tasks.update(task.id, { title: 'Stale', expectedVersion: 1 }, ctx),
      ERROR_CODES.versionConflict,
    );
    expect(error.details).toEqual({ expectedVersion: 1, actualVersion: 2 });
    expect((await services.tasks.get(task.id)).title).toBe('Renamed');
  });

  it('lists with filters, search (LIKE-escaped) and priority ordering', async () => {
    const project = await newProject();
    await services.tasks.create(project.id, { title: 'low one', priority: 'low' }, ctx);
    await services.tasks.create(project.id, { title: 'urgent one', priority: 'urgent' }, ctx);
    await services.tasks.create(project.id, { title: '100% done?', priority: 'medium' }, ctx);

    const all = await services.tasks.list(project.id, { limit: 50, offset: 0 });
    expect(all.items.map((t) => t.title)).toEqual(['urgent one', '100% done?', 'low one']);
    expect(all.total).toBe(3);

    const search = await services.tasks.list(project.id, { q: '100%', limit: 50, offset: 0 });
    expect(search.items.map((t) => t.title)).toEqual(['100% done?']);
    const literalPercent = await services.tasks.list(project.id, { q: '%', limit: 50, offset: 0 });
    expect(literalPercent.items.map((t) => t.title)).toEqual(['100% done?']);

    const page = await services.tasks.list(project.id, { limit: 1, offset: 1 });
    expect(page).toMatchObject({ total: 3, limit: 1, offset: 1 });
    expect(page.items.map((t) => t.title)).toEqual(['100% done?']);

    const low = await services.tasks.list(project.id, { priority: 'low', limit: 50, offset: 0 });
    expect(low.items.map((t) => t.title)).toEqual(['low one']);
  });
});

describe('TaskService: transitions', () => {
  it('walks the happy path and records full history', async () => {
    const project = await newProject();
    const task = await services.tasks.create(project.id, { title: 'Happy' }, ctx);
    for (const to of ['in_progress', 'verification', 'ready_for_qa', 'done'] as const) {
      await services.tasks.transition(task.id, { to }, ctx);
    }
    const final = await services.tasks.get(task.id);
    expect(final).toMatchObject({ state: 'done', version: 5, allowedTransitions: [] });
    const history = await services.tasks.history(task.id);
    expect(history.map((h) => [h.fromState, h.toState])).toEqual([
      [null, 'backlog'],
      ['backlog', 'in_progress'],
      ['in_progress', 'verification'],
      ['verification', 'ready_for_qa'],
      ['ready_for_qa', 'done'],
    ]);
    const audit = await handle.db.select().from(auditLogs).where(eq(auditLogs.resourceId, task.id));
    expect(audit.filter((row) => row.action === 'task.state_changed')).toHaveLength(4);
  });

  it('rejects an invalid transition and writes nothing', async () => {
    const project = await newProject();
    const task = await services.tasks.create(project.id, { title: 'Invalid' }, ctx);
    await expectDomainError(
      services.tasks.transition(task.id, { to: 'done' }, ctx),
      ERROR_CODES.invalidTransition,
    );
    const [row] = await handle.db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(row).toMatchObject({ state: 'backlog', version: 1 });
    expect(
      await handle.db
        .select()
        .from(taskStateTransitions)
        .where(eq(taskStateTransitions.taskId, task.id)),
    ).toHaveLength(1);
    const audit = await handle.db.select().from(auditLogs).where(eq(auditLogs.resourceId, task.id));
    expect(audit.map((r) => r.action)).toEqual(['task.created']);
  });

  it('requires a reason for blocked and stores it', async () => {
    const project = await newProject();
    const task = await services.tasks.create(project.id, { title: 'Block me' }, ctx);
    await expectDomainError(
      services.tasks.transition(task.id, { to: 'blocked' }, ctx),
      ERROR_CODES.reasonRequired,
    );
    await services.tasks.transition(
      task.id,
      { to: 'blocked', reason: '  waiting on API key  ' },
      ctx,
    );
    const history = await services.tasks.history(task.id);
    expect(history.at(-1)).toMatchObject({ toState: 'blocked', reason: 'waiting on API key' });
  });

  it('lets exactly one of two concurrent transitions with the same expectedVersion win', async () => {
    const project = await newProject();
    const task = await services.tasks.create(project.id, { title: 'Race' }, ctx);
    const results = await Promise.allSettled([
      services.tasks.transition(task.id, { to: 'planning', expectedVersion: 1 }, ctx),
      services.tasks.transition(task.id, { to: 'in_progress', expectedVersion: 1 }, ctx),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0]!.reason as DomainError).code).toBe(ERROR_CODES.versionConflict);
    expect(await services.tasks.history(task.id)).toHaveLength(2);
  });

  it('serialises concurrent transitions without a version guard (second sees the new state)', async () => {
    const project = await newProject();
    const task = await services.tasks.create(project.id, { title: 'Race 2' }, ctx);
    const results = await Promise.allSettled([
      services.tasks.transition(task.id, { to: 'planning' }, ctx),
      services.tasks.transition(task.id, { to: 'planning' }, ctx),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect((rejected!.reason as DomainError).code).toBe(ERROR_CODES.invalidTransition);
  });

  it('returns NOT_FOUND for unknown tasks', async () => {
    const missing = '00000000-0000-4000-8000-000000000000';
    await expectDomainError(services.tasks.get(missing), ERROR_CODES.notFound);
    await expectDomainError(
      services.tasks.transition(missing, { to: 'planning' }, ctx),
      ERROR_CODES.notFound,
    );
    await expectDomainError(services.tasks.history(missing), ERROR_CODES.notFound);
  });
});

describe('TaskService: dependencies', () => {
  it('stores dependencies and rejects self, cross-project and cyclic ones', async () => {
    const project = await newProject();
    const other = await newProject();
    const a = await services.tasks.create(project.id, { title: 'A' }, ctx);
    const b = await services.tasks.create(project.id, { title: 'B', dependsOn: [a.id] }, ctx);
    const foreign = await services.tasks.create(other.id, { title: 'Foreign' }, ctx);
    expect(b.dependsOn).toEqual([a.id]);

    await expectDomainError(
      services.tasks.update(a.id, { dependsOn: [a.id] }, ctx),
      ERROR_CODES.invalidDependency,
    );
    const crossProject = await expectDomainError(
      services.tasks.update(a.id, { dependsOn: [foreign.id] }, ctx),
      ERROR_CODES.invalidDependency,
    );
    expect(crossProject.details).toEqual({ missing: [foreign.id] });
    const cycle = await expectDomainError(
      services.tasks.update(a.id, { dependsOn: [b.id] }, ctx),
      ERROR_CODES.invalidDependency,
    );
    expect(cycle.details).toEqual({ cycle: [a.id, b.id, a.id] });

    // Replacing and clearing dependencies.
    const c = await services.tasks.create(project.id, { title: 'C' }, ctx);
    expect((await services.tasks.update(b.id, { dependsOn: [c.id, c.id] }, ctx)).dependsOn).toEqual(
      [c.id],
    );
    expect((await services.tasks.update(b.id, { dependsOn: [] }, ctx)).dependsOn).toEqual([]);
  });

  it('does not let two concurrent edits create a cycle together', async () => {
    const project = await newProject();
    const a = await services.tasks.create(project.id, { title: 'A' }, ctx);
    const b = await services.tasks.create(project.id, { title: 'B' }, ctx);
    const results = await Promise.allSettled([
      services.tasks.update(a.id, { dependsOn: [b.id] }, ctx),
      services.tasks.update(b.id, { dependsOn: [a.id] }, ctx),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect((rejected!.reason as DomainError).code).toBe(ERROR_CODES.invalidDependency);
  });

  it('does not deadlock when task creation and dependency edits run concurrently', async () => {
    const project = await newProject();
    const base = await services.tasks.create(project.id, { title: 'Base' }, ctx);
    const others = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        services.tasks.create(project.id, { title: `O${i}` }, ctx),
      ),
    );
    const results = await Promise.allSettled([
      ...others.map((task) => services.tasks.update(task.id, { dependsOn: [base.id] }, ctx)),
      ...Array.from({ length: 5 }, (_, i) =>
        services.tasks.create(project.id, { title: `N${i}`, dependsOn: [base.id] }, ctx),
      ),
      services.tasks.transition(base.id, { to: 'planning' }, ctx),
    ]);
    expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
  });
});
