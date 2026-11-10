import type {
  CodeHostProvider,
  CreateConnectionInput,
  LinkRepositoryInput,
  CreateProjectInput,
  CreateTaskInput,
  ProjectStatus,
  TransitionTaskInput,
  UpdateProjectInput,
  UpdateTaskInput,
} from '#shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client.js';

/** Dashboard data is polled; the spec allows polling before SSE (§9). */
export const REFRESH_INTERVAL_MS = 5_000;

export const keys = {
  projects: (status?: ProjectStatus) => ['projects', status ?? 'all'] as const,
  project: (idOrSlug: string) => ['project', idOrSlug] as const,
  tasks: (projectIdOrSlug: string) => ['tasks', projectIdOrSlug] as const,
  task: (id: string) => ['task', id] as const,
  history: (id: string) => ['history', id] as const,
  connections: (provider?: CodeHostProvider) => ['connections', provider ?? 'all'] as const,
  remoteRepositories: (connectionId: string, search: string) =>
    ['remote-repos', connectionId, search] as const,
  projectRepository: (projectIdOrSlug: string) => ['project-repository', projectIdOrSlug] as const,
  agentRuntime: ['agent-runtime'] as const,
  runs: (taskId: string) => ['runs', taskId] as const,
  runReadiness: (taskId: string) => ['run-readiness', taskId] as const,
  runEvents: (runId: string) => ['run-events', runId] as const,
  runDiff: (runId: string) => ['run-diff', runId] as const,
};

export const useProjects = (status?: ProjectStatus) =>
  useQuery({
    queryKey: keys.projects(status),
    queryFn: () => api.listProjects(status),
    refetchInterval: REFRESH_INTERVAL_MS,
  });

export const useProject = (idOrSlug: string) =>
  useQuery({
    queryKey: keys.project(idOrSlug),
    queryFn: () => api.getProject(idOrSlug),
    enabled: idOrSlug !== '',
    refetchInterval: REFRESH_INTERVAL_MS,
  });

export const useTasks = (projectIdOrSlug: string) =>
  useQuery({
    queryKey: keys.tasks(projectIdOrSlug),
    queryFn: () => api.listTasks(projectIdOrSlug),
    enabled: projectIdOrSlug !== '',
    refetchInterval: REFRESH_INTERVAL_MS,
  });

export const useTask = (id: string) =>
  useQuery({
    queryKey: keys.task(id),
    queryFn: () => api.getTask(id),
    enabled: id !== '',
    refetchInterval: REFRESH_INTERVAL_MS,
  });

export const useTaskHistory = (id: string) =>
  useQuery({
    queryKey: keys.history(id),
    queryFn: () => api.taskHistory(id),
    enabled: id !== '',
    refetchInterval: REFRESH_INTERVAL_MS,
  });

/** After any write, refetch everything that could display the changed data. */
function useInvalidateAll() {
  const client = useQueryClient();
  return () => client.invalidateQueries();
}

export function useCreateProject() {
  const invalidate = useInvalidateAll();
  return useMutation({
    mutationFn: (input: CreateProjectInput) => api.createProject(input),
    onSuccess: invalidate,
  });
}

export function useUpdateProject(idOrSlug: string) {
  const invalidate = useInvalidateAll();
  return useMutation({
    mutationFn: (input: UpdateProjectInput) => api.updateProject(idOrSlug, input),
    onSuccess: invalidate,
  });
}

export function useSetProjectArchived(idOrSlug: string) {
  const invalidate = useInvalidateAll();
  return useMutation({
    mutationFn: (archived: boolean) => api.setProjectArchived(idOrSlug, archived),
    onSuccess: invalidate,
  });
}

export function useCreateTask(projectIdOrSlug: string) {
  const invalidate = useInvalidateAll();
  return useMutation({
    mutationFn: (input: CreateTaskInput) => api.createTask(projectIdOrSlug, input),
    onSuccess: invalidate,
  });
}

export function useUpdateTask(id: string) {
  const invalidate = useInvalidateAll();
  return useMutation({
    mutationFn: (input: UpdateTaskInput) => api.updateTask(id, input),
    onSuccess: invalidate,
  });
}

export function useTransitionTask(id: string) {
  const invalidate = useInvalidateAll();
  return useMutation({
    mutationFn: (input: TransitionTaskInput) => api.transitionTask(id, input),
    onSuccess: invalidate,
  });
}

