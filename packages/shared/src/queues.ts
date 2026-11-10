import { z } from 'zod';

/** Canonical queue names. Producers and consumers must import these instead of hard-coding strings. */
export const QUEUE_NAMES = {
  system: 'system',
  /** Git clone/fetch jobs: separate so long clones never block health checks and probes. */
  workspaces: 'workspaces',
  /** Agent runs: one at a time per worker, so runs never compete for the machine. */
  runs: 'runs',
} as const;
export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export const SYSTEM_JOB_NAMES = {
  ping: 'ping',
  probeAgentRuntime: 'probe-agent-runtime',
} as const;

export const pingJobDataSchema = z.object({
  requestedAt: z.iso.datetime(),
  requestedBy: z.string().min(1).max(200),
});
export type PingJobData = z.infer<typeof pingJobDataSchema>;

export const pingJobResultSchema = z.object({
  pong: z.literal(true),
  workerId: z.string(),
  requestedAt: z.iso.datetime(),
  processedAt: z.iso.datetime(),
});
export type PingJobResult = z.infer<typeof pingJobResultSchema>;

export const probeAgentRuntimeJobDataSchema = z.object({
  provider: z.literal('claude_code'),
  requestedAt: z.iso.datetime(),
});
export type ProbeAgentRuntimeJobData = z.infer<typeof probeAgentRuntimeJobDataSchema>;

export const probeAgentRuntimeJobResultSchema = z.object({
  workerId: z.string(),
  checkedAt: z.iso.datetime(),
  installed: z.boolean(),
  version: z.string().nullable(),
  loggedIn: z.boolean().nullable(),
  authMethod: z.string().nullable(),
  subscriptionType: z.string().nullable(),
  loginExpiresAt: z.string().nullable(),
  ok: z.boolean(),
  message: z.string(),
});
export type ProbeAgentRuntimeJobResult = z.infer<typeof probeAgentRuntimeJobResultSchema>;

export const WORKSPACE_JOB_NAMES = {
  sync: 'sync-workspace',
  remove: 'remove-workspace',
} as const;

export const syncWorkspaceJobDataSchema = z.object({
  projectRepositoryId: z.uuid(),
  reason: z.enum(['linked', 'manual', 'startup']),
});
export type SyncWorkspaceJobData = z.infer<typeof syncWorkspaceJobDataSchema>;

export const removeWorkspaceJobDataSchema = z.object({
  projectSlug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
});
export type RemoveWorkspaceJobData = z.infer<typeof removeWorkspaceJobDataSchema>;

export const RUN_JOB_NAMES = { execute: 'execute-run' } as const;

export const executeRunJobDataSchema = z.object({ runId: z.uuid() });
export type ExecuteRunJobData = z.infer<typeof executeRunJobDataSchema>;
