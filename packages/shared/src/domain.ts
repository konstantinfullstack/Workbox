/**
 * Canonical domain enumerations. Single source of truth for DB CHECK constraints, API validation
 * and the dashboard. Order matters only for display.
 */
export const TASK_STATES = [
  'backlog',
  'planning',
  'in_progress',
  'verification',
  'ready_for_qa',
  'done',
  'blocked',
  'changes_requested',
  'cancelled',
] as const;
export type TaskState = (typeof TASK_STATES)[number];

/** Entering these states must be explained (enforced by the server; used by clients for UX). */
export const TASK_STATES_REQUIRING_REASON = [
  'blocked',
  'changes_requested',
  'cancelled',
] as const satisfies readonly TaskState[];

export const TASK_PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const PROJECT_STATUSES = ['active', 'archived'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

/** Actor recorded for actions taken through the API while Workbox is a single-user local tool. */
export const LOCAL_USER_ACTOR = 'user:local';

/** Code hosts Workbox can link repositories from. Each has an adapter in #integrations. */
export const CODE_HOST_PROVIDERS = ['github', 'gitlab'] as const;
export type CodeHostProvider = (typeof CODE_HOST_PROVIDERS)[number];

/** Agent runtimes. A local CLI login is a worker capability, not a stored credential (spec §8). */
export const AGENT_RUNTIME_PROVIDERS = ['claude_code'] as const;
export type AgentRuntimeProvider = (typeof AGENT_RUNTIME_PROVIDERS)[number];

export const CONNECTION_PROVIDERS = [...CODE_HOST_PROVIDERS, ...AGENT_RUNTIME_PROVIDERS] as const;
export type ConnectionProvider = (typeof CONNECTION_PROVIDERS)[number];

/** Spec §5 connection state machine. */
export const CONNECTION_STATUSES = [
  'unconfigured',
  'connected',
  'degraded',
  'expired',
  'disconnected',
] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

export const CREDENTIAL_AUTH_TYPES = [
  'personal_access_token',
  'project_access_token',
  'group_access_token',
  'api_key',
  'local_cli',
] as const;
export type CredentialAuthType = (typeof CREDENTIAL_AUTH_TYPES)[number];

export const REPOSITORY_PURPOSES = ['primary'] as const;
export type RepositoryPurpose = (typeof REPOSITORY_PURPOSES)[number];

export const REPOSITORY_ACCESS_STATUSES = ['verified', 'denied', 'expired', 'unverified'] as const;
export type RepositoryAccessStatus = (typeof REPOSITORY_ACCESS_STATUSES)[number];

/** Local clone of a project's repository on a worker (M4 phase A). */
export const WORKSPACE_STATUSES = ['queued', 'syncing', 'ready', 'failed'] as const;
export type WorkspaceStatus = (typeof WORKSPACE_STATUSES)[number];