export const useConnections = (provider?: CodeHostProvider) =>
  useQuery({
    queryKey: keys.connections(provider),
    queryFn: () => api.listConnections(provider),
    refetchInterval: REFRESH_INTERVAL_MS,
  });

/** Not polled: each call decrypts the token and queries the provider. */
export const useRemoteRepositories = (connectionId: string, search: string) =>
  useQuery({
    queryKey: keys.remoteRepositories(connectionId, search),
    queryFn: () => api.listRemoteRepositories(connectionId, search || undefined),
    enabled: connectionId !== '',
    staleTime: 60_000,
    retry: false,
  });

export const useProjectRepository = (projectIdOrSlug: string) =>
  useQuery({
    queryKey: keys.projectRepository(projectIdOrSlug),
    queryFn: () => api.getProjectRepository(projectIdOrSlug),
    enabled: projectIdOrSlug !== '',
    refetchInterval: REFRESH_INTERVAL_MS,
  });

export const useAgentRuntime = () =>
  useQuery({
    queryKey: keys.agentRuntime,
    queryFn: () => api.agentRuntime(),
    refetchInterval: 30_000,
  });

export function useCreateConnection() {
  const invalidate = useInvalidateAll();
  return useMutation({
    mutationFn: (input: CreateConnectionInput) => api.createConnection(input),
    onSuccess: invalidate,
  });
}

export function useConnectionActions(id: string) {
  const invalidate = useInvalidateAll();
  return {
    test: useMutation({ mutationFn: () => api.testConnection(id), onSuccess: invalidate }),
    rotate: useMutation({
      mutationFn: (secret: string) => api.rotateConnection(id, secret),
      onSuccess: invalidate,
    }),
    disconnect: useMutation({
      mutationFn: () => api.disconnectConnection(id),
      onSuccess: invalidate,
    }),
  };
}

export function useRepositoryActions(projectIdOrSlug: string) {
  const invalidate = useInvalidateAll();
  return {
    link: useMutation({
      mutationFn: (input: LinkRepositoryInput) => api.linkRepository(projectIdOrSlug, input),
      onSuccess: invalidate,
    }),
    verify: useMutation({
      mutationFn: () => api.verifyRepository(projectIdOrSlug),
      onSuccess: invalidate,
    }),
    sync: useMutation({
      mutationFn: () => api.syncRepository(projectIdOrSlug),
      onSuccess: invalidate,
    }),
    unlink: useMutation({
      mutationFn: () => api.unlinkRepository(projectIdOrSlug),
      onSuccess: invalidate,
    }),
  };
}

export function useCheckAgentRuntime() {
  const invalidate = useInvalidateAll();
  return useMutation({ mutationFn: () => api.checkAgentRuntime(), onSuccess: invalidate });
}

const ACTIVE = new Set(['queued', 'preparing', 'running', 'verifying']);

/** Polls quickly while a run is active, slowly otherwise. */
export const useRuns = (taskId: string) =>
  useQuery({
    queryKey: keys.runs(taskId),
    queryFn: () => api.listRuns(taskId),
    enabled: taskId !== '',
    refetchInterval: (query) =>
      query.state.data?.some((run) => ACTIVE.has(run.state)) ? 2_000 : REFRESH_INTERVAL_MS,
  });

export const useRunReadiness = (taskId: string) =>
  useQuery({
    queryKey: keys.runReadiness(taskId),
    queryFn: () => api.runReadiness(taskId),
    enabled: taskId !== '',
    refetchInterval: REFRESH_INTERVAL_MS,
  });

export const useRunEvents = (runId: string, active: boolean) =>
  useQuery({
    queryKey: keys.runEvents(runId),
    queryFn: () => api.runEvents(runId),
    enabled: runId !== '',
    refetchInterval: active ? 2_000 : false,
  });

export const useRunDiff = (runId: string, enabled: boolean) =>
  useQuery({
    queryKey: keys.runDiff(runId),
    queryFn: () => api.runDiff(runId),
    enabled: enabled && runId !== '',
    staleTime: Infinity,
  });

export function useRunActions(taskId: string) {
  const invalidate = useInvalidateAll();
  return {
    start: useMutation({
      mutationFn: (note?: string) => api.startRun(taskId, note),
      onSuccess: invalidate,
    }),
    cancel: useMutation({
      mutationFn: (runId: string) => api.cancelRun(runId),
      onSuccess: invalidate,
    }),
  };
}
