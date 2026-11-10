import { z } from 'zod';

/**
 * Why "Continue development" can or can't start the next task (B3). The autopilot stops at
 * Ready for QA: while a task waits for the user's review, nothing new starts.
 */
export const CONTINUE_REASONS = [
  /** `task` is the next one and can start now. */
  'ready',
  /** A run is active in this project (`task` is the one running). */
  'running',
  /** `task` waits for the user's review (Ready for QA). */
  'waiting_for_qa',
  /** `task` is blocked (failed, cancelled or timed-out run, or blocked by hand). */
  'blocked',
  /** Every remaining task waits on a dependency that isn't done. */
  'waiting_on_dependencies',
  /** Nothing in the backlog or with requested changes. */
  'queue_empty',
  /** `task` is next, but the project can't run tasks yet (see `details`). */
  'not_ready',
  'archived',
] as const;
export type ContinueReason = (typeof CONTINUE_REASONS)[number];

export const continueTaskRefSchema = z.object({
  id: z.uuid(),
  number: z.number().int().positive(),
  title: z.string(),
});
export type ContinueTaskRef = z.infer<typeof continueTaskRefSchema>;

export const continueStatusSchema = z.object({
  canStart: z.boolean(),
  reason: z.enum(CONTINUE_REASONS),
  /** One line for the project page, e.g. "Next up: #5 Add login page". */
  message: z.string(),
  task: continueTaskRefSchema.nullable(),
  /** Extra lines: what's missing before runs can start, other tasks waiting for review, etc. */
  details: z.array(z.string()),
});
export type ContinueStatus = z.infer<typeof continueStatusSchema>;
