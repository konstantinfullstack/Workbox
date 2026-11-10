import { z } from 'zod';

/** Spec §5 run state machine. Distinct from the task state machine. */
export const RUN_STATES = [
  'queued',
  'preparing',
  'running',
  'verifying',
  'completed',
  'failed',
  'cancelled',
  'timed_out',
] as const;
export type RunState = (typeof RUN_STATES)[number];
export const ACTIVE_RUN_STATES = [
  'queued',
  'preparing',
  'running',
  'verifying',
] as const satisfies readonly RunState[];

/** Agent runtimes that can execute runs (adapters in #agents). */
export const AGENT_RUNTIMES = ['claude_code'] as const;
export type AgentRuntime = (typeof AGENT_RUNTIMES)[number];
/** Display names (UI, commit trailers). */
export const AGENT_LABELS: Record<AgentRuntime, string> = { claude_code: 'Claude Code' };

/** Spec §7 event types, plus `stage` for orchestrator progress (preparing workspace, etc.). */
export const RUN_EVENT_TYPES = [
  'stage',
  'started',
  'progress',
  'tool_call',
  'log',
  'completed',
  'failed',
] as const;
export type RunEventType = (typeof RUN_EVENT_TYPES)[number];

export const changedFileSchema = z.object({
  path: z.string(),
  status: z.enum(['added', 'modified', 'deleted', 'renamed']),
});
export type ChangedFile = z.infer<typeof changedFileSchema>;

export const taskRunSchema = z.object({
  id: z.uuid(),
  taskId: z.uuid(),
  projectId: z.uuid(),
  /** 1, 2, 3… per task. */
  attempt: z.number().int().positive(),
  state: z.enum(RUN_STATES),
  agent: z.enum(AGENT_RUNTIMES),
  branch: z.string().nullable(),
  /** merge-base with the default branch: what a pull request compares against. */
  baseSha: z.string().nullable(),
  /** Local commit made by Workbox at the end of the run (pushed in B2). */
  commitSha: z.string().nullable(),
  /** The project's working copy the run used. */
  worktreePath: z.string().nullable(),
  summary: z.string().nullable(),
  qaSteps: z.array(z.string()),
  changedFiles: z.array(changedFileSchema),
  exitReason: z.string().nullable(),
  costUsd: z.number().nullable(),
  durationMs: z.number().int().nullable(),
  cancelRequested: z.boolean(),
  queuedAt: z.iso.datetime(),
  startedAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
});
export type TaskRun = z.infer<typeof taskRunSchema>;

export const runEventSchema = z.object({
  seq: z.number().int().positive(),
  type: z.enum(RUN_EVENT_TYPES),
  message: z.string(),
  data: z.record(z.string(), z.unknown()),
  createdAt: z.iso.datetime(),
});
export type RunEvent = z.infer<typeof runEventSchema>;

export const runEventsQuerySchema = z.object({
  after: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(1_000).default(500),
});

export const startRunInputSchema = z.strictObject({
  /** Extra guidance for this run (e.g. what to change after a review). */
  note: z.string().trim().min(1).max(5_000).optional(),
});
export type StartRunInput = z.infer<typeof startRunInputSchema>;

export const runDiffSchema = z.object({
  diff: z.string(),
  truncated: z.boolean(),
});
export type RunDiff = z.infer<typeof runDiffSchema>;
