import {
  checksDetectionSchema,
  continueStatusSchema,
  continueTaskRefSchema,
  type ContinueStatus,
  type ContinueTaskRef,
  gitReferenceSchema,
  projectChecksSchema,
  type ChecksDetection,
  type ConfirmChecksInput,
  type GitReference,
  type ProjectChecks,
  runDiffSchema,
  runEventSchema,
  taskRunSchema,
  type RunDiff,
  type RunEvent,
  type TaskRun,
  agentRuntimeStatusSchema,
  connectionSchema,
  projectRepositorySchema,
  remoteRepositorySchema,
  type AgentRuntimeStatus,
  type CodeHostProvider,
  type Connection,
  type CreateConnectionInput,
  type LinkRepositoryInput,
  type ProjectRepository,
  type RemoteRepository,
  errorResponseSchema,
  projectSummarySchema,
  taskListSchema,
  taskSchema,
  taskTransitionSchema,
  type CreateProjectInput,
  type CreateTaskInput,
  type ListTasksQuery,
  type ProjectStatus,
  type ProjectSummary,
  type Task,
  type TaskList,
  type TaskTransition,
  type TransitionTaskInput,
  type UpdateProjectInput,
  type UpdateTaskInput,
} from '#shared';
import { z, type ZodType } from 'zod';

