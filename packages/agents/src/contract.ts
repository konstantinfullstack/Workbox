/**
 * Provider-agnostic agent contract (spec §7, ADR-006). Orchestration code depends only on these
 * types. Everything specific to one runtime (flags, output parsing, auth) stays in its adapter.
 */

export type AgentCapability =
  'code_edit' | 'shell' | 'stream_events' | 'resume_session' | 'structured_output';

export interface AgentTask {
  runId: string;
  /** The run's worktree. The agent must not read or write outside it. */
  workspacePath: string;
  /** Full task instructions (see buildTaskInstructions). */
  instructions: string;
  timeoutMs: number;
  /** Shell commands the agent may run (e.g. the project's check commands). Empty = no shell. */
  allowedCommands: string[];
  /**
   * If set, the adapter appends its raw native output here (one record per line), so the run's
   * full transcript can be kept as a file. Never contains Workbox secrets: agents don't get any.
   */
  transcriptPath?: string;
}

/** Normalised event stream. Adapters map their native output onto these. */
export type AgentEvent =
  | { type: 'started'; message: string; data: { model?: string; tools?: string[] } }
  | { type: 'progress'; message: string; data: Record<string, never> }
  | { type: 'tool_call'; message: string; data: { tool: string; target?: string } }
  | { type: 'log'; message: string; data: { level: 'info' | 'warn' | 'error' } };

export type AgentResultStatus = 'completed' | 'failed' | 'cancelled' | 'timed_out';

export interface AgentResult {
  status: AgentResultStatus;
  /** What the agent says it did (claims, not verification). */
  summary: string;
  /** Manual test steps for the reviewer. */
  qaSteps: string[];
  failureReason?: string;
  usage?: { costUsd?: number; durationMs?: number; turns?: number };
}

export interface AgentAdapter {
  readonly id: string;
  capabilities(): readonly AgentCapability[];
  /** Runs to completion, failure, timeout or until `signal` aborts (cancel). Never throws for agent failures. */
  execute(
    task: AgentTask,
    emit: (event: AgentEvent) => void,
    signal: AbortSignal,
  ): Promise<AgentResult>;
}
