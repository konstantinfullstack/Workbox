import { z } from 'zod';
import {
  CODE_HOST_PROVIDERS,
  CONNECTION_PROVIDERS,
  CONNECTION_STATUSES,
  CREDENTIAL_AUTH_TYPES,
  REPOSITORY_ACCESS_STATUSES,
  WORKSPACE_STATUSES,
} from './domain.js';

export const codeHostProviderSchema = z.enum(CODE_HOST_PROVIDERS);
export const connectionProviderSchema = z.enum(CONNECTION_PROVIDERS);
export const connectionStatusSchema = z.enum(CONNECTION_STATUSES);
export const authTypeSchema = z.enum(CREDENTIAL_AUTH_TYPES);

/** Result of verifying a token against its provider. Never contains the token. */
export const credentialCheckSchema = z.object({
  accountName: z.string(),
  /** Provider's numeric account id (used for the account's no-reply commit email). */
  accountId: z.string().nullable(),
  tokenKind: authTypeSchema,
  scopes: z.array(z.string()),
  expiresAt: z.iso.datetime().nullable(),
  warnings: z.array(z.string()),
});
export type CredentialCheck = z.infer<typeof credentialCheckSchema>;

export const repositoryAccessSchema = z.object({
  pull: z.boolean(),
  push: z.boolean(),
  /** Creating PRs/MRs cannot be verified without creating one; confirmed on first use (M5). */
  reviewRequests: z.enum(['unverified', 'verified', 'denied']),
});
export type RepositoryAccess = z.infer<typeof repositoryAccessSchema>;

/** A repository as reported by a code host. */
export const remoteRepositorySchema = z.object({
  externalId: z.string(),
  fullPath: z.string(),
  name: z.string(),
  webUrl: z.string(),
  cloneUrlHttps: z.string(),
  cloneUrlSsh: z.string().nullable(),
  defaultBranch: z.string(),
  visibility: z.string(),
  access: z.object({ pull: z.boolean(), push: z.boolean() }),
});
export type RemoteRepository = z.infer<typeof remoteRepositorySchema>;

export const lastCheckSchema = z.object({
  ok: z.boolean(),
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});

export const connectionSchema = z.object({
  id: z.uuid(),
  provider: connectionProviderSchema,
  name: z.string(),
  baseUrl: z.string(),
  account: z.string().nullable(),
  /** Provider's numeric account id, if known (used for the no-reply commit email). */
  accountId: z.string().nullable(),
  authType: authTypeSchema.nullable(),
  /** e.g. `github_pat_…a1B2`. The secret itself is never returned. */
  fingerprint: z.string().nullable(),
  hasSecret: z.boolean(),
  tokenExpiresAt: z.iso.datetime().nullable(),
  scopes: z.array(z.string()),
  status: connectionStatusSchema,
  lastCheckedAt: z.iso.datetime().nullable(),
  lastCheck: lastCheckSchema.nullable(),
  projects: z.array(z.object({ id: z.uuid(), slug: z.string(), name: z.string() })),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Connection = z.infer<typeof connectionSchema>;

const secretSchema = z
  .string()
  .trim()
  .min(8, 'looks too short to be a token')
  .max(1_000)
  .regex(/^\S+$/, 'must not contain spaces');

export const createConnectionInputSchema = z.strictObject({
  provider: codeHostProviderSchema,
  name: z.string().trim().min(1).max(100),
  /** Instance URL; defaults to https://github.com or https://gitlab.com. */
  baseUrl: z.string().trim().max(300).optional(),
  secret: secretSchema,
});
export type CreateConnectionInput = z.infer<typeof createConnectionInputSchema>;

export const rotateConnectionInputSchema = z.strictObject({ secret: secretSchema });
export type RotateConnectionInput = z.infer<typeof rotateConnectionInputSchema>;

export const listRepositoriesQuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/** The worker's local clone of the repository. */
export const workspaceSchema = z.object({
  status: z.enum(WORKSPACE_STATUSES),
  /** Absolute path on the worker machine (home directory shown as ~). */
  path: z.string().nullable(),
  headSha: z.string().nullable(),
  sizeKb: z.number().int().nonnegative().nullable(),
  lastSyncedAt: z.iso.datetime().nullable(),
  lastError: z.string().nullable(),
  workerId: z.string().nullable(),
  updatedAt: z.iso.datetime(),
});
export type Workspace = z.infer<typeof workspaceSchema>;

export const projectRepositorySchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  connectionId: z.uuid(),
  connectionName: z.string(),
  connectionStatus: connectionStatusSchema,
  provider: codeHostProviderSchema,
  host: z.string(),
  externalId: z.string(),
  fullPath: z.string(),
  webUrl: z.string(),
  cloneUrlHttps: z.string(),
  cloneUrlSsh: z.string().nullable(),
  defaultBranch: z.string(),
  visibility: z.string(),
  access: repositoryAccessSchema,
  accessStatus: z.enum(REPOSITORY_ACCESS_STATUSES),
  verifiedAt: z.iso.datetime().nullable(),
  lastError: z.string().nullable(),
  workspace: workspaceSchema.nullable(),
});
export type ProjectRepository = z.infer<typeof projectRepositorySchema>;

export const linkRepositoryInputSchema = z.object({
  connectionId: z.uuid(),
  externalId: z.string().trim().min(1).max(100),
});
export type LinkRepositoryInput = z.infer<typeof linkRepositoryInputSchema>;

export const agentRuntimeStatusSchema = z.object({
  provider: z.enum(['claude_code']),
  installed: z.boolean(),
  version: z.string().nullable(),
  loggedIn: z.boolean().nullable(),
  authMethod: z.string().nullable(),
  subscriptionType: z.string().nullable(),
  loginExpiresAt: z.string().nullable(),
  ok: z.boolean(),
  message: z.string(),
  checkedAt: z.iso.datetime().nullable(),
  /** Which worker ran the check (agents run where the CLI is installed). */
  workerId: z.string().nullable(),
});
export type AgentRuntimeStatus = z.infer<typeof agentRuntimeStatusSchema>;