/** An error returned by the API in the shared error envelope (or a network failure). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const BASE = '/api/v1';

async function request<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  schema: ZodType<T>,
  body?: unknown,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the Workbox API. Is it running?');
  }
  const payload: unknown =
    response.status === 204 ? null : await response.json().catch(() => undefined);
  if (!response.ok) {
    const parsed = errorResponseSchema.safeParse(payload);
    if (parsed.success) {
      throw new ApiError(
        response.status,
        parsed.data.error.code,
        parsed.data.error.message,
        parsed.data.error.details,
      );
    }
    throw new ApiError(response.status, 'HTTP_ERROR', `Request failed with ${response.status}`);
  }
  // Validate responses too: a contract mismatch should fail loudly, not render garbage.
  return schema.parse(payload);
}

const projectList = z.object({ items: z.array(projectSummarySchema) });
const connectionList = z.object({ items: z.array(connectionSchema) });
const repositoryList = z.object({ items: z.array(remoteRepositorySchema) });
const linkedRepository = z.object({ repository: projectRepositorySchema.nullable() });
const runList = z.object({ items: z.array(taskRunSchema) });
const taskGitSchema = z.object({
  branch: z.string().nullable(),
  localCommitSha: z.string().nullable(),
  reference: gitReferenceSchema.nullable(),
});
export type TaskGit = {
  branch: string | null;
  localCommitSha: string | null;
  reference: GitReference | null;
};
const eventList = z.object({ items: z.array(runEventSchema) });
const readinessSchema = z.object({ ready: z.boolean(), reasons: z.array(z.string()) });
const historyList = z.object({ items: z.array(taskTransitionSchema) });

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

export const api = {
  listProjects: async (status?: ProjectStatus): Promise<ProjectSummary[]> =>
    (await request('GET', `/projects${query({ status })}`, projectList)).items,
  getProject: (idOrSlug: string): Promise<ProjectSummary> =>
    request('GET', `/projects/${encodeURIComponent(idOrSlug)}`, projectSummarySchema),
  createProject: (input: CreateProjectInput): Promise<ProjectSummary> =>
    request('POST', '/projects', projectSummarySchema, input),
  updateProject: (idOrSlug: string, input: UpdateProjectInput): Promise<ProjectSummary> =>
    request('PATCH', `/projects/${encodeURIComponent(idOrSlug)}`, projectSummarySchema, input),
  setProjectArchived: (idOrSlug: string, archived: boolean): Promise<ProjectSummary> =>
    request(
      'POST',
      `/projects/${encodeURIComponent(idOrSlug)}/${archived ? 'archive' : 'unarchive'}`,
      projectSummarySchema,
    ),
  listTasks: (projectIdOrSlug: string, filters: Partial<ListTasksQuery> = {}): Promise<TaskList> =>
    request(
      'GET',
      `/projects/${encodeURIComponent(projectIdOrSlug)}/tasks${query({ limit: 500, ...filters })}`,
      taskListSchema,
    ),
  createTask: (projectIdOrSlug: string, input: CreateTaskInput): Promise<Task> =>
    request('POST', `/projects/${encodeURIComponent(projectIdOrSlug)}/tasks`, taskSchema, input),
  getTask: (id: string): Promise<Task> => request('GET', `/tasks/${id}`, taskSchema),
  updateTask: (id: string, input: UpdateTaskInput): Promise<Task> =>
    request('PATCH', `/tasks/${id}`, taskSchema, input),
  transitionTask: (id: string, input: TransitionTaskInput): Promise<Task> =>
    request('POST', `/tasks/${id}/transitions`, taskSchema, input),
  taskHistory: async (id: string): Promise<TaskTransition[]> =>
    (await request('GET', `/tasks/${id}/history`, historyList)).items,

  listConnections: async (provider?: CodeHostProvider): Promise<Connection[]> =>
    (await request('GET', `/connections${query({ provider })}`, connectionList)).items,
  createConnection: (input: CreateConnectionInput): Promise<Connection> =>
    request('POST', '/connections', connectionSchema, input),
  testConnection: (id: string): Promise<Connection> =>
    request('POST', `/connections/${id}/test`, connectionSchema),
  rotateConnection: (id: string, secret: string): Promise<Connection> =>
    request('POST', `/connections/${id}/rotate`, connectionSchema, { secret }),
  disconnectConnection: (id: string): Promise<Connection> =>
    request('POST', `/connections/${id}/disconnect`, connectionSchema),
  listRemoteRepositories: async (id: string, search?: string): Promise<RemoteRepository[]> =>
    (
      await request(
        'GET',
        `/connections/${id}/repositories${query({ search, limit: 50 })}`,
        repositoryList,
      )
    ).items,

  getProjectRepository: async (projectIdOrSlug: string): Promise<ProjectRepository | null> =>
    (
      await request(
        'GET',
        `/projects/${encodeURIComponent(projectIdOrSlug)}/repository`,
        linkedRepository,
      )
    ).repository,
  linkRepository: (
    projectIdOrSlug: string,
    input: LinkRepositoryInput,
  ): Promise<ProjectRepository> =>
    request(
      'PUT',
      `/projects/${encodeURIComponent(projectIdOrSlug)}/repository`,
      projectRepositorySchema,
      input,
    ),
  verifyRepository: (projectIdOrSlug: string): Promise<ProjectRepository> =>
    request(
      'POST',
      `/projects/${encodeURIComponent(projectIdOrSlug)}/repository/verify`,
      projectRepositorySchema,
    ),
  syncRepository: (projectIdOrSlug: string): Promise<ProjectRepository> =>
    request(
      'POST',
      `/projects/${encodeURIComponent(projectIdOrSlug)}/repository/sync`,
      projectRepositorySchema,
    ),
  unlinkRepository: (projectIdOrSlug: string): Promise<null> =>
    request('DELETE', `/projects/${encodeURIComponent(projectIdOrSlug)}/repository`, z.null()),

  agentRuntime: (): Promise<AgentRuntimeStatus> =>
    request('GET', '/agent-runtimes/claude-code', agentRuntimeStatusSchema),
  checkAgentRuntime: (): Promise<AgentRuntimeStatus> =>
    request('POST', '/agent-runtimes/claude-code/check', agentRuntimeStatusSchema),

  runReadiness: (taskId: string): Promise<{ ready: boolean; reasons: string[] }> =>
    request('GET', `/tasks/${taskId}/run-readiness`, readinessSchema),
  startRun: (taskId: string, note?: string): Promise<TaskRun> =>
    request('POST', `/tasks/${taskId}/runs`, taskRunSchema, note ? { note } : {}),
  listRuns: async (taskId: string): Promise<TaskRun[]> =>
    (await request('GET', `/tasks/${taskId}/runs`, runList)).items,
  runEvents: async (runId: string): Promise<RunEvent[]> =>
    (await request('GET', `/runs/${runId}/events?limit=1000`, eventList)).items,
  runDiff: (runId: string): Promise<RunDiff> =>
    request('GET', `/runs/${runId}/diff`, runDiffSchema),
  cancelRun: (runId: string): Promise<TaskRun> =>
    request('POST', `/runs/${runId}/cancel`, taskRunSchema),

  projectChecks: (project: string): Promise<ProjectChecks> =>
    request('GET', `/projects/${encodeURIComponent(project)}/checks`, projectChecksSchema),
  detectChecks: (project: string): Promise<ChecksDetection> =>
    request(
      'POST',
      `/projects/${encodeURIComponent(project)}/checks/detect`,
      checksDetectionSchema,
    ),
  confirmChecks: (project: string, input: ConfirmChecksInput): Promise<ProjectChecks> =>
    request('PUT', `/projects/${encodeURIComponent(project)}/checks`, projectChecksSchema, input),
  continueStatus: (project: string): Promise<ContinueStatus> =>
    request('GET', `/projects/${encodeURIComponent(project)}/continue`, continueStatusSchema),
  continueDevelopment: (project: string): Promise<{ task: ContinueTaskRef; run: TaskRun }> =>
    request(
      'POST',
      `/projects/${encodeURIComponent(project)}/continue`,
      z.object({ task: continueTaskRefSchema, run: taskRunSchema }),
    ),
  taskGit: (taskId: string): Promise<TaskGit> =>
    request('GET', `/tasks/${taskId}/git`, taskGitSchema),
  publishTask: (taskId: string): Promise<{ queued: true }> =>
    request('POST', `/tasks/${taskId}/publish`, z.object({ queued: z.literal(true) })),
};

export type Api = typeof api;
