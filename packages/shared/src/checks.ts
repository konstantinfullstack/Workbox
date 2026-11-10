import { z } from 'zod';

/** One verification command run in the project's working copy after the agent finishes. */
export const checkCommandSchema = z.object({
  name: z.string().trim().min(1).max(60),
  command: z.string().trim().min(1).max(500),
});
export type CheckCommand = z.infer<typeof checkCommandSchema>;

/** Stored in the project config. Runs require `confirmed` (even with no commands): U9. */
export const projectChecksSchema = z.object({
  confirmed: z.boolean(),
  /** Installs dependencies before the checks (e.g. `pnpm install --frozen-lockfile`). */
  setup: z.string().nullable(),
  commands: z.array(checkCommandSchema),
  /** Files the proposal was based on (for the UI). */
  detectedFrom: z.array(z.string()),
  confirmedAt: z.iso.datetime().nullable(),
});
export type ProjectChecks = z.infer<typeof projectChecksSchema>;

export const checksDetectionSchema = z.object({
  setup: z.string().nullable(),
  commands: z.array(checkCommandSchema),
  detectedFrom: z.array(z.string()),
  notes: z.array(z.string()),
});
export type ChecksDetection = z.infer<typeof checksDetectionSchema>;

export const confirmChecksInputSchema = z.strictObject({
  setup: z.string().trim().min(1).max(500).nullable(),
  commands: z.array(checkCommandSchema).max(10),
  detectedFrom: z.array(z.string().max(200)).max(20).default([]),
});
export type ConfirmChecksInput = z.infer<typeof confirmChecksInputSchema>;

export const VERIFICATION_STATUSES = ['pending', 'running', 'passed', 'failed', 'skipped'] as const; // spec §5
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export const checkResultSchema = z.object({
  name: z.string(),
  command: z.string(),
  status: z.enum(['passed', 'failed', 'timed_out']),
  exitCode: z.number().int().nullable(),
  durationMs: z.number().int(),
  /** Last part of the combined output (redacted, truncated). */
  output: z.string(),
});
export type CheckResult = z.infer<typeof checkResultSchema>;

export const REVIEW_REQUEST_STATES = ['draft', 'open', 'merged', 'closed'] as const; // spec §5 PR states
export type ReviewRequestState = (typeof REVIEW_REQUEST_STATES)[number];

/** A task's published branch and pull/merge request (spec §5 git_references). */
export const gitReferenceSchema = z.object({
  provider: z.enum(['github', 'gitlab']),
  branch: z.string(),
  /** Last commit pushed by Workbox. */
  pushedSha: z.string().nullable(),
  pushedAt: z.iso.datetime().nullable(),
  reviewNumber: z.number().int().nullable(),
  reviewUrl: z.string().nullable(),
  reviewState: z.enum(REVIEW_REQUEST_STATES).nullable(),
  lastSyncedAt: z.iso.datetime().nullable(),
  /** Last publishing problem, if any (shown with a Retry button). */
  lastError: z.string().nullable(),
});
export type GitReference = z.infer<typeof gitReferenceSchema>;
